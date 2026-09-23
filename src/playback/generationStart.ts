import type { GenerationStartKind } from '../cluster/EndpointRegistry.js';
import { probeHlsReadiness, type HlsWalkFetch } from './hlsWalk.js';
import type { PlaybackSession } from './PlaybackResolver.js';

/**
 * What kind of start this generation was, for keying its cost.
 *
 * Undefined for Direct Play, which has no pipeline and nothing to start: the
 * node hands over bytes it already has.
 */
export function generationStartKind(session: PlaybackSession): GenerationStartKind | undefined {
  if (session.mode === 'direct') return undefined;
  if (session.mode === 'remux') return 'remux';
  return session.transform?.video === 'copy' ? 'video-copy' : 'video-transcode';
}

/**
 * How much further ahead of the viewer a move asks for, beyond the measured
 * start.
 *
 * Covers what the start measurement does not: the first fragment travelling
 * to the player once it exists, and the host settling its join. **A guess,
 * documented as one** — the same standing as `ENDPOINT_TRANSPORT_ALLOWANCE_MS`,
 * the other term in this package that no node can state about itself. A host
 * that knows better passes its own lead to `moveTo` and this is not used.
 */
export const MOVE_LEAD_MARGIN_MS = 5_000;

export interface GenerationStartProbeOptions {
  /** The host's fetch; the probe reads no payload. */
  fetch: HlsWalkFetch;
  /** When the request that produced this generation was sent, on `now`'s clock. */
  startedAt: number;
  /** Give up after this long since `startedAt`: the node's own attempt budget. */
  budgetMs: number;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long this generation took to reach a first fragment, measured by asking.
 *
 * Polls `probeHlsReadiness`, which ranges `bytes=0-0` and so **moves no media
 * bytes**, honouring the node's own `Retry-After` between attempts. The
 * answer is the time from the request that created the generation to the
 * first `ready`. That is the cost a viewer pays when a move or a seek asks this
 * node for a fresh generation.
 *
 * Undefined whenever the answer would not be a start cost: not a manifest, an
 * empty one, a node that refused, a session stopped under it, a budget that
 * ran out. A failed measurement records nothing, so it can never become a lead.
 *
 * Background only. Nothing a viewer waits on awaits this.
 */
export async function measureGenerationStart(
  source: PlaybackSession['source'],
  options: GenerationStartProbeOptions,
): Promise<number | undefined> {
  const sleep = options.sleep ?? defaultSleep;
  for (;;) {
    if (options.now() - options.startedAt > options.budgetMs) return undefined;
    let outcome;
    try {
      outcome = await probeHlsReadiness(source, { fetch: options.fetch });
    } catch {
      return undefined;
    }
    if (outcome.state === 'ready') {
      const elapsed = options.now() - options.startedAt;
      return elapsed > options.budgetMs ? undefined : elapsed;
    }
    if (outcome.state !== 'holding') return undefined;
    await sleep(Math.max(100, outcome.retryAfterMs));
  }
}

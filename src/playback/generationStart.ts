import type { GenerationStartKind } from '../cluster/EndpointRegistry.js';
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

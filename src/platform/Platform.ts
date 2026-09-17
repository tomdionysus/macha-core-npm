import type { MediaTechnicalProfile, PlaybackCapabilities, PlaybackEvent, PlaybackSource, PlaybackTimeRange } from '../types.js';

export type PlaybackListener = (event: PlaybackEvent) => void;
export type PlaybackFailureListener = (error: Error) => void;
export type PlaybackDegradationListener = (error: Error) => void;

/**
 * What the player's evidence is about.
 *
 * Each member names **what the node said**, never what to do about it. That is
 * the whole discipline of this type: an adapter reports the observation, and
 * core decides what it means. Two of the members exist because a kind that
 * smuggled in a conclusion got the conclusion wrong.
 *
 * `stream` and `unknown` may be endpoint evidence; `media` and `unsupported`
 * are facts about the bytes and never reflect on the node.
 *
 * `not-ready` is not a failure at all. A node holding a fragment back until it
 * has been produced answers `500 segment_not_ready` with a `Retry-After`,
 * which is the node working correctly near the production frontier and saying
 * so. It is separated from `stream` because the two are indistinguishable
 * without reading the status — both arrive as a failed fragment — and treating
 * a hold as evidence would take a healthy node out of rotation for doing
 * exactly what it was asked.
 *
 * *This paragraph said `503` until 2026-09-17, and `streamProtocol.ts` has
 * always said `503` is a broken generation and terminal. Inverted, not merely
 * inconsistent: an author following this seam would have retried the terminal
 * status and condemned the node on the benign one. Both shipped adapters were
 * already right, so it was a trap for the next author rather than a live
 * defect. `docs/writing-a-player.md` is and was correct.*
 *
 * `not-found` is a `404` on a playback route: the node did not serve this
 * media. **It is a statement about one session's existence, not about the
 * node**, which is why it is not endpoint evidence. What it means is genuinely
 * ambiguous and an adapter cannot resolve it — measured against one node in
 * one run on 2026-09-17, a session the reaper had erased and a fragment past
 * the end of a live plan both answered `404` with the identical machine code
 * `not_found`, differing only in one word of English in a message the adapter
 * never receives. Core resolves it by asking whether the session still exists;
 * see `PlaybackResolver.sessionAlive`.
 *
 * Reporting it cost a node its place in the candidate list until this member
 * existed: a reaped session surfaced as `stream`, `stream` is endpoint
 * evidence, and the node that had answered honestly was excluded while the
 * viewer was sent to one that had never held the session.
 */
export type PlaybackFailureKind = 'stream' | 'media' | 'unsupported' | 'not-ready' | 'not-found' | 'unknown';

/**
 * What a source activation means for the person watching.
 *
 * **The one bit a host cannot work out for itself, and the only thing that
 * decides whether replacing a source should be invisible or obvious.**
 *
 * - `continue` — the viewer did not ask for this and should not see it. A
 *   session the node reaped, a failover to another node, a quality change. A
 *   host able to prepare the replacement alongside the current one and cut
 *   between them should do exactly that.
 * - `relocate` — the viewer asked to be somewhere else. Attach at the new
 *   position and let them see it happen. Holding them where they were while a
 *   replacement is prepared is the one outcome they did not want.
 *
 * **Both arrive as `play(source, positionMs)` and are byte-identical.**
 * Measured: a viewer's seek and a reaped-session recovery both reached a host
 * as position `0` with the same offsets, so a host that cut seamlessly on both
 * held a viewer at 17:40 for fourteen seconds after they asked to go to 47:00,
 * while the clock read 46:58 the whole time. No inference from position deltas
 * separates them either — a short seek and a reap recovery look alike, and
 * guessing wrong reintroduces a visible cut on the recovery path or keeps the
 * lie on the seek path.
 *
 * **Optional, and absent means `relocate`** — the behaviour every player had
 * before seamless replacement existed, which is to attach and let it show. A
 * host that ignores this argument is therefore still correct; only a host that
 * can hide the change needs to know when it should.
 */
export type PlaybackTransition = 'continue' | 'relocate';

/** Terminal player evidence, kept distinct from endpoint/API failures. */
export class PlaybackSourceError extends Error {
  constructor(
    message: string,
    public readonly kind: PlaybackFailureKind,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PlaybackSourceError';
  }
}

export function isEndpointRetryablePlaybackFailure(error: unknown): boolean {
  // Existing/custom players historically emitted plain Error objects for
  // source loss. Preserve that compatibility while allowing players with real
  // decoder evidence to prevent pointless node churn.
  //
  // Note what the default costs a player that does not classify: a bare Error
  // is treated as endpoint evidence, so a segment hold reported without a kind
  // prepares a standby on another node and can escalate to failover. Only the
  // adapter can tell a hold from a loss — it is the thing holding the response
  // — so a player fetching fragments itself must classify them.
  //
  // `not-found` is excluded for the same reason as `not-ready`, one layer up:
  // the node answered, correctly, about a session rather than about itself.
  // Recovering from it is a separate decision and is not made here — see
  // `PlaybackCoordinator`'s handling of the kind.
  return !(error instanceof PlaybackSourceError) || error.kind === 'stream' || error.kind === 'unknown';
}

/**
 * Whatever a platform presents into: a DOM element on the web, a native view
 * handle or component ref on React Native. The core never inspects it — it
 * only carries it from the presentation layer to that platform's own player.
 *
 * **Use this rather than a DOM type, and nothing will stop you doing otherwise.**
 * `tsconfig` enables the `DOM` lib because core legitimately uses the web
 * standard `fetch`, `Response`, `Headers` and `AbortSignal`, whose types live
 * there — so `HTMLElement` also compiles perfectly well, and `PlaybackRuntime`
 * accepted one for a while. It typechecks, it passes every test, and it is
 * wrong: it hands React Native a type it cannot satisfy, in a package whose
 * whole claim is that it assumes no browser.
 */
export type PlaybackHost = unknown;

export interface Player {
  /** Bind the existing player surface to a presentation host. Must not create a playback session. */
  attach(host: PlaybackHost): void;
  /** Unbind presentation without changing playback/resource ownership. */
  detachHost?(): void;
  /** Final player destruction. This is resource-destructive. */
  detach(): void;
  /**
   * Attach a source at a source-generation-local position and request
   * playback.
   *
   * **Resolves when this source is the one being presented**, which for a host
   * that tears the old element down is the moment it is dispatched, and for a
   * host that prepares the replacement alongside is the moment it cuts. Core
   * treats the resolution as the instant the source changed: until then it
   * goes on describing the source that is still playing. Never resolve on
   * buffering completing.
   *
   * `transition` says whether the viewer asked for this — see
   * `PlaybackTransition`. A host that can replace a source invisibly must only
   * do so for `continue`.
   */
  play(
    source: PlaybackSource,
    positionMs?: number,
    startPaused?: boolean,
    transition?: PlaybackTransition,
  ): Promise<boolean>;
  /** Non-blocking, idempotent local setup from advisory or session-derived technical facts. */
  prepare?(profile: MediaTechnicalProfile): void;
  /** Pause transport and suspend avoidable/speculative source acquisition. */
  pause(): void;
  /** Resume source acquisition as necessary and continue the active generation. */
  resume(): void;
  seek(positionMs: number): void;
  /**
   * Source-generation-local timeline ranges that the active player can seek to
   * without changing the playback session or creating another source generation.
   * Implementations must normalize platform/media timestamp origins before
   * exposing these ranges; seek() uses this same coordinate system.
   */
  localSeekCoverage(): readonly PlaybackTimeRange[];
  /**
   * Set the output level, where the host has an app-level volume at all.
   *
   * **Optional because whether a host has one is platform-specific — not
   * because none do.** A Tizen widget has no meaningful per-app level and
   * leaves it to the set; an Android TV player built on Media3 exposes a real
   * per-player volume that is genuinely independent of the television's own
   * output stage, so the remote's volume keys drive the set while the app's
   * 0–1 rides underneath. Both are real hosts and they need opposite things,
   * which is what makes this skippable rather than required.
   *
   * *Do not argue from the fakes.* An earlier version of this comment cited
   * core's three `Player` fakes all implementing it with an empty body as
   * evidence the member was unnecessary. A fake implementing something
   * emptily says nothing about whether real hosts need it, and at least one
   * shipped adapter implements this for real — setting the active player's
   * level and remembering it, because a warm standby is primed at `0` so it
   * cannot be heard behind the active source and must come up at the real
   * level when promoted.
   *
   * {@link Platform.initialVolume} is the related seam and the one that
   * carries the genuinely cross-client fact: whether the host does app volume
   * at all, and therefore whether a client should restore a remembered level
   * or leave it to the device.
   */
  setVolume?(volume: number): void;
  /** Replace the subtitle resource without touching active A/V playback. */
  setSubtitle?(subtitleUrl?: string): Promise<void> | void;
  /** Add an equivalent Direct Play byte source without replacing active media. */
  addDirectSourceAlternative?(activeSource: PlaybackSource, alternative: PlaybackSource): boolean;
  /** Validate a transformed source without replacing the active presentation. */
  preflightSource?(source: PlaybackSource): Promise<boolean>;
  /** Release all source-side resources and cancel active acquisition. */
  stop(): void;
  subscribe(listener: PlaybackListener): () => void;
  /**
   * Subscribe to terminal source/player failures that require generation
   * teardown.
   *
   * **An adapter that reports `not-found` must not tear the presentation down
   * on it.** That kind means one thing only — the node did not serve this
   * media — and the buffer the element already holds is unaffected and still
   * playable. Core may have a replacement generation built and waiting, in
   * which case the right outcome is for the viewer to watch out their buffer
   * and be swapped onto the replacement with no visible interruption. An
   * adapter that destroys its loader, pauses the element or suppresses the
   * next play request on that kind throws away exactly the cover the recovery
   * was going to spend. Measured: 82 seconds of it.
   *
   * **This obligation is opt-in and arrives with the kind.** An adapter that
   * never reports `not-found` never reaches the path, and every other kind
   * keeps the old contract — so a player that tears down on a terminal is
   * still correct until the day it starts classifying `404`s.
   *
   * **What happens when there is no replacement is core's, not the
   * adapter's.** If recovery is impossible core sets a fatal error on its
   * snapshot and the owning runtime stops the player. The viewer gets a
   * stated failure either way; the adapter does not have to manufacture one
   * by tearing down, and should not, because doing so pre-empts a recovery
   * that may still be seconds from ready.
   */
  subscribeFailure?(listener: PlaybackFailureListener): () => void;
  /** Early network evidence while the current buffered source may still play. */
  subscribeDegradation?(listener: PlaybackDegradationListener): () => void;
}

/**
 * Which player implementation is in use.
 *
 * Named for the executor rather than the operating system: `'ios'` and
 * `'android'` are distinct because AVPlayer and ExoPlayer are, even where one
 * React Native codebase covers both, and `'tizen'` is distinct from `'web'`
 * despite both running in a browser engine.
 */
export type PlatformName = 'web' | 'ios' | 'android' | 'tizen';

export interface Platform {
  readonly name: PlatformName;
  /** Native/system volume when the platform owns audio volume, otherwise undefined. */
  initialVolume?(): number | undefined;
  capabilities(): Promise<PlaybackCapabilities>;
  createPlayer(): Player;
  exitApplication?(): void;
}

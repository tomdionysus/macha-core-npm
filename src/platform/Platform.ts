import type { MediaTechnicalProfile, PlaybackCapabilities, PlaybackEvent, PlaybackSource, PlaybackTimeRange } from '../types.js';

export type PlaybackListener = (event: PlaybackEvent) => void;
export type PlaybackFailureListener = (error: Error) => void;
export type PlaybackDegradationListener = (error: Error) => void;

/**
 * What the player's evidence is about.
 *
 * `stream` and `unknown` may be endpoint evidence; `media` and `unsupported`
 * are facts about the bytes and never reflect on the node. `not-ready` is the
 * odd one: it is not a failure at all. A node holding a fragment back until it
 * has been produced answers `503 segment_not_ready` with a `Retry-After`, which
 * is the node working correctly near the production frontier and saying so. It
 * is separated from `stream` because they are indistinguishable by status — both
 * are 5xx on a fragment — and treating a hold as evidence would take a healthy
 * node out of rotation for doing exactly what it was asked.
 */
export type PlaybackFailureKind = 'stream' | 'media' | 'unsupported' | 'not-ready' | 'unknown';

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
  /** Attach a source at a source-generation-local position and request playback. Resolves once dispatched, never when buffering completes. */
  play(source: PlaybackSource, positionMs?: number, startPaused?: boolean): Promise<boolean>;
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
  /** Subscribe to terminal source/player failures that require generation teardown. */
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

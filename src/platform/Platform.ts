import type { MediaTechnicalProfile, PlaybackCapabilities, PlaybackEvent, PlaybackSource, PlaybackTimeRange } from '../types.js';

export type PlaybackListener = (event: PlaybackEvent) => void;
export type PlaybackFailureListener = (error: Error) => void;
export type PlaybackDegradationListener = (error: Error) => void;

export type PlaybackFailureKind = 'stream' | 'media' | 'unsupported' | 'unknown';

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
  return !(error instanceof PlaybackSourceError) || error.kind === 'stream' || error.kind === 'unknown';
}

/**
 * Whatever a platform presents into: a DOM element on the web, a native view
 * handle or component ref on React Native. The core never inspects it — it
 * only carries it from the presentation layer to that platform's own player.
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
  setVolume(volume: number): void;
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

import type { MediaSummary, PlaybackCapabilities, PlaybackMode, PlaybackSource } from '../types.js';

export type PlaybackStreamType = 'video' | 'audio' | 'subtitle' | 'other';
export type PlaybackTransform = 'copy' | 'transcode' | 'omit';

export interface PlaybackStreamInfo {
  index: number;
  type: PlaybackStreamType;
  codec: string;
  profile: string;
  language: string;
  default: boolean;
  forced: boolean;
  width?: number;
  height?: number;
  channels?: number;
  sampleRate?: number;
  bitDepth?: number;
  bitrate?: number;
  /** Encoded level (H.264/HEVC), when the server reports one. */
  level?: number;
  /**
   * Transfer characteristics by their ffmpeg/H.273 name — `smpte2084` (PQ),
   * `arib-std-b67` (HLG), or an SDR name. Reported per stream on both the
   * source and, after negotiation, whatever the server decided to serve, so
   * a client can tell whether it was actually given the HDR it asked for.
   */
  colorTransfer?: string;
  /** Dolby Vision profile of the source stream, when it carries one. */
  dolbyVisionProfile?: number;
  /** Base-layer compatibility id, which decides what a non-DV decoder sees. */
  dolbyVisionCompatibility?: number;
}

export interface PlaybackSourceInfo {
  path: string;
  /** Raw demuxer list. Use `container` for capability matching. */
  format: string;
  /** Resolved container family, when the server reports one. */
  container?: string;
  size: number;
  bitrate: number;
  streams: PlaybackStreamInfo[];
}

export interface PlaybackOutputVideoInfo {
  sourceStream: number;
  transform: PlaybackTransform;
  codec?: string;
  profile?: string;
  width?: number;
  height?: number;
  bitrate?: number;
  /**
   * What is actually served, which is the only way to tell a successful
   * downconvert from a gate that did nothing. A copied stream reports the
   * source's values; a transcode reports the encoder's — so a PQ source
   * transcoded for an SDR client shows `smpte2084` on the source stream and
   * `bt709` here.
   */
  bitDepth?: number;
  level?: number;
  colorTransfer?: string;
}

export interface PlaybackOutputAudioInfo {
  sourceStream: number;
  transform: PlaybackTransform;
  codec?: string;
  profile?: string;
  channels?: number;
  sampleRate?: number;
  bitDepth?: number;
  bitrate?: number;
}

export interface PlaybackOutputInfo {
  format?: string;
  /**
   * The container actually served — `fmp4` or `mpegts` for HLS, the source
   * file's own container for a direct session.
   *
   * The instruction says which segment container to package into; this says
   * which one came back, and until the server reported it there was no way to
   * tell a preference that took effect from one that was ignored. Absent when
   * the node predates the field: read that as unknown, never as a default,
   * because a default is indistinguishable on screen from an answer.
   */
  container?: string;
  bitrate?: number;
  video?: PlaybackOutputVideoInfo;
  audio?: PlaybackOutputAudioInfo;
}

export interface PlaybackSelection {
  videoStream: number;
  audioStream: number;
  subtitleStream: number;
}

export interface PlaybackOptions {
  modes: PlaybackMode[];
  qualityHeights: number[];
  mediaIds: string[];
  audioStreams: PlaybackStreamInfo[];
  subtitleStreams: PlaybackStreamInfo[];
  canSeek: boolean;
  canChangeQuality: boolean;
  canSwitchMedia: boolean;
}

export interface PlaybackPreferences {
  mode: PlaybackMode;
  maxHeight: number | null;
  maxBitrate: number | null;
  audioStream: number | null;
  subtitleStream: number | null;
  audioLanguage: string;
  subtitleLanguage: string;
}

export interface PlaybackSession {
  sessionId: string;
  /** Node/API provenance for this disposable playback generation. */
  endpoint?: { id: string; baseUrl: string };
  itemId?: string;
  mediaId: string;
  mode: PlaybackMode;
  mimeType: string;
  source: PlaybackSource;
  durationMs: number;
  /**
   * How far past the last fragment requested this node will have produced,
   * from `stream.look_ahead_ms`.
   *
   * **The line between a fragment request that is held and one refused.** A
   * node produces to `highest_requested + max_ahead_segments` and parks, and
   * the hold window is deliberately the same distance — so a viewer arriving
   * beyond this finds the encoder still working towards them, answering
   * `500 segment_not_ready` until it arrives. That is not a fault and must not
   * be read as one; production is sequential, so asking for a distant index
   * does not skip the fragments before it.
   *
   * **Three states, and none may be collapsed.** `undefined` — the node
   * predates server 0.45.0 and cannot say, so a client must bound itself
   * conservatively rather than assume a default. `null` — direct play, which
   * has no pipeline and therefore no frontier at all. A number — the answer,
   * in milliseconds.
   *
   * **Per session, not per node.** It follows the node's `reconfigure()`, so
   * it is read from the session that reports it and never cached against an
   * endpoint.
   *
   * Nothing on the wire carried this before, so a client had only the defaults
   * to reason from. One that assumed 8 segments of 4 s against a node
   * configured for 4 believed it had 32 s of authorised production when it had
   * 16, and sat refused at the frontier for the difference — measured as a
   * 12.7 s viewer freeze on 2026-09-17.
   */
  lookAheadMs?: number | null;
  seekMs: number;
  preferences: PlaybackPreferences;
  sourceInfo: PlaybackSourceInfo;
  output: PlaybackOutputInfo;
  selected: PlaybackSelection;
  transform: {
    video: PlaybackTransform;
    audio: PlaybackTransform;
  };
  options: PlaybackOptions;
}

export interface PlaybackPreferencesUpdate {
  /**
   * Required on session creation, optional on update.
   *
   * There is no `auto`. The server reports what the media is and performs
   * what it is told; deciding is the client's job, and
   * `choosePlaybackInstruction` is how the core does it from source facts
   * plus honest host capabilities.
   *
   * `'choose'` is a **client-side sentinel and never reaches the server**. It
   * means "decide for me now", and the coordinator replaces it with a
   * concrete instruction before anything is sent. It is not the old `auto`
   * under a new name: `auto` asked the server to decide, this asks the core
   * to, from facts the server does not have. It shares the `mode` field
   * because choosing and naming a mode are mutually exclusive — as two
   * fields they could contradict each other, and something would have to
   * decide which wins.
   */
  mode?: PlaybackMode | 'choose';
  /** Per-stream instruction, overriding the `mode` shorthand when given. */
  video?: 'copy' | 'transcode';
  audio?: 'copy' | 'transcode';
  /** Which HLS segment container to package into. */
  container?: 'fmp4' | 'mpegts';
  maxHeight?: number | null;
  maxBitrate?: number | null;
  audioStream?: number | null;
  subtitleStream?: number | null;
  audioLanguage?: string;
  subtitleLanguage?: string;
}

export interface PlaybackUpdate {
  preferences?: PlaybackPreferencesUpdate;
  seekMs?: number;
  mediaId?: string;
}

export interface PlaybackStopOptions {
  /** Keep the teardown request alive while the browser is navigating away. */
  keepalive?: boolean;
}

/**
 * How long one attempt to negotiate a generation on one endpoint may take
 * before the caller stops waiting for it.
 *
 * Lives on the contract rather than inside an implementation because two
 * layers need it and neither owns it. `ClusterPlaybackResolver` enforces it
 * per endpoint, abandoning a slow node and moving to the next; the coordinator
 * budgets against it when deciding how far ahead of a viewer's remaining media
 * it must start building a replacement. Declared once so those two cannot
 * drift, which is the fault this package keeps recording.
 */
export const GENERATION_ATTEMPT_BUDGET_MS = 12_000;

/** Server-side playback negotiation and session-control seam. */
export interface PlaybackResolver {
  readonly available: boolean;
  resolve(
    media: MediaSummary,
    capabilities: PlaybackCapabilities,
    seekMs?: number,
    preferences?: PlaybackPreferencesUpdate,
  ): Promise<PlaybackSession>;
  update(sessionId: string, update: PlaybackUpdate, signal?: AbortSignal): Promise<PlaybackSession>;
  stop(sessionId: string, options?: PlaybackStopOptions): Promise<void>;
  /** Recreate client-owned playback intent on another node after source failure. */
  failover?(
    failedSession: PlaybackSession,
    media: MediaSummary,
    capabilities: PlaybackCapabilities,
    seekMs: number,
    preferences: PlaybackPreferencesUpdate,
    preparedAlternate?: PlaybackSession,
  ): Promise<PlaybackSession>;
  /**
   * Whether the node that issued this generation still holds it.
   *
   * The question that resolves a `PlaybackFailureKind` of `not-found`, which a
   * player cannot resolve for itself: a reaped session and a fragment past the
   * end of the plan are the same status and the same error code on the wire.
   *
   * Resolves `false` only on a definitive `404` from the owning node. It
   * throws when the answer could not be obtained, and callers must keep those
   * apart — "I could not find out" is not "it is gone", and acting on the
   * second when you have the first condemns a node for being briefly
   * unreachable.
   *
   * Never call it on a timer. See `SERVER_SESSION_IDLE_MS` for why a keepalive
   * is the wrong shape here.
   */
  sessionAlive?(sessionId: string): Promise<boolean>;
  /**
   * Replace a generation on the node already serving it, without holding that
   * node responsible for it.
   *
   * Distinct from `failover`, which means "this node failed" and records it.
   * A node answering `404 not_found` for a session it has reaped is making a
   * statement about that session, not about itself, and is the right place to
   * ask again. See `ClusterPlaybackResolver.regenerate` for the whole of why.
   *
   * Rejects when the endpoint is unknown or no longer configured; deciding to
   * failover instead is the caller's.
   */
  regenerate?(
    failedSession: PlaybackSession,
    media: MediaSummary,
    capabilities: PlaybackCapabilities,
    seekMs: number,
    preferences: PlaybackPreferencesUpdate,
  ): Promise<PlaybackSession>;
  /** Prepare one bounded standby generation without delaying active playback. */
  prepareAlternate?(
    activeSession: PlaybackSession,
    media: MediaSummary,
    capabilities: PlaybackCapabilities,
    seekMs: number,
    preferences: PlaybackPreferencesUpdate,
  ): Promise<PlaybackSession | undefined>;
  /**
   * Record that a specific endpoint has failed without negotiating any new
   * session. Needed when the transport layer has already moved off an
   * endpoint silently (see `PlaybackCoordinator`'s direct-source-alternative
   * promotion) — endpoint health/cooldown tracking must still learn about
   * the failure, or a later failover can blindly retry a node already known
   * to be dead.
   */
  recordEndpointFailure?(endpointId: string): void;
}

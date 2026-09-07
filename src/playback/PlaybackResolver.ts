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
  format: string;
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
  mode: PlaybackMode | 'auto';
  maxHeight: number | null;
  maxBitrate: number | null;
  audioStream: number | null;
  subtitleStream: number | null;
  audioLanguage: string;
  subtitleLanguage: string;
}

/**
 * Warning codes are stable strings, but the server is free to add more than
 * the core knows about. The `(string & {})` arm keeps editor completion for
 * the known values while still accepting an unrecognised one, so a newer
 * server cannot break an older client's types — consumers must handle a code
 * they do not recognise rather than assume the union is closed.
 */
export type PlaybackWarningCode = 'capability_contradiction' | (string & {});
export type PlaybackWarningField = 'video_codecs' | 'video_bit_depth' | 'hdr' | 'audio_codecs' | (string & {});

/**
 * Advisory notice that a session contradicts what the client advertised.
 *
 * Emitted only when the viewer asked for an explicit `direct` or `remux` and
 * the copied stream is something the client said it could not handle — the
 * escape hatch is deliberately still honoured, so this is how a client learns
 * the server noticed. Never fatal, and never a reason to refuse a session.
 */
export interface PlaybackWarning {
  code: PlaybackWarningCode;
  /** The advertised capability the source contradicts. */
  field: PlaybackWarningField;
  /** A specific sentence, e.g. "the source video is 10-bit; the client advertised 8". */
  message: string;
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
  /**
   * Optional, so that a resolver synthesising a session — an offline or
   * local-file resolver, a test fixture — need not write an empty array it
   * has nothing to say into. `MachaPlaybackResolver` always populates it,
   * so a session that came from a server is never undefined.
   *
   * Empty or absent means either "the server found no contradiction" or
   * "the server is too old to report one", and those are indistinguishable
   * by design, in the same way an absent capability means the client did not
   * answer. Treat it as advice, never as proof of safety.
   */
  warnings?: PlaybackWarning[];
}

export interface PlaybackPreferencesUpdate {
  mode?: PlaybackMode | 'auto';
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

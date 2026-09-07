import type { CatalogueKind } from './api/CatalogueApi.js';

export type MediaKind = CatalogueKind;

export interface ArtworkRef {
  id: string;
  mimeType: string;
  /**
   * Short-lived signed capability URL, when the server supplies one.
   * Renders directly with no client-side blob fetch — the browser owns
   * fetching, decode and HTTP caching. `LazyArtwork` does remember the last
   * URL that loaded successfully for this `id`, since the server re-signs
   * this on every catalogue fetch even when the image hasn't changed.
   */
  url?: string;
}

export interface Artwork {
  poster?: ArtworkRef;
  backdrop?: ArtworkRef;
  thumbnail?: ArtworkRef;
}

export interface PlaybackHierarchyContext {
  series: { id: string; title: string };
  season: { id: string; title: string; seasonNumber: number };
}

export interface MediaSummary {
  id: string;
  kind: MediaKind;
  title: string;
  subtitle?: string;
  year?: number;
  synopsis?: string;
  artwork?: Artwork;
  parentId?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  discNumber?: number;
  trackNumber?: number;
  mediaIds: string[];
  durationMs?: number;
  playbackContext?: PlaybackHierarchyContext;

  /** Catalogue `updated_ns`, currently the server's only chronology signal for Home recency ordering. */
  catalogueUpdatedNs?: number;

  /**
   * Reserved UI field for a future catalogue release/air date.
   * The current Macha catalogue wire model does not expose this yet.
   */
  releaseDate?: string;
}

export interface Episode extends MediaSummary {
  kind: 'episode';
  seasonNumber: number;
  episodeNumber: number;
  /** Always present on an API-produced episode; the catalogue wire item only carries `parent_id`. */
  playbackContext: PlaybackHierarchyContext;
}

export interface SeasonSummary extends MediaSummary {
  kind: 'season';
  showId: string;
  seasonNumber: number;
}

export interface SeasonDetails extends SeasonSummary {
  episodes: Episode[];
}

export interface ShowDetails extends MediaSummary {
  kind: 'show';
  seasons: SeasonSummary[];
}

export interface ArtistDetails extends MediaSummary {
  kind: 'artist';
  albums: MediaSummary[];
}

export interface AlbumDetails extends MediaSummary {
  kind: 'album';
  tracks: MediaSummary[];
}

export interface MovieDetails extends MediaSummary {
  kind: 'movie';
}

export type MediaDetails = ShowDetails | SeasonDetails | ArtistDetails | AlbumDetails | MediaSummary;

export interface LibraryHome {
  movies: MediaSummary[];
  shows: MediaSummary[];
  albums: MediaSummary[];
}

export interface PlaybackProgress {
  mediaId: string;
  positionMs: number;
  durationMs: number;
  updatedAt: number;
  media?: MediaSummary;
}

export type VideoCodec = 'h264' | 'hevc' | 'vp9' | 'av1' | 'mpeg2' | string;
export type AudioCodec = 'aac' | 'ac3' | 'eac3' | 'opus' | 'mp3' | 'flac' | string;

export interface PlaybackCapabilities {
  platform: 'web' | 'android' | 'tizen';
  /** Optional decoder/platform limits. Web deliberately leaves these unset. */
  maxWidth?: number;
  maxHeight?: number;
  videoCodecs: VideoCodec[];
  audioCodecs: AudioCodec[];
  containers: string[];
  /**
   * HLS with **fragmented-MP4** segments specifically — not HLS in general.
   *
   * The distinction is not pedantry. `canPlayType('application/vnd.apple.
   * mpegurl')` answers "can you play HLS", which is a different and easier
   * question: Tizen 3 answers yes to it, then renders fMP4 video while
   * silently dropping the muxed AAC. A host that maps a general HLS probe
   * onto this field asserts a capability it never tested, and the failure is
   * a silent stream rather than an error. The field is named for what the
   * server reads it as.
   */
  hlsFmp4: boolean;
  /** HLS with MPEG-TS segments, offered by newer servers when `hlsFmp4` is false. */
  hlsTs?: boolean;
  dash: boolean;
  /**
   * Transfer characteristics the client can actually display, by their
   * ffmpeg/H.273 names: `smpte2084` (PQ) and `arib-std-b67` (HLG). Empty
   * means SDR only — the server transcodes an HDR source down rather than
   * handing over a stream that decodes to a washed-out or black picture.
   */
  hdr: string[];
  /**
   * Deepest sample depth the client's video pipeline decodes, 8-16. Leave
   * unset when unknown; the server assumes 8. Over-claiming is worse than
   * under-claiming: an 8-bit decoder fed a 10-bit source shows nothing,
   * whereas a 10-bit decoder fed an unnecessary 8-bit transcode still plays.
   *
   * Sent verbatim — the core does not clamp or round it, so a host that
   * derives the depth from something parsed (a device profile string, a
   * system property) must validate at its own boundary, where it still
   * knows what it read. A wrong value reaching the server is visibly wrong;
   * one silently corrected here looks correct and hides the detection bug.
   */
  videoBitDepth?: number;
  /**
   * Dolby Vision profile numbers the client decodes (5, 7, 8, ...). Absent or
   * empty means none — silence is never read as capable.
   *
   * Distinct from `hdr` because a profile number answers a question the
   * transfer name cannot: a set can present PQ perfectly and still fail on a
   * DV profile whose base layer it cannot use.
   */
  dolbyVision?: number[];
}

export interface MediaTechnicalStream {
  index: number;
  type: 'video' | 'audio' | 'subtitle' | 'other';
  codec: string;
  profile: string;
  language: string;
  width?: number;
  height?: number;
  channels?: number;
  sampleRate?: number;
  bitDepth?: number;
  bitrate?: number;
  /** Session-derived only; the immutable catalogue profile does not carry these. */
  level?: number;
  colorTransfer?: string;
  dolbyVisionProfile?: number;
  dolbyVisionCompatibility?: number;
  default: boolean;
  forced: boolean;
}

/**
 * Source facts used for opportunistic local player preparation. They may come
 * from an immutable catalogue profile or from the authoritative session
 * response; consumers must never wait for the catalogue form.
 */
export interface MediaTechnicalProfile {
  mediaId: string;
  format: string;
  durationMs: number;
  bitrate: number;
  sizeBytes?: number;
  streams: MediaTechnicalStream[];
  negotiated?: {
    mode: PlaybackMode;
    mimeType: string;
    format?: string;
  };
}

export type PlaybackMode = 'direct' | 'remux' | 'transcode';

export interface PlaybackSource {
  mediaId: string;
  url: string;
  subtitleUrl?: string;
  mimeType?: string;
  /**
   * True when `url` is a manifest to be parsed, false when it is media bytes
   * to be decoded. Stated explicitly because native players do not sniff:
   * hand ExoPlayer an `.m3u8` without declaring it and it parses the
   * playlist as a media file and reports a source error. Never infer this
   * from the extension or the mode.
   */
  isManifest: boolean;
  mode: PlaybackMode;
  durationMs?: number;
  /** Source byte length when known; enables bounded Direct Play read-ahead. */
  sizeBytes?: number;
  headers?: Record<string, string>;
}

export interface PlaybackTimeRange {
  startMs: number;
  endMs: number;
}

export interface PlaybackEvent {
  positionMs: number;
  durationMs: number;
  paused: boolean;
  ended: boolean;
  /** True while the underlying media element is resolving a new seek position. */
  seeking?: boolean;
  /** True while playback wants to run but lacks enough media to continue. */
  buffering?: boolean;
  /** Buffered media-time ranges reported by the active player. */
  bufferedRangesMs?: PlaybackTimeRange[];
  /** Contiguous buffered runway ahead of the current media position. */
  forwardBufferMs?: number;
  /** Query/credential-free origin currently serving media bytes. */
  streamOrigin?: string;
}

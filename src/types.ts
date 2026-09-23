import type { PlatformName } from './platform/Platform.js';
import type { CatalogueKind } from './api/CatalogueApi.js';

export type MediaKind = CatalogueKind;

export interface ArtworkRef {
  /**
   * The SHA-256 of the artwork bytes — **a content address, not a database
   * key.** It is identical on every node, identical for every client, and
   * identical across every re-signing of `url`.
   *
   * **This is the cache key. `url` is not.** Two clients independently built a
   * module-scoped `id`-to-last-loaded-`url` map because this was documented
   * nowhere and the churn in `url` was the visible symptom, and one of them
   * carries a React lint suppression to keep it: the correct dependency is
   * `id`, while the value the code reads is `url`. The suppression is the
   * smell, and this field is the answer to it. Key an image cache, a
   * decode cache or a memo on `id`, and treat `url` as transport.
   */
  id: string;
  mimeType: string;
  /**
   * Signed capability URL, when the server supplies one.
   *
   * Renders directly with no blob fetch and no headers — the server owns
   * fetching, decode and HTTP caching for it, and the response carries a long
   * `immutable` cache lifetime.
   *
   * **Not guaranteed stable, and not a cache key — because of the host, not
   * the signature.** The signed part is stable: since server `0.40.0` the
   * expiry is quantised to a day bucket, so `exp` and `sig` are identical
   * across every object in a response and across nodes, and hold for at least
   * 24 hours. What varies is the **origin**: this URL is absolutised against
   * whichever node answered the catalogue read, so it renames itself whenever
   * the cluster's preferred endpoint moves. Anything keyed on the whole string
   * therefore misses on a swap, including the platform HTTP cache the
   * `immutable` header was meant to reach.
   *
   * Use {@link ArtworkRef.id}, and get the candidates from
   * `MediaApi.artworkUrls`, which promotes the host that last served artwork
   * so the URL stays byte-identical across a swap.
   *
   * *An earlier version of this comment blamed per-fetch re-signing. That was
   * true of builds up to `0.39.1` and was measured false on the deployed
   * cluster — the advice was right for the wrong reason, which is the kind of
   * comment that sends the next reader to build the very workaround the
   * paragraph above warns against.*
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

/**
 * Album and artist ancestry for a track.
 *
 * Resolved once by the media API rather than by callers, because a track row
 * has to name its album and draw its cover without the caller knowing how to
 * walk the catalogue upwards. The artwork is the album's, used wherever a
 * track carries none of its own.
 */
export interface MusicHierarchyContext {
  /** `year` is the album's release year, absent when the catalogue has none. */
  album: { id: string; title: string; year?: number };
  artist?: { id: string; title: string };
  artwork?: ArtworkRef;
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

  /** Album/artist ancestry for a track. Resolved by the media API, never by callers. */
  musicContext?: MusicHierarchyContext;

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
  /**
   * Which player implementation is answering.
   *
   * Purely client-side since capabilities left the wire: it identifies the
   * executor in diagnostics, and is the honest place for a host to say what
   * it is rather than approximate. `'ios'` is not `'web'` — AVPlayer and a
   * browser differ on HLS segment containers and on ALAC — so a client that
   * cannot name itself would be stating something the chooser could later act
   * on wrongly.
   */
  platform: PlatformName;
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
  /**
   * Video codecs decodable **through HLS delivery**, when that differs from
   * `videoCodecs`.
   *
   * It does differ, and the difference is not theoretical: the HLS decoder is
   * often not the media element's decoder. Samsung Tizen 3 direct-plays HEVC
   * and reports it supported via `MediaSource.isTypeSupported`, then fails to
   * decode it under hls.js. A codec list valid for direct play can therefore
   * be invalid for remux or transcode delivery. Leave unset when the host has
   * one decoder for both; the chooser then falls back to `videoCodecs`.
   */
  hlsVideoCodecs?: VideoCodec[];
  /** Audio codecs decodable through HLS delivery, when that differs from `audioCodecs`. */
  hlsAudioCodecs?: AudioCodec[];
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
  /**
   * Reported by both the session response and the catalogue media profile
   * from schema 2, so a client can decide how to play something before it
   * asks for a session. Absent when the server could not probe the value.
   */
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
  /** Raw demuxer list. Use `container` for capability matching. */
  format: string;
  /** Resolved container family, when the server reports one. */
  container?: string;
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

/**
 * The deadlines that apply to acquiring one source from one node.
 *
 * **The division here is the contract between core and a host: core owns when
 * to stop, the host owns what happens until then.** A host that invents its own
 * stop time and a core that dictates retry behaviour are the two ways this goes
 * wrong, and both have happened — a deadline living in two layers is a deadline
 * nobody owns.
 */
export interface PlaybackSourceBudgets {
  /**
   * How long a host may spend acquiring this source before giving up on this
   * node. Core's figure, derived from what the node says about itself plus the
   * measured distance to it.
   *
   * **Not a target and not a prediction.** Most acquisitions finish far inside
   * it; it is the point past which waiting longer is worse than trying
   * elsewhere. A host must not shorten it on its own authority, because the
   * shorter of two deadlines silently wins and the other layer then looks
   * broken.
   */
  deadlineMs: number;
  /**
   * How long this node holds a request for a fragment it has not produced yet
   * before answering `500 segment_not_ready`.
   *
   * **A hold is the node working, not the node failing.** A host waiting inside
   * `deadlineMs` uses this to tell a node that is producing from one that is
   * not: a refusal after roughly this long is the expected answer at the
   * production frontier and is worth retrying, while a transfer that never
   * became a response is evidence about the node. Nothing here says how many
   * holds are worth sitting through — that is the host's, and it is the part
   * core cannot see from where it sits.
   */
  segmentHoldMs: number;
  /**
   * How long the node serving this source keeps an idle transcode engine
   * before reclaiming it — its `streaming.pipeline_idle_ms`.
   *
   * **A ceiling on how long a standby prepared here is worth holding**, not a
   * target. A standby held inside it still has a warm engine to promote onto;
   * one held past it promotes onto a live session whose pipeline the node has
   * torn down, which costs a cold start.
   *
   * Absent means the node did not say — every node older than server 0.48.0 —
   * and absence is never zero. Core then keeps the floor the server
   * guarantees rather than a figure it invented.
   */
  pipelineIdleMs?: number;
}

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
  /**
   * What the node serving this source will wait for, and therefore what a host
   * may wait for.
   *
   * **Carried on the source rather than passed as an argument** because every
   * seam that acquires media already receives one — `play()`, and
   * `preflightSource()` — so a host gets the figures without four client
   * adapters changing a signature. It travels with the thing it describes: a
   * replacement generation on another node brings that node's deadlines with
   * it, and there is no window where a host holds a new source and the old
   * node's numbers.
   *
   * Absent where core could not learn them — a node too old to report, one with
   * streaming disabled, or a status call that has not landed yet. A host that
   * finds this absent uses its own conservative default, exactly as before.
   */
  budgets?: PlaybackSourceBudgets;
  /**
   * Headers a host must attach when fetching this source, if any.
   *
   * **Nothing in this package ever sets it**, and that is worth keeping true:
   * a native player receives them through its own data source, so anything put
   * here reaches the wire without passing through this package's fetch and
   * without any client seeing it. Macha needs no custom header on the data
   * plane — media and artwork are reached by signed capability URLs that carry
   * their own authority — and two of its clients cannot attach one at all.
   *
   * The field exists for a host with its own transport requirement, not as a
   * channel for this package to use.
   */
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
  /**
   * Contiguous buffered runway ahead of the current media position.
   *
   * **The element's own buffer and nothing else.** A host that reads ahead
   * into a cache of its own reports that separately, in `readAheadBytes` —
   * folding it in here would make one number mean two things, and a consumer
   * comparing this against a media-time budget would be comparing it against
   * bytes that are not yet playable.
   *
   * **Report it as a measurement, never as a request.** While core is
   * recovering a source, a `0` from an event that also says the element is
   * playing — not `buffering`, not `ended`, not `paused` — is treated as a
   * player on its way down rather than as real exhaustion, and the last
   * figure core had reason to trust stands in its place, aged. `positionMs`
   * has had that guard for longer: a tearing-down element can report zero,
   * and one reading from a source already given up on would otherwise send
   * the viewer back to the start of the film. This field rode through the
   * same spread without one, feeding a decision that is not reversible.
   *
   * **So `buffering` must be produced independently of this number.** An
   * adapter that derives `buffering` *from* an empty buffer can be wrong
   * about both at once and core has nothing left to cross-check; one that
   * takes it from the player's own state — `readyState`, a `status` field —
   * cannot. Signalling exhaustion by zeroing this instead of setting
   * `buffering` will not work during a recovery, and is not the contract.
   *
   * **It is also read as having an age**, not as a current fact: core
   * subtracts the time elapsed since this event before spending the figure,
   * while the viewer is playing. Emitting on a cadence is therefore worth
   * more than emitting a precise number once.
   */
  forwardBufferMs?: number;
  /**
   * Source bytes a host-side read-ahead holds beyond what the element has
   * taken, where the host has such a cache at all.
   *
   * Direct Play on the web is the case this exists for: the read-ahead worker
   * holds bytes in front of the element, so `forwardBufferMs` — computed from
   * `video.buffered` — understates the real cover, on the path most likely to
   * be serving a large file. Reported as bytes rather than milliseconds
   * because bytes are what the host honestly knows; converting needs a
   * bitrate, and the session carries one.
   *
   * **Absent means the host has no read-ahead, never that it holds zero.**
   * A transformed source, or a worker that never registered, reports nothing
   * here rather than `0`, so a generation cannot claim a cache it has not got.
   *
   * **Do not include it in an event-dedupe comparison.** It changes on every
   * prefetch response, so comparing it turns a deduped event stream into a
   * firehose on the path already moving the most bytes. Let it ride on events
   * published for some other reason and recompute it each time; it is then
   * never older than the event carrying it. Named here because the omission
   * reads exactly like a bug to the next person who looks — the web client
   * had to comment it as deliberate in its own adapter for that reason.
   */
  readAheadBytes?: number;
  /** Query/credential-free origin currently serving media bytes. */
  streamOrigin?: string;
}

import type { Availability, AvailabilityMembers } from './availability.js';
export type CatalogueKind =
  | 'movie'
  | 'show'
  | 'season'
  | 'episode'
  | 'artist'
  | 'album'
  | 'track'
  /** Server 0.92.0. A book names its authors and series by reference; none of the three has a parent. */
  | 'book'
  | 'author'
  | 'series';

/** A book's place in one series (server 0.92.0). */
export interface CatalogueSeriesRef {
  series_id: string;
  /**
   * The book's position in the series: a whole number (`8`), a fraction for a
   * novella between two numbered books (`8.5`), or null when unknown. The
   * server does not sort by it; `orderBooksInSeries` does.
   */
  index: number | null;
}

export interface CatalogueArtwork {
  role: string;
  id: string;
  mime_type: string;
  /** Short-lived signed capability URL. Absent from a node that has not yet upgraded. */
  url?: string;
}

/** Exact JSON shape exposed by Macha's catalogue API. */
export interface CatalogueItem {
  id: string;
  kind: CatalogueKind;
  title: string;
  sort_title: string;
  synopsis: string;
  parent_id: string | null;
  year: number | null;
  season_number: number | null;
  episode_number: number | null;
  disc_number: number | null;
  track_number: number | null;
  aliases: string[];
  external_ids: Record<string, string>;
  media_ids: string[];
  artwork: CatalogueArtwork[];
  /** Server-resolved display artwork. Derived only; never canonical metadata. */
  effective_artwork?: CatalogueArtwork[];
  revision: number;
  updated_ns: number;
  /**
   * How much of the item the reachable cluster holds (server 0.83.0); see
   * `Availability`. An item with files takes the best of them, since any one
   * can be played; a set is judged over its members. Absent before 0.83.0.
   * Ignored by the server when a PUT or PATCH echoes it.
   */
  availability?: Availability;
  /** A set's members by availability (0.83.0); null for an item that is not a set. */
  availability_members?: AvailabilityMembers | null;
  /**
   * Server 0.92.0, on every item, empty or null for any kind but a book.
   * Absent from an older node. A book's authors in credited order, as
   * `author` item ids; empty for an unmatched manual book.
   */
  author_ids?: string[];
  /** The series a book belongs to, by reference (0.92.0). */
  series?: CatalogueSeriesRef[];
  /** BCP 47, from the file or the provider (0.92.0). */
  language?: string | null;
  publisher?: string | null;
  /** The date as the file or provider gives it, ISO in form but not always a full date (0.92.0). */
  published?: string | null;
}

export interface CatalogueStatus {
  enabled: boolean;
  ready: boolean;
  metadata_generation: number;
  root: string | null;
  items: number;
  artwork_objects: number;
  local_artwork_objects: number;
  last_sync_unix_ms: number;
  error: string | null;
  /** `converging` or `unavailable` when not ready, else null. Absent before 0.56.0. */
  error_code?: 'converging' | 'unavailable' | (string & {}) | null;
}

export interface CatalogueMediaStreamProfile {
  index: number;
  type: 'video' | 'audio' | 'subtitle' | 'other';
  codec: string;
  profile: string;
  language: string;
  width: number;
  height: number;
  channels: number;
  sample_rate: number;
  bit_depth: number;
  default: boolean;
  forced: boolean;
  bitrate: number;
  attached_picture: boolean;
  /**
   * Added in profile schema 2. Zero and empty string are the server's
   * "not probed" values, not real answers: Matroska does not carry
   * `bits_per_raw_sample` for HEVC, and the colour transfer needs an SPS the
   * bounded probe may not reach.
   */
  level?: number;
  color_transfer?: string;
  dolby_vision_profile?: number;
  dolby_vision_compatibility?: number;
}

export interface CatalogueMediaProfile {
  schema_version: number;
  media_id: string;
  /**
   * The raw demuxer list, which names every format the demuxer covers rather
   * than the one the file is: Matroska appears here as `matroska,webm`.
   * Prefer `container`; see its note.
   */
  format: string;
  /**
   * The resolved container family (`mp4`, `matroska`, `webm`, `mp3`, `flac`
   * or `ogg`), added in schema 3. This is the field to match capabilities
   * against; matching `format` accepts a Matroska file for any host that
   * merely supports WebM, which is a corrupt picture rather than an error.
   */
  container?: string;
  duration_ms: number;
  bitrate: number;
  streams: CatalogueMediaStreamProfile[];
}

/**
 * One place an artwork can be fetched from.
 *
 * `requiresAuthorization` is not decoration. A signed capability URL carries
 * its own authority and works from anywhere; a per-node catalogue URL needs the
 * client's `Authorization` header. A flat list of strings mixes the two, and a
 * caller that cannot set headers (an `<img src>`, a native image loader, a
 * platform downloader) silently 401s on every fallback while appearing to have
 * options. Such a caller should filter on this rather than hope.
 *
 * **"Cannot set headers" is literal for two of Macha's clients**, and it is a
 * constraint on the wire rather than a client preference. React Native's
 * `expo-file-system` downloader is invoked with no headers option at all, and a
 * native player is handed a URL rather than a request; neither can attach one
 * without a native module. The web client attaches nothing of its own either,
 * though its legacy Blob path reaches artwork through this package's
 * authenticated fetch, so a bearer token does travel when no signed URL was
 * supplied.
 *
 * So a URL marked `requiresAuthorization: false` must be **genuinely
 * self-authenticating**, and that is a promise the server has to keep rather
 * than a hint. "Macha requires no custom headers" and "Macha's media URLs need
 * no headers at all" are different guarantees, and the data plane depends on
 * the second one: if a capability URL ever came to need an accompanying
 * header, downloads and native playback would both break with no client-side
 * fix available.
 */
export interface ArtworkSource {
  url: string;
  /**
   * Whether a bearer token must accompany this URL.
   *
   * **A caller that cannot set headers is not thereby short of sources.** An
   * image loader (`<img src>`, a native `Image`) can use every entry marked
   * `false`, and `MachaMediaApi.artworkUrls` emits the signed capability
   * first, then that same capability re-hosted onto every known node, all
   * header-free, before any authenticated URL. So dropping every `true` entry
   * still leaves a capability plus one usable entry per node to fail over
   * between. A client that finds itself with nothing to render after that drop
   * has a ref that arrived with no `url` at all, which is a different problem
   * and a much smaller one; do not reach for a blob-to-file path before
   * checking which it is.
   */
  requiresAuthorization: boolean;
  /**
   * This viewer's measured round trip to the node behind this URL, where the
   * health cycle has one and the node is ready. What
   * `ArtworkHostPreference.chooseOnce` compares hosts on.
   */
  latencyMs?: number;
  /**
   * False when the last thing heard from the node behind this URL was a
   * failure, whether or not its retry cooldown has passed. Absent means
   * nothing is known, which a single-node API is, and is treated as usable.
   * `ArtworkHostPreference.order` never promotes a host marked false.
   */
  ready?: boolean;
}

/** A partial item edit; see `CatalogueApi.patch`. */
export type CatalogueItemPatch = {
  [K in keyof CatalogueItem as K extends 'id' | 'kind' | 'revision' | 'updated_ns' ? never : K]?: CatalogueItem[K] | null;
} & { lock?: boolean };

/** Lists narrowed by a book's references (server 0.92.0); see `CatalogueApi.list`. */
export interface CatalogueReferenceFilter {
  /** Only books crediting this author item. */
  author?: string;
  /** Only books in this series item. */
  series?: string;
}

/** Where a search looks; see `CatalogueApi.search`. */
export interface CatalogueSearchFilter extends CatalogueReferenceFilter {
  kinds?: readonly CatalogueKind[];
  parent?: string;
}

/** One byte range of a file, inclusive at both ends as HTTP's `Range` is; `end` absent reads to the end. */
export interface ContentRange {
  start: number;
  end?: number;
}

/** What `CatalogueApi.content` read (server 0.92.0). */
export interface CatalogueContent {
  mediaId: string;
  body: Blob;
  /** From the file's name on the server, `application/octet-stream` when it knows no better. */
  contentType: string;
  /** The file's whole size, where the response said (`Content-Range`, or the length of a whole read). */
  totalBytes?: number;
  /** The range served, when the server honoured a `Range`; absent for the whole file. */
  range?: { start: number; end: number };
}

/** Where a file's bytes can be fetched from; see `CatalogueApi.contentUrls`. */
export interface ContentUrlOptions {
  /** Ask for `Content-Disposition: attachment` with the file's own name (`?download=1`). */
  download?: boolean;
}

export interface CatalogueApi {
  status(signal?: AbortSignal): Promise<CatalogueStatus>;
  /** `filter` narrows to a book's references (server 0.92.0), as `parent` narrows to children. */
  list(kind?: CatalogueKind, parent?: string, signal?: AbortSignal, filter?: CatalogueReferenceFilter): Promise<CatalogueItem[]>;
  get(id: string, signal?: AbortSignal): Promise<CatalogueItem>;
  /**
   * Replace an item's descriptive fields (PUT). From server 0.67.0 its files
   * and artwork change only where the body names them, and an edit locks the
   * item against the scanner unless the body says `lock: false`.
   */
  update(item: CatalogueItem, expectedRevision?: number): Promise<CatalogueItem>;
  /**
   * Change only the fields given (server 0.67.0, proposal G); `null` clears
   * an optional one. The metadata editor's edit: nothing it leaves out,
   * files included, can be lost by omission. A `parent_id` must name an
   * existing item of the right kind (`400 parent_not_found`,
   * `400 bad_parent_kind`). Locks the item unless `lock` is false.
   */
  patch(id: string, fields: CatalogueItemPatch, expectedRevision?: number): Promise<CatalogueItem>;
  /**
   * Remove the item and its descendants. From server 0.90.25 their files go
   * straight to the unmatched list (`GET /api/v1/manage/unmatched`, result
   * `unmatched_by_operator`), to be identified by hand; before, they were
   * queued for an automatic rematch. `expectedRevision` is sent as
   * `If-Match`, refused `409 catalogue_conflict` when stale (`conflict`
   * before 0.90.25).
   */
  clearMetadata(id: string, expectedRevision?: number): Promise<void>;
  /**
   * `filter` narrows the search on the server, before `limit` (server
   * 0.67.0, proposal F): `kinds` to those kinds, `parent` to one item's
   * children, and from 0.92.0 `author` and `series` to the books naming
   * them. An older node ignores it.
   */
  search(query: string, limit?: number, signal?: AbortSignal, filter?: CatalogueSearchFilter): Promise<CatalogueItem[]>;
  putArtwork(itemId: string, role: string, mimeType: string, data: Blob): Promise<CatalogueArtwork>;
  artwork(id: string, signal?: AbortSignal): Promise<Blob>;
  /**
   * Where this artwork can be fetched from, best first.
   *
   * A list because artwork is content-addressed: any node holding it will do,
   * so a node that fails to serve one image should not cost the viewer the
   * image. A caller walks the list on a decode or transport failure.
   *
   * **Every URL here is transport for one set of bytes, and none of them
   * identifies those bytes.** The identity is the artwork id (the SHA-256 of
   * the content), which is what this is keyed by and what a caller should key
   * its own caching on. Walking to the next entry changes where the bytes come
   * from and never what they are, and a re-signed capability is the same image
   * at a different string.
   *
   * Synchronous, and the primitive `artwork()` is built on: a URL can always
   * be fetched into a `Blob`, while a `Blob` cannot be handed to an image
   * loader that wants a URL, which is what `<img src>` and a native `Image`
   * both want.
   */
  artworkUrls(id: string): ArtworkSource[];
  /** Immutable technical facts; absence is temporary while catalogue hydration catches up. */
  mediaProfile(mediaId: string, signal?: AbortSignal): Promise<CatalogueMediaProfile | undefined>;
  /**
   * A Direct Play file's keyframe byte index (server 0.68.0), for
   * `bufferedTimeRanges`. Undefined when no node has one: a container that
   * keeps no byte index (only MP4 and Matroska do), a file no node could
   * read, or a node older than the route. Immutable per media id.
   */
  keyframes(mediaId: string, signal?: AbortSignal): Promise<KeyframeIndex | undefined>;
  /**
   * A file's bytes as stored (server 0.92.0,
   * `GET /api/v1/catalogue/media/{id}/content`): any media id, though it is
   * how a book is read, since a book has no playback. One `range` at most; a
   * node that cannot read the file answers `404 not_found` and the cluster
   * asks the next. Other refusals: `400 bad_media_id` (not a `macha:` id),
   * `416 bad_range`. Nothing is staged, so a large file streams; the whole of
   * it still lands in one `Blob` here, so a reader that wants pieces asks for
   * ranges.
   */
  content(mediaId: string, options?: { range?: ContentRange; signal?: AbortSignal }): Promise<CatalogueContent>;
  /**
   * The content route on each candidate node, preferred first, for a host
   * whose reader or downloader fetches by URL. **Every entry needs the
   * bearer token** (`requiresAuthorization: true`): the server signs no
   * capability for content as it does for artwork, so a loader that cannot
   * set headers cannot use these, and reads through `content` instead.
   */
  contentUrls(mediaId: string, options?: ContentUrlOptions): ArtworkSource[];
}

/** One stream's entries in a `KeyframeIndex`. */
export interface KeyframeStream {
  /**
   * The container's stream index: the same number as `PlaybackSession.selected`
   * and the session's source streams carry (server docs/catalogue.md, d8cd5d5).
   */
  index: number;
  type: 'video' | 'audio';
  codec: string;
  /**
   * `[timeMs, byteOffset]`, sorted by byte offset; times need not rise in
   * that order. Times are decode times (DTS), so with B-frames a keyframe
   * reads early by its composition offset: they place bytes, not frames,
   * which is what a buffered bar needs. Video: its keyframes. Audio: samples, at most one per second
   * of media. Matroska often cues only its video, so audio may hold one
   * entry or none.
   */
  entries: ReadonlyArray<readonly [number, number]>;
}

/** `GET /api/v1/catalogue/media/{id}/keyframes`, server 0.68.0. */
export interface KeyframeIndex {
  mediaId: string;
  container: 'mp4' | 'matroska' | 'webm' | (string & {});
  /** `sample`: the exact position (MP4). `cluster`: the Matroska cluster holding the entry, at or just before it. */
  offsets: 'sample' | 'cluster' | (string & {});
  sizeBytes: number;
  durationMs: number;
  streams: KeyframeStream[];
}

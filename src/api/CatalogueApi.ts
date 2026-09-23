export type CatalogueKind =
  | 'movie'
  | 'show'
  | 'season'
  | 'episode'
  | 'artist'
  | 'album'
  | 'track';

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
   * Prefer `container` — see its note.
   */
  format: string;
  /**
   * The resolved container family — `mp4`, `matroska`, `webm`, `mp3`, `flac`
   * or `ogg` — added in schema 3. This is the field to match capabilities
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
 * caller that cannot set headers — an `<img src>`, a native image loader, a
 * platform downloader — silently 401s on every fallback while appearing to have
 * options. Such a caller should filter on this rather than hope.
 *
 * **"Cannot set headers" is literal for two of Macha's clients**, and it is a
 * constraint on the wire rather than a client preference. React Native's
 * `expo-file-system` downloader is invoked with no headers option at all, and a
 * native player is handed a URL rather than a request — neither can attach one
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
   * image loader — `<img src>`, a native `Image` — can use every entry marked
   * `false`, and `MachaMediaApi.artworkUrls` emits the signed capability
   * first, then that same capability re-hosted onto every known node, all
   * header-free, before any authenticated URL. So dropping every `true` entry
   * still leaves a capability plus one usable entry per node to fail over
   * between. A client that finds itself with nothing to render after that drop
   * has a ref that arrived with no `url` at all, which is a different problem
   * and a much smaller one — do not reach for a blob-to-file path before
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
   * False when the node behind this URL is in failure cooldown. Absent means
   * nothing is known, which a single-node API is, and is treated as usable.
   * `ArtworkHostPreference.order` never promotes a host marked false.
   */
  ready?: boolean;
}

export interface CatalogueApi {
  status(signal?: AbortSignal): Promise<CatalogueStatus>;
  list(kind?: CatalogueKind, parent?: string, signal?: AbortSignal): Promise<CatalogueItem[]>;
  get(id: string, signal?: AbortSignal): Promise<CatalogueItem>;
  update(item: CatalogueItem, expectedRevision?: number): Promise<CatalogueItem>;
  clearMetadata(id: string, expectedRevision?: number): Promise<void>;
  search(query: string, limit?: number, signal?: AbortSignal): Promise<CatalogueItem[]>;
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
   * identifies those bytes.** The identity is the artwork id — the SHA-256 of
   * the content — which is what this is keyed by and what a caller should key
   * its own caching on. Walking to the next entry changes where the bytes come
   * from and never what they are, and a re-signed capability is the same image
   * at a different string.
   *
   * Synchronous, and the primitive `artwork()` is built on: a URL can always
   * be fetched into a `Blob`, while a `Blob` cannot be handed to an image
   * loader that wants a URL — which is what `<img src>` and a native `Image`
   * both want.
   */
  artworkUrls(id: string): ArtworkSource[];
  /** Immutable technical facts; absence is temporary while catalogue hydration catches up. */
  mediaProfile(mediaId: string, signal?: AbortSignal): Promise<CatalogueMediaProfile | undefined>;
}

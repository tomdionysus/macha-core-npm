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
 */
export interface ArtworkSource {
  url: string;
  requiresAuthorization: boolean;
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
   * Synchronous, and the primitive `artwork()` is built on: a URL can always
   * be fetched into a `Blob`, while a `Blob` cannot be handed to an image
   * loader that wants a URL — which is what `<img src>` and a native `Image`
   * both want.
   */
  artworkUrls(id: string): ArtworkSource[];
  /** Immutable technical facts; absence is temporary while catalogue hydration catches up. */
  mediaProfile(mediaId: string, signal?: AbortSignal): Promise<CatalogueMediaProfile | undefined>;
}

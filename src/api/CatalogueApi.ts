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
}

export interface CatalogueMediaProfile {
  schema_version: number;
  media_id: string;
  format: string;
  duration_ms: number;
  bitrate: number;
  streams: CatalogueMediaStreamProfile[];
}

export interface CatalogueApi {
  status(): Promise<CatalogueStatus>;
  list(kind?: CatalogueKind, parent?: string): Promise<CatalogueItem[]>;
  get(id: string): Promise<CatalogueItem>;
  update(item: CatalogueItem, expectedRevision?: number): Promise<CatalogueItem>;
  clearMetadata(id: string, expectedRevision?: number): Promise<void>;
  search(query: string, limit?: number): Promise<CatalogueItem[]>;
  putArtwork(itemId: string, role: string, mimeType: string, data: Blob): Promise<CatalogueArtwork>;
  artwork(id: string, signal?: AbortSignal): Promise<Blob>;
  /** Immutable technical facts; absence is temporary while catalogue hydration catches up. */
  mediaProfile(mediaId: string, signal?: AbortSignal): Promise<CatalogueMediaProfile | undefined>;
}

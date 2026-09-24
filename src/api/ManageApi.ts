import type { CatalogueKind } from './CatalogueApi.js';

/**
 * What cataloguing a file came to, as a code from server 0.56.0. A node older
 * than that sends an English sentence here instead, and a newer one may send
 * a code not listed, so a client needs a fallback either way.
 */
export type CatalogueHintResult =
  | 'matched' | 'outside_catalogue_roots' | 'not_media_file' | 'no_media_candidate' | 'no_provider_match'
  | 'already_stored' | 'profile_prepared' | 'media_not_live' | 'manual_existing_item' | 'manual_metadata';

export interface UnmatchedFile {
  id: string;
  path: string;
  provider: string | null;
  media_id: string | null;
  result: CatalogueHintResult | (string & {});
  attempts: number;
  updated_unix_ms: number;
  size: number;
  mtime_ns: number;
  current: boolean;
}

export interface MediaProbeCandidate {
  kind: 'movie' | 'episode' | 'track';
  score: number;
  generator: string;
  title: string;
  year: number | null;
  series: string;
  season_number: number | null;
  episode_number: number | null;
  artist: string;
  album: string;
  disc_number: number | null;
  track_number: number | null;
  evidence: string[];
}

export interface ManageCatalogueMatch {
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
  media_ids: string[];
  revision: number;
  updated_ns: number;
}

export interface UnmatchedDetail {
  item: UnmatchedFile;
  probes: MediaProbeCandidate[];
}

export interface MatchSearchResult {
  query: string;
  matches: ManageCatalogueMatch[];
}

export type ManualMetadata =
  | { kind: 'movie'; title: string; year?: number; synopsis?: string }
  | { kind: 'episode'; series: string; series_year?: number; season_number: number; episode_number: number; title?: string; synopsis?: string }
  | { kind: 'track'; artist: string; album: string; title: string; year?: number; disc_number?: number; track_number?: number; synopsis?: string };

export interface ManualMetadataResult {
  leaf_item_id: string;
  items: ManageCatalogueMatch[];
}

export interface MachaDfsEntry {
  path: string;
  name: string;
  type: 'directory' | 'file';
  size: number;
  mtime_ns: number;
  mode: number;
  media_id: string | null;
  catalogue_item_ids: string[];
}

export interface MachaDfsDirectory {
  path: string;
  parent: string | null;
  entries: MachaDfsEntry[];
}


export interface IdentityAssociationReset {
  scope: string;
  host: string;
  port: number | null;
  stale_node_id: string | null;
  epoch: number;
  reset_at_unix_ms: number;
  reset_by_node_id: string;
  reason: string | null;
  audit_state?: string;
  metadata_persisted?: boolean;
}

export interface IdentityAssociationResetResult {
  reset: IdentityAssociationReset;
  metadata_generation?: number;
  audit_state?: string;
  metadata_persisted?: boolean;
}

export interface IdentityAssociationResetRequest {
  host: string;
  port?: number;
  node_id?: string;
  reason?: string;
}

export interface ManageApi {
  unmatched(): Promise<UnmatchedFile[]>;
  unmatchedDetail(id: string): Promise<UnmatchedDetail>;
  prospectiveMatches(id: string, query?: string): Promise<MatchSearchResult>;
  retry(id: string): Promise<void>;
  match(id: string, catalogueItemId: string): Promise<void>;
  manual(id: string, metadata: ManualMetadata): Promise<ManualMetadataResult>;
  deleteUnmatched(id: string): Promise<void>;
  browse(path: string): Promise<MachaDfsDirectory>;
  mkdir(path: string): Promise<void>;
  rename(path: string, destination: string): Promise<void>;
  deletePath(path: string): Promise<void>;
  resetIdentityAssociation(request: IdentityAssociationResetRequest): Promise<IdentityAssociationResetResult>;
  resetNodeIdentityAssociation(nodeId: string, host: string, port?: number, reason?: string): Promise<IdentityAssociationResetResult>;
}

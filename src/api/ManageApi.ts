import type { CatalogueKind } from './CatalogueApi.js';

/**
 * What cataloguing a file came to, as a code from server 0.56.0. A node older
 * than that sends an English sentence here instead, and a newer one may send
 * a code not listed, so a client needs a fallback either way.
 */
export type CatalogueHintResult =
  | 'matched' | 'outside_catalogue_roots' | 'not_media_file' | 'no_media_candidate' | 'no_provider_match'
  | 'already_stored' | 'profile_prepared' | 'media_not_live' | 'manual_existing_item' | 'manual_metadata'
  // Server 0.64.0: deferred, the file is newer than the namespace snapshot its
  // batch read; retried next batch.
  | 'path_not_yet_visible';

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

/**
 * Metadata entered by hand for an unmatched file. From server 0.67.0 an
 * episode or track may name its parents by id and join an existing
 * hierarchy, such as a show the scanner matched, instead of creating a
 * `manual:` one beside it (proposal D):
 * - an episode takes `season_id`, or `series_id` with `season_number`, or the
 *   titles `series` (and `series_year`) with `season_number`;
 * - a track takes `album_id`, or `artist_id` with `album`, or the titles
 *   `artist` and `album`.
 * A named parent that does not exist is `404 parent_not_found`, one of the
 * wrong kind `400 bad_parent_kind`. Every item written carries the metadata
 * lock against the scanner unless `lock` is false.
 */
export type ManualMetadata =
  | { kind: 'movie'; title: string; year?: number; synopsis?: string; lock?: boolean }
  | {
    kind: 'episode'; episode_number: number; title?: string; synopsis?: string; lock?: boolean;
    series?: string; series_year?: number; season_number?: number; series_id?: string; season_id?: string;
  }
  | {
    kind: 'track'; title: string; year?: number; disc_number?: number; track_number?: number; synopsis?: string; lock?: boolean;
    artist?: string; album?: string; artist_id?: string; album_id?: string;
  };

/**
 * A provider record to match an unmatched file to (server 0.67.0, proposal
 * C): `tmdb:movie:<id>`; `tmdb:tv:<id>` with season and episode numbers; or
 * `musicbrainz:release:<mbid>` with a track number (and disc, where needed).
 * The server fetches the record, builds its hierarchy (reusing items already
 * catalogued under the same ids), stages its default artwork and binds the
 * file, as a scan match does.
 */
export interface ProviderMatchRef {
  ref: string;
  season_number?: number;
  episode_number?: number;
  track_number?: number;
  disc_number?: number;
}

/** A provider search result (proposal A); `ref` is what `matchProvider` takes. */
export interface ProviderSearchResult {
  ref: string;
  provider: 'tmdb' | 'musicbrainz' | (string & {});
  kind: 'movie' | 'show' | 'album';
  title: string;
  year: number | null;
  overview?: string;
  /** An album's artist. */
  artist?: string;
  /** Present when the catalogue already holds the item a match would write. */
  catalogue_item_id?: string;
}

export type ProviderSearchKind = 'movie' | 'show' | 'album';

/** Which artwork a provider reference offers: posters and backdrops for a movie or show, a season's poster, an episode's still, an album's cover. */
export type ProviderArtworkRole = 'poster' | 'backdrop' | 'still' | 'cover';

/** One image a provider offers for a role (proposal E); `preview_url` is the provider's own small image, to show directly. */
export interface ProviderArtworkOption {
  option_id: string;
  role: ProviderArtworkRole | (string & {});
  width: number | null;
  height: number | null;
  language: string | null;
  preview_url: string;
}

/**
 * One track of a MusicBrainz release (server 0.86.0), in the release's own
 * order. `disc_number` is the medium's position and `track_number` the
 * track's integer position on it, the numbers a match by provider reference
 * takes. `title` is the track's title on this release, which may differ from
 * its recording's. `length_ms` falls back to the recording's length. Each
 * nullable field is null when MusicBrainz gives none.
 */
export interface ProviderReleaseTrack {
  disc_number: number | null;
  track_number: number | null;
  title: string;
  length_ms: number | null;
  recording_id: string | null;
}

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
  /** Match an unmatched file to a provider record (server 0.67.0); see `ProviderMatchRef`. */
  matchProvider(id: string, target: ProviderMatchRef): Promise<ManualMetadataResult>;
  /**
   * Search the metadata provider for a kind (server 0.67.0): TMDB for a movie
   * or show, MusicBrainz releases for an album. Needs the manager role.
   */
  providerSearch(query: string, kind: ProviderSearchKind, options?: { year?: number; artist?: string; limit?: number }): Promise<ProviderSearchResult[]>;
  /** The images a provider has for one role of a reference (server 0.67.0). */
  providerArtwork(ref: string, role: ProviderArtworkRole, numbers?: { season_number?: number; episode_number?: number }): Promise<ProviderArtworkOption[]>;
  /**
   * The tracks of a MusicBrainz release (server 0.86.0), from its
   * `musicbrainz:release:<mbid>` reference as `providerSearch` gives it, so
   * no client talks to MusicBrainz itself. Needs the manager role. A
   * reference that is not a MusicBrainz release rejects with `bad_ref`
   * before any request. The node paces MusicBrainz at one request a second
   * and waits its turn rather than refusing.
   */
  providerReleaseTracks(ref: string): Promise<ProviderReleaseTrack[]>;
  /**
   * Make a provider's image the item's only artwork for the role (server
   * 0.67.0). An item with no provider reference of its own (a manual item)
   * names one. Locks the item unless `lock` is false. Answers the item.
   */
  chooseArtwork(itemId: string, role: ProviderArtworkRole, optionId: string, options?: { ref?: string; season_number?: number; episode_number?: number; lock?: boolean }): Promise<ManageCatalogueMatch>;
  deleteUnmatched(id: string): Promise<void>;
  browse(path: string): Promise<MachaDfsDirectory>;
  mkdir(path: string): Promise<void>;
  rename(path: string, destination: string): Promise<void>;
  deletePath(path: string): Promise<void>;
  resetIdentityAssociation(request: IdentityAssociationResetRequest): Promise<IdentityAssociationResetResult>;
  resetNodeIdentityAssociation(nodeId: string, host: string, port?: number, reason?: string): Promise<IdentityAssociationResetResult>;
}

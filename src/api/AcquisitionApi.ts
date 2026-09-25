export type IngestJobState = 'queued' | 'scanning' | 'importing' | 'cataloguing' | 'paused' | 'blocked' | 'completed' | 'cancelled' | 'failed';
/**
 * `verify_queued` (server 0.61.0) is waiting to check the pieces already on
 * disk while another torrent is checked, which libtorrent does one at a time;
 * not terminal, and it takes pause and cancel as `queued` does. Before 0.61.0
 * it read as `verifying` with no progress, which looked like a stall.
 * `verifying` is a check in progress on this job, with `eta_seconds` from
 * 0.61.0.
 */
export type TorrentJobState = 'queued' | 'metadata' | 'downloading' | 'verify_queued' | 'verifying' | 'downloaded' | 'importing' | 'cataloguing' | 'paused' | 'blocked' | 'completed' | 'cancelled' | 'failed';

export interface StagingStatus {
  path: string;
  limit_bytes: number;
  disk_bytes: number;
  reserved_bytes: number;
  accounted_bytes: number;
}

export interface IngestStatus {
  enabled: boolean;
  staging: StagingStatus;
}

export interface TorrentStatus {
  enabled: boolean;
  build_available: boolean;
  search_enabled: boolean;
}

/**
 * Why an ingest job is blocked or failed, from server 0.56.0. Codes are what a
 * client acts on and words; `error` is the server's English for people.
 * Blocked: the source is in a state the job is waiting on. Failed: the job
 * stopped. `import_failed` is also what jobs recorded before 0.56.0 carry. A
 * newer server may send a code not listed here, so a client needs a fallback.
 */
export type IngestJobErrorCode =
  | 'source_unavailable' | 'source_not_regular' | 'source_scan_interrupted' | 'source_changed_during_scan'
  | 'source_disappeared' | 'source_changed' | 'source_unreadable' | 'source_seek_failed' | 'source_short_read'
  | 'source_is_symlink' | 'no_supported_media' | 'destination_parent_not_directory' | 'partial_not_file'
  | 'destination_conflict' | 'namespace_short_write' | 'size_mismatch' | 'metadata_unavailable'
  | 'filesystem_error' | 'import_failed';

/**
 * Why a torrent job failed or is blocked, from server 0.56.0. A torrent whose
 * ingest failed carries the ingest's own code, else `ingest_failed`; while
 * importing it mirrors its ingest's code. `staging_full` is blocked.
 * `torrent_failed` is what jobs recorded before 0.56.0 carry.
 */
export type TorrentJobErrorCode =
  | 'restore_failed' | 'ingest_missing' | 'ingest_cancelled' | 'torrent_error' | 'staging_full'
  | 'ingest_submit_failed' | 'ingest_failed' | 'torrent_failed' | IngestJobErrorCode;

export interface IngestJob {
  id: string;
  source_type: string;
  source_ref: string | null;
  display_name: string;
  source_path: string;
  remove_source_on_complete: boolean;
  state: IngestJobState;
  bytes_total: number;
  bytes_completed: number;
  files_total: number;
  files_completed: number;
  rate_bytes_per_second: number;
  eta_seconds: number | null;
  progress: number | null;
  current_file: string | null;
  current_destination: string | null;
  created_unix_ms: number;
  updated_unix_ms: number;
  /** The server's English, for people. Act on `error_code`. */
  error: string | null;
  /** Null when none. Absent on a node older than 0.56.0. */
  error_code?: IngestJobErrorCode | (string & {}) | null;
}

// Post-import cataloguing of what the torrent delivered, reported per job by
// the server since 0.28.1. A torrent whose payload landed but matched nothing
// in the catalogue is a successful download and a failed acquisition, and only
// these counts tell the two apart.
export type TorrentCatalogueState = 'waiting' | 'processing' | 'completed' | 'completed_with_issues';

export interface TorrentCatalogueSummary {
  total: number;
  pending: number;
  catalogued: number;
  no_match: number;
  failed: number;
  state: TorrentCatalogueState;
}

export interface TorrentJob {
  id: string;
  name: string;
  info_hash: string | null;
  state: TorrentJobState;
  bytes_total: number;
  bytes_completed: number;
  download_rate: number;
  upload_rate: number;
  uploaded_total: number;
  peers: number;
  seeds: number;
  /**
   * Absent on a node older than 0.28.1, which does not report it. The package
   * supports mixed-version clusters, so absent stays absent: never a default.
   */
  catalogue?: TorrentCatalogueSummary;
  eta_seconds: number | null;
  progress: number | null;
  ingest_job_id: string | null;
  // Present only in the cluster-wide job listing, which tags each job with the
  // node running it; a single-job action response carries the job alone.
  node_id?: string;
  created_unix_ms: number;
  updated_unix_ms: number;
  /** The server's English, for people. Act on `error_code`. */
  error: string | null;
  /** Null when none. Absent on a node older than 0.56.0. */
  error_code?: TorrentJobErrorCode | (string & {}) | null;
}

export interface AcquisitionSnapshot {
  ingestStatus: IngestStatus;
  torrentStatus: TorrentStatus;
  ingestJobs: IngestJob[];
  torrentJobs: TorrentJob[];
}

export interface AcquisitionApi {
  snapshot(): Promise<AcquisitionSnapshot>;
  submitPath(path: string): Promise<string>;
  submitMagnet(magnet: string): Promise<string>;
  pauseIngest(id: string): Promise<IngestJob>;
  resumeIngest(id: string): Promise<IngestJob>;
  cancelIngest(id: string): Promise<IngestJob>;
  clearIngest(id: string): Promise<void>;
  pauseTorrent(id: string): Promise<TorrentJob>;
  resumeTorrent(id: string): Promise<TorrentJob>;
  retryTorrent(id: string): Promise<TorrentJob>;
  cancelTorrent(id: string): Promise<TorrentJob>;
  clearTorrent(id: string): Promise<void>;
}

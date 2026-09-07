export type IngestJobState = 'queued' | 'scanning' | 'importing' | 'cataloguing' | 'paused' | 'blocked' | 'completed' | 'cancelled' | 'failed';
export type TorrentJobState = 'queued' | 'metadata' | 'downloading' | 'verifying' | 'downloaded' | 'importing' | 'cataloguing' | 'paused' | 'blocked' | 'completed' | 'cancelled' | 'failed';

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
  error: string | null;
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
  eta_seconds: number | null;
  progress: number | null;
  ingest_job_id: string | null;
  created_unix_ms: number;
  updated_unix_ms: number;
  error: string | null;
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

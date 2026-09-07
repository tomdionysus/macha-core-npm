import type {
  AcquisitionApi,
  AcquisitionSnapshot,
  IngestJob,
  IngestStatus,
  TorrentJob,
  TorrentStatus,
} from './AcquisitionApi.js';
import { parseErrorEnvelope } from './errorEnvelope.js';
import { DEFAULT_REQUEST_TIMEOUT_MS, fetchWithTimeout, mergeRequestHeaders, normalizeBaseUrl, readJsonBody, readResponseBody } from './httpCompat.js';
import { NO_AUTH, type AuthenticatedFetch } from './SessionManager.js';
import { isGatewayConnectionFailure, serverUnreachable } from './serverConnection.js';

interface IngestJobsEnvelope { jobs: IngestJob[]; }
interface TorrentJobsEnvelope { jobs: TorrentJob[]; }
interface IdEnvelope { id: string; }
interface ClearEnvelope { cleared: boolean; }

export class MachaAcquisitionApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'MachaAcquisitionApiError';
  }
}

export class MachaAcquisitionApi implements AcquisitionApi {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly auth: AuthenticatedFetch = NO_AUTH,
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  async snapshot(): Promise<AcquisitionSnapshot> {
    const [ingestStatus, torrentStatus, ingestJobs, torrentJobs] = await Promise.all([
      this.getJson<IngestStatus>('/api/v1/ingest/status'),
      this.getJson<TorrentStatus>('/api/v1/torrents/status'),
      this.getJson<IngestJobsEnvelope>('/api/v1/ingest/jobs'),
      this.getJson<TorrentJobsEnvelope>('/api/v1/torrents/jobs'),
    ]);
    return {
      ingestStatus,
      torrentStatus,
      ingestJobs: ingestJobs.jobs,
      torrentJobs: torrentJobs.jobs,
    };
  }

  async submitPath(path: string): Promise<string> {
    const response = await this.request<IdEnvelope>('/api/v1/ingest/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, remove_source: false }),
    });
    return response.id;
  }

  async submitMagnet(magnet: string): Promise<string> {
    const response = await this.request<IdEnvelope>('/api/v1/torrents/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ magnet }),
    });
    return response.id;
  }

  pauseIngest(id: string): Promise<IngestJob> { return this.ingestAction(id, 'pause'); }
  resumeIngest(id: string): Promise<IngestJob> { return this.ingestAction(id, 'resume'); }
  cancelIngest(id: string): Promise<IngestJob> { return this.ingestAction(id, 'cancel'); }
  async clearIngest(id: string): Promise<void> {
    await this.request<ClearEnvelope>(`/api/v1/ingest/jobs/${encodeURIComponent(id)}/clear`, { method: 'POST' });
  }
  pauseTorrent(id: string): Promise<TorrentJob> { return this.torrentAction(id, 'pause'); }
  resumeTorrent(id: string): Promise<TorrentJob> { return this.torrentAction(id, 'resume'); }
  retryTorrent(id: string): Promise<TorrentJob> { return this.torrentAction(id, 'retry'); }
  cancelTorrent(id: string): Promise<TorrentJob> { return this.torrentAction(id, 'cancel'); }
  async clearTorrent(id: string): Promise<void> {
    await this.request<ClearEnvelope>(`/api/v1/torrents/jobs/${encodeURIComponent(id)}/clear`, { method: 'POST' });
  }

  private ingestAction(id: string, action: 'pause' | 'resume' | 'cancel'): Promise<IngestJob> {
    return this.request(`/api/v1/ingest/jobs/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
  }

  private torrentAction(id: string, action: 'pause' | 'resume' | 'retry' | 'cancel'): Promise<TorrentJob> {
    return this.request(`/api/v1/torrents/jobs/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
  }

  private getJson<T>(path: string): Promise<T> {
    return this.request(path, { method: 'GET' });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetchWithTimeout(
      (url, requestInit) => this.auth.fetch(url, requestInit),
      `${this.baseUrl}${path}`,
      { ...init, headers: mergeRequestHeaders(init.headers, { Accept: 'application/json' }) },
      DEFAULT_REQUEST_TIMEOUT_MS,
    );

    if (!response.ok) await this.throwResponseError(response);
    return await readJsonBody<T>(response);
  }

  private async throwResponseError(response: Response): Promise<never> {
    const { body, wasJson } = await readResponseBody(response);
    if (isGatewayConnectionFailure(response, wasJson)) throw serverUnreachable();
    const parsed = parseErrorEnvelope(body, `${response.status} ${response.statusText}`);
    throw new MachaAcquisitionApiError(`Macha acquisition request failed: ${parsed.message}`, response.status, parsed.code);
  }
}

import type {
  AcquisitionApi,
  AcquisitionSnapshot,
  AcquisitionSource,
  IngestJob,
  IngestStatus,
  TorrentAddOptions,
  TorrentAddResult,
  TorrentJob,
  TorrentJobUpdate,
  TorrentNode,
  TorrentNodes,
  TorrentStatus,
} from './AcquisitionApi.js';
import { parseErrorEnvelope } from './errorEnvelope.js';
import { DEFAULT_REQUEST_TIMEOUT_MS, envelopeArray, fetchWithTimeout, mergeRequestHeaders, normalizeBaseUrl, readJsonBody, readResponseBody } from './httpCompat.js';
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
    /** The server's own sentence, for a host that shows it. Never core's text; `message` is for a log. */
    public readonly detail?: string,
    /**
     * Which way the request failed, where the server says, from 0.56.0. On
     * `placement_failed` (409): `node_not_member`, `node_refused`,
     * `node_unreachable`, `node_did_not_start`, `missing_uri`, `add_failed`,
     * or the target node's own code.
     */
    public readonly reason?: string,
    /**
     * On `torrent_already_added` (409, server 0.63.0): the job that already
     * holds this torrent, and its node, so a host can go straight to it. To
     * download it again, clear that job first.
     */
    public readonly heldBy?: { id: string; nodeId?: string },
  ) {
    super(message);
    this.name = 'MachaAcquisitionApiError';
  }
}

/** A torrent a job on the target node already holds; see `MachaAcquisitionApiError.heldBy`. */
export const TORRENT_ALREADY_ADDED_CODE = 'torrent_already_added';

/**
 * The acquisition refusal wherever it sits in the error chain, so a host can
 * read its `code`, `reason`, `detail` and `heldBy`. The cluster router wraps
 * every mutation failure in `MachaEndpointError`, so `instanceof` on what was
 * caught never matches: the web client's `placement_failed` wording went
 * unused that way until 2026-09-27. The same walk as `playbackFailureCode`.
 */
export function acquisitionError(error: unknown): MachaAcquisitionApiError | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (current instanceof MachaAcquisitionApiError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** The job already holding a torrent, from a `torrent_already_added` refusal; see `acquisitionError`. */
export function torrentHeldBy(error: unknown): { id: string; nodeId?: string } | undefined {
  return acquisitionError(error)?.heldBy;
}

/** The `sources` of a job list (0.64.0), or none from an older node. */
function sources(envelope: unknown): AcquisitionSource[] {
  const list = (envelope as { sources?: unknown } | undefined)?.sources;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry): AcquisitionSource[] => {
    const item = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    if (typeof item.node_id !== 'string') return [];
    return [{
      node_id: item.node_id,
      local: item.local === true,
      reachable: item.reachable === true,
      as_of_unix_ms: typeof item.as_of_unix_ms === 'number' ? item.as_of_unix_ms : null,
    }];
  });
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
    const interval = [ingestJobs, torrentJobs]
      .map((envelope) => (envelope as { refresh_interval_ms?: unknown } | undefined)?.refresh_interval_ms)
      .find((value): value is number => typeof value === 'number');
    return {
      ingestStatus,
      torrentStatus,
      ingestJobs: this.jobs<IngestJob>(ingestJobs),
      torrentJobs: this.jobs<TorrentJob>(torrentJobs),
      ingestSources: sources(ingestJobs),
      torrentSources: sources(torrentJobs),
      ...(interval !== undefined ? { refreshIntervalMs: interval } : {}),
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

  async submitMagnet(magnet: string, options: TorrentAddOptions = {}): Promise<TorrentAddResult> {
    const body: Record<string, unknown> = { magnet };
    if (options.nodeId !== undefined) body.node_id = options.nodeId;
    if (options.removeAfterMs !== undefined) body.remove_after_ms = options.removeAfterMs;
    if (options.paused === true) body.paused = true;
    const response = await this.request<{ id: string; info_hash?: unknown; node_id?: unknown; job?: TorrentJob }>('/api/v1/torrents/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result: TorrentAddResult = {
      id: response.id,
      infoHash: typeof response.info_hash === 'string' ? response.info_hash : null,
      pinnedNodeId: typeof response.node_id === 'string' ? response.node_id : null,
      ...(response.job ? { job: response.job } : {}),
    };
    // A node before 0.71.0 ignores `paused` and starts the job. Said by the
    // job it answers with (`desired` not paused), so it is paused at once:
    // a moment's start at worst, never a download nobody asked for.
    if (options.paused === true && response.job?.desired !== 'paused') {
      const paused = await this.pauseTorrent(response.id);
      return { ...result, job: paused, pausedAfterAdd: true };
    }
    return result;
  }

  updateTorrent(id: string, update: TorrentJobUpdate): Promise<TorrentJob> {
    const body: Record<string, unknown> = {};
    if (update.removeAfterMs !== undefined) body.remove_after_ms = update.removeAfterMs;
    if (update.nodeId !== undefined) body.node_id = update.nodeId;
    return this.request(`/api/v1/torrents/jobs/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async torrentNodes(): Promise<TorrentNodes> {
    const response = await this.getJson<{ nodes?: unknown; refresh_interval_ms?: unknown; default_remove_after_ms?: unknown }>('/api/v1/torrents/nodes');
    const nodes = envelopeArray<TorrentNode>(response, 'nodes', (message) => new MachaAcquisitionApiError(message, 502, 'invalid_response'));
    return {
      nodes,
      ...(typeof response.refresh_interval_ms === 'number' ? { refreshIntervalMs: response.refresh_interval_ms } : {}),
      ...(response.default_remove_after_ms === null || typeof response.default_remove_after_ms === 'number'
        ? { defaultRemoveAfterMs: response.default_remove_after_ms } : {}),
    };
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

  private jobs<T>(response: unknown): T[] {
    return envelopeArray<T>(response, 'jobs', (message) => (
      new MachaAcquisitionApiError(message, 502, 'invalid_response')
    ));
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
    try {
      return await readJsonBody<T>(response);
    } catch (error) {
      // A 200 carrying HTML — a captive portal, a proxy — used to surface as a
      // raw `SyntaxError`, which has no status, so the router read it as
      // non-retryable and the parse message reached the caller.
      if (error instanceof SyntaxError) {
        throw new MachaAcquisitionApiError('Macha acquisition answered with a body that is not JSON.', 502, 'invalid_response');
      }
      throw error;
    }
  }

  private async throwResponseError(response: Response): Promise<never> {
    const { body, wasJson } = await readResponseBody(response);
    if (isGatewayConnectionFailure(response, wasJson)) throw serverUnreachable();
    const parsed = parseErrorEnvelope(body, `${response.status} ${response.statusText}`);
    const record = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const heldBy = parsed.code === TORRENT_ALREADY_ADDED_CODE && typeof record.id === 'string'
      ? { id: record.id, ...(typeof record.node_id === 'string' ? { nodeId: record.node_id } : {}) }
      : undefined;
    throw new MachaAcquisitionApiError(`Macha acquisition request failed: ${parsed.message}`, response.status, parsed.code, parsed.detail, parsed.reason, heldBy);
  }
}

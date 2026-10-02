import { DEFAULT_REQUEST_TIMEOUT_MS, envelopeArray, fetchWithTimeout, mergeRequestHeaders, normalizeBaseUrl, queryString, readJsonBody, readResponseBody } from './httpCompat.js';
import { NO_AUTH, type AuthenticatedFetch } from './SessionManager.js';
import { parseErrorEnvelope } from './errorEnvelope.js';
import { isGatewayConnectionFailure, serverUnreachable } from './serverConnection.js';
import type {
  IdentityAssociationResetRequest,
  IdentityAssociationResetResult,
  MachaDfsDirectory,
  ManageApi,
  ManageCatalogueMatch,
  ManualMetadata,
  ManualMetadataResult,
  MatchSearchResult,
  ProviderArtworkOption,
  ProviderArtworkRole,
  ProviderMatchRef,
  ProviderSearchKind,
  ProviderSearchResult,
  UnmatchedDetail,
  UnmatchedFile,
} from './ManageApi.js';

/**
 * The budget for a management read that makes the node do real work: listing
 * unmatched files (about 200 KB), one file's detail, and its prospective
 * matches. Measured by the web client on 2026-10-01: 18 s on fi-1 at worst,
 * 2.3 s a moment later, 1 to 6 s on gbni-1. Under `DEFAULT_REQUEST_TIMEOUT_MS`
 * the slowest of those failed on every node in turn. 30 s is the worst
 * measured with two thirds again as margin; if a node is measured past it,
 * move the derivation, not the number.
 */
export const MANAGE_WORK_TIMEOUT_MS = 30_000;

export class MachaManageApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
    /** The server's own sentence, for a host that shows it. Never core's text; `message` is for a log. */
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'MachaManageApiError';
  }
}

export class MachaManageApi implements ManageApi {
  private readonly baseUrl: string;

  constructor(baseUrl: string, private readonly auth: AuthenticatedFetch = NO_AUTH) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  async unmatched(): Promise<UnmatchedFile[]> {
    const response = await this.request<{ items: UnmatchedFile[] }>('/api/v1/manage/unmatched', { method: 'GET', cache: 'no-store' }, MANAGE_WORK_TIMEOUT_MS);
    return envelopeArray<UnmatchedFile>(response, 'items', (message) => (
      new MachaManageApiError(message, 502, 'invalid_response')
    ));
  }

  unmatchedDetail(id: string): Promise<UnmatchedDetail> {
    return this.request(`/api/v1/manage/unmatched/${encodeURIComponent(id)}`, { method: 'GET' }, MANAGE_WORK_TIMEOUT_MS);
  }

  prospectiveMatches(id: string, query?: string): Promise<MatchSearchResult> {
    const qs = queryString([['q', query]]);
    return this.request(`/api/v1/manage/unmatched/${encodeURIComponent(id)}/matches${qs ? `?${qs}` : ''}`, { method: 'GET' }, MANAGE_WORK_TIMEOUT_MS);
  }

  async retry(id: string): Promise<void> {
    await this.request(`/api/v1/manage/unmatched/${encodeURIComponent(id)}/retry`, { method: 'POST' });
  }

  async match(id: string, catalogueItemId: string): Promise<void> {
    await this.request(`/api/v1/manage/unmatched/${encodeURIComponent(id)}/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ catalogue_item_id: catalogueItemId }),
    });
  }

  manual(id: string, metadata: ManualMetadata): Promise<ManualMetadataResult> {
    return this.request(`/api/v1/manage/unmatched/${encodeURIComponent(id)}/manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata),
    });
  }

  matchProvider(id: string, target: ProviderMatchRef): Promise<ManualMetadataResult> {
    return this.request(`/api/v1/manage/unmatched/${encodeURIComponent(id)}/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(target),
    });
  }

  async providerSearch(query: string, kind: ProviderSearchKind, options: { year?: number; artist?: string; limit?: number } = {}): Promise<ProviderSearchResult[]> {
    const params = queryString([
      ['q', query], ['kind', kind],
      ['year', options.year !== undefined ? String(options.year) : undefined],
      ['artist', options.artist],
      ['limit', options.limit !== undefined ? String(options.limit) : undefined],
    ]);
    const response = await this.request<{ results?: ProviderSearchResult[] }>(`/api/v1/manage/providers/search?${params}`, { method: 'GET' });
    return Array.isArray(response?.results) ? response.results : [];
  }

  async providerArtwork(ref: string, role: ProviderArtworkRole, numbers: { season_number?: number; episode_number?: number } = {}): Promise<ProviderArtworkOption[]> {
    const params = queryString([
      ['ref', ref], ['role', role],
      ['season_number', numbers.season_number !== undefined ? String(numbers.season_number) : undefined],
      ['episode_number', numbers.episode_number !== undefined ? String(numbers.episode_number) : undefined],
    ]);
    const response = await this.request<{ options?: ProviderArtworkOption[] }>(`/api/v1/manage/providers/artwork?${params}`, { method: 'GET' });
    return Array.isArray(response?.options) ? response.options : [];
  }

  async chooseArtwork(itemId: string, role: ProviderArtworkRole, optionId: string, options: { ref?: string; season_number?: number; episode_number?: number; lock?: boolean } = {}): Promise<ManageCatalogueMatch> {
    const response = await this.request<{ item: ManageCatalogueMatch }>('/api/v1/manage/providers/artwork/choose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id: itemId, role, option_id: optionId, ...options }),
    });
    return response.item;
  }

  async deleteUnmatched(id: string): Promise<void> {
    await this.request(`/api/v1/manage/unmatched/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  browse(path: string): Promise<MachaDfsDirectory> {
    const qs = queryString([['path', path]]);
    return this.request(`/api/v1/manage/filesystem?${qs}`, { method: 'GET', cache: 'no-store' });
  }

  async mkdir(path: string): Promise<void> {
    await this.request('/api/v1/manage/filesystem/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
  }

  async rename(path: string, destination: string): Promise<void> {
    await this.request('/api/v1/manage/filesystem/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, destination, no_replace: true }),
    });
  }

  async deletePath(path: string): Promise<void> {
    const qs = queryString([['path', path]]);
    await this.request(`/api/v1/manage/filesystem?${qs}`, { method: 'DELETE' });
  }

  resetIdentityAssociation(request: IdentityAssociationResetRequest): Promise<IdentityAssociationResetResult> {
    return this.request('/api/v1/manage/identity-associations/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
  }

  resetNodeIdentityAssociation(nodeId: string, host: string, port?: number, reason?: string): Promise<IdentityAssociationResetResult> {
    return this.request(`/api/v1/manage/nodes/${encodeURIComponent(nodeId)}/identity-association/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host, port, reason }),
    });
  }

  private async request<T>(path: string, init: RequestInit, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
    const response = await fetchWithTimeout(
      (url, requestInit) => this.auth.fetch(url, requestInit),
      `${this.baseUrl}${path}`,
      { ...init, headers: mergeRequestHeaders(init.headers, { Accept: 'application/json' }) },
      timeoutMs,
    );
    if (!response.ok) {
      const { body, wasJson } = await readResponseBody(response);
      if (isGatewayConnectionFailure(response, wasJson)) throw serverUnreachable();
      const parsed = parseErrorEnvelope(body, `${response.status} ${response.statusText}`);
      throw new MachaManageApiError(`Macha management request failed: ${parsed.message}`, response.status, parsed.code, parsed.detail);
    }
    if (response.status === 204) return undefined as T;
    try {
      return await readJsonBody<T>(response);
    } catch (error) {
      // A 200 that is not JSON — a captive portal or a proxy answering with
      // HTML — used to surface as a raw `SyntaxError`, which has no status, so
      // the router read it as non-retryable and the parse message was what a
      // caller got.
      if (error instanceof SyntaxError) {
        throw new MachaManageApiError('Macha management answered with a body that is not JSON.', 502, 'invalid_response');
      }
      throw error;
    }
  }
}

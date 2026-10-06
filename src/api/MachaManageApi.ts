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
  ProviderReleaseTrack,
  FileContentDeletion,
  TitleFileRemoval,
  TitleFileUnmatch,
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
 *
 * **Every management write runs under it too.** A node runs management
 * writes one at a time, each its own metadata commit of 2 to 3 s, so the Nth
 * of a burst answers after about N times that. On 2026-10-05 a burst of 13
 * unmatched deletes all succeeded, answering at 3.7 s up to 24.1 s, and under
 * the 8 s default 11 were reported as not deleted. A burst longer than this
 * budget still times out: send writes one after another.
 */
export const MANAGE_WORK_TIMEOUT_MS = 30_000;

const MUSICBRAINZ_RELEASE_REF = 'musicbrainz:release:';

/** A `Retry-After` header in seconds, as milliseconds; the server sends `retry_after_ms` beside it. */
function retryAfterHeaderMs(response: Response): number | undefined {
  const header = response.headers.get('Retry-After');
  if (header === null || header.trim() === '') return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

function removedIds(response: { removed_item_ids?: unknown } | undefined): string[] {
  const ids = response?.removed_item_ids;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

function titleWent(removedItemIds: readonly string[], itemId: string | undefined): boolean {
  return itemId === undefined ? removedItemIds.length > 0 : removedItemIds.includes(itemId);
}

/** `/a b/c.mkv` as the files route takes it: each segment percent-encoded, the slashes kept. */
function encodedFilePath(path: string): string {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  return `/${segments.map(encodeURIComponent).join('/')}`;
}

export class MachaManageApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
    /** The server's own sentence, for a host that shows it. Never core's text; `message` is for a log. */
    public readonly detail?: string,
    /** How long until asking again may succeed, where the server says; see `ParsedErrorEnvelope.retryAfterMs`. */
    public readonly retryAfterMs?: number,
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

  async providerReleaseTracks(ref: string): Promise<ProviderReleaseTrack[]> {
    const mbid = ref.startsWith(MUSICBRAINZ_RELEASE_REF) ? ref.slice(MUSICBRAINZ_RELEASE_REF.length) : '';
    if (!mbid) throw new MachaManageApiError(`Not a MusicBrainz release reference: ${ref}.`, 400, 'bad_ref');
    // Manage work: the node may wait its turn at the MusicBrainz gate.
    const response = await this.request<{ tracks?: ProviderReleaseTrack[] }>(
      `/api/v1/manage/providers/musicbrainz/releases/${encodeURIComponent(mbid)}/tracks`,
      { method: 'GET' },
      MANAGE_WORK_TIMEOUT_MS,
    );
    return Array.isArray(response?.tracks) ? response.tracks : [];
  }

  async chooseArtwork(itemId: string, role: ProviderArtworkRole, optionId: string, options: { ref?: string; season_number?: number; episode_number?: number; lock?: boolean } = {}): Promise<ManageCatalogueMatch> {
    const response = await this.request<{ item: ManageCatalogueMatch }>('/api/v1/manage/providers/artwork/choose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id: itemId, role, option_id: optionId, ...options }),
    });
    return response.item;
  }

  async unmatchFile(itemId: string, mediaId: string, expectedRevision?: number): Promise<TitleFileUnmatch> {
    const response = await this.request<{ item?: ManageCatalogueMatch; removed_item_ids?: string[] }>(
      `/api/v1/catalogue/items/${encodeURIComponent(itemId)}/media/${encodeURIComponent(mediaId)}`,
      { method: 'DELETE', ...(expectedRevision !== undefined ? { headers: { 'If-Match': `"rev-${expectedRevision}"` } } : {}) },
    );
    const removedItemIds = removedIds(response);
    return {
      titleRemoved: response?.item === undefined || removedItemIds.includes(itemId),
      removedItemIds,
      ...(response?.item ? { item: response.item } : {}),
    };
  }

  async deleteFilePath(path: string, itemId?: string): Promise<TitleFileRemoval> {
    const response = await this.request<{ removed_item_ids?: string[] }>(`/api/v1/files${encodedFilePath(path)}`, { method: 'DELETE' });
    const removedItemIds = removedIds(response);
    return { titleRemoved: titleWent(removedItemIds, itemId), removedItemIds };
  }

  async deleteFileContent(mediaId: string, itemId?: string): Promise<FileContentDeletion> {
    const response = await this.request<{ paths?: string[]; removed_item_ids?: string[] }>(
      `/api/v1/files?${queryString([['hash', mediaId]])}`,
      { method: 'DELETE' },
    );
    const removedItemIds = removedIds(response);
    return {
      titleRemoved: titleWent(removedItemIds, itemId),
      removedItemIds,
      paths: Array.isArray(response?.paths) ? response.paths.filter((path): path is string => typeof path === 'string') : [],
    };
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

  private async request<T>(
    path: string,
    init: RequestInit,
    timeoutMs = (init.method ?? 'GET') === 'GET' ? DEFAULT_REQUEST_TIMEOUT_MS : MANAGE_WORK_TIMEOUT_MS,
  ): Promise<T> {
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
      throw new MachaManageApiError(`Macha management request failed: ${parsed.message}`, response.status, parsed.code, parsed.detail, parsed.retryAfterMs ?? retryAfterHeaderMs(response));
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

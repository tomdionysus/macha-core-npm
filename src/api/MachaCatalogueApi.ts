import { DEFAULT_REQUEST_TIMEOUT_MS, fetchWithTimeout, mergeRequestHeaders, normalizeBaseUrl, queryString, readJsonBody, readResponseBody } from './httpCompat.js';
import { NO_AUTH, type AuthenticatedFetch } from './SessionManager.js';
import { parseErrorEnvelope } from './errorEnvelope.js';
import { isGatewayConnectionFailure, serverUnreachable } from './serverConnection.js';
import type {
  CatalogueApi,
  CatalogueArtwork,
  CatalogueItem,
  CatalogueKind,
  CatalogueMediaProfile,
  CatalogueStatus,
} from './CatalogueApi.js';
import { machaHost } from '../runtime/host.js';

interface ItemEnvelope {
  items: CatalogueItem[];
}

function mediaProfilePending(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'object') return false;
  const candidate = value as { status?: unknown; error?: unknown; code?: unknown; available?: unknown };
  const marker = [candidate.status, candidate.error, candidate.code]
    .find((entry): entry is string => typeof entry === 'string')
    ?.trim().toLowerCase().replace(/[ -]+/g, '_');
  return marker === 'profile_not_available'
    || marker === 'profile_pending'
    || marker === 'not_available_yet'
    || marker === 'profile_not_available_yet'
    || candidate.available === false;
}

export class MachaApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
  ) {
    super(message);
  }
}

export class MachaCatalogueApi implements CatalogueApi {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly auth: AuthenticatedFetch = NO_AUTH,
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  status(): Promise<CatalogueStatus> {
    return this.getJson('/api/v1/catalogue/status');
  }

  async list(kind?: CatalogueKind, parent?: string): Promise<CatalogueItem[]> {
    const query = queryString([['type', kind], ['parent', parent]]);
    const suffix = query ? `?${query}` : '';
    const response = await this.getJson<ItemEnvelope>(`/api/v1/catalogue/items${suffix}`);
    return response.items.map((item) => this.withAbsoluteArtworkUrls(item));
  }

  async get(id: string): Promise<CatalogueItem> {
    return this.withAbsoluteArtworkUrls(await this.getJson(`/api/v1/catalogue/items/${encodeURIComponent(id)}`));
  }

  async mediaProfile(mediaId: string, signal?: AbortSignal): Promise<CatalogueMediaProfile | undefined> {
    // Mutable path identities are deliberately ineligible for profile caching.
    if (!mediaId.startsWith('macha:')) return undefined;
    try {
      const profile = await this.request<CatalogueMediaProfile | undefined | Record<string, unknown>>(
        `/api/v1/catalogue/media/${encodeURIComponent(mediaId)}/profile`,
        { method: 'GET', signal },
      );
      if (profile === undefined || mediaProfilePending(profile)) return undefined;
      if (profile.schema_version !== 1 || profile.media_id !== mediaId || !Array.isArray(profile.streams)) {
        throw new MachaApiError('Macha catalogue returned an invalid immutable media profile.', 502, 'invalid_media_profile');
      }
      return profile as unknown as CatalogueMediaProfile;
    } catch (error) {
      // `profile_not_available` is the new contract. A generic 404 is also a
      // temporary absence while older nodes without this route remain in a
      // mixed-version endpoint set.
      if (error instanceof MachaApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  async update(item: CatalogueItem, expectedRevision = item.revision): Promise<CatalogueItem> {
    return this.withAbsoluteArtworkUrls(await this.request(`/api/v1/catalogue/items/${encodeURIComponent(item.id)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': `"rev-${expectedRevision}"`,
      },
      body: JSON.stringify(item),
    }));
  }

  clearMetadata(id: string, expectedRevision?: number): Promise<void> {
    return this.request(`/api/v1/catalogue/items/${encodeURIComponent(id)}/metadata`, {
      method: 'DELETE',
      headers: expectedRevision === undefined ? undefined : {
        'If-Match': `"rev-${expectedRevision}"`,
      },
    });
  }

  async search(query: string, limit = 50): Promise<CatalogueItem[]> {
    const params = queryString([['q', query], ['limit', String(limit)]]);
    const response = await this.getJson<ItemEnvelope>(`/api/v1/catalogue/search?${params}`);
    return response.items.map((item) => this.withAbsoluteArtworkUrls(item));
  }

  async putArtwork(itemId: string, role: string, mimeType: string, data: Blob): Promise<CatalogueArtwork> {
    const params = queryString([['role', role], ['mime', mimeType]]);
    return this.withAbsoluteArtworkUrl(await this.request(`/api/v1/catalogue/items/${encodeURIComponent(itemId)}/artwork?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': mimeType },
      body: data,
    }));
  }

  async artwork(id: string, signal?: AbortSignal): Promise<Blob> {
    const init: RequestInit = signal ? { method: 'GET', signal } : { method: 'GET' };
    const response = await this.fetch(`/api/v1/catalogue/artwork/${encodeURIComponent(id)}`, 'image/*', init);
    if (!response.ok) await this.throwResponseError(response);
    const blob = await response.blob();
    const contentType = blob.type || response.headers.get('Content-Type') || '';
    if (blob.size === 0) throw new Error(`Macha catalogue returned empty artwork for ${id}.`);
    if (contentType && !contentType.toLowerCase().startsWith('image/')) {
      throw new Error(`Macha catalogue returned non-image artwork for ${id} (${contentType}).`);
    }
    return blob;
  }

  /**
   * A signed artwork capability URL arrives as a bare path, meaningful only
   * relative to the node that issued it. Absolutizing it here — the same
   * place MachaPlaybackResolver absolutizes stream/subtitle URLs — means
   * every higher layer (ClusterCatalogueApi across nodes, MachaMediaApi,
   * `<img src>`) can treat it as already correct, never rediscovering which
   * node it came from. Left relative, the browser would resolve it against
   * the client application's own origin instead.
   */
  private resolveArtworkUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    if (this.baseUrl) return `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    // No configured node base: the same-origin deployment, where the client
    // is served by the node that issued this path. A host with no origin at
    // all (React Native) never reaches here, because it always talks to an
    // explicit endpoint — and if it somehow did, a relative artwork URL would
    // fail later, somewhere with no evidence of why.
    const origin = machaHost().origin;
    if (origin) return new URL(path, origin).toString();
    throw new Error(`Cannot absolutize the artwork URL "${path}": no node base URL and no host origin.`);
  }

  private withAbsoluteArtworkUrl(artwork: CatalogueArtwork): CatalogueArtwork {
    return artwork.url ? { ...artwork, url: this.resolveArtworkUrl(artwork.url) } : artwork;
  }

  private withAbsoluteArtworkUrls(item: CatalogueItem): CatalogueItem {
    return {
      ...item,
      artwork: item.artwork.map((entry) => this.withAbsoluteArtworkUrl(entry)),
      effective_artwork: item.effective_artwork?.map((entry) => this.withAbsoluteArtworkUrl(entry)),
    };
  }

  private getJson<T>(path: string): Promise<T> {
    return this.request(path, { method: 'GET' });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.fetch(path, 'application/json', init);
    if (!response.ok) await this.throwResponseError(response);
    if (response.status === 204) return undefined as T;
    try {
      return await readJsonBody<T>(response);
    } catch (error) {
      // `202 Accepted` with Retry-After may intentionally have no body while
      // the immutable profile is being generated.
      if (response.status === 202) return undefined as T;
      throw error;
    }
  }

  private fetch(path: string, accept: string, init: RequestInit = { method: 'GET' }): Promise<Response> {
    const headers = mergeRequestHeaders(init.headers, { Accept: accept });
    return fetchWithTimeout(
      (url, requestInit) => this.auth.fetch(url, requestInit),
      `${this.baseUrl}${path}`,
      { ...init, headers },
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
  }

  private async throwResponseError(response: Response): Promise<never> {
    const { body, wasJson } = await readResponseBody(response);
    if (isGatewayConnectionFailure(response, wasJson)) throw serverUnreachable();
    const parsed = parseErrorEnvelope(body, `${response.status} ${response.statusText}`);
    throw new MachaApiError(`Macha catalogue request failed: ${parsed.message}`, response.status, parsed.code);
  }
}

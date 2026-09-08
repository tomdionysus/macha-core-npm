import type {
  ArtworkSource,
  CatalogueApi,
  CatalogueArtwork,
  CatalogueItem,
  CatalogueKind,
  CatalogueMediaProfile,
  CatalogueStatus,
} from './CatalogueApi.js';
import { MachaApiError, MachaCatalogueApi } from './MachaCatalogueApi.js';
import type { EndpointRegistry, MachaEndpoint } from '../cluster/EndpointRegistry.js';
import { ClusterEndpointRouter } from '../cluster/endpointRouting.js';
import { NO_AUTH, type AuthenticatedFetch } from './SessionManager.js';

type EndpointOperation<T> = (api: MachaCatalogueApi, endpoint: MachaEndpoint) => Promise<T>;

interface MediaProfileRequest {
  controller: AbortController;
  consumers: Set<symbol>;
  promise: Promise<CatalogueMediaProfile | undefined>;
  abandonedOrder?: number;
}

/** Preserve a small corpus-building tail without allowing advisory work to occupy every browser connection. */
export const MAX_ABANDONED_MEDIA_PROFILE_REQUESTS = 2;
export const ARTWORK_ENDPOINT_TIMEOUT_MS = 8_000;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

/** Safe catalogue reads fail over; mutations deliberately execute once. */
export class ClusterCatalogueApi implements CatalogueApi {
  private readonly apis = new Map<string, MachaCatalogueApi>();
  private readonly mediaProfiles = new Map<string, CatalogueMediaProfile>();
  private readonly mediaProfileRequests = new Map<string, MediaProfileRequest>();
  private mediaProfileAbandonmentSequence = 0;

  constructor(
    routerOrRegistry: ClusterEndpointRouter | EndpointRegistry,
    private readonly auth: AuthenticatedFetch = NO_AUTH,
  ) {
    this.router = routerOrRegistry instanceof ClusterEndpointRouter
      ? routerOrRegistry
      : new ClusterEndpointRouter(routerOrRegistry);
  }

  private readonly router: ClusterEndpointRouter;

  status(signal?: AbortSignal): Promise<CatalogueStatus> {
    return this.read(async (api) => {
      const status = await api.status(signal);
      if (!status.ready) {
        throw new MachaApiError(
          status.error || 'Macha catalogue is not ready.',
          503,
          'catalogue_unavailable',
        );
      }
      return status;
    }, signal);
  }

  list(kind?: CatalogueKind, parent?: string, signal?: AbortSignal): Promise<CatalogueItem[]> {
    return this.read((api) => api.list(kind, parent, signal), signal);
  }

  get(id: string, signal?: AbortSignal): Promise<CatalogueItem> {
    return this.read((api) => api.get(id, signal), signal);
  }

  mediaProfile(mediaId: string, signal?: AbortSignal): Promise<CatalogueMediaProfile | undefined> {
    if (!mediaId.startsWith('macha:')) return Promise.resolve(undefined);
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const cached = this.mediaProfiles.get(mediaId);
    if (cached) return Promise.resolve(cached);
    let request = this.mediaProfileRequests.get(mediaId);
    if (!request) request = this.startMediaProfileRequest(mediaId);
    const consumer = Symbol(mediaId);
    request.consumers.add(consumer);
    request.abandonedOrder = undefined;
    return this.consumeMediaProfile(mediaId, request, consumer, signal);
  }

  search(query: string, limit?: number, signal?: AbortSignal): Promise<CatalogueItem[]> {
    return this.read((api) => api.search(query, limit, signal), signal);
  }

  artwork(id: string, signal?: AbortSignal): Promise<Blob> {
    return this.readArtwork(id, signal);
  }

  /**
   * One URL per candidate endpoint, preferred node first.
   *
   * Ordered by the same ranking real requests use, so the first entry is the
   * node this client would talk to anyway; the rest are fallbacks a caller
   * walks on a decode or transport failure. Artwork is content-addressed, so
   * any node holding it serves the same bytes.
   */
  artworkUrls(id: string): ArtworkSource[] {
    return this.router.registry.candidates().flatMap(({ endpoint }) => this.api(endpoint).artworkUrls(id));
  }

  update(item: CatalogueItem, expectedRevision?: number): Promise<CatalogueItem> {
    return this.write((api) => api.update(item, expectedRevision));
  }

  clearMetadata(id: string, expectedRevision?: number): Promise<void> {
    return this.write((api) => api.clearMetadata(id, expectedRevision));
  }

  putArtwork(itemId: string, role: string, mimeType: string, data: Blob): Promise<CatalogueArtwork> {
    return this.write((api) => api.putArtwork(itemId, role, mimeType, data));
  }

  private async read<T>(operation: EndpointOperation<T>, signal?: AbortSignal): Promise<T> {
    // The signal reaches the router as well as the operation: it must cancel
    // the walk over remaining candidates, not merely the attempt in flight.
    return this.router.request((endpoint) => operation(this.api(endpoint), endpoint), signal);
  }

  private async readArtwork(id: string, signal?: AbortSignal): Promise<Blob> {
    // Artwork placement is deliberately sparse: a reachable node may not hold
    // this content-addressed object yet. Route through the shared authority
    // rather than reimplementing candidate/health bookkeeping here, so a 404
    // is treated the same "temporary absence" way find() already treats one.
    let lastMissing: MachaApiError | undefined;
    const artwork = await this.router.find(async (endpoint) => {
      try {
        return await this.artworkAttempt(endpoint, id, signal);
      } catch (error) {
        if (error instanceof MachaApiError && error.status === 404) {
          lastMissing = error;
          return undefined;
        }
        throw error;
      }
    }, signal, { advisory: true });
    if (artwork) return artwork;
    throw lastMissing ?? new MachaApiError(`Artwork ${id} is unavailable on every configured node.`, 404, 'artwork_not_found');
  }

  private artworkAttempt(endpoint: MachaEndpoint, id: string, consumerSignal?: AbortSignal): Promise<Blob> {
    const controller = new AbortController();
    return new Promise<Blob>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        consumerSignal?.removeEventListener('abort', consumerAborted);
        callback();
      };
      const consumerAborted = () => {
        const reason = consumerSignal ? abortReason(consumerSignal) : new DOMException('Aborted', 'AbortError');
        controller.abort(reason);
        finish(() => reject(reason));
      };
      const timeout = setTimeout(() => {
        const error = new MachaApiError(
          `Artwork request to ${endpoint.baseUrl} exceeded ${ARTWORK_ENDPOINT_TIMEOUT_MS} ms.`,
          504,
          'artwork_timeout',
        );
        controller.abort(error);
        finish(() => reject(error));
      }, ARTWORK_ENDPOINT_TIMEOUT_MS);
      consumerSignal?.addEventListener('abort', consumerAborted, { once: true });
      if (consumerSignal?.aborted) {
        consumerAborted();
        return;
      }
      void this.api(endpoint).artwork(id, controller.signal).then(
        (blob) => finish(() => resolve(blob)),
        (error) => finish(() => reject(error)),
      );
    });
  }

  private async readMediaProfile(mediaId: string, signal: AbortSignal): Promise<CatalogueMediaProfile | undefined> {
    // A temporary negative proves reachability but does not steal API
    // authority; another node may already have the immutable profile.
    return this.router.find((endpoint) => this.api(endpoint).mediaProfile(mediaId, signal), signal);
  }

  private startMediaProfileRequest(mediaId: string): MediaProfileRequest {
    const controller = new AbortController();
    const request = {} as MediaProfileRequest;
    request.controller = controller;
    request.consumers = new Set();
    request.promise = this.readMediaProfile(mediaId, controller.signal).then((profile) => {
      if (profile) this.mediaProfiles.set(mediaId, profile);
      if (this.mediaProfileRequests.get(mediaId) === request) this.mediaProfileRequests.delete(mediaId);
      return profile;
    }, (error) => {
      if (this.mediaProfileRequests.get(mediaId) === request) this.mediaProfileRequests.delete(mediaId);
      throw error;
    });
    // An intentionally abandoned request may later be evicted and aborted with
    // no remaining consumer promise. Keep that expected rejection observed.
    void request.promise.catch(() => undefined);
    this.mediaProfileRequests.set(mediaId, request);
    return request;
  }

  private consumeMediaProfile(
    mediaId: string,
    request: MediaProfileRequest,
    consumer: symbol,
    signal?: AbortSignal,
  ): Promise<CatalogueMediaProfile | undefined> {
    return new Promise((resolve, reject) => {
      let active = true;
      const finish = () => {
        if (!active) return false;
        active = false;
        signal?.removeEventListener('abort', onAbort);
        request.consumers.delete(consumer);
        return true;
      };
      const onAbort = () => {
        if (!finish()) return;
        this.abandonMediaProfile(mediaId, request);
        reject(signal ? abortReason(signal) : new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      request.promise.then((profile) => {
        if (!finish()) return;
        resolve(profile);
      }, (error) => {
        if (!finish()) return;
        reject(error);
      });
    });
  }

  private abandonMediaProfile(mediaId: string, request: MediaProfileRequest): void {
    if (request.consumers.size > 0 || this.mediaProfileRequests.get(mediaId) !== request) return;
    request.abandonedOrder = ++this.mediaProfileAbandonmentSequence;
    const abandoned = [...this.mediaProfileRequests.entries()]
      .filter((entry): entry is [string, MediaProfileRequest] => entry[1].consumers.size === 0 && entry[1].abandonedOrder !== undefined)
      .sort((left, right) => left[1].abandonedOrder! - right[1].abandonedOrder!);
    for (const [abandonedMediaId, abandonedRequest] of abandoned.slice(0, -MAX_ABANDONED_MEDIA_PROFILE_REQUESTS)) {
      if (this.mediaProfileRequests.get(abandonedMediaId) === abandonedRequest) {
        this.mediaProfileRequests.delete(abandonedMediaId);
        abandonedRequest.controller.abort(new DOMException('Profile preparation tail exceeded', 'AbortError'));
      }
    }
  }

  private async write<T>(operation: EndpointOperation<T>): Promise<T> {
    return this.router.mutation((endpoint) => operation(this.api(endpoint), endpoint));
  }

  private api(endpoint: MachaEndpoint): MachaCatalogueApi {
    let api = this.apis.get(endpoint.id);
    if (!api) {
      api = new MachaCatalogueApi(endpoint.baseUrl, this.auth);
      this.apis.set(endpoint.id, api);
    }
    return api;
  }
}

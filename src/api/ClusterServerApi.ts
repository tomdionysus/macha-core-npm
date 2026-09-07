import type { EndpointRegistry, MachaEndpoint } from '../cluster/EndpointRegistry.js';
import { MachaServerApi, type ServerApi, type ServerStatus } from './MachaServerApi.js';
import { ClusterEndpointRouter } from '../cluster/endpointRouting.js';
import { NO_AUTH, type AuthenticatedFetch } from './SessionManager.js';

/** Read-only playback capability status across all suitable API endpoints. */
export class ClusterServerApi implements ServerApi {
  private readonly apis = new Map<string, MachaServerApi>();
  private readonly router: ClusterEndpointRouter;

  constructor(routerOrRegistry: ClusterEndpointRouter | EndpointRegistry, private readonly auth: AuthenticatedFetch = NO_AUTH) {
    this.router = routerOrRegistry instanceof ClusterEndpointRouter
      ? routerOrRegistry
      : new ClusterEndpointRouter(routerOrRegistry);
  }

  async status(): Promise<ServerStatus> {
    return this.router.request(async (endpoint) => {
      const status = await this.api(endpoint).status();
      if (!status.playbackAvailable && [429, 502, 503, 504].includes(status.httpStatus)) {
        throw Object.assign(new Error(`Macha playback API returned ${status.httpStatus}`), { status: status.httpStatus });
      }
      return status;
    });
  }

  private api(endpoint: MachaEndpoint): MachaServerApi {
    let api = this.apis.get(endpoint.id);
    if (!api) {
      api = new MachaServerApi(endpoint.baseUrl, this.auth);
      this.apis.set(endpoint.id, api);
    }
    return api;
  }
}

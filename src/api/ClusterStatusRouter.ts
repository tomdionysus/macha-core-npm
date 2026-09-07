import type { EndpointRegistry, MachaEndpoint } from '../cluster/EndpointRegistry.js';
import { ClusterEndpointRouter } from '../cluster/endpointRouting.js';
import {
  MachaClusterStatusApi,
  type ClusterNodeStatus,
  type ClusterStatusApi,
  type ClusterStatusSnapshot,
  type ConnectivityCheck,
} from './ClusterStatusApi.js';
import { NO_AUTH, type AuthenticatedFetch } from './SessionManager.js';

/** Safe status reads fail over; diagnostic POST actions execute exactly once. */
export class ClusterStatusRouter implements ClusterStatusApi {
  private readonly apis = new Map<string, MachaClusterStatusApi>();

  private readonly router: ClusterEndpointRouter;
  constructor(routerOrRegistry: ClusterEndpointRouter | EndpointRegistry, private readonly auth: AuthenticatedFetch = NO_AUTH) {
    this.router = routerOrRegistry instanceof ClusterEndpointRouter
      ? routerOrRegistry
      : new ClusterEndpointRouter(routerOrRegistry);
  }

  status(): Promise<ClusterStatusSnapshot> {
    return this.read((api) => api.status());
  }

  node(id: string): Promise<ClusterNodeStatus> {
    return this.read((api) => api.node(id));
  }

  checkConnectivity(nodeId?: string): Promise<ConnectivityCheck> {
    return this.write((api) => api.checkConnectivity(nodeId));
  }

  private async read<T>(operation: (api: MachaClusterStatusApi) => Promise<T>): Promise<T> {
    return this.router.request((endpoint) => operation(this.api(endpoint)));
  }

  private async write<T>(operation: (api: MachaClusterStatusApi) => Promise<T>): Promise<T> {
    return this.router.mutation((endpoint) => operation(this.api(endpoint)));
  }

  private api(endpoint: MachaEndpoint): MachaClusterStatusApi {
    let api = this.apis.get(endpoint.id);
    if (!api) {
      api = new MachaClusterStatusApi(endpoint.baseUrl, this.auth);
      this.apis.set(endpoint.id, api);
    }
    return api;
  }
}

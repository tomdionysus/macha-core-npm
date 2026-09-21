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

/** Safe status reads fail over advisorily; diagnostic POST actions execute exactly once. */
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

  /**
   * Advisory, because nothing read here is work a viewer is waiting on.
   *
   * This is the call the health cycle makes every ten seconds to discover
   * cluster membership and load, so routing it as normal work would let
   * bookkeeping decide which node the viewer's media flows through: one status
   * timeout un-sticks the preferred endpoint, one status success on another
   * node steals preference from it. Health evidence is still recorded — a node
   * that cannot answer is still in trouble — through the probe variants that
   * update health without touching authority.
   */
  private async read<T>(operation: (api: MachaClusterStatusApi) => Promise<T>): Promise<T> {
    return this.router.request((endpoint) => operation(this.api(endpoint)), undefined, { advisory: true });
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

import type { EndpointRegistry, MachaEndpoint } from '../cluster/EndpointRegistry.js';
import { ClusterEndpointRouter } from '../cluster/endpointRouting.js';
import { failureBlamesEndpoint, retryableEndpointFailure } from '../cluster/endpointFailure.js';
import {
  MachaClusterStatusApi,
  MachaClusterStatusApiError,
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

  /**
   * Asks the endpoints the registry attributes to `nodeId`, in its ranking
   * order, and takes the first answer that names itself as that node. Health
   * evidence is recorded as probes, as every status read is, so this never
   * moves the viewer's preferred endpoint. The last failure is rethrown when
   * every such endpoint failed.
   */
  async statusOf(nodeId: string): Promise<ClusterStatusSnapshot> {
    let lastError: unknown;
    for (const { endpoint } of this.router.registry.candidates()) {
      if (endpoint.nodeId !== nodeId) continue;
      try {
        const snapshot = await this.api(endpoint).status();
        this.router.registry.recordProbeSuccess(endpoint.id);
        if (snapshot.node_id === nodeId) return snapshot;
      } catch (error) {
        // Only a failure that is the node's, as a pinned read judges it.
        if (retryableEndpointFailure(error) && failureBlamesEndpoint(error, { pinned: true })) {
          this.router.registry.recordProbeFailure(endpoint.id);
        }
        lastError = error;
      }
    }
    if (lastError !== undefined) throw lastError;
    throw new MachaClusterStatusApiError(`No known endpoint answers as node ${nodeId}.`, 404);
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
   * node steals preference from it. Health evidence is still recorded (a node
   * that cannot answer is still in trouble) through the probe variants that
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

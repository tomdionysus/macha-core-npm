import type { IdentityAssociationReset } from './ManageApi.js';
import { DEFAULT_REQUEST_TIMEOUT_MS, fetchWithTimeout, mergeRequestHeaders, normalizeBaseUrl, readResponseBody } from './httpCompat.js';
import { NO_AUTH, type AuthenticatedFetch } from './SessionManager.js';
import { isGatewayConnectionFailure, serverUnreachable } from './serverConnection.js';

export type TelemetryFreshness = 'live' | 'stale' | 'last_known' | 'unavailable';
export type NodeState = 'online' | 'offline' | 'retired';
export type NodePhase = 'starting' | 'recovering' | 'ready' | 'unknown';
export type ClusterHealth = 'healthy' | 'recovering' | 'degraded' | 'critical';
export type MetadataAvailability = 'unavailable' | 'read-only' | 'writable';

export type StartupPhase = 'starting' | 'recovering' | 'ready' | 'failed';
export type StartupSubsystemState = 'starting' | 'recovering' | 'ready' | 'failed';

export interface ClusterStartupStatus {
  phase: StartupPhase;
  control_plane: StartupSubsystemState;
  api: StartupSubsystemState;
  data_storage: StartupSubsystemState;
  control_storage: StartupSubsystemState;
  cache: StartupSubsystemState;
  retention: StartupSubsystemState;
  metadata: StartupSubsystemState;
  services: StartupSubsystemState;
  started_at_unix_ms: number;
  ready_at_unix_ms: number | null;
  error: string | null;
}

export interface ByteUsage {
  capacity_bytes: number;
  used_bytes: number;
  free_bytes: number;
}

export interface NodeRuntimeStatus {
  uptime_ms?: number;
  rss_bytes?: number;
  process_cpu_percent?: number;
  load1?: number;
  /**
   * CPUs available to the node. Optional because older nodes do not report it;
   * without it `load1` cannot be compared between machines of different sizes,
   * so the client's capacity ranking abstains rather than guess.
   */
  cpu_cores?: number;
  peers_known?: number;
  peers_active?: number;
  rpc_connections_created?: number;
  rpc_connections_reused?: number;
  rpc_connections_canonical?: number;
}

export interface ClusterNodeStatus {
  id: string;
  state: NodeState;
  // Older nodes in a mixed-version cluster may not report this yet.
  phase?: NodePhase;
  telemetry_freshness: TelemetryFreshness;
  observed_at_unix_ms: number;
  live_age_ms: number | null;
  version: string;
  host: string;
  port: number;
  /**
   * The URL a client dials to reach this node's HTTP API — scheme, host and
   * optional port, never a path.
   *
   * Distinct from `host`/`port` above, which is the node's internal RPC bind
   * address: a different plane, never proxied, and not necessarily reachable
   * or even the right protocol for REST calls. Displaying `host:port` as
   * though it were the API is a mistake two clients made independently before
   * this field existed.
   *
   * It has to be a whole URL rather than a host and a port because neither the
   * scheme nor the port of the outer address is derivable from the bind: with
   * TLS offload in front of the API, the node serves plain HTTP on its own port
   * while clients must be told HTTPS on the proxy's.
   *
   * Optional because a node predating this does not send it. It arrives absent
   * rather than partial — the server rejects anything without `://` — so a
   * client can treat presence as sufficient and never has to guess a scheme.
   */
  api_endpoint?: string;
  failure_domain: string;
  metadata_generation: number;
  storage: ByteUsage;
  cache: ByteUsage;
  storage_backends_online: number;
  roles: string[];
  runtime: NodeRuntimeStatus;
  identity_association_reset: IdentityAssociationReset | null;
}

export interface ClusterSummaryStatus {
  health: ClusterHealth;
  conditions: string[];
  nodes_known: number;
  nodes_online: number;
  metadata_generation: number;
  metadata_voters: number;
  metadata_voters_online: number;
  metadata_quorum_required: number;
  metadata_availability: MetadataAvailability;
  metadata_read_available: boolean;
  metadata_quorum_available: boolean;
  metadata_write_available: boolean;
  metadata_quorum_validated: boolean;
  metadata_quorum_validated_at_unix_ms: number;
  storage_known: ByteUsage;
  storage_online: ByteUsage;
  cache_known: ByteUsage;
  cache_online: ByteUsage;
}

export interface ConnectivityEndpoint {
  host: string;
  port: number;
  source?: string;
}

export interface UpnpConnectivityStatus {
  enabled: boolean;
  support_built: boolean;
  gateway_found: boolean;
  mapping_active: boolean;
  mapping_created: boolean;
  mapping_owned: boolean;
  private_wan: boolean;
  lan_address: string | null;
  external_address: string | null;
  internal_port: number;
  external_port: number;
  lease_seconds: number;
  igd_status: number;
  error: string | null;
}

export interface ExternalIpConnectivityStatus {
  enabled: boolean;
  attempted: boolean;
  address: string | null;
  error: string | null;
}

export interface PublicConnectivityCheckStatus {
  enabled: boolean;
  self_probe: string;
  error: string | null;
  checked_at_unix_ms: number;
  externally_verified: boolean;
}

export interface PublicConnectivityStatus {
  configured: ConnectivityEndpoint;
  advertised: ConnectivityEndpoint;
  upnp: UpnpConnectivityStatus;
  external_ip: ExternalIpConnectivityStatus;
  check: PublicConnectivityCheckStatus;
}

export interface ClusterStatusSnapshot {
  cluster: ClusterSummaryStatus;
  startup?: ClusterStartupStatus;
  nodes: ClusterNodeStatus[];
  connectivity?: PublicConnectivityStatus;
  generated_at_unix_ms: number;
}

export interface ConnectivityResult {
  node_id: string;
  reachable: boolean;
  error?: string;
}

export interface ConnectivityCheck {
  results: ConnectivityResult[];
  connectivity?: PublicConnectivityStatus;
  checked_at_unix_ms: number;
}

export interface ClusterStatusApi {
  status(): Promise<ClusterStatusSnapshot>;
  node(id: string): Promise<ClusterNodeStatus>;
  checkConnectivity(nodeId?: string): Promise<ConnectivityCheck>;
}

export class MachaClusterStatusApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'MachaClusterStatusApiError';
  }
}

export class MachaClusterStatusApi implements ClusterStatusApi {
  private readonly baseUrl: string;

  constructor(baseUrl: string, private readonly auth: AuthenticatedFetch = NO_AUTH) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  private async request<T>(path: string, method: 'GET' | 'POST'): Promise<T> {
    const response = await fetchWithTimeout(
      (url, init) => this.auth.fetch(url, init),
      `${this.baseUrl}${path}`,
      { method, headers: mergeRequestHeaders(undefined, { Accept: 'application/json' }) },
      DEFAULT_REQUEST_TIMEOUT_MS,
    );

    const { body, wasJson } = await readResponseBody(response);
    if (isGatewayConnectionFailure(response, wasJson)) throw serverUnreachable();
    if (!response.ok) {
      const record = body && typeof body === 'object' && !Array.isArray(body)
        ? body as Record<string, unknown>
        : undefined;
      const message = typeof record?.message === 'string'
        ? record.message
        : `${response.status} ${response.statusText}`;
      throw new MachaClusterStatusApiError(message, response.status);
    }
    return body as T;
  }

  status(): Promise<ClusterStatusSnapshot> {
    return this.request('/api/v1/status', 'GET');
  }

  node(id: string): Promise<ClusterNodeStatus> {
    return this.request(`/api/v1/status/nodes/${encodeURIComponent(id)}`, 'GET');
  }

  checkConnectivity(nodeId?: string): Promise<ConnectivityCheck> {
    const path = nodeId
      ? `/api/v1/status/nodes/${encodeURIComponent(nodeId)}/connectivity/check`
      : '/api/v1/status/connectivity/check';
    return this.request(path, 'POST');
  }
}

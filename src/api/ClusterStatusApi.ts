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
  /** `recovery_failed` when startup failed, else null. Absent before 0.56.0. */
  error_code?: 'recovery_failed' | (string & {}) | null;
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
  /**
   * Physical RAM on the machine, not the node's own footprint — `rss_bytes`
   * above is the process's resident set and answers a different question.
   * Optional for the same reason as `cpu_cores`: older nodes do not send it.
   *
   * Reported for display only. Unlike `cpu_cores`, which makes `load1`
   * comparable between machines of different sizes, total memory does not
   * make any other figure mean more: a node is not slower for having less of
   * it until it runs out, and by then `load1` is already saying so. The
   * endpoint ranking deliberately does not read it — ranking on total memory
   * would prefer a large thrashing machine to a small healthy one, which is
   * not a subtle inaccuracy but the axis voting for the wrong node.
   */
  memory_total_bytes?: number;
  peers_known?: number;
  peers_active?: number;
  rpc_connections_created?: number;
  rpc_connections_reused?: number;
  rpc_connections_canonical?: number;
}

/**
 * The deadlines this node enforces on itself, so a client stops guessing them.
 *
 * **Each node's statement about itself**, relayed by whichever node answers the
 * status call exactly as `load1` and `cpu_cores` are. No node computes these
 * for a peer, and nothing here is a cluster-wide figure.
 *
 * **Absent means the node cannot say** — it predates server 0.46.2, or it runs
 * with `streaming.enabled` false and will not honour a playback budget it does
 * not run. Never read absence as a default: a client that substitutes its own
 * number has invented one, and a number that came from nowhere is
 * indistinguishable at runtime from one the node sent.
 *
 * The pair is all-or-nothing on the wire. A truncated record reports neither
 * rather than pairing a real startup budget with a fabricated hold, so a client
 * never has to wonder whether one of the two is genuine.
 *
 * Both move under a live session: the node's `reconfigure()` applies them
 * immediately with no restart. Read them per cycle rather than caching them
 * against an endpoint for the life of the process.
 */
export interface NodePlaybackBudgets {
  /**
   * How long this node may take to bring a transformed stream up before it
   * abandons the attempt — its `startup_timeout_ms`.
   *
   * Bounds what the *node* spends: it starts when the node begins work and
   * stops when the node gives up on itself. Getting the request there and the
   * response back is outside it, which is what
   * `ENDPOINT_TRANSPORT_ALLOWANCE_MS` covers.
   */
  startup_timeout_ms?: number;
  /**
   * How long this node holds a request for a fragment it has not produced yet
   * before answering `500 segment_not_ready` — its `segment_timeout_ms`.
   *
   * A hold is the node working, not the node failing. Any client deadline that
   * expires inside one abandons a node that was about to answer.
   */
  segment_timeout_ms?: number;
  /**
   * How long this node keeps a transcode pipeline alive with nothing pulling
   * from it before reclaiming the engine — its `streaming.pipeline_idle_ms`.
   *
   * **Not the session clock.** `pipeline_idle` reclaims the *engine* while
   * `session_idle` erases the *session*, and they are half an hour apart. A
   * standby held inside this window still has a warm engine to promote onto;
   * one held past it promotes onto a live session with a cold pipeline, which
   * costs a cold start rather than a failure.
   *
   * Absent on any node older than 0.48.0, and absent is not zero: core keeps
   * the floor the server guarantees instead. `config_base.cpp:359` refuses to
   * start a node with this under ten seconds, so 10,000 ms is true of every
   * node that is running at all.
   */
  pipeline_idle_ms?: number;
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
  /** The deadlines this node enforces on playback. Absent on a node that cannot say. */
  playback?: NodePlaybackBudgets;
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
  /** Null when none. Absent before 0.56.0. */
  error_code?: UpnpErrorCode | (string & {}) | null;
}

/** Why UPnP port mapping is not working, from server 0.56.0. */
export type UpnpErrorCode =
  | 'igd_not_connected' | 'port_mapped_elsewhere' | 'mapping_verification_failed'
  | 'add_mapping_failed' | 'discovery_failed' | 'support_not_built';

export interface ExternalIpConnectivityStatus {
  enabled: boolean;
  attempted: boolean;
  address: string | null;
  error: string | null;
  /** `lookup_failed`, else null. Absent before 0.56.0. */
  error_code?: 'lookup_failed' | (string & {}) | null;
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
  /**
   * Which node produced this response, matching an `id` in `nodes[]`.
   *
   * **The one thing a client cannot work out for itself.** Every node in
   * `nodes[]` states an `api_endpoint`, but that is the name a node advertises
   * — not necessarily the address the caller dialled. A client reaching a node
   * by a LAN address while the node advertises a DNS name had no way to learn
   * the two were one machine, so the registry held it as two nodes: counted
   * twice, offered twice in a selector, and a failover could "move" to the box
   * it had just left.
   *
   * Core never guesses this. Two addresses that share an authority are the
   * same door and are matched as such; two that do not may still be one node,
   * and merging them on a hunch merges two genuinely different ones, which is
   * worse than the miscount. So the node states it.
   */
  node_id: string;
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
  /** `rpc_failed` beside an error, from 0.56.0. */
  error_code?: 'rpc_failed' | (string & {});
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
  constructor(
    message: string,
    public readonly status: number,
    /** The server's own sentence, for a host that shows it. Never core's text; `message` is for a log. */
    public readonly detail?: string,
  ) {
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
      const detail = typeof record?.message === 'string' && record.message.trim() ? record.message : undefined;
      throw new MachaClusterStatusApiError(`Macha status request failed: ${detail ?? `${response.status} ${response.statusText}`}`, response.status, detail);
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

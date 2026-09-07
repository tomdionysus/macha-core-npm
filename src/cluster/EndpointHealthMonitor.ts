import { DEFAULT_REQUEST_TIMEOUT_MS, fetchWithTimeout, mergeRequestHeaders } from '../api/httpCompat.js';
import { NO_AUTH, type AuthenticatedFetch } from '../api/SessionManager.js';
import type { ClusterStatusApi } from '../api/ClusterStatusApi.js';
import type { EndpointRegistry, MachaEndpoint } from './EndpointRegistry.js';
import { reportClusterReachable, reportClusterUnreachable } from '../api/serverConnection.js';
import type { MachaClientConfiguration } from '../runtime/configuration.js';
import { machaHost } from '../runtime/host.js';
import { createClientLogger } from '../diagnostics/ClientLog.js';

export const ENDPOINT_HEALTH_INTERVAL_MS = 10_000;

const log = createClientLogger('cluster.health');

interface ProbeResult {
  status: 'healthy' | 'reachable' | 'unreachable';
  /** Round-trip time for a genuinely successful response only. */
  latencyMs?: number;
}

async function probeEndpoint(endpoint: MachaEndpoint, auth: AuthenticatedFetch): Promise<ProbeResult> {
  const startedAt = machaHost().now();
  try {
    const response = await fetchWithTimeout(
      (url, init) => auth.fetch(url, init),
      `${endpoint.baseUrl}/api/v1/catalogue/status`,
      { method: 'GET', headers: mergeRequestHeaders(undefined, { Accept: 'application/json' }), cache: 'no-store' },
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    if (!response.ok) return { status: 'reachable' };
    return { status: 'healthy', latencyMs: machaHost().now() - startedAt };
  } catch {
    return { status: 'unreachable' };
  }
}

/**
 * A small, bounded set of endpoints this client has actually reached at some
 * point, but never configured — a restart's only fallback if the single
 * configured bootstrap endpoint happens to be down at that exact moment
 * (`EndpointRegistry` otherwise reseeds runtime-discovered membership from
 * nothing every time). Purely a resumable-history hint: recomputed from live
 * state every cycle, so it always tracks what is *currently* confirmed rather
 * than accumulating unbounded discovery history, and is superseded the moment
 * a fresh `applyAdvertisement()` succeeds.
 */
export function persistConfirmedEndpoints(
  registry: EndpointRegistry,
  configuration: MachaClientConfiguration,
): void {
  const confirmed = registry.snapshot()
    .filter(({ endpoint, health }) => endpoint.source === 'discovered' && health.lastSuccessAt !== undefined)
    .map(({ endpoint }) => endpoint.baseUrl);
  const current = configuration.discoveredEndpoints();
  if (confirmed.length === current.length && confirmed.every((url, index) => url === current[index])) return;
  configuration.setDiscoveredEndpoints(confirmed);
}

/**
 * Learn live cluster membership from whichever known endpoint answers and
 * merge it into the registry. This is how failover candidates reach beyond
 * the single endpoint a user happens to have typed in: the cluster already
 * reports every online node's host/port on this same status call, so the
 * playback failover pool tracks real membership instead of staying frozen
 * at bootstrap configuration.
 */
export async function discoverClusterEndpoints(
  registry: EndpointRegistry,
  clusterStatusApi: ClusterStatusApi,
): Promise<void> {
  try {
    const { nodes } = await clusterStatusApi.status();
    // `host`/`port` is the node's internal RPC bind address, not its HTTP API
    // — using it here would guess at a port that is frequently wrong (a
    // different service, or unreachable behind NAT). Only `api_host`/
    // `api_port`, which the server advertises specifically for this purpose,
    // are trustworthy; nodes not yet reporting it are simply not discovered.
    const advertisements = nodes
      .filter((node) => node.state === 'online' && node.api_host && node.api_port)
      .map((node) => ({ nodeId: node.id, apiBaseUrls: [`http://${node.api_host}:${node.api_port}`] }));
    if (advertisements.length > 0) registry.applyAdvertisement(advertisements);
  } catch {
    // Membership discovery is opportunistic. Health probing of already-known
    // endpoints must keep working even when no endpoint can answer this yet.
  }
}

/** Probe every currently known HTTP API endpoint once, in parallel. */
export async function probeKnownEndpoints(
  registry: EndpointRegistry,
  auth: AuthenticatedFetch,
  signal: AbortSignal,
): Promise<number> {
  const endpoints = registry.snapshot().map(({ endpoint }) => endpoint);
  let reachable = 0;
  await Promise.all(endpoints.map(async (endpoint) => {
    // The lifecycle signal governs whether this result is still publishable;
    // it must never be attached to the HTTP request. Cancelling one consumer
    // (or a playback request) is not evidence about node health.
    const result = await probeEndpoint(endpoint, auth);
    if (signal.aborted) return;
    if (result.status !== 'unreachable') reachable += 1;
    if (result.status === 'healthy') {
      registry.recordProbeSuccess(endpoint.id);
      if (result.latencyMs !== undefined) registry.recordLatency(endpoint.id, result.latencyMs);
    } else {
      registry.recordProbeFailure(endpoint.id);
    }
  }));
  if (!signal.aborted) {
    const swap = registry.evaluatePreferredSwap();
    if (swap) {
      log.info('preemptive-endpoint-swap', swap);
    }
    log.debug('probe-cycle', { reachable, known: endpoints.length });
  }
  return reachable;
}

export interface EndpointHealthMonitorOptions {
  registry: EndpointRegistry;
  clusterStatusApi: ClusterStatusApi;
  auth?: AuthenticatedFetch;
  /** Where confirmed discoveries are remembered for the next start. Omit to keep them in memory only. */
  configuration?: MachaClientConfiguration;
  intervalMs?: number;
}

/**
 * Application-wide, bounded health loop. It owns no server or playback state.
 *
 * This was a React `useEffect` in the web client; the loop itself is plain,
 * so it lives here as start/stop and each platform binds it to whatever
 * lifecycle it has (an effect, a screen focus, a foreground event).
 * `stop()` is idempotent and safe to call from a teardown path that may run
 * more than once.
 */
export class EndpointHealthMonitor {
  private controller?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly auth: AuthenticatedFetch;
  private readonly intervalMs: number;

  constructor(private readonly options: EndpointHealthMonitorOptions) {
    this.auth = options.auth ?? NO_AUTH;
    this.intervalMs = options.intervalMs ?? ENDPOINT_HEALTH_INTERVAL_MS;
  }

  get running(): boolean {
    return this.controller !== undefined;
  }

  start(): void {
    if (this.controller) return;
    this.controller = new AbortController();
    void this.cycle(this.controller);
  }

  stop(): void {
    this.controller?.abort();
    this.controller = undefined;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async cycle(controller: AbortController): Promise<void> {
    const { registry, clusterStatusApi, configuration } = this.options;
    await discoverClusterEndpoints(registry, clusterStatusApi);
    if (controller.signal.aborted) return;
    const reachable = await probeKnownEndpoints(registry, this.auth, controller.signal);
    if (controller.signal.aborted) return;
    if (registry.snapshot().length > 0) {
      if (reachable > 0) reportClusterReachable(); else reportClusterUnreachable();
    }
    if (configuration) persistConfirmedEndpoints(registry, configuration);
    this.timer = setTimeout(() => void this.cycle(controller), this.intervalMs);
  }
}

import { DEFAULT_REQUEST_TIMEOUT_MS, fetchWithTimeout, mergeRequestHeaders } from '../api/httpCompat.js';
import { NO_AUTH, type AuthenticatedFetch } from '../api/SessionManager.js';
import { MachaClusterStatusApi, type ClusterStatusApi } from '../api/ClusterStatusApi.js';
import { endpointId, type EndpointRegistry, type MachaEndpoint } from './EndpointRegistry.js';
import { reportClusterReachable, reportClusterUnreachable } from '../api/serverConnection.js';
import type { MachaClientConfiguration } from '../runtime/configuration.js';
import { LIVENESS_PATH } from '../api/serverConnection.js';

/**
 * What liveness was asked on before `/api/v1/health` existed.
 *
 * Kept for any node the liveness route cannot answer for: one too old to have
 * it, and — measured, not assumed — builds that have it but gate it. This one
 * needs `media_viewer`, so it is no better for a role-less session; it is a
 * fallback because it is *different*, not because it is right, and a node
 * that refuses both is simply ungraded rather than condemned.
 */
const LEGACY_PROBE_PATH = '/api/v1/catalogue/status';
import { machaHost } from '../runtime/host.js';
import { createClientLogger } from '../diagnostics/ClientLog.js';

export const ENDPOINT_HEALTH_INTERVAL_MS = 10_000;

const log = createClientLogger('cluster.health');

/**
 * What one probe learned, which is not the same as whether it succeeded.
 *
 * - `healthy` — 2xx. The node says it is serving, and this is the only case
 *   that carries a latency measurement.
 * - `unhealthy` — a 5xx. `/api/v1/health` answers `503` with `starting` or
 *   `failed`, which is the node reporting that it is *not* serving. Negative
 *   evidence it volunteered about itself.
 * - `absent` — `404`. A node too old to have the liveness route, not a node
 *   in trouble.
 * - `answered` — anything else. Reached, and nothing learned: a proxy, a
 *   gateway, an address that is not Macha at all.
 * - `unreachable` — no HTTP answer of any kind.
 */
interface ProbeResult {
  status: 'healthy' | 'unhealthy' | 'absent' | 'answered' | 'unreachable';
  /** Round-trip time for a genuinely successful response only. */
  latencyMs?: number;
}

/**
 * A health probe must never be answered from a cache, and `cache: 'no-store'`
 * is not enough to guarantee that.
 *
 * The option means three different things across this project's three hosts,
 * measured rather than assumed: a browser sends the directive; React Native's
 * `whatwg-fetch` implements it by appending `_=<epoch>` to the query; and
 * Tizen 3 does not have the property at all — `'cache' in new Request(url,
 * {cache:'no-store'})` is `false` — so it vanishes silently, header and all.
 *
 * On that last one the consequence is not cosmetic. A cached
 * `/api/v1/catalogue/status` makes a dead node answer `200` from the WebView's
 * own store, so `EndpointHealthMonitor` reports it healthy, keeps ranking it
 * first, and keeps sending playback to a node that is gone.
 *
 * A unique URL is the one mechanism every host honours, because none of them
 * can cache a request they have never seen. Doing it here makes the behaviour
 * the same everywhere instead of three-way different, and Macha ignores query
 * parameters it does not know — which is the accurate guarantee, rather than
 * "the query string is never inspected". It is inspected elsewhere: session
 * creation validates the *content* of a parameter it knows and answers 400.
 * So this stays safe only while `_` remains unknown to every endpoint it is
 * sent to.
 *
 * **It is not a polyfill workaround and does not retire with Tizen 3.**
 * `no-store` is a *request* directive: it governs the caches the client can
 * speak to, and says nothing to an intermediary. A proxy or CDN between this
 * client and a node can still answer from its own store — a live possibility
 * on a WAN endpoint rather than a theoretical one — and a health probe served
 * from anyone's cache reports a dead node healthy. A URL nobody has seen
 * before defeats every cache on the path, which no header can promise.
 *
 * **It must not be built from `machaHost().now()`, and was.** That clock is
 * monotonic — `performance.now()` wherever the host has it — so it restarts
 * near zero on every page load, and the first probe of a load fires at a fixed
 * point in startup. Measured on the running web client: two consecutive
 * reloads produced 744 and 571. The value space for a load's first probe is a
 * few hundred integers, re-entered from the beginning every time, so a
 * collision is close to certain for anyone who reloads more than a handful of
 * times — and the cache then answers a probe for a node that is gone. A
 * defeated cache-buster fails silently and in the worst direction.
 *
 * The counter is what makes this never-repeating rather than merely unlikely:
 * a wall clock rounded to milliseconds still collides between two probes in
 * the same millisecond, and two endpoints are probed together.
 */
let probeSequence = 0;

function cacheBustedProbeUrl(baseUrl: string, path: string): string {
  // Deliberately NOT `startedAt`. That value is the other half of the latency
  // measurement and has to stay monotonic; this half needs an absolute value
  // that never repeats. They are different clocks for different jobs — see the
  // note on `MachaHost.now()` — and the second reading costs nothing here
  // because it is taken before the timed region rather than inside it.
  probeSequence += 1;
  return `${baseUrl}${path}?_=${Date.now()}-${probeSequence}`;
}

async function probePath(baseUrl: string, path: string, auth: AuthenticatedFetch): Promise<ProbeResult> {
  const url = cacheBustedProbeUrl(baseUrl, path);
  const startedAt = machaHost().now();
  try {
    const response = await fetchWithTimeout(
      (url, init) => auth.fetch(url, init),
      url,
      { method: 'GET', headers: mergeRequestHeaders(undefined, { Accept: 'application/json' }), cache: 'no-store' },
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    if (response.ok) return { status: 'healthy', latencyMs: machaHost().now() - startedAt };
    if (response.status >= 500) return { status: 'unhealthy' };
    // 404 is a build without the route. 401 and 403 are a build that has it
    // and insists on a credential for it. Both mean the same thing to a
    // caller: this route did not give a liveness answer, ask the other way.
    if (response.status === 404) return { status: 'absent' };
    return { status: 'answered' };
  } catch {
    return { status: 'unreachable' };
  }
}

async function probeEndpoint(endpoint: MachaEndpoint, auth: AuthenticatedFetch): Promise<ProbeResult> {
  const result = await probePath(endpoint.baseUrl, LIVENESS_PATH, auth);
  if (result.status !== 'absent' && result.status !== 'answered') return result;
  // Anything that did not answer the liveness question gets asked the old
  // way, and the reason it cannot be keyed on 404 alone is the whole point:
  // **authentication happens before routing**, so a node too old to have the
  // liveness route never reaches the part that would 404 and answers **401**
  // instead. Confirmed against the server source and measured on the one
  // node in the field still running 0.38.1. A 404-only fallback would have
  // fired on every node except the single one that needs it.
  //
  // Without it that node is permanently ungraded — no latency samples, so no
  // ranking on the one axis that can see a bad network path, and no
  // pre-emptive swap — which makes it second-class for running an old build.
  //
  // The fallback is no better for a role-less session, since the old route
  // needs `media_viewer` on any build new enough to gate it. It is a fallback
  // because it is *different*, and a node that refuses both ends up ungraded
  // rather than condemned.
  //
  // Probes keep carrying whatever credential the host supplies. Asking
  // unauthenticated was considered and dropped: on the node that gates
  // liveness it is refused either way, so it buys nothing there, and it would
  // route around the transport a host injects through `auth`.
  //
  // Deliberately triggered by the answer rather than by a version check: the
  // day no node needs the fallback is the day this path can go, and a version
  // check would hide that day rather than show it.
  return probePath(endpoint.baseUrl, LEGACY_PROBE_PATH, auth);
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
  const snapshot = registry.snapshot();
  const current = configuration.discoveredEndpoints();
  const remembered = new Set(current);
  // Before anything at all has answered this run, a failure is not evidence
  // against a remembered node: the likelier fault is the network, a set whose
  // Wi-Fi is still coming up. Rewriting then would forget every remembered
  // node exactly when the configured one is down and they are the fallback.
  const anyAnswered = snapshot.some(({ health }) => health.lastSuccessAt !== undefined);
  const confirmed = snapshot
    .filter(({ endpoint, health }) => endpoint.source === 'discovered' && (
      health.lastSuccessAt !== undefined
      // Remembered and still in the registry: kept until it actually fails
      // while something else answers. A node the cluster no longer lists has
      // left the registry, and so leaves this list.
      || (remembered.has(endpoint.baseUrl) && (!anyAnswered || health.lastFailureAt === undefined))
    ))
    .map(({ endpoint }) => endpoint.baseUrl);
  if (confirmed.length === current.length && confirmed.every((url, index) => url === current[index])) return;
  configuration.setDiscoveredEndpoints(confirmed);
}

/**
 * How many endpoints may be asked to name themselves in one cycle.
 *
 * Identity is stable, so this converges: an endpoint that answers is claimed
 * and never asked again. The cap is only so that a first cycle against a large
 * cluster of unidentified endpoints does not fan out into one status call per
 * endpoint at once.
 */
const IDENTITY_RESOLUTIONS_PER_CYCLE = 2;

/**
 * Ask an endpoint which node it is, when nothing else can say.
 *
 * **The membership advertisement cannot answer this.** It is built from each
 * node's `api_endpoint` — the name the node advertises — so an endpoint
 * reached by any *other* address matches nothing and keeps no `nodeId` at all.
 * A LAN address beside a DNS name for one machine is then two nodes to the
 * registry: counted twice, offered twice in a selector, and a failover that
 * "moves" to the box it just left. Live on this cluster.
 *
 * It cannot be inferred either. Two addresses that share an authority are the
 * same door and are matched as such in `applyAdvertisement`; two that do not
 * may still be one node, and guessing merges two genuinely different ones,
 * which is worse than the miscount. So core declined to guess until the server
 * stated it, and server 0.48.2 states it: `node_id` on the status root,
 * matching an `id` in `nodes[]`.
 *
 * Asked of the endpoint directly rather than through the routed API, because
 * the whole question is *which address this is* — a routed call answers from
 * whichever node it picked and says nothing about the one being identified.
 *
 * **Only ever claims an address already in the registry.** It advertises
 * endpoints that are already configured or discovered, so nothing here can
 * mint a plaintext address for a node someone put behind TLS — the rule the
 * membership advertisement is built around.
 *
 * An endpoint that will not answer is left unidentified and is not asked
 * again; it is a question about identity, not a health signal.
 */
export async function identifyUnclaimedEndpoints(
  registry: EndpointRegistry,
  auth: AuthenticatedFetch,
  asked: Set<string>,
  signal?: AbortSignal,
): Promise<void> {
  const unclaimed = registry.snapshot()
    .filter(({ endpoint }) => endpoint.nodeId === undefined && !asked.has(endpoint.baseUrl))
    .slice(0, IDENTITY_RESOLUTIONS_PER_CYCLE);
  for (const { endpoint } of unclaimed) {
    if (signal?.aborted) return;
    // Once per endpoint, whatever the answer. A node that answers is claimed
    // and never appears here again; one that will not answer — unreachable, or
    // refusing the route to this session's roles — must not be re-asked every
    // cycle for the life of the client.
    asked.add(endpoint.baseUrl);
    try {
      const { node_id: nodeId } = await new MachaClusterStatusApi(endpoint.baseUrl, auth).status();
      // `claimNodeId`, never `applyAdvertisement`. The latter states the whole
      // of membership and drops whatever it is not told about, so announcing
      // one identified address would delete every discovered endpoint beside
      // it. Identity is not membership.
      if (typeof nodeId === 'string' && nodeId.length > 0) registry.claimNodeId(endpoint.baseUrl, nodeId);
    } catch {
      // Unreachable or refusing the route. Neither is a health signal — this
      // is a question about identity, and an endpoint that cannot answer it is
      // simply not identified.
    }
  }
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
  signal?: AbortSignal,
): Promise<void> {
  try {
    const { nodes } = await clusterStatusApi.status();
    // `stop()` may have run while that was in flight. Applying an
    // advertisement after it reshapes the registry and fires every host
    // listener on behalf of a monitor the host has already torn down — the
    // same rule the cycle applies either side of the probe walk, which this
    // call sat above rather than inside.
    if (signal?.aborted) return;
    // `host`/`port` is the node's internal RPC bind address, not its HTTP API —
    // using it here would guess at a port that is frequently wrong, and at a
    // scheme that TLS offload makes unguessable. `api_endpoint` is the whole
    // URL the node says to dial, so nothing is assembled here and no scheme is
    // inferred. A node that does not report one is simply not discovered:
    // failing closed costs a failover candidate, while inventing a URL costs a
    // plaintext request to a node someone deliberately put behind TLS.
    const online = nodes.filter((node) => node.state === 'online' && node.api_endpoint?.includes('://'));
    const advertisements = online
      .map((node) => ({ nodeId: node.id, apiBaseUrls: [node.api_endpoint!] }));
    if (advertisements.length > 0) registry.applyAdvertisement(advertisements);

    // This payload already describes every node's load, and it arrives on a
    // call the health cycle makes anyway. Reading it costs nothing; the
    // alternative — a synthetic throughput or load probe — would compete with
    // viewer traffic for the exact resource it claims to measure, and on a
    // weak link would consume the capacity it was trying to observe.
    //
    // Note the coverage this buys: real request evidence only ever accrues for
    // the node already in use, so the alternates a failover would pick from
    // have none. Self-reported load is the only measurement held about a node
    // this client is *not* currently talking to.
    const observedAt = machaHost().now();
    for (const node of online) {
      registry.recordCapacity(endpointId(node.api_endpoint!), {
        ...(node.runtime.process_cpu_percent !== undefined ? { cpuPercent: node.runtime.process_cpu_percent } : {}),
        ...(node.runtime.load1 !== undefined ? { load1: node.runtime.load1 } : {}),
        ...(node.runtime.cpu_cores !== undefined ? { cores: node.runtime.cpu_cores } : {}),
        ...(node.storage?.free_bytes !== undefined ? { storageAvailableBytes: node.storage.free_bytes } : {}),
        observedAt,
      });
      // Deadlines rather than load, and recorded even when the node reports
      // neither: an entry that says "this node has been heard from and said
      // nothing" is different from no entry at all, and the difference is what
      // stops a stale figure surviving a node that has stopped reporting one.
      //
      // Read here rather than from the session payload because the budget has
      // to be known for a node this client may be about to fail over to, before
      // it has ever created a session there.
      registry.recordPlaybackBudgets(endpointId(node.api_endpoint!), {
        ...(node.playback?.startup_timeout_ms !== undefined
          ? { startupTimeoutMs: node.playback.startup_timeout_ms }
          : {}),
        ...(node.playback?.segment_timeout_ms !== undefined
          ? { segmentTimeoutMs: node.playback.segment_timeout_ms }
          : {}),
        ...(node.playback?.pipeline_idle_ms !== undefined
          ? { pipelineIdleMs: node.playback.pipeline_idle_ms }
          : {}),
        observedAt,
      });
    }
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
    } else if (result.status === 'unhealthy' || result.status === 'unreachable') {
      registry.recordProbeFailure(endpoint.id);
    }
    // `answered` and `absent` record nothing, in either direction. Something
    // replied, so calling the endpoint failed would demote it on the word of
    // a proxy or for serving a route it has never heard of; but a reply that
    // is not a success is no evidence of health either, and recording a
    // success would claim a measurement nobody took.
  }));
  if (!signal.aborted) {
    const swap = registry.evaluatePreferredSwap();
    if (swap) {
      log.info('preemptive-endpoint-swap', swap);
    }
    log.debug('probe-cycle', { reachable, known: endpoints.length, decidedBy: registry.selectionAxis() });
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
  /** Endpoints already asked to name themselves; see `identifyUnclaimedEndpoints`. */
  private readonly identityAsked = new Set<string>();
  private controller?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<void>;
  private cycleToken = 0;
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
    this.inFlight = undefined;
  }

  /**
   * Run a cycle now, and re-base the interval from it.
   *
   * **The monitor cannot see the one event that most justifies a probe.** A
   * radio coming back is a host fact — no timer here can observe it — and it
   * is simultaneously the moment the cluster's state is most likely to have
   * changed and the viewer most likely to be waiting. Waiting out the
   * remainder of a ten second cycle is a real cost, not a tidy-up. The seam is
   * right and only the trigger was missing, which is why this is a method
   * rather than the monitor growing a subscription of its own.
   *
   * Clients were achieving this with `stop()` then `start()`. That is safe,
   * but it aborts a probe already in flight and restarts the interval from
   * zero — it throws away the answer it was about to get in order to ask the
   * question again.
   *
   * **A cycle already running is awaited rather than duplicated.** Two
   * concurrent cycles would probe every endpoint twice and race each other's
   * `persistConfirmedEndpoints`, so the honest answer to "probe now" while a
   * probe is in progress is the one already being taken.
   *
   * **A stopped monitor stays stopped.** Resurrecting a loop that was
   * deliberately torn down would make teardown conditional on nobody holding a
   * reference, which is how a disposed client keeps polling. Call `start()`.
   */
  probeNow(): Promise<void> {
    const controller = this.controller;
    if (!controller) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    return this.cycle(controller);
  }

  private cycle(controller: AbortController): Promise<void> {
    const token = ++this.cycleToken;
    const settle = () => { if (this.cycleToken === token) this.inFlight = undefined; };
    const run = this.runCycle(controller).then(settle, (error: unknown) => { settle(); throw error; });
    this.inFlight = run;
    return run;
  }

  private async runCycle(controller: AbortController): Promise<void> {
    const { registry, clusterStatusApi, configuration } = this.options;
    try {
      await discoverClusterEndpoints(registry, clusterStatusApi, controller.signal);
      if (controller.signal.aborted) return;
      const reachable = await probeKnownEndpoints(registry, this.auth, controller.signal);
      if (controller.signal.aborted) return;
      // After the probe walk, deliberately. Health is what this loop exists
      // for; learning which node an address is can wait a cycle, and putting
      // it first would let one slow identification delay every probe.
      await identifyUnclaimedEndpoints(registry, this.auth, this.identityAsked, controller.signal);
      if (controller.signal.aborted) return;
      if (registry.snapshot().length > 0) {
        if (reachable > 0) reportClusterReachable(); else reportClusterUnreachable();
      }
      // Remembering where the cluster was is a convenience for the next start.
      // A television with a full store throwing `QuotaExceededError` out of
      // `setItem` used to reject this cycle, and the `void` on the caller
      // swallowed it: no reschedule ever ran, `running` stayed `true`, and the
      // health loop was dead with nothing said. `EndpointBandwidth.write()`
      // has caught for exactly this reason since it was written — two copies
      // of one rule, and only one of them was true.
      if (configuration) {
        try {
          persistConfirmedEndpoints(registry, configuration);
        } catch (error) {
          log.warn('discovered-endpoints-not-persisted', { error });
        }
      }
    } finally {
      // In a `finally`, because the loop surviving must not depend on the body
      // having succeeded. A failure here is a cycle lost; a failure that also
      // stops the rescheduling is every future cycle lost, which is the
      // indefinite-wait failure the contract says must never be silent.
      //
      // Scheduling here rather than in `cycle` is what re-bases the interval:
      // an off-cycle probe clears the pending timer and this sets the next one
      // from the moment this probe finished, so `probeNow()` does not leave a
      // short remainder behind it.
      if (!controller.signal.aborted) {
        this.timer = setTimeout(() => void this.cycle(controller), this.intervalMs);
      }
    }
  }
}

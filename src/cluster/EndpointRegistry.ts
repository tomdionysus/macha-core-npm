import { normalizeBaseUrl } from '../api/httpCompat.js';
import type { EndpointBandwidth } from './EndpointBandwidth.js';

export type EndpointSource = 'bootstrap' | 'environment' | 'discovered';

export interface MachaEndpoint {
  /** Provisional identity until the server advertises a durable node ID. */
  id: string;
  baseUrl: string;
  source: EndpointSource;
  nodeId?: string;
}

export interface EndpointHealth {
  consecutiveFailures: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  retryAt?: number;
}

export interface EndpointCandidate {
  endpoint: MachaEndpoint;
  health: EndpointHealth;
}

/** Transport-neutral shape consumed by the registry once servers advertise APIs. */
export interface EndpointAdvertisement {
  nodeId?: string;
  apiBaseUrls: readonly string[];
}

const FAILURE_COOLDOWN_MS = [500, 2_000, 10_000, 30_000] as const;

/** Rolling probe-latency samples kept per endpoint before averaging. */
const LATENCY_SAMPLE_WINDOW = 5;
/** A pre-emptive swap never runs again this soon after the last one. */
const LATENCY_SWAP_COOLDOWN_MS = 60_000;
/** Consecutive probe cycles the same alternate must stay materially better before authority actually moves. */
const LATENCY_SWAP_MIN_CONSECUTIVE_CYCLES = 3;
/** An alternate must beat the preferred endpoint by at least this many milliseconds... */
const LATENCY_SWAP_MIN_ABSOLUTE_IMPROVEMENT_MS = 200;
/** ...and by at least this fraction, so two already-fast nodes never swap over noise. */
const LATENCY_SWAP_MIN_RELATIVE_IMPROVEMENT = 0.4;
/**
 * Throughput evidence is only consulted once an endpoint has this many
 * transfers behind it. One large response is a data point, not a trend.
 */
const THROUGHPUT_MIN_SAMPLES = 2;
/** How much faster (or slower) a link must measure before throughput changes any decision. */
const THROUGHPUT_MIN_RELATIVE_DIFFERENCE = 0.4;

export interface PreferredEndpointSwap {
  fromId: string;
  toId: string;
  fromLatencyMs: number;
  toLatencyMs: number;
  /** Present only where both endpoints had enough transfer evidence to compare. */
  fromBytesPerSecond?: number;
  toBytesPerSecond?: number;
  reason: 'latency' | 'throughput';
}

export function endpointId(baseUrl: string): string {
  return normalizeBaseUrl(baseUrl);
}

export function bootstrapEndpoints(urls: readonly string[], source: EndpointSource = 'bootstrap'): MachaEndpoint[] {
  const unique = new Set<string>();
  const endpoints: MachaEndpoint[] = [];
  for (const value of urls) {
    const baseUrl = normalizeBaseUrl(value);
    if (!baseUrl) continue;
    if (unique.has(baseUrl)) continue;
    unique.add(baseUrl);
    endpoints.push({ id: endpointId(baseUrl), baseUrl, source });
  }
  return endpoints;
}

/**
 * Endpoint ordering from real request and active-probe evidence. The registry
 * owns no timer itself; callers feed it outcomes and ask for candidates.
 */
export class EndpointRegistry {
  private endpoints: MachaEndpoint[];
  private readonly health = new Map<string, EndpointHealth>();
  private readonly listeners = new Set<() => void>();
  private preferredId?: string;
  private readonly latencySamples = new Map<string, number[]>();
  private latencyAdvantageId?: string;
  private latencyAdvantageStreak = 0;
  private lastLatencySwapAt?: number;

  constructor(
    endpoints: readonly MachaEndpoint[],
    private readonly now: () => number = Date.now,
    private readonly bandwidth?: EndpointBandwidth,
  ) {
    this.endpoints = this.deduplicate(endpoints);
  }

  replace(endpoints: readonly MachaEndpoint[]): void {
    this.endpoints = this.deduplicate(endpoints);
    const retained = new Set(this.endpoints.map((endpoint) => endpoint.id));
    for (const id of this.health.keys()) if (!retained.has(id)) this.health.delete(id);
    for (const id of this.latencySamples.keys()) if (!retained.has(id)) this.latencySamples.delete(id);
    this.bandwidth?.retain(retained);
    if (this.preferredId && !retained.has(this.preferredId)) this.preferredId = undefined;
    if (this.latencyAdvantageId && !retained.has(this.latencyAdvantageId)) {
      this.latencyAdvantageId = undefined;
      this.latencyAdvantageStreak = 0;
    }
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Apply the latest endpoint advertisement while retaining configured seeds.
   * Discovery is a refreshable view, not durable configuration. Matching seeds
   * gain durable node identity but remain bootstrap candidates.
   */
  applyAdvertisement(advertisements: readonly EndpointAdvertisement[]): void {
    const advertisedByUrl = new Map<string, string | undefined>();
    for (const advertisement of advertisements) {
      for (const value of advertisement.apiBaseUrls) {
        const baseUrl = normalizeBaseUrl(value);
        if (!baseUrl) continue;
        if (!advertisedByUrl.has(baseUrl)) advertisedByUrl.set(baseUrl, advertisement.nodeId);
      }
    }

    const retained = this.endpoints
      .filter((endpoint) => endpoint.source !== 'discovered')
      .map((endpoint) => {
        const nodeId = advertisedByUrl.get(endpoint.baseUrl);
        advertisedByUrl.delete(endpoint.baseUrl);
        return nodeId ? { ...endpoint, nodeId } : endpoint;
      });
    const discovered = [...advertisedByUrl].map(([baseUrl, nodeId]) => ({
      id: endpointId(baseUrl),
      baseUrl,
      source: 'discovered' as const,
      ...(nodeId ? { nodeId } : {}),
    }));
    this.replace([...retained, ...discovered]);
  }

  candidates(excludedIds: ReadonlySet<string> = new Set()): EndpointCandidate[] {
    const now = this.now();
    const candidates = this.endpoints
      .filter((endpoint) => !excludedIds.has(endpoint.id))
      .map((endpoint, order) => ({
        endpoint,
        health: { ...(this.health.get(endpoint.id) ?? { consecutiveFailures: 0 }) },
        order,
      }));

    candidates.sort((left, right) => {
      const leftReady = (left.health.retryAt ?? 0) <= now;
      const rightReady = (right.health.retryAt ?? 0) <= now;
      if (leftReady !== rightReady) return leftReady ? -1 : 1;
      const leftPreferred = left.endpoint.id === this.preferredId;
      const rightPreferred = right.endpoint.id === this.preferredId;
      if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1;
      if (!leftReady && !rightReady) return (left.health.retryAt ?? 0) - (right.health.retryAt ?? 0);
      if (left.health.consecutiveFailures !== right.health.consecutiveFailures) {
        return left.health.consecutiveFailures - right.health.consecutiveFailures;
      }
      // Measured throughput outranks the order the endpoints happened to be
      // configured in. Without this, a failover from the preferred node walks
      // the list as typed — which is a stand-in for "nearest" that a mixed
      // wired/wireless/WAN cluster falsifies routinely.
      const throughput = this.compareThroughput(left.endpoint.id, right.endpoint.id);
      if (throughput !== 0) return throughput;
      return left.order - right.order;
    });

    return candidates.map(({ endpoint, health }) => ({ endpoint, health }));
  }

  recordSuccess(endpointIdValue: string): void {
    this.recordHealthy(endpointIdValue, true);
  }

  /** Health probes must not reshuffle the sticky endpoint used by real work. */
  recordProbeSuccess(endpointIdValue: string): void {
    this.recordHealthy(endpointIdValue, false);
  }

  private recordHealthy(endpointIdValue: string, prefer: boolean): void {
    this.health.set(endpointIdValue, {
      consecutiveFailures: 0,
      lastSuccessAt: this.now(),
    });
    if (prefer) this.preferredId = endpointIdValue;
    this.notify();
  }

  recordFailure(endpointIdValue: string): void {
    this.recordUnhealthy(endpointIdValue, true);
  }

  /** Health probes must not reshuffle the sticky endpoint used by real work. */
  recordProbeFailure(endpointIdValue: string): void {
    this.recordUnhealthy(endpointIdValue, false);
  }

  private recordUnhealthy(endpointIdValue: string, demote: boolean): void {
    const previous = this.health.get(endpointIdValue);
    const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
    const now = this.now();
    const cooldownIndex = Math.min(consecutiveFailures - 1, FAILURE_COOLDOWN_MS.length - 1);
    this.health.set(endpointIdValue, {
      ...previous,
      consecutiveFailures,
      lastFailureAt: now,
      retryAt: now + FAILURE_COOLDOWN_MS[cooldownIndex],
    });
    if (demote && this.preferredId === endpointIdValue) this.preferredId = undefined;
    this.notify();
  }

  /** Record one successful round-trip time, independent of reachability bookkeeping. */
  recordLatency(endpointIdValue: string, latencyMs: number): void {
    const samples = this.latencySamples.get(endpointIdValue) ?? [];
    samples.push(latencyMs);
    if (samples.length > LATENCY_SAMPLE_WINDOW) samples.shift();
    this.latencySamples.set(endpointIdValue, samples);
  }

  /** The current rolling average probe latency, or undefined with no samples yet. */
  latencyMs(endpointIdValue: string): number | undefined {
    const samples = this.latencySamples.get(endpointIdValue);
    if (!samples || samples.length === 0) return undefined;
    return samples.reduce((sum, value) => sum + value, 0) / samples.length;
  }

  /** The measured throughput of an endpoint in bytes per second, where enough transfers back it. */
  bytesPerSecond(endpointIdValue: string): number | undefined {
    if (!this.bandwidth) return undefined;
    if (this.bandwidth.samples(endpointIdValue) < THROUGHPUT_MIN_SAMPLES) return undefined;
    return this.bandwidth.bytesPerSecond(endpointIdValue);
  }

  /**
   * -1 when `leftId` is the materially faster link, 1 when `rightId` is, and 0
   * when they are comparable or either lacks evidence. Deliberately blunt: a
   * small difference must not reshuffle anything.
   */
  private compareThroughput(leftId: string, rightId: string): number {
    const left = this.bytesPerSecond(leftId);
    const right = this.bytesPerSecond(rightId);
    if (left === undefined || right === undefined) return 0;
    if (left >= right / (1 - THROUGHPUT_MIN_RELATIVE_DIFFERENCE)) return -1;
    if (right >= left / (1 - THROUGHPUT_MIN_RELATIVE_DIFFERENCE)) return 1;
    return 0;
  }

  /**
   * Pre-emptively move authority to a healthy known endpoint that measures
   * materially and consistently better than the current preferred endpoint.
   *
   * "Better" is two facts, not one. Round-trip time decides how quickly the
   * next request starts; throughput decides whether media can actually be read
   * across the link, and the two disagree often enough to matter — a node one
   * wireless hop away can answer probes promptly and still be the worst place
   * to stream from. So a swap requires an advantage on one axis and no
   * material regression on the other, and either axis can motivate it.
   *
   * Independent of reachability: this only ever compares endpoints that are
   * already out of any failure cooldown. A sustained-advantage streak across
   * consecutive calls (one per health-probe cycle) plus a cooldown after any
   * swap keep authority from flapping between two close nodes. Returns the
   * swap that was made, if any, for the caller to log.
   */
  evaluatePreferredSwap(now: number = this.now()): PreferredEndpointSwap | undefined {
    const resetAdvantage = () => {
      this.latencyAdvantageId = undefined;
      this.latencyAdvantageStreak = 0;
    };
    if (!this.preferredId || (this.lastLatencySwapAt !== undefined && now - this.lastLatencySwapAt < LATENCY_SWAP_COOLDOWN_MS)) {
      resetAdvantage();
      return undefined;
    }
    const preferredLatency = this.latencyMs(this.preferredId);
    if (preferredLatency === undefined) {
      resetAdvantage();
      return undefined;
    }

    let best: { id: string; latencyMs: number; reason: 'latency' | 'throughput' } | undefined;
    for (const { endpoint, health } of this.candidates()) {
      if (endpoint.id === this.preferredId || (health.retryAt ?? 0) > now) continue;
      const latency = this.latencyMs(endpoint.id);
      if (latency === undefined) continue;

      const throughput = this.compareThroughput(endpoint.id, this.preferredId);
      // Never hand authority to a link that measurably cannot carry as much,
      // however promptly it answers a probe.
      if (throughput > 0) continue;

      const fasterByLatency = latency <= preferredLatency - LATENCY_SWAP_MIN_ABSOLUTE_IMPROVEMENT_MS
        && latency <= preferredLatency * (1 - LATENCY_SWAP_MIN_RELATIVE_IMPROVEMENT);
      // A materially fatter pipe is reason enough on its own, provided the
      // round trip has not regressed materially in exchange.
      const fatterPipe = throughput < 0
        && latency <= preferredLatency / (1 - LATENCY_SWAP_MIN_RELATIVE_IMPROVEMENT);
      if (!fasterByLatency && !fatterPipe) continue;

      if (!best || latency < best.latencyMs) {
        best = { id: endpoint.id, latencyMs: latency, reason: fasterByLatency ? 'latency' : 'throughput' };
      }
    }

    if (!best) {
      resetAdvantage();
      return undefined;
    }

    this.latencyAdvantageStreak = this.latencyAdvantageId === best.id ? this.latencyAdvantageStreak + 1 : 1;
    this.latencyAdvantageId = best.id;
    if (this.latencyAdvantageStreak < LATENCY_SWAP_MIN_CONSECUTIVE_CYCLES) return undefined;

    const fromBytesPerSecond = this.bytesPerSecond(this.preferredId);
    const toBytesPerSecond = this.bytesPerSecond(best.id);
    const swap: PreferredEndpointSwap = {
      fromId: this.preferredId,
      toId: best.id,
      fromLatencyMs: preferredLatency,
      toLatencyMs: best.latencyMs,
      ...(fromBytesPerSecond !== undefined ? { fromBytesPerSecond } : {}),
      ...(toBytesPerSecond !== undefined ? { toBytesPerSecond } : {}),
      reason: best.reason,
    };
    this.preferredId = best.id;
    this.lastLatencySwapAt = now;
    resetAdvantage();
    this.notify();
    return swap;
  }

  snapshot(): EndpointCandidate[] {
    return this.endpoints.map((endpoint) => ({
      endpoint,
      health: { ...(this.health.get(endpoint.id) ?? { consecutiveFailures: 0 }) },
    }));
  }

  private deduplicate(endpoints: readonly MachaEndpoint[]): MachaEndpoint[] {
    const seenIds = new Set<string>();
    const seenUrls = new Set<string>();
    const result: MachaEndpoint[] = [];
    for (const endpoint of endpoints) {
      const baseUrl = normalizeBaseUrl(endpoint.baseUrl);
      if (!baseUrl) continue;
      // One node may advertise several independently reachable API bases.
      // nodeId groups candidates but must never collapse endpoint identity.
      const id = endpoint.id || endpointId(baseUrl);
      if (seenIds.has(id) || seenUrls.has(baseUrl)) continue;
      seenIds.add(id);
      seenUrls.add(baseUrl);
      result.push({ ...endpoint, id, baseUrl });
    }
    return result;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

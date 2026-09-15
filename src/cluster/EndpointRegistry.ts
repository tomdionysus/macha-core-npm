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

/**
 * What a node says about its own load, taken from the cluster status payload
 * the health cycle already fetches. Never probed for: a synthetic request
 * competes with viewer traffic for the exact resource it claims to measure,
 * and on a weak link it consumes the capacity it is trying to observe.
 *
 * Every field is optional because a node that has not answered yet has none of
 * them, and absent must stay distinguishable from zero — a node reporting 0%
 * CPU and a node that has never been heard from are opposite situations.
 */
export interface EndpointCapacity {
  /** The node process's CPU, as the node reports it. May exceed 100 across cores. */
  cpuPercent?: number;
  /** System load average over one minute. Only comparable once divided by `cores`. */
  load1?: number;
  /**
   * How many CPUs the load is spread across.
   *
   * Load-bearing rather than decorative: `load1: 2.67` is a struggling machine
   * on two cores and an idle one on eight, and this cluster is deliberately
   * non-uniform hardware. `process_cpu_percent` has the same problem from the
   * other side — it exceeds 100 precisely because cores are not normalised out
   * of it. So the capacity comparison divides by this and abstains without it,
   * rather than making a hardware-size guess on every cycle.
   */
  cores?: number;
  storageAvailableBytes?: number;
  observedAt: number;
}

/**
 * Which comparison actually separated one endpoint from the next.
 *
 * Ranking on four axes is only debuggable if the client can say which one
 * decided. Without this an operator looking at a bad choice has to reconstruct
 * the comparator from stored evidence, which is how an afternoon of transcode
 * measurements got taken against the wrong node before anyone noticed.
 */
export type EndpointSelectionAxis =
  | 'availability'
  | 'sticky'
  | 'failures'
  | 'throughput'
  | 'latency'
  | 'capacity'
  | 'configured-order';

export interface EndpointCandidate {
  endpoint: MachaEndpoint;
  health: EndpointHealth;
  /**
   * Whether this endpoint is out of any failure cooldown as of this call.
   *
   * Answered here because it cannot be answered anywhere else: `health.retryAt`
   * is a reading of the registry's own clock, and a caller has no way to
   * compare against it — `MachaHost.now()` is a duration clock with an
   * arbitrary origin, so a caller using `Date.now()` would be comparing two
   * unrelated number lines. Without this, "is anything actually usable right
   * now" can only be approximated by "is the list empty", which is a different
   * question and answers wrong the moment a third node exists.
   */
  ready: boolean;
  /** Rolling average probe round-trip, where any probe has succeeded. */
  latencyMs?: number;
  /** Measured transfer rate, where enough transfers back it. */
  bytesPerSecond?: number;
  /** The node's own last reported load, where it has answered a status call. */
  capacity?: EndpointCapacity;
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
/**
 * Ranking thresholds, deliberately blunt for the same reason throughput's is:
 * ordering must not reshuffle on noise. Latency needs an absolute floor as
 * well as a ratio, or two nodes at 3 ms and 5 ms trade places every cycle on a
 * 40% "difference" nobody can perceive.
 */
const LATENCY_RANK_MIN_ABSOLUTE_MS = 50;
const LATENCY_RANK_MIN_RELATIVE_DIFFERENCE = 0.4;
const CAPACITY_RANK_MIN_RELATIVE_DIFFERENCE = 0.4;

/**
 * The measured axes, in the order the ranking cascade consults them. Most
 * direct first:
 *
 * - **Throughput** is the closest thing to the question actually being asked —
 *   can this link carry the bytes — so where it is known it wins.
 * - **Latency** is the only signal held about the *path*. It has to outrank
 *   capacity, because the failure this ordering exists to prevent is a
 *   healthy, lightly loaded node behind a bad wireless hop, and no
 *   server-reported metric can see that. Rank capacity above latency and the
 *   axis that is blind to the fault decides before the one that can see it.
 * - **Capacity** is last of the three, and is a comparison rather than a
 *   threshold on purpose: `load1` cannot be turned into "saturated" without a
 *   core count, which the status payload does not carry, so `load1: 2.67` is
 *   comfortable on eight cores and dire on two. A relative comparison between
 *   two nodes at least has bounded error; an absolute gate would be
 *   confidently wrong on any node whose size we guessed. If a core count ever
 *   arrives, a saturation gate ahead of latency is the better shape, because a
 *   saturated node is a harder blocker than a longer round trip.
 */
const MEASURED_AXES = ['throughput', 'latency', 'capacity'] as const;
type MeasuredAxis = typeof MEASURED_AXES[number];

/**
 * The axes settled before any measurement is consulted, in order, as the slots
 * of one sort key: reachable before cooling, the sticky preference, then —
 * among endpoints that are all cooling — whichever is ready soonest, then the
 * consecutive failure count.
 *
 * They come first because they are about whether an endpoint can be used at
 * all rather than how well it performs. They are also a total order for free:
 * each is a number compared against the same number on every other endpoint —
 * a flag, a deadline, a count — so unlike the measured axes they can be a sort
 * key rather than a filter.
 */
const ABSOLUTE_AXES: readonly EndpointSelectionAxis[] = ['availability', 'sticky', 'availability', 'failures'];

/** One endpoint on its way through the cascade, before it is described to a caller. */
interface RankEntry {
  endpoint: MachaEndpoint;
  health: EndpointHealth;
  /** Where the endpoint sits in the configured list — the last tie-break of all. */
  order: number;
}

function compareRankKeys(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function firstRankKeyDifference(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return index;
  return left.length - 1;
}

/**
 * Whether a measurement is far enough behind the best on its axis to be ranked
 * below it. Deliberately blunt on every axis, because ordering must not
 * reshuffle on noise.
 *
 * Latency needs an absolute floor as well as a ratio, or two nodes at 3 ms and
 * 5 ms trade places every probe cycle over a 40% "difference" nobody can
 * perceive. Capacity is blunter still, because it is the one measurement that
 * responds to our own routing: send work to a node and its load rises, which
 * demotes it, which moves the work away, which lowers the load, which promotes
 * it again. The minimum relative difference is the damping on that loop —
 * together with the sticky preference, which is settled before any measured
 * axis and so holds authority in place while the numbers move underneath it.
 *
 * Never true of the best value against itself, on any axis. That is what keeps
 * an elimination round from emptying the field.
 */
function materiallyWorseThanBest(axis: MeasuredAxis, value: number, best: number): boolean {
  if (axis === 'throughput') return value < best && best >= value / (1 - THROUGHPUT_MIN_RELATIVE_DIFFERENCE);
  if (axis === 'latency') {
    return value - best >= LATENCY_RANK_MIN_ABSOLUTE_MS && best <= value * (1 - LATENCY_RANK_MIN_RELATIVE_DIFFERENCE);
  }
  // Two idle nodes are not distinguishable, and a ratio against zero is not a
  // number. Neither is worth reshuffling for.
  if (value <= 0 && best <= 0) return false;
  return value > best && (value - best) / Math.max(value, best) >= CAPACITY_RANK_MIN_RELATIVE_DIFFERENCE;
}

export interface PreferredEndpointSwap {
  fromId: string;
  toId: string;
  fromLatencyMs: number;
  toLatencyMs: number;
  /** Present only where both endpoints had enough transfer evidence to compare. */
  fromBytesPerSecond?: number;
  toBytesPerSecond?: number;
  /** The nodes' own reported load at the moment of the swap, for the log line. */
  fromCapacity?: EndpointCapacity;
  toCapacity?: EndpointCapacity;
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
  private readonly capacities = new Map<string, EndpointCapacity>();
  private lastSelectionAxis?: EndpointSelectionAxis;
  private latencyAdvantageId?: string;
  private latencyAdvantageStreak = 0;
  private lastLatencySwapAt?: number;

  /**
   * **Omitting `bandwidth` silently disables the throughput axis**, and
   * throughput is the axis documented as outranking latency. `bytesPerSecond`
   * then returns `undefined` for every endpoint, the first measured axis
   * eliminates nobody, and ranking falls through to latency. Nothing errors
   * and nothing logs — the phone client has run this way throughout and
   * reports it was invisible from the call site, which is why this note is
   * here rather than only in the README.
   *
   * **Supplying it is not sufficient either.** For throughput to rank anything
   * a host must do four things, and core does none of them for you:
   *
   * 1. construct an `EndpointBandwidth`,
   * 2. pass it here,
   * 3. call `record()` on it — **nothing in this package ever does**, and
   * 4. do so at least `THROUGHPUT_MIN_SAMPLES` (2) times *in the current
   *    session*, because `EndpointBandwidth.restore()` re-enters a persisted
   *    record at `samples: 1`, one short of the threshold, so throughput
   *    restored from storage never ranks on its own.
   *
   * Step 4 deserves its own warning: **a host that records once per session
   * looks fully wired and ranks nothing, for ever.** Neither the threshold nor
   * `restore()`'s re-entry at one sample is discoverable from the call site.
   *
   * Steps 3 and 4 were already recorded separately as small defects. Together
   * with this parameter being optional they are one thing, and the web client
   * has been bitten by a partial version of it — its bandwidth record
   * described only JSON bytes until a media feed was added, and it spent an
   * afternoon streaming from the slowest node it had. Degrading to latency
   * when an axis has no evidence is correct behaviour, and is why none of this
   * announced itself.
   */
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
    for (const id of this.capacities.keys()) if (!retained.has(id)) this.capacities.delete(id);
    this.bandwidth?.retain(retained);
    if (this.preferredId && !retained.has(this.preferredId)) this.preferredId = undefined;
    if (this.latencyAdvantageId && !retained.has(this.latencyAdvantageId)) {
      this.latencyAdvantageId = undefined;
      this.latencyAdvantageStreak = 0;
    }
    this.notify();
  }

  /**
   * Fires on **every** change to endpoint state, not only on membership.
   *
   * That includes each probe success and failure, so with a ten-second health
   * cycle a listener sees one notification per endpoint per cycle even when
   * nothing an observer would call different has happened — only
   * `lastSuccessAt` moved. That is deliberate: a listener rendering health
   * wants exactly those, and the registry cannot know which subset any
   * particular listener cares about.
   *
   * It does mean a listener that *writes* on notification must diff first, or
   * it will write on every probe forever. `persistConfirmedEndpoints` is the
   * worked example: it recomputes the confirmed list and returns without
   * touching storage unless the list itself moved.
   */
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
    const entries = this.endpoints
      .filter((endpoint) => !excludedIds.has(endpoint.id))
      .map((endpoint, order) => ({
        endpoint,
        health: { ...(this.health.get(endpoint.id) ?? { consecutiveFailures: 0 }) },
        order,
      }));

    const { ordered, axis } = this.rank(entries, now);

    // The axis that separated the winner from the runner-up is the one that
    // actually decided; the rest never got a say. Read off the ranking that
    // produced this order rather than recomputed afterwards from the top two,
    // so it cannot disagree with the list it describes. Recorded rather than
    // returned so the ordinary call site stays a list of candidates.
    this.lastSelectionAxis = entries.length === 0 ? undefined : axis;

    return ordered.map(({ endpoint, health }) => this.describe(endpoint, health, now));
  }

  /**
   * Rank every candidate, and report which axis separated the head from the
   * runner-up.
   *
   * The measured axes eliminate against the *best* value still in contention
   * rather than comparing pairs, because a threshold applied pairwise is not a
   * consistent order. At 20/65/110 ms with a 50 ms floor, A ties B and B ties
   * C while A beats C: `sort` is handed a cycle, its output becomes
   * implementation-defined, and which node ends up at the head depends on the
   * order the endpoints happened to be configured in — the WAN node can win
   * while `selectionAxis()` reports that no measurement decided anything. This
   * is the fault the cascade was built to prevent, arriving through the
   * comparator itself; see *Routing on evidence* in `HISTORY.md`.
   *
   * Against a single reference the same threshold is a total preorder: an
   * endpoint either is within it of the best or it is not, and that answer
   * does not depend on which other endpoint it is asked about.
   *
   * The best is always taken within the surviving pool and never globally, so
   * evidence from an endpoint already out of contention — a node in a failure
   * cooldown that happens to have the fastest link — cannot eliminate a
   * healthy one.
   */
  private rank(entries: RankEntry[], now: number): { ordered: RankEntry[]; axis: EndpointSelectionAxis } {
    if (entries.length === 0) return { ordered: [], axis: 'configured-order' };
    const keyed = entries.map((entry) => ({ entry, key: this.absoluteKey(entry, now) }));
    keyed.sort((left, right) => compareRankKeys(left.key, right.key) || left.entry.order - right.entry.order);

    const ordered: RankEntry[] = [];
    let axis: EndpointSelectionAxis = 'configured-order';
    let tierStart = 0;
    for (let index = 1; index <= keyed.length; index += 1) {
      if (index < keyed.length && compareRankKeys(keyed[tierStart].key, keyed[index].key) === 0) continue;
      const tier = keyed.slice(tierStart, index).map(({ entry }) => entry);
      const ranked = this.rankTier(tier, 0);
      if (tierStart === 0) {
        // The runner-up is either inside this first tier, in which case the
        // measured cascade separated them, or it is the head of the next tier
        // and one of the absolute axes did.
        axis = tier.length > 1
          ? ranked.axis
          : keyed.length > 1
            ? ABSOLUTE_AXES[firstRankKeyDifference(keyed[0].key, keyed[1].key)]
            : 'configured-order';
      }
      ordered.push(...ranked.ordered);
      tierStart = index;
    }
    return { ordered, axis };
  }

  /**
   * The absolute axes as one sort key, in the order `ABSOLUTE_AXES` names
   * them. The cooldown deadline is flattened to zero for a reachable endpoint,
   * so it only ever separates endpoints that are all still cooling — the
   * availability slot above it has already dealt with the mixed case.
   */
  private absoluteKey(entry: RankEntry, now: number): number[] {
    const ready = (entry.health.retryAt ?? 0) <= now;
    return [
      ready ? 0 : 1,
      entry.endpoint.id === this.preferredId ? 0 : 1,
      ready ? 0 : entry.health.retryAt ?? 0,
      entry.health.consecutiveFailures,
    ];
  }

  /**
   * Order one tier — endpoints no absolute axis could separate — by the
   * measured cascade, reporting the axis that separated its own head from its
   * own runner-up.
   *
   * Each round keeps whatever is within threshold of the best and pushes the
   * rest behind it, then re-runs the *same* axis on those: the best of the
   * eliminated can still be materially ahead of the rest of them, and a
   * candidate list is walked to the end on failover, so the tail is an
   * ordering question and not a discard.
   */
  private rankTier(tier: RankEntry[], axisIndex: number): { ordered: RankEntry[]; axis: EndpointSelectionAxis } {
    if (tier.length <= 1 || axisIndex >= MEASURED_AXES.length) {
      return { ordered: [...tier].sort((left, right) => left.order - right.order), axis: 'configured-order' };
    }
    const axis = MEASURED_AXES[axisIndex];
    const { kept, dropped } = this.eliminateAgainstBest(tier, axis);
    if (dropped.length === 0) return this.rankTier(tier, axisIndex + 1);
    const ahead = this.rankTier(kept, axisIndex + 1);
    const behind = this.rankTier(dropped, axisIndex);
    return {
      ordered: [...ahead.ordered, ...behind.ordered],
      // With more than one survivor the head and the runner-up are both in it,
      // so whatever separated them is further down the cascade. With exactly
      // one, this axis is what put the next endpoint behind it.
      axis: kept.length > 1 ? ahead.axis : axis,
    };
  }

  /**
   * Split a tier into what is still in contention on one axis and what the
   * best value on it eliminates.
   *
   * An endpoint with no evidence on an axis is never eliminated by it: absent
   * is not a poor measurement, and a node that has not been probed yet must
   * not be ranked as though it had been and done badly. It carries on to the
   * next axis alongside the best, which is what the pairwise comparator did
   * for the same reason.
   */
  private eliminateAgainstBest(tier: RankEntry[], axis: MeasuredAxis): { kept: RankEntry[]; dropped: RankEntry[] } {
    const valued = tier.map((entry) => ({ entry, value: this.axisValue(entry.endpoint.id, axis) }));
    const measured = valued.map(({ value }) => value).filter((value): value is number => value !== undefined);
    if (measured.length === 0) return { kept: tier, dropped: [] };
    const best = axis === 'throughput' ? Math.max(...measured) : Math.min(...measured);

    const kept: RankEntry[] = [];
    const dropped: RankEntry[] = [];
    for (const { entry, value } of valued) {
      const eliminated = value !== undefined && materiallyWorseThanBest(axis, value, best);
      (eliminated ? dropped : kept).push(entry);
    }
    return { kept, dropped };
  }

  /** The evidence one axis ranks on, or undefined where this endpoint has none of it yet. */
  private axisValue(endpointIdValue: string, axis: MeasuredAxis): number | undefined {
    if (axis === 'throughput') return this.bytesPerSecond(endpointIdValue);
    if (axis === 'latency') return this.latencyMs(endpointIdValue);
    return this.loadPerCore(endpointIdValue);
  }

  private describe(endpoint: MachaEndpoint, health: EndpointHealth, now: number): EndpointCandidate {
    const latencyMs = this.latencyMs(endpoint.id);
    const bytesPerSecond = this.bytesPerSecond(endpoint.id);
    const capacity = this.capacities.get(endpoint.id);
    return {
      endpoint,
      health,
      ready: (health.retryAt ?? 0) <= now,
      ...(latencyMs !== undefined ? { latencyMs } : {}),
      ...(bytesPerSecond !== undefined ? { bytesPerSecond } : {}),
      ...(capacity ? { capacity: { ...capacity } } : {}),
    };
  }

  /**
   * Which axis decided the current head of `candidates()`, as of the last call.
   *
   * Undefined before any call, and when only one endpoint is known there is
   * nothing to have decided — `configured-order` is reported for that case,
   * since the list is what put it there.
   */
  selectionAxis(): EndpointSelectionAxis | undefined {
    return this.lastSelectionAxis;
  }

  /** Record a node's self-reported load, from the status call the health cycle already makes. */
  recordCapacity(endpointIdValue: string, capacity: EndpointCapacity): void {
    this.capacities.set(endpointIdValue, capacity);
  }

  /** The node's last self-reported load, or undefined if it has never answered. */
  capacity(endpointIdValue: string): EndpointCapacity | undefined {
    const value = this.capacities.get(endpointIdValue);
    return value ? { ...value } : undefined;
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
   * Load per CPU, or undefined where the node has not said enough to compute it.
   *
   * `load1` describes the machine and `process_cpu_percent` describes one
   * process, so `load1` is preferred; both are divided by the core count
   * because neither means anything without it. No fallback to raw values: a
   * comparison between two machines of unknown and probably different size is
   * not a comparison, and this axis staying inert until the count arrives is
   * the honest behaviour rather than a degraded one.
   */
  private loadPerCore(endpointIdValue: string): number | undefined {
    const capacity = this.capacities.get(endpointIdValue);
    if (!capacity?.cores || capacity.cores <= 0) return undefined;
    if (capacity.load1 !== undefined) return capacity.load1 / capacity.cores;
    if (capacity.cpuPercent !== undefined) return capacity.cpuPercent / 100 / capacity.cores;
    return undefined;
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
    const fromCapacity = this.capacity(this.preferredId);
    const toCapacity = this.capacity(best.id);
    const swap: PreferredEndpointSwap = {
      fromId: this.preferredId,
      toId: best.id,
      fromLatencyMs: preferredLatency,
      toLatencyMs: best.latencyMs,
      ...(fromBytesPerSecond !== undefined ? { fromBytesPerSecond } : {}),
      ...(toBytesPerSecond !== undefined ? { toBytesPerSecond } : {}),
      ...(fromCapacity ? { fromCapacity } : {}),
      ...(toCapacity ? { toCapacity } : {}),
      reason: best.reason,
    };
    this.preferredId = best.id;
    this.lastLatencySwapAt = now;
    resetAdvantage();
    this.notify();
    return swap;
  }

  snapshot(): EndpointCandidate[] {
    const now = this.now();
    return this.endpoints.map((endpoint) => this.describe(
      endpoint,
      { ...(this.health.get(endpoint.id) ?? { consecutiveFailures: 0 }) },
      now,
    ));
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

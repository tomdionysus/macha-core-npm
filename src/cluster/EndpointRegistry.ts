import { normalizeBaseUrl } from '../api/httpCompat.js';
import { createClientLogger } from '../diagnostics/ClientLog.js';
import type { EndpointBandwidth } from './EndpointBandwidth.js';

export type EndpointSource = 'bootstrap' | 'environment' | 'discovered';

export interface MachaEndpoint {
  /**
   * How this endpoint is addressed, and what everything here keys on.
   *
   * **An address, not a machine.** It is derived from the base URL an operator
   * configured or a node advertised, so one node reached two ways has two of
   * these. Health, cooldown, latency, capacity and session provenance are all
   * per address, correctly — a LAN path and a WAN path to the same box really
   * do have different round trips and can fail independently.
   *
   * Group by `nodeId` when the question is about the machine.
   */
  id: string;
  baseUrl: string;
  source: EndpointSource;
  /**
   * Which node this address reaches, as the node itself states it.
   *
   * **The answer to "are these two entries the same box?", and the only
   * reliable one.** `id` cannot answer it: `http://10.44.1.50:7438` and
   * `https://macnessa.macha.network` are one machine and share nothing a
   * client could match on. Before this was populated the registry held that
   * node twice — counted twice in any per-node total, offered twice in a node
   * selector, and a failover could "move" to the box it had just left.
   *
   * Anything a host presents or totals *per node* groups on this and not on
   * `id`. Anything about a path — health, latency, which door to dial — stays
   * on `id`.
   *
   * Learned two ways, both from the node: the membership advertisement, which
   * matches a node's own `api_endpoint`, and `identifyUnclaimedEndpoints`,
   * which asks an endpoint that matched nothing which node it is. Never
   * inferred from the address, because two addresses that look unrelated may
   * be one node and guessing merges two that are not.
   *
   * `undefined` means not yet learned — an endpoint configured this instant,
   * or one that has not answered. It is never a claim that the endpoint has no
   * node.
   */
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
 * The deadlines a node enforces on itself, as it last reported them.
 *
 * **Deliberately not folded into `EndpointCapacity`.** Capacity is measured
 * evidence about how hard a node is working and is used to rank candidates;
 * this is stated policy about how long it will wait before giving up, and is
 * used to set deadlines. Ranking on a deadline or timing out on a load average
 * would both be category errors, and one type holding both invites exactly
 * that.
 *
 * Each field is independently optional because the node may be too old to
 * report either. **Absent never shortens a deadline** — a missing figure falls
 * back to the conservative published default, never to zero and never to
 * whatever the last node happened to say.
 */
export interface EndpointPlaybackBudgets {
  /** The node's `startup_timeout_ms`: how long it may take to bring a stream up. */
  startupTimeoutMs?: number;
  /** The node's `segment_timeout_ms`: how long it holds a fragment it has not produced. */
  segmentTimeoutMs?: number;
  /**
   * The node's `pipeline_idle_ms`: how long it keeps an idle transcode engine
   * before reclaiming it. Bounds how long a standby prepared here is worth
   * holding — see `ALTERNATE_RECOVERY_WINDOW_MS`.
   */
  pipelineIdleMs?: number;
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
/**
 * What a generation start involves, which is what decides how long it takes.
 *
 * Kept apart because they differ by an order of magnitude on one node: a
 * software HEVC re-encode against a stream copy is seconds against fractions
 * of one. One figure per node would describe neither.
 */
export type GenerationStartKind = 'video-transcode' | 'video-copy' | 'remux';

/** How many recent starts per node and kind make an estimate. */
export const GENERATION_START_SAMPLES = 5;

/**
 * How long a start measurement stays evidence.
 *
 * A node's start cost moves with its load: another viewer's transcode on the
 * same box is the difference between the two figures the web client measured
 * on gbni-1. Old samples describe a load that has gone, so they are dropped
 * rather than averaged in. Thirty minutes is a guess at "recent", not a server
 * figure; nothing on the wire says how long contention lasts.
 */
export const GENERATION_START_EVIDENCE_TTL_MS = 30 * 60_000;

interface GenerationStartSample {
  ms: number;
  at: number;
}

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
 *
 * **Two is not the low bar it reads as, and this is the part to know.** A
 * sample is a body read of at least `MIN_SAMPLE_BYTES` (32 KB) that went
 * through `readJsonBody` — a catalogue listing or a search big enough to
 * qualify — or a media transfer a host fed in through
 * `recordTransferByUrl`. **The health cycle produces none**: its probes and
 * the ten-second status call are small, and a small transfer measures
 * round-trip time and handler cost rather than throughput. So an endpoint can
 * be probed every ten seconds for an hour and still have nothing here.
 *
 * And a *restored* record re-enters at one sample whatever history it holds
 * (`EndpointBandwidth.restore`), deliberately, so that a stale reading cannot
 * outvote a live link — which means a client that reloads before its second
 * large read of the session is back to ranking without this axis. A client
 * that browses little and streams through a host that does not call
 * `recordTransferByUrl` may never reach two at all.
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
 * `scheme://host:port` for a base URL, with the scheme's default port filled
 * in and the host lowercased — the thing two spellings of one address agree
 * about.
 *
 * Used for matching advertisements to configured endpoints, never for
 * identity: `MachaEndpoint.id` stays the configured string, because that is
 * what an operator typed and what every log, health record and session id
 * already keys on. Two addresses that share an authority are the same door to
 * the same node; two that do not may still be the same node, and nothing in a
 * status payload says so — see the note on `nodeId`.
 *
 * Returns `undefined` for anything unparseable rather than guessing, so a
 * malformed entry simply matches nothing.
 */
function endpointAuthority(baseUrl: string): string | undefined {
  try {
    // `origin` already is this: it drops a default port, lowercases the host
    // and keeps the scheme. Spelling it out by hand was both more code and
    // less portable — `protocol` and `hostname` are DOM-only, and this package
    // is typechecked a second time against a runtime that has neither.
    const origin = new URL(baseUrl).origin;
    return origin && origin !== 'null' ? origin : undefined;
  } catch {
    return undefined;
  }
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
  private readonly playbackBudgetsById = new Map<string, EndpointPlaybackBudgets>();
  private readonly generationStarts = new Map<string, GenerationStartSample[]>();
  private lastSelectionAxis?: EndpointSelectionAxis;
  private readonly log = createClientLogger('endpoint-registry');
  /** So the abstention is reported once rather than on every probe cycle. */
  private throughputAbstentionReported = false;
  private latencyAdvantageId?: string;
  private latencyAdvantageStreak = 0;
  private lastLatencySwapAt?: number;

  /**
   * Throughput is not a constructor concern. `createMachaServices` attaches
   * the store and installs the recorder, so the axis the cascade documents as
   * outranking latency is on by default rather than on if a host completed
   * four steps it could not see from here. That parameter used to exist;
   * two of three clients never passed it and never knew the axis was dark.
   */
  private bandwidth?: EndpointBandwidth;

  constructor(
    endpoints: readonly MachaEndpoint[],
    /**
     * **Epoch milliseconds, and a wall clock rather than a duration clock.**
     *
     * `lastSuccessAt`, `lastFailureAt` and `observedAt` are read beside a
     * node's own journal and are persisted across restarts, so they have to
     * mean the same thing to two machines. A host that passes
     * `performance.now` — an arbitrary origin that resets each run — gets
     * health readings that render as 1970 and comparisons that silently
     * compare a duration against an instant. `MachaHost.now()` is that clock
     * and is not this one.
     *
     * **Epoch across every boundary, and formatting only at the edge.** Macha
     * spans sites in different timezones — three nodes in three zones on this
     * cluster — and epoch milliseconds are what make a client reading and a
     * node reading agree at all, because they carry no zone to get wrong.
     * Nothing in this package turns one into a wall-clock string.
     *
     * A host that does has two cases and they take different formats.
     * **Presentation** — a person asking when a node was last seen — is their
     * own zone, **labelled with it**: `21 Sep 2026, 18:51:52 GMT+3`. A viewer
     * should not have to convert their own clock, and the label is what stops
     * it being read as the node's time. **Interchange** — a log line, anything
     * handed to another machine, anything that will be read beside a node's
     * journal — is Zulu, because that is where an unlabelled local time turns
     * into an hour that silently disappears. Timezones are a presentation
     * problem; the data is never in one.
     */
    private readonly now: () => number = Date.now,
  ) {
    this.endpoints = this.deduplicate(endpoints);
  }

  replace(endpoints: readonly MachaEndpoint[]): void {
    this.endpoints = this.deduplicate(endpoints);
    const retained = new Set(this.endpoints.map((endpoint) => endpoint.id));
    for (const id of this.health.keys()) if (!retained.has(id)) this.health.delete(id);
    for (const id of this.latencySamples.keys()) if (!retained.has(id)) this.latencySamples.delete(id);
    for (const id of this.capacities.keys()) if (!retained.has(id)) this.capacities.delete(id);
    for (const id of this.playbackBudgetsById.keys()) if (!retained.has(id)) this.playbackBudgetsById.delete(id);
    for (const key of this.generationStarts.keys()) if (!retained.has(key.slice(0, key.lastIndexOf('|')))) this.generationStarts.delete(key);
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
    // A second index, by authority rather than by string. `normalizeBaseUrl`
    // only trims trailing slashes, so `https://node` and `https://node:443`
    // are two different keys for one address and an endpoint configured as
    // either misses an advertisement written as the other — it then keeps no
    // `nodeId` at all, and anything grouping by node counts one machine twice.
    //
    // **Matching only, never minting.** This changes which *configured*
    // endpoint an advertisement attaches to; it does not add a URL. An
    // unmatched advertisement still becomes a discovered endpoint by its own
    // advertised string, so nothing here can invent a plaintext address for a
    // node someone deliberately put behind TLS — which is the reason the
    // monitor advertises one URL per node in the first place.
    const advertisedByAuthority = new Map<string, string | undefined>();
    for (const advertisement of advertisements) {
      for (const value of advertisement.apiBaseUrls) {
        const baseUrl = normalizeBaseUrl(value);
        if (!baseUrl) continue;
        if (!advertisedByUrl.has(baseUrl)) advertisedByUrl.set(baseUrl, advertisement.nodeId);
        const authority = endpointAuthority(baseUrl);
        if (authority && !advertisedByAuthority.has(authority)) {
          advertisedByAuthority.set(authority, advertisement.nodeId);
        }
      }
    }

    const retained = this.endpoints
      .filter((endpoint) => endpoint.source !== 'discovered')
      .map((endpoint) => {
        const authority = endpointAuthority(endpoint.baseUrl);
        const nodeId = advertisedByUrl.get(endpoint.baseUrl)
          ?? (authority ? advertisedByAuthority.get(authority) : undefined);
        advertisedByUrl.delete(endpoint.baseUrl);
        // Claimed by authority as well, so a URL that matched this way is not
        // then also minted as a discovered endpoint under its other spelling.
        if (authority) {
          for (const [url, id] of [...advertisedByUrl]) {
            if (id === nodeId && endpointAuthority(url) === authority) advertisedByUrl.delete(url);
          }
        }
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

  /**
   * Record which node an endpoint already in the registry reaches.
   *
   * **Not `applyAdvertisement`, and the difference is not cosmetic.** That one
   * states the whole of membership: whatever it is not told about is dropped,
   * because a node missing from a fresh cluster view has genuinely gone. Call
   * it with a partial list and every discovered endpoint outside that list
   * disappears — a three-node cluster collapsing to one, sessions keyed to the
   * endpoints that vanished going with it.
   *
   * Identity is not membership. Learning that one address is `gbni-1` says
   * nothing about whether the other nodes still exist, so it cannot be
   * expressed as a membership statement. This attaches the id and changes
   * nothing else: no endpoint added, none removed, none reordered.
   *
   * A no-op when the endpoint is unknown or already carries this id.
   */
  claimNodeId(baseUrl: string, nodeId: string): void {
    const target = normalizeBaseUrl(baseUrl);
    const authority = endpointAuthority(target);
    let changed = false;
    const next = this.endpoints.map((endpoint) => {
      const matches = endpoint.baseUrl === target
        || (authority !== undefined && endpointAuthority(endpoint.baseUrl) === authority);
      if (!matches || endpoint.nodeId === nodeId) return endpoint;
      changed = true;
      return { ...endpoint, nodeId };
    });
    if (!changed) return;
    this.replace(next);
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
    if (entries.length > 1 && axis === 'configured-order') this.reportThroughputAbstention();

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
   * Say so, once, when configuration order decided a ranking that the primary
   * measured axis was never able to weigh in on.
   *
   * **`configured-order` used to be indistinguishable from two different
   * situations**: every axis was consulted and none separated the endpoints,
   * or the axis the cascade documents as primary had no data to consult.
   * Throughput is the one that goes missing silently — it needs a store the
   * host may never have supplied, and transfers recorded into it — so the
   * ranking falls through and nothing says why. Two of three clients ran that
   * way without noticing. `capacity` already abstains visibly without a core
   * count; this is the same courtesy for the axis above it.
   */
  private reportThroughputAbstention(): void {
    if (this.throughputAbstentionReported) return;
    this.throughputAbstentionReported = true;
    if (!this.bandwidth) {
      this.log.warn('throughput-unavailable', {
        reason: 'no-bandwidth-store',
        detail: 'Ranking fell through to configuration order and throughput could not be consulted: no EndpointBandwidth is attached to this registry.',
      });
      return;
    }
    this.log.warn('throughput-unavailable', {
      reason: 'insufficient-samples',
      minimumSamples: THROUGHPUT_MIN_SAMPLES,
      detail: 'Ranking fell through to configuration order and no endpoint has enough recorded transfers for throughput to rank.',
    });
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

  /**
   * Attach the throughput store this registry ranks on. Called by
   * `createMachaServices`; a host does not need to.
   *
   * **Refuses a second store, and that is the point.** Two `EndpointBandwidth`
   * instances for one client serialise the same record map to
   * `macha-client-bandwidth:<clientId>` and clobber each other. Services are
   * rebuilt when routing changes, so this can be reached again for the same
   * registry; the first store stays and the call reports `false`.
   */
  attachBandwidth(bandwidth: EndpointBandwidth): boolean {
    if (this.bandwidth) return false;
    this.bandwidth = bandwidth;
    return true;
  }

  /** Whether throughput is even recordable — false when no store was ever supplied. */
  get throughputRecordable(): boolean {
    return this.bandwidth !== undefined;
  }

  /**
   * Feed a completed transfer to the throughput axis, resolving the endpoint
   * from the URL it was fetched from.
   *
   * **This is the seam for bytes core cannot see.** Core records its own JSON
   * reads automatically; it never fetches media. The web client's Direct Play
   * read-ahead worker does, and until it fed those bytes in, its throughput
   * record described only JSON — a node serving nothing but media had no
   * evidence against it and the client spent an afternoon streaming from its
   * slowest node. A host with media-byte evidence calls this. It is the only
   * throughput wiring a host does, and it is additive: nothing else to build,
   * pass, install or match.
   *
   * **It is also the only thing that produces throughput samples on a client
   * that mostly streams.** A sample needs 32 KB of body in one read; the
   * health cycle's probes and status calls are far too small to make one, and
   * a viewer who opens the app on the screen they left it on may make no
   * qualifying catalogue read at all. Without this call that client ranks
   * endpoints with the throughput axis permanently dark, and nothing says so
   * beyond one `throughput-unavailable` line.
   */
  recordTransferByUrl(url: string, bytes: number, durationMs: number): void {
    if (!this.bandwidth) return;
    const endpoint = this.endpoints.find((candidate) => url.startsWith(`${candidate.baseUrl}/`) || url === candidate.baseUrl);
    if (endpoint) this.bandwidth.record(endpoint.id, bytes, durationMs);
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

  /**
   * Record the deadlines a node reports for itself, from the status call the
   * health cycle already makes.
   *
   * **Replaces rather than merges.** These follow the node's `reconfigure()`,
   * so a field that has stopped being reported has stopped being true, and
   * keeping the last value would let a figure outlive the configuration that
   * produced it.
   */
  recordPlaybackBudgets(endpointIdValue: string, budgets: EndpointPlaybackBudgets): void {
    this.playbackBudgetsById.set(endpointIdValue, budgets);
  }

  /**
   * What this node last said its playback deadlines are, or undefined where it
   * has never said.
   *
   * Undefined is not an error and not a default: it is the answer for a node
   * too old to report, one running with streaming disabled, and one this client
   * has not yet heard a status call about. Callers apply the conservative
   * published floor rather than inventing a figure.
   */
  playbackBudgets(endpointIdValue: string): EndpointPlaybackBudgets | undefined {
    const value = this.playbackBudgetsById.get(endpointIdValue);
    return value ? { ...value } : undefined;
  }

  /**
   * Record how long a generation start took on this node.
   *
   * **Nothing feeds this yet.** Core measured it with a `bytes=0-0` readiness
   * probe until Tom ruled that out on 2026-09-23; where the figure comes from
   * instead is with the server. Kept because it is where that figure lands and
   * what `moveTo`'s estimate reads. Anything non-finite or negative is refused
   * rather than stored, because it would become a lead.
   */
  recordGenerationStart(endpointIdValue: string, kind: GenerationStartKind, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    const key = `${endpointIdValue}|${kind}`;
    const samples = [...(this.generationStarts.get(key) ?? []), { ms, at: this.now() }];
    this.generationStarts.set(key, samples.slice(-GENERATION_START_SAMPLES));
  }

  /**
   * The longest recent start of this kind on this node, or undefined.
   *
   * **The longest, not the mean,** because the two ways of being wrong cost
   * differently. Estimating long makes a move ask for a generation further
   * ahead, which the outgoing source's runway pays for, and a move that cannot
   * afford it declines. Estimating short makes the join start behind the viewer,
   * and a node that produces at no better than realtime never catches up: the
   * freeze this exists to prevent.
   *
   * **Undefined means unknown, never zero.** A node with no recent start of this
   * kind gets no estimate, and a move there behaves as it did before this
   * existed, because a figure borrowed from another node would be describing a
   * different machine.
   */
  generationStartEstimate(endpointIdValue: string, kind: GenerationStartKind): number | undefined {
    const cutoff = this.now() - GENERATION_START_EVIDENCE_TTL_MS;
    const recent = (this.generationStarts.get(`${endpointIdValue}|${kind}`) ?? []).filter((sample) => sample.at >= cutoff);
    return recent.length === 0 ? undefined : Math.max(...recent.map((sample) => sample.ms));
  }

  recordSuccess(endpointIdValue: string): void {
    this.recordHealthy(endpointIdValue, true);
  }

  /**
   * Route to this endpoint by preference, without claiming anything happened.
   *
   * **The third case, and core had two.** `recordSuccess` sets the sticky
   * endpoint *and* writes a successful round trip; `recordProbeSuccess` writes
   * the round trip and leaves the sticky endpoint alone. There was no way to
   * express the remaining combination — move the preference, assert nothing —
   * so a caller wanting it reached for `recordSuccess`, which zeroes
   * `consecutiveFailures` and dates a `lastSuccessAt` that never occurred.
   * That reaches a Status screen as evidence, and it is fabricated.
   *
   * **A viewer choosing a node is not evidence about the node.** This is the
   * case that found it: a node selector in the web client had no other public
   * door, and subclassed the registry rather than lie through this one. The
   * asymmetry was already half-noticed — the comment on `recordProbeSuccess`
   * has been saying "health probes must not reshuffle the sticky endpoint"
   * since it was written, which is this same distinction seen from the other
   * side.
   *
   * **Preference does not outrank readiness**, and deliberately: `absoluteKey`
   * sorts on availability first and preference second, so a chosen endpoint
   * that is cooling down still ranks below a ready one and failover still
   * walks away from it. A choice is a tie-break among nodes that can serve,
   * never an instruction to use one that cannot.
   *
   * Unknown ids are ignored rather than stored. `replace` already drops a
   * preference for an endpoint that has gone, and accepting one for an
   * endpoint that never existed would hold a routing instruction that can
   * never match and never expire.
   */
  prefer(endpointIdValue: string): void {
    if (!this.endpoints.some((endpoint) => endpoint.id === endpointIdValue)) return;
    if (this.preferredId === endpointIdValue) return;
    this.preferredId = endpointIdValue;
    this.notify();
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

  /**
   * Publish to listeners without letting one of them break the caller.
   *
   * A host listener that throws used to turn a `route()` that had *succeeded*
   * into a rejection — the recording happens on the success path — and could
   * take the health loop down with it. Presentation cannot be allowed to
   * break routing: the same posture `publishConnectionState` has always
   * taken, and for the same reason. Copied before iterating, since a listener
   * may unsubscribe itself on delivery.
   */
  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        this.log.warn('endpoint-listener-failed', { error });
      }
    }
  }
}

import { machaHost } from '../runtime/host.js';
import type { StorageLike } from './storage.js';

/**
 * Not scoped by client id, unlike every other store here.
 *
 * The others hold a viewer's data — a queue, a volume, watch history — and two
 * clients sharing a browser profile must not read each other's. This holds an
 * *ordering hint* about a cluster both of them are talking to, and either
 * answer is correct for either client. Scoping it would cost a plumbed client
 * id for no benefit, and the worst a shared value can do is cost one client a
 * single re-download.
 */
export const ARTWORK_HOST_KEY = 'macha.artworkHost.v1';

/**
 * The path every node serves artwork under. Splitting on it recovers the node
 * base — including any path prefix in front of it, which a reverse proxy may
 * add and which `artworkUrls` is careful to preserve.
 */
const ARTWORK_PATH = '/api/v1/catalogue/artwork/';

/** The node base a full artwork URL was served from, or `undefined` if it is not one. */
export function artworkHostOf(url: string): string | undefined {
  const index = url.indexOf(ARTWORK_PATH);
  return index > 0 ? url.slice(0, index) : undefined;
}

/**
 * Which node this client should keep asking for artwork.
 *
 * **This is not a cache and not a choice of node. It removes a variable from a
 * URL that is otherwise already a content address.** A signed artwork URL is
 * `{host}/api/v1/catalogue/artwork/{sha256}?exp&sig` — the path is the SHA-256
 * of the bytes, and the signature covers the id and the expiry and *never the
 * host*, so one capability is good on every node. Every component is already
 * stable except the host.
 *
 * The host was varying by accident rather than by decision. `artworkUrls`
 * ordered its candidates by the *streaming* preferred endpoint, and the
 * capability URL in a catalogue payload is absolutised against whichever node
 * answered that catalogue read. So a pre-emptive endpoint swap renamed every
 * poster on screen, and a platform HTTP cache — which keys on the whole URL
 * and which this package neither owns nor can re-key — re-downloaded bytes it
 * already held.
 *
 * Measured on the web client: one swap, then 29 posters re-fetched at 2.7–3.0 s
 * each. Same artwork id, same `?exp&sig`, three hosts, byte-identical — 3 ms
 * from disk cache on the node already held against 923 ms over the wire on
 * another. **The bytes were in the cache the whole time.** The irony is the
 * argument: the swap is chosen *for throughput*, and "this node is faster" is a
 * claim about streaming video that says nothing about whose artwork this
 * viewer's browser is already holding.
 *
 * **Sticky rather than deterministic, deliberately.** A canonical host — the
 * lowest endpoint id, say — would make the URL a pure function of the content
 * and the node set, which sounds better and is worse: every key would change
 * at once whenever the set changed, and a node that is down would fail every
 * poster until the walk moved past it, losing the warm cache exactly when it
 * is needed. The goal is warmth, not determinism. Keep asking whoever last
 * answered, because that is whose bytes are already here.
 *
 * **It needs no failure handling**, which is what makes it safe. It orders
 * candidates the cluster already offered rather than choosing among nodes, so
 * a host that is down, cooling off, or gone from the registry contributes no
 * candidate and the ordinary order and ordinary failover apply untouched.
 * Preference follows success only: a single artwork 404 never moves it, and
 * nothing here can make an image fail that would otherwise have loaded.
 */
/**
 * How much faster another node must measure before artwork moves to it: the
 * same bar endpoint ranking applies to latency, both an absolute and a
 * relative gap, so that two LAN nodes at 3 ms and 5 ms never trade places.
 */
const ARTWORK_HOST_MIN_GAIN_MS = 50;
const ARTWORK_HOST_MIN_RELATIVE_GAIN = 0.4;

export class ArtworkHostPreference {
  private value?: string;
  private loaded = false;
  private chosen = false;
  /** Set when `chooseOnce` moved the preference; see `noteLoaded`. */
  private switched = false;

  constructor(private readonly storage: StorageLike | undefined = machaHost().storage) {}

  /** The node base to try first, or `undefined` before anything has succeeded. */
  get(): string | undefined {
    if (!this.loaded) {
      this.loaded = true;
      try {
        this.value = this.storage?.getItem(ARTWORK_HOST_KEY) || undefined;
      } catch {
        // An unreadable store costs cache warmth and nothing else.
      }
    }
    return this.value;
  }

  /**
   * Record that this URL served artwork successfully.
   *
   * Takes the full URL rather than a node base so a caller can pass back
   * exactly what it loaded, without having to know how the URL was assembled
   * or which registry entry it came from. A URL that is not an artwork URL is
   * ignored rather than stored.
   */
  noteLoaded(url: string): void {
    const host = artworkHostOf(url);
    if (!host || host === this.get()) return;
    // After a deliberate switch, a load from elsewhere is almost always one
    // started before it, finishing late, and following it would undo the
    // switch within the run. The chosen host still leads every list, and a
    // poster it cannot serve still falls through to the next.
    if (this.switched) return;
    this.set(host);
  }

  private set(host: string): void {
    this.value = host;
    this.loaded = true;
    try {
      this.storage?.setItem(ARTWORK_HOST_KEY, host);
    } catch {
      // Held in memory for this run regardless; the next start simply
      // re-learns it from the first poster that loads.
    }
  }

  /**
   * Once per run, move artwork to a node that is materially cheaper for this
   * viewer to reach than the one it would otherwise come from.
   *
   * **Stickiness alone kept whichever node served first, and that was chosen
   * by accident.** The signed URL is absolutised against whichever node
   * answered the catalogue read, and it leads, so the first poster to load
   * pinned that node for good. Measured by the web client from the fi-1 site,
   * 2026-09-24: every poster came from macnessa (https, ~90 ms round trip,
   * 636 ms median per cold poster) while fi-1 on the LAN served the identical
   * signed URL in 65 ms cold and ~15 ms warm. Tom made slow artwork a business
   * P0 that day.
   *
   * So the choice is made on this viewer's round trip to each ready node, from
   * the health cycle's probes. It is made **once**: a switch re-downloads every
   * poster the old host had cached, so it has to be worth it and must not
   * happen again within the run. The next run looks again, since a laptop
   * that has moved has a different nearest node. Without latency evidence
   * yet, nothing is decided, and a later call tries again.
   *
   * `leadingUrl` is the URL that would be tried first without a preference,
   * the signed capability where there is one.
   */
  chooseOnce(sources: readonly { url: string; latencyMs?: number }[], leadingUrl?: string): void {
    if (this.chosen) return;
    const latency = new Map<string, number>();
    for (const source of sources) {
      const host = artworkHostOf(source.url);
      if (host && source.latencyMs !== undefined && !latency.has(host)) latency.set(host, source.latencyMs);
    }
    if (latency.size === 0) return;
    this.chosen = true;

    const current = this.get() ?? artworkHostOf(leadingUrl ?? sources[0]?.url ?? '');
    let best: { host: string; latencyMs: number } | undefined;
    for (const [host, latencyMs] of latency) {
      if (!best || latencyMs < best.latencyMs) best = { host, latencyMs };
    }
    if (!best || best.host === current) return;
    const currentMs = current === undefined ? undefined : latency.get(current);
    // A current host with no reading is not ready, or not a node at all:
    // anything measured beats it.
    const worthIt = currentMs === undefined
      || (currentMs - best.latencyMs >= ARTWORK_HOST_MIN_GAIN_MS
        && best.latencyMs <= currentMs * (1 - ARTWORK_HOST_MIN_RELATIVE_GAIN));
    if (worthIt) {
      this.set(best.host);
      this.switched = true;
    }
  }

  /** Forget the preference. Nothing in this package calls it; a host clearing its data might. */
  clear(): void {
    this.value = undefined;
    this.loaded = true;
    try {
      this.storage?.removeItem(ARTWORK_HOST_KEY);
    } catch {
      // Already forgotten in memory, which is what this run will act on.
    }
  }

  /**
   * Move the preferred host's candidates to the front, otherwise preserving
   * order.
   *
   * Stable on purpose: everything behind the preferred host is still the
   * cluster's own ranking, so failover order is unchanged for every candidate
   * this does not promote.
   */
  order<T extends { url: string }>(sources: readonly T[]): T[] {
    const host = this.get();
    if (!host) return [...sources];
    const preferred: T[] = [];
    const rest: T[] = [];
    for (const source of sources) {
      (artworkHostOf(source.url) === host ? preferred : rest).push(source);
    }
    return [...preferred, ...rest];
  }
}

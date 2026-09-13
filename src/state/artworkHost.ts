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
export class ArtworkHostPreference {
  private value?: string;
  private loaded = false;

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
    this.value = host;
    this.loaded = true;
    try {
      this.storage?.setItem(ARTWORK_HOST_KEY, host);
    } catch {
      // Held in memory for this run regardless; the next start simply
      // re-learns it from the first poster that loads.
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

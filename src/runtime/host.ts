import type { StorageLike } from '../state/storage.js';

/**
 * Everything the core needs from its host that is not a network call.
 *
 * The web client, the React Native app and a test all supply the same three
 * things by different means, so the core asks for them by shape rather than
 * reaching for `localStorage`, `crypto` or `performance` — none of which are
 * present, or mean the same thing, on every target.
 */
export interface MachaHost {
  /**
   * Survives an application restart. Configuration, client identity, resumable
   * position.
   *
   * **It must be able to answer for every key in `MACHA_STORAGE_KEYS` and
   * `MACHA_STORAGE_KEY_PREFIXES`, including the retired ones** — not only the
   * keys core currently writes. A host backing this with a prefix-hydrated
   * cache rather than reading straight through will otherwise answer `null`
   * for a key it never loaded, and core cannot tell that apart from the key
   * being absent.
   *
   * The worked case, found on the phone client 2026-09-15:
   * `ContinueWatchingStore` adopts `macha-client-progress:<clientId>` on first
   * read when the current key is empty. A host that did not hydrate that
   * prefix reports nothing, so adoption silently does not happen and the data
   * the migration exists to carry is dropped — no error, no log, nothing to
   * attribute it to. It works there only because `macha-` happened to be in
   * that client's filter.
   *
   * **Nobody has lost anything and nobody is going to**: this package has no
   * users, and no device in the world holds a pre-`0.10.0` key. This is
   * recorded as a coupling rather than an incident. It is worth stating and
   * testing anyway, because it holds for every read-time migration not yet
   * written, and by then the premise may not be true.
   *
   * So the registry is two lists wearing one name: what a host should *clear*
   * when clearing Macha's data, and what a caching host must *load* before
   * core reads anything. Same keys, different reason, and the second one is
   * the one nobody thinks of.
   *
   * **The load list is what core may *read*, not what core *writes*, and the
   * difference is the whole danger.** They diverge exactly at core's read-time
   * migrations — `macha-client-progress:` and `macha-server-url` are read and
   * then never written again. A host deriving its filter by observing what
   * core writes therefore misses precisely the keys whose absence loses data,
   * and "load everything in the registry" and "load everything I have seen
   * core write" look equivalent while differing only in the case that hurts.
   * (Sharpening owed to the Android TV client, 2026-09-15.)
   */
  storage: StorageLike;
  /**
   * Where a secret belongs on this platform, when the host has somewhere
   * better than `storage`.
   *
   * The session token is the only thing core puts here, and **every** session
   * goes here — there is no disposable kind. A session is a session: the
   * account it belongs to may have no password and may be the one an empty
   * set of credentials authenticates, and none of that makes the bearer less
   * worth protecting or less worth keeping.
   *
   * Optional because platforms genuinely differ, and core will not pretend
   * otherwise: React Native reaches the Keychain and the Keystore through
   * `expo-secure-store`; a Tizen widget has app-private storage and no
   * hardware backing, which is its ceiling; a browser has nothing JavaScript
   * can read that an injected script cannot. **Core cannot make a platform
   * safer than it is — it can only use what the host offers.** A host that
   * supplies nothing falls back to `storage`, which is exactly today's
   * behaviour and is stated rather than implied.
   *
   * The browser's real answer is not a storage slot at all: it is an
   * `httpOnly` cookie the server sets and JavaScript never touches. That is a
   * property of transport rather than of storage, so it belongs on the fetch
   * path and not here — a `StorageLike` contorted to express "no storage"
   * could not say what it meant.
   */
  secureStorage?: StorageLike;
  /**
   * Milliseconds from an arbitrary origin, for measuring durations only.
   *
   * **The consequence, because "durations only" has not been enough.** This is
   * `performance.now()` wherever the host has it: monotonic, and restarting
   * near zero on every run. It cannot express an absolute instant, so route a
   * duration through it and keep anything absolute on `Date.now()` — never
   * convert between them. Three cases in this package, all of which have been
   * got wrong or nearly swept the wrong way:
   *
   * - `EndpointBandwidth` persists `updatedAt` and compares it after a restart
   *   against a six-hour window. On this clock the cutoff goes negative and
   *   every stored record reads as fresh, whatever its age.
   * - `MachaMediaApi.expiredCapability` compares against an expiry another
   *   machine signed, which a from-arbitrary-origin clock cannot express.
   * - `EndpointHealthMonitor`'s probe cache-buster needs a value that never
   *   repeats. Built from this clock it restarted every page load and
   *   collided, which is the same confusion running the other way.
   */
  now(): number;
  /** A fresh RFC 4122 identifier. */
  uuid(): string;
  /**
   * Absolute base for resolving a server-relative URL (artwork, stream) that
   * a node returns as a path. The browser has `location.origin`; a native app
   * has nothing equivalent and must supply the endpoint base it is talking to.
   */
  origin?: string;
}

/** A `StorageLike` backed by a plain map. The default when the host has none. */
export function memoryStorage(seed?: Readonly<Record<string, string>>): StorageLike {
  const values = new Map<string, string>(seed ? Object.entries(seed) : undefined);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

function globalStorage(name: 'localStorage' | 'sessionStorage'): StorageLike | undefined {
  try {
    const candidate = (globalThis as Record<string, unknown>)[name] as StorageLike | undefined;
    if (!candidate || typeof candidate.getItem !== 'function') return undefined;
    // Safari in private mode, and a WebView with site data disabled, expose the
    // object and throw on write. Fail over to memory rather than at first use.
    candidate.setItem('macha-storage-probe', '1');
    candidate.removeItem('macha-storage-probe');
    return candidate;
  } catch {
    return undefined;
  }
}

function defaultUuid(): string {
  const webCrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof webCrypto?.getRandomValues === 'function') webCrypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

/** Monotonic where the host has it; a wall clock is only ever a fallback. */
export function defaultNow(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof perf?.now === 'function' ? perf.now() : Date.now();
}

function detectHost(): MachaHost {
  return {
    storage: globalStorage('localStorage') ?? memoryStorage(),
    now: defaultNow,
    uuid: defaultUuid,
    origin: (globalThis as { location?: { origin?: string } }).location?.origin,
  };
}

let host: MachaHost | undefined;

/**
 * Install (or adjust) the host environment. Call once at application start,
 * before the first service is constructed. Omitted fields keep whatever the
 * environment already supplies, so a host that only needs to override storage
 * says only that.
 */
export function configureMachaHost(overrides: Partial<MachaHost>): MachaHost {
  host = { ...(host ?? detectHost()), ...overrides };
  return host;
}

export function machaHost(): MachaHost {
  if (!host) host = detectHost();
  return host;
}

/** Discard an installed host. Tests use this; applications should not need it. */
export function resetMachaHost(): void {
  host = undefined;
}

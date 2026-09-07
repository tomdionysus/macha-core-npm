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
  /** Survives an application restart. Configuration, client identity, resumable position. */
  storage: StorageLike;
  /**
   * Lives only as long as one run of the application.
   *
   * On the web this is `sessionStorage`: an anonymous session is meant to die
   * with the tab. A native app has no tab, so its "run" is the process — a
   * host that wants sessions to survive a relaunch must say so explicitly by
   * passing persistent storage here, rather than inheriting it by accident.
   */
  ephemeralStorage: StorageLike;
  /** Milliseconds from an arbitrary origin, for measuring durations only. */
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
    ephemeralStorage: globalStorage('sessionStorage') ?? memoryStorage(),
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

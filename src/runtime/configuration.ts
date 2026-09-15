import { machaHost } from './host.js';
import type { StorageLike } from '../state/storage.js';

const CLIENT_ID_KEY = 'macha-client-id';
const SERVER_URL_KEY = 'macha-server-url';
const INTERIM_SERVER_ENDPOINTS_KEY = 'macha-server-endpoints-v1';
const BOOTSTRAP_ENDPOINTS_KEY = 'macha-bootstrap-endpoints-v1';
const DISCOVERED_ENDPOINTS_KEY = 'macha-discovered-endpoints-v1';
/** A cluster realistically has a handful of nodes; this only guards against a pathological advertisement. */
const MAX_DISCOVERED_ENDPOINTS = 16;

interface StoredEndpointList {
  version: 1;
  urls: string[];
}

export interface MachaClientConfigurationOptions {
  /** Persistent storage. Defaults to the configured host's. */
  storage?: StorageLike;
  /**
   * Endpoints supplied by the build or the environment — a `.env` value on the
   * web, an app config on native. Used when the client has never been
   * configured by hand.
   */
  environmentEndpoints?: readonly string[];
  /**
   * Environment endpoints are authoritative and stored configuration is
   * ignored entirely.
   *
   * The Samsung package is intentionally pinned to its build-time endpoint:
   * stale storage from an earlier development install on the same TV must not
   * override it. Normal builds leave this off and stay user-configurable.
   */
  pinnedEndpoints?: boolean;
}

/**
 * Client-side configuration and identity: which endpoints to try, who this
 * client says it is, and the standing API token if one was typed in.
 *
 * The web build read these from `import.meta.env` and `localStorage` directly.
 * The values are the same everywhere; only their provenance differs, so they
 * arrive as constructor options and every reader goes through this one object.
 */
export class MachaClientConfiguration {
  private readonly storageOverride?: StorageLike;
  private readonly environment: string[];
  private readonly pinned: boolean;

  constructor(options: MachaClientConfigurationOptions = {}) {
    this.storageOverride = options.storage;
    this.environment = normalizeUrls(options.environmentEndpoints ?? []);
    this.pinned = options.pinnedEndpoints ?? false;
  }

  /**
   * Resolved on use, never captured at construction — the same rule, and for
   * the same reason, as `SessionManager.storage`.
   *
   * Capturing it here meant a host that constructs this at **module scope**
   * pinned it to whatever `detectHost()` guessed before `configureMachaHost()`
   * ran. Under ESM every import resolves before the importing module's body,
   * so on React Native that is `memoryStorage()` — a `Map` this object then
   * held for the life of the process, while the later `configureMachaHost`
   * call replaced the module host and could not reach inside.
   *
   * The Android TV client hit exactly that: `macha-client-id` was never once
   * written to `AsyncStorage`, a fresh id was minted into memory on every
   * launch, and endpoints a viewer set in Settings did not survive a restart.
   * `SessionManager` had documented this hazard and solved it; this class had
   * the same hazard and did not. Two copies of one rule, disagreeing.
   */
  private get storage(): StorageLike {
    return this.storageOverride ?? machaHost().storage;
  }

  /**
   * The installation identity **if one has already been stored**, without
   * minting when it has not.
   *
   * For callers that need to key something by identity but must not create an
   * identity to do it. `clientId()` mints on absence, and on a host whose
   * storage is a prefix-hydrated cache an unhydrated key is indistinguishable
   * from an absent one — so minting there invents a fresh identity and
   * destroys the previous one. **A read that finds nothing is harmless; a
   * write that invents an identity is not.** Core uses this, never `clientId`,
   * for anything it wires on a host's behalf.
   */
  existingClientId(): string | undefined {
    return this.storage.getItem(CLIENT_ID_KEY) ?? undefined;
  }

  /** Stable per-installation identity, minted on first use. */
  clientId(): string {
    const existing = this.storage.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
    const id = machaHost().uuid();
    this.storage.setItem(CLIENT_ID_KEY, id);
    return id;
  }

  /** First bootstrap endpoint, or '' when the client is unconfigured. */
  serverUrl(): string {
    return this.bootstrapEndpoints()[0] ?? '';
  }

  /**
   * User-configured (or environment-supplied) endpoints to start from.
   * Migrates the two superseded storage layouts on read.
   */
  bootstrapEndpoints(): string[] {
    if (this.pinned) return this.environment;

    const stored = this.readEndpointValue(BOOTSTRAP_ENDPOINTS_KEY);
    if (stored) return stored;

    const interim = this.readEndpointValue(INTERIM_SERVER_ENDPOINTS_KEY);
    if (interim) {
      this.writeEndpointValue(interim, BOOTSTRAP_ENDPOINTS_KEY);
      this.storage.removeItem(INTERIM_SERVER_ENDPOINTS_KEY);
      return interim;
    }

    const configured = this.storage.getItem(SERVER_URL_KEY);
    if (configured !== null) {
      const migrated = normalizeUrls([configured]);
      this.writeEndpointValue(migrated, BOOTSTRAP_ENDPOINTS_KEY);
      this.storage.removeItem(SERVER_URL_KEY);
      return migrated;
    }

    return this.environment;
  }

  setServerUrl(url: string): void {
    this.setBootstrapEndpoints([url]);
  }

  setBootstrapEndpoints(urls: readonly string[]): void {
    this.writeEndpointValue(normalizeUrls(urls), BOOTSTRAP_ENDPOINTS_KEY);
    this.storage.removeItem(SERVER_URL_KEY);
    this.storage.removeItem(INTERIM_SERVER_ENDPOINTS_KEY);
  }

  /**
   * Endpoints this client has actually reached successfully at some point, but
   * never configured by the user — runtime-discovered cluster membership, not
   * bootstrap configuration (discovered candidates must never be persisted as
   * user configuration). Purely a resumable-history hint for the next start's
   * registry seed, never authoritative: the live cluster is always free to
   * supersede it. `EndpointHealthMonitor` is the only writer.
   */
  discoveredEndpoints(): string[] {
    return this.readEndpointValue(DISCOVERED_ENDPOINTS_KEY) ?? [];
  }

  setDiscoveredEndpoints(urls: readonly string[]): void {
    const normalized = normalizeUrls(urls).slice(0, MAX_DISCOVERED_ENDPOINTS);
    if (normalized.length === 0) {
      this.storage.removeItem(DISCOVERED_ENDPOINTS_KEY);
      return;
    }
    this.writeEndpointValue(normalized, DISCOVERED_ENDPOINTS_KEY);
  }

  private readEndpointValue(key: string): string[] | undefined {
    const raw = this.storage.getItem(key);
    if (!raw) return undefined;
    try {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid endpoint state');
      const record = value as Partial<StoredEndpointList>;
      if (record.version !== 1 || !Array.isArray(record.urls) || record.urls.some((url) => typeof url !== 'string')) {
        throw new Error('invalid endpoint state');
      }
      const normalized = normalizeUrls(record.urls);
      if (JSON.stringify(record.urls) !== JSON.stringify(normalized)) this.writeEndpointValue(normalized, key);
      return normalized;
    } catch {
      this.storage.removeItem(key);
      return undefined;
    }
  }

  private writeEndpointValue(urls: string[], key: string): void {
    const value: StoredEndpointList = { version: 1, urls };
    this.storage.setItem(key, JSON.stringify(value));
  }
}

/**
 * Read endpoints out of one or more environment values, in precedence order.
 *
 * Each value is a `VITE_MACHA_SERVERS`-style list: newline- or comma-separated,
 * normalized and deduplicated. The first candidate that yields any usable
 * endpoint wins, so the conventional "a list, or else a single value" pair is
 * one call:
 *
 * ```ts
 * parseEndpointList(env.VITE_MACHA_SERVERS, env.VITE_MACHA_SERVER)
 * ```
 *
 * That precedence is the whole reason this takes more than one value. Written
 * out at a call site it invites `??`, which is wrong: an env var that is
 * *defined but empty* is the normal way a `.env` file leaves one unset, and
 * `??` passes the empty string through instead of falling back to the next
 * candidate.
 *
 * A candidate that is non-empty but contains no usable URL also falls through
 * here. That is a deliberate, small departure from the single-value original,
 * which would have stopped at it and returned nothing — falling back is
 * strictly more useful, and nothing can depend on the old behaviour except a
 * misconfiguration.
 */
export function parseEndpointList(...values: ReadonlyArray<string | undefined>): string[] {
  for (const value of values) {
    if (value === undefined) continue;
    const endpoints = normalizeUrls(value.split(/[\n,]/));
    if (endpoints.length > 0) return endpoints;
  }
  return [];
}

export function normalizeUrl(url: string): string {
  const value = url.trim();
  if (!value || value === '/') return '';
  return value.replace(/\/+$/, '');
}

export function normalizeUrls(urls: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const url of urls) {
    const normalized = normalizeUrl(url);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

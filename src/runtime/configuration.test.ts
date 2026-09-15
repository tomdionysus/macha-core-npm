import { describe, expect, it } from 'vitest';
import { MachaClientConfiguration, parseEndpointList } from './configuration.js';
import { configureMachaHost, memoryStorage } from './host.js';
import type { StorageLike } from '../state/storage.js';

function configured(storage: StorageLike, options: { environmentEndpoints?: string[]; pinnedEndpoints?: boolean } = {}) {
  return new MachaClientConfiguration({ storage, ...options });
}

describe('client server endpoint persistence', () => {
  it('migrates the legacy single URL into versioned endpoint state', () => {
    const storage = memoryStorage({ 'macha-server-url': 'http://node-a/' });

    expect(configured(storage).bootstrapEndpoints()).toEqual(['http://node-a']);
    expect(storage.getItem('macha-server-url')).toBeNull();
    expect(JSON.parse(storage.getItem('macha-bootstrap-endpoints-v1') ?? '')).toEqual({
      version: 1,
      urls: ['http://node-a'],
    });
  });

  it('normalizes and deduplicates a bootstrap endpoint set', () => {
    const configuration = configured(memoryStorage());
    configuration.setBootstrapEndpoints(['http://node-a/', '', ' http://node-b ', '  ', 'http://node-a']);

    expect(configuration.bootstrapEndpoints()).toEqual(['http://node-a', 'http://node-b']);
    expect(configuration.serverUrl()).toBe('http://node-a');
  });

  it('removes obsolete same-origin entries from persisted endpoint state', () => {
    const storage = memoryStorage({
      'macha-bootstrap-endpoints-v1': JSON.stringify({ version: 1, urls: ['', 'http://node-a', '/', 'http://node-a/'] }),
    });

    expect(configured(storage).bootstrapEndpoints()).toEqual(['http://node-a']);
    expect(JSON.parse(storage.getItem('macha-bootstrap-endpoints-v1') ?? '')).toEqual({
      version: 1,
      urls: ['http://node-a'],
    });
  });

  it('retains the single-URL compatibility API', () => {
    const configuration = configured(memoryStorage());
    configuration.setServerUrl('http://node-a/');
    expect(configuration.bootstrapEndpoints()).toEqual(['http://node-a']);
  });

  it('discards malformed versioned state and falls back safely', () => {
    const storage = memoryStorage({ 'macha-bootstrap-endpoints-v1': '{broken' });
    expect(configured(storage).bootstrapEndpoints()).toEqual([]);
    expect(storage.getItem('macha-bootstrap-endpoints-v1')).toBeNull();
  });

  it('migrates the interim multi-endpoint key without losing candidates', () => {
    const storage = memoryStorage({
      'macha-server-endpoints-v1': JSON.stringify({ version: 1, urls: ['http://a', 'http://b'] }),
    });
    expect(configured(storage).bootstrapEndpoints()).toEqual(['http://a', 'http://b']);
    expect(storage.getItem('macha-server-endpoints-v1')).toBeNull();
  });

  it('falls back to environment endpoints only while nothing is configured', () => {
    const storage = memoryStorage();
    const configuration = configured(storage, { environmentEndpoints: ['http://env-a/'] });

    expect(configuration.bootstrapEndpoints()).toEqual(['http://env-a']);
    // A fallback must not write itself into user configuration.
    expect(storage.getItem('macha-bootstrap-endpoints-v1')).toBeNull();

    configuration.setBootstrapEndpoints(['http://typed-in']);
    expect(configuration.bootstrapEndpoints()).toEqual(['http://typed-in']);
  });

  it('lets a pinned build ignore stale stored configuration entirely', () => {
    const storage = memoryStorage({
      'macha-bootstrap-endpoints-v1': JSON.stringify({ version: 1, urls: ['http://stale-dev-install'] }),
    });
    const configuration = configured(storage, { environmentEndpoints: ['http://pinned'], pinnedEndpoints: true });

    expect(configuration.bootstrapEndpoints()).toEqual(['http://pinned']);
  });
});

describe('discovered endpoint persistence', () => {
  it('persists and reads back confirmed-reachable discovered endpoints under their own key, separate from bootstrap configuration', () => {
    const storage = memoryStorage();
    const configuration = configured(storage);
    configuration.setDiscoveredEndpoints(['http://node-b/', '', ' http://node-c ', 'http://node-b']);

    expect(configuration.discoveredEndpoints()).toEqual(['http://node-b', 'http://node-c']);
    expect(storage.getItem('macha-bootstrap-endpoints-v1')).toBeNull();
    expect(JSON.parse(storage.getItem('macha-discovered-endpoints-v1') ?? '')).toEqual({
      version: 1,
      urls: ['http://node-b', 'http://node-c'],
    });
  });

  it('clears the discovered-endpoints key once nothing is confirmed reachable any more', () => {
    const storage = memoryStorage();
    const configuration = configured(storage);
    configuration.setDiscoveredEndpoints(['http://node-b']);
    expect(configuration.discoveredEndpoints()).toEqual(['http://node-b']);

    configuration.setDiscoveredEndpoints([]);
    expect(configuration.discoveredEndpoints()).toEqual([]);
    expect(storage.getItem('macha-discovered-endpoints-v1')).toBeNull();
  });

  it('bounds the persisted discovered set instead of accumulating unbounded discovery history', () => {
    const configuration = configured(memoryStorage());
    const many = Array.from({ length: 40 }, (_, index) => `http://node-${index}`);

    configuration.setDiscoveredEndpoints(many);

    expect(configuration.discoveredEndpoints()).toHaveLength(16);
    expect(configuration.discoveredEndpoints()).toEqual(many.slice(0, 16));
  });

  it('self-heals a malformed discovered-endpoints value into its own key, never the bootstrap key', () => {
    // The read/normalize/rewrite helper is shared with the bootstrap-endpoint
    // key; it must rewrite whichever key it was actually asked to read, not a
    // hardcoded one, or a discovered-endpoints value that needs normalizing
    // would silently leak into user-facing bootstrap configuration.
    const storage = memoryStorage({
      'macha-discovered-endpoints-v1': JSON.stringify({ version: 1, urls: ['http://node-b/', '/'] }),
    });

    expect(configured(storage).discoveredEndpoints()).toEqual(['http://node-b']);
    expect(JSON.parse(storage.getItem('macha-discovered-endpoints-v1') ?? '')).toEqual({
      version: 1,
      urls: ['http://node-b'],
    });
    expect(storage.getItem('macha-bootstrap-endpoints-v1')).toBeNull();
  });

  it('discards malformed discovered-endpoints state and falls back to empty, independent of bootstrap state', () => {
    const storage = memoryStorage();
    const configuration = configured(storage);
    configuration.setBootstrapEndpoints(['http://node-a']);
    storage.setItem('macha-discovered-endpoints-v1', '{broken');

    expect(configuration.discoveredEndpoints()).toEqual([]);
    expect(storage.getItem('macha-discovered-endpoints-v1')).toBeNull();
    expect(configuration.bootstrapEndpoints()).toEqual(['http://node-a']);
  });
});

describe('client identity', () => {
  it('mints once and reuses the stored identity afterwards', () => {
    const storage = memoryStorage();

    const first = configured(storage).clientId();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    // A second configuration over the same storage is a restart, not a new client.
    expect(configured(storage).clientId()).toBe(first);
  });
});

describe('parseEndpointList', () => {
  it('splits a newline- or comma-separated environment value and normalizes it', () => {
    expect(parseEndpointList('http://a/, http://b\nhttp://a')).toEqual(['http://a', 'http://b']);
  });

  it('treats an unset value as no configuration at all', () => {
    expect(parseEndpointList(undefined)).toEqual([]);
    expect(parseEndpointList('')).toEqual([]);
    expect(parseEndpointList()).toEqual([]);
  });

  it('falls through an empty leading candidate to the next one', () => {
    // A `.env` file's normal way of leaving a variable unset is to define it
    // empty, not to omit it. A call site reaching for `??` here would pass
    // that empty string through and silently lose the fallback.
    expect(parseEndpointList('', 'http://single')).toEqual(['http://single']);
    expect(parseEndpointList(undefined, 'http://single')).toEqual(['http://single']);
  });

  it('prefers the first candidate that yields anything', () => {
    expect(parseEndpointList('http://list-a,http://list-b', 'http://single')).toEqual(['http://list-a', 'http://list-b']);
  });

  it('falls through a candidate that is non-empty but contains no usable URL', () => {
    expect(parseEndpointList('  ,  ', 'http://single')).toEqual(['http://single']);
    expect(parseEndpointList('/', 'http://single')).toEqual(['http://single']);
  });

  it('returns nothing when no candidate yields anything', () => {
    expect(parseEndpointList('', '  ', undefined)).toEqual([]);
  });
});


describe('the host is resolved on use, never captured', () => {
  /**
   * A host that constructs this at module scope — which the Android TV client
   * does — pinned it to whatever `detectHost()` guessed before
   * `configureMachaHost()` ran. Under ESM every import resolves before the
   * importing module's body, so on React Native that is `memoryStorage()`: a
   * Map held for the life of the process while the real store sat unused.
   * `macha-client-id` was never once written to AsyncStorage there, and
   * endpoints a viewer set in Settings did not survive a restart.
   *
   * `SessionManager` had documented this hazard and solved it with a getter.
   * This class had the same hazard and did not.
   */
  it('uses the storage configured after construction, not the one guessed before it', () => {
    const configuration = new MachaClientConfiguration();
    const configured = memoryStorage();
    configureMachaHost({ storage: configured, secureStorage: undefined, now: Date.now, uuid: () => 'minted-id' });

    configuration.setBootstrapEndpoints(['https://node.example']);

    expect(configured.getItem('macha-bootstrap-endpoints-v1')).toContain('https://node.example');
  });
});

describe('reading an identity without creating one', () => {
  /**
   * On a host whose storage is a prefix-hydrated cache, an unhydrated key is
   * indistinguishable from an absent one — so minting there invents a fresh
   * identity and destroys the previous one. A read that finds nothing is
   * harmless; a write that invents an identity is not. Core uses this, never
   * `clientId()`, for anything it wires on a host's behalf.
   */
  it('answers undefined rather than minting when nothing is stored', () => {
    const storage = memoryStorage();
    const configuration = new MachaClientConfiguration({ storage });

    expect(configuration.existingClientId()).toBeUndefined();
    expect(storage.getItem('macha-client-id')).toBeNull();
  });

  it('answers the stored identity when there is one', () => {
    const configuration = new MachaClientConfiguration({ storage: memoryStorage({ 'macha-client-id': 'client-42' }) });

    expect(configuration.existingClientId()).toBe('client-42');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureMachaHost, machaHost, memoryStorage, resetMachaHost } from './host.js';

afterEach(() => {
  vi.unstubAllGlobals();
  resetMachaHost();
});

describe('memoryStorage', () => {
  it('behaves as a StorageLike, distinguishing an absent key from an empty value', () => {
    const storage = memoryStorage({ seeded: 'yes' });

    expect(storage.getItem('seeded')).toBe('yes');
    expect(storage.getItem('missing')).toBeNull();

    storage.setItem('empty', '');
    expect(storage.getItem('empty')).toBe('');

    storage.removeItem('seeded');
    expect(storage.getItem('seeded')).toBeNull();
  });
});

describe('host detection', () => {
  it('falls back to memory when the environment exposes no storage', () => {
    resetMachaHost();
    const host = machaHost();

    host.storage.setItem('macha-probe', 'kept');
    expect(host.storage.getItem('macha-probe')).toBe('kept');
  });

  it('falls back to memory when a storage object exists but throws on write', () => {
    // Safari private mode, and a WebView with site data disabled, expose the
    // object and reject the write. Detection must not defer that to first use.
    resetMachaHost();
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError'); },
      removeItem: () => undefined,
    });

    expect(() => machaHost().storage.setItem('macha-probe', 'x')).not.toThrow();
  });

  it('offers no secure storage until a host supplies one', () => {
    // Optional on purpose: a browser has nowhere JavaScript can read that an
    // injected script cannot, so the honest default is to say so and let
    // `SessionManager` fall back to `storage` rather than imply a safety the
    // platform does not provide.
    resetMachaHost();
    expect(machaHost().secureStorage).toBeUndefined();
  });

  it('takes a secure store from the host and keeps it distinct from persistent storage', () => {
    resetMachaHost();
    const secure = memoryStorage();
    const host = configureMachaHost({ secureStorage: secure });
    host.storage.setItem('shared-key', 'persistent');

    expect(host.secureStorage).toBe(secure);
    expect(host.secureStorage?.getItem('shared-key')).toBeNull();
  });

  it('mints distinct RFC 4122 identifiers without a platform crypto', () => {
    resetMachaHost();
    vi.stubGlobal('crypto', undefined);

    const first = machaHost().uuid();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(machaHost().uuid()).not.toBe(first);
  });
});

describe('configureMachaHost', () => {
  it('merges overrides over the detected environment rather than replacing it', () => {
    resetMachaHost();
    const storage = memoryStorage();

    const host = configureMachaHost({ storage });

    expect(host.storage).toBe(storage);
    expect(typeof host.uuid()).toBe('string');
    expect(typeof host.now()).toBe('number');
  });

  it('is what every later reader sees', () => {
    resetMachaHost();
    configureMachaHost({ origin: 'http://node-a:9000' });

    expect(machaHost().origin).toBe('http://node-a:9000');
  });
});

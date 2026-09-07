import { describe, expect, it, vi } from 'vitest';
import { EndpointBandwidth } from './EndpointBandwidth.js';

/** Storage is injected, so these run without jsdom and without touching a real localStorage. */
function fakeStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key); },
    setItem: (key: string, value: string) => { values.set(key, value); },
  } as Storage;
}

const KEY = 'macha-client-bandwidth:client-1';

describe('EndpointBandwidth', () => {
  it('ignores transfers too small to measure anything but round-trip time', () => {
    const bandwidth = new EndpointBandwidth('client-1', fakeStorage(), () => 0);

    // A 2 KB session response returning in 4 ms would imply 500 KB/s. It says
    // nothing about the link: the time is round trip and handler cost.
    bandwidth.record('http://a', 2_048, 4);

    expect(bandwidth.bytesPerSecond('http://a')).toBeUndefined();
    expect(bandwidth.samples('http://a')).toBe(0);
  });

  it('estimates throughput from a large transfer and lets later samples move it', () => {
    const bandwidth = new EndpointBandwidth('client-1', fakeStorage(), () => 0);

    bandwidth.record('http://a', 1_000_000, 1_000);
    expect(bandwidth.bytesPerSecond('http://a')).toBe(1_000_000);

    // Smoothed, not replaced: one slow response on a good link must not
    // condemn it, and one fast response on a bad link must not redeem it.
    bandwidth.record('http://a', 1_000_000, 2_000);
    const estimate = bandwidth.bytesPerSecond('http://a');
    expect(estimate).toBeLessThan(1_000_000);
    expect(estimate).toBeGreaterThan(500_000);
    expect(bandwidth.samples('http://a')).toBe(2);
  });

  it('rejects a zero or negative duration rather than recording an infinite link', () => {
    const bandwidth = new EndpointBandwidth('client-1', fakeStorage(), () => 0);

    bandwidth.record('http://a', 1_000_000, 0);
    bandwidth.record('http://a', 1_000_000, -5);
    bandwidth.record('http://a', Number.NaN, 100);

    expect(bandwidth.bytesPerSecond('http://a')).toBeUndefined();
  });

  it('persists across a reload, but re-enters as a single sample so live evidence overtakes it', () => {
    const storage = fakeStorage();
    let clock = 1_000_000;
    const first = new EndpointBandwidth('client-1', storage, () => clock);
    first.record('http://a', 1_000_000, 1_000);

    // A cold client with no stored estimate ranks every endpoint identically
    // until its first large transfer, which is the case worth avoiding.
    const restored = new EndpointBandwidth('client-1', storage, () => clock);
    expect(restored.bytesPerSecond('http://a')).toBe(1_000_000);
    expect(restored.samples('http://a')).toBe(1);
  });

  it('discards a restored estimate old enough that the link may be a different link', () => {
    const storage = fakeStorage({
      [KEY]: JSON.stringify({ 'http://a': { bytesPerSecond: 1_000_000, samples: 9, updatedAt: 0 } }),
    });

    const bandwidth = new EndpointBandwidth('client-1', storage, () => 7 * 60 * 60 * 1000);

    expect(bandwidth.bytesPerSecond('http://a')).toBeUndefined();
  });

  it('ignores stored entries that are not usable records', () => {
    const storage = fakeStorage({
      [KEY]: JSON.stringify({
        'http://a': { bytesPerSecond: 'quick', updatedAt: 0 },
        'http://b': { bytesPerSecond: 0, updatedAt: 0 },
        'http://c': null,
      }),
    });

    const bandwidth = new EndpointBandwidth('client-1', storage, () => 0);

    for (const id of ['http://a', 'http://b', 'http://c']) {
      expect(bandwidth.bytesPerSecond(id)).toBeUndefined();
    }
  });

  it('keeps measuring when storage is unavailable, rather than failing a request path', () => {
    const storage = fakeStorage();
    vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    const bandwidth = new EndpointBandwidth('client-1', storage, () => 0);

    expect(() => bandwidth.record('http://a', 1_000_000, 1_000)).not.toThrow();
    expect(bandwidth.bytesPerSecond('http://a')).toBe(1_000_000);
  });

  it('drops estimates for endpoints that are no longer configured', () => {
    const bandwidth = new EndpointBandwidth('client-1', fakeStorage(), () => 0);
    bandwidth.record('http://a', 1_000_000, 1_000);
    bandwidth.record('http://b', 1_000_000, 1_000);

    bandwidth.retain(new Set(['http://a']));

    expect(bandwidth.bytesPerSecond('http://a')).toBe(1_000_000);
    expect(bandwidth.bytesPerSecond('http://b')).toBeUndefined();
  });

  it('throttles writes but flushes on demand, so a TV is not storing on every response', () => {
    const storage = fakeStorage();
    const setItem = vi.spyOn(storage, 'setItem');
    let clock = 0;
    const bandwidth = new EndpointBandwidth('client-1', storage, () => clock);

    bandwidth.record('http://a', 1_000_000, 1_000);
    expect(setItem).toHaveBeenCalledTimes(1);
    bandwidth.record('http://a', 1_000_000, 1_000);
    bandwidth.record('http://a', 1_000_000, 1_000);
    expect(setItem).toHaveBeenCalledTimes(1);

    clock += 5_000;
    bandwidth.record('http://a', 1_000_000, 1_000);
    expect(setItem).toHaveBeenCalledTimes(2);

    bandwidth.flush();
    expect(setItem).toHaveBeenCalledTimes(3);
  });
});

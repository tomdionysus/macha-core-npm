import { describe, expect, it } from 'vitest';
import { VolumeStore } from './volume.js';

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

describe('VolumeStore', () => {
  it('defaults to full volume and persists client-local changes', () => {
    const storage = new MemoryStorage();
    const store = new VolumeStore('client', storage);
    expect(store.load()).toBe(1);
    expect(store.save(0.35)).toBe(0.35);
    expect(new VolumeStore('client', storage).load()).toBe(0.35);
  });

  it('clamps persisted volume to the player range', () => {
    const storage = new MemoryStorage();
    const store = new VolumeStore('client', storage);
    expect(store.save(2)).toBe(1);
    expect(store.save(-1)).toBe(0);
  });
});

describe('volume that has been stored badly or not at all', () => {
  const store = (seed?: string) => {
    const values = new Map<string, string>();
    if (seed !== undefined) values.set('macha.volume.v1.c1', seed);
    return new VolumeStore('c1', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    });
  };

  it('starts at full volume when nothing has been stored', () => {
    expect(store().load()).toBe(1);
  });

  it('reads back a stored level', () => {
    expect(store('0.4').load()).toBeCloseTo(0.4);
  });

  it('falls back to full volume for a stored value that is not a number', () => {
    // Silence would be indistinguishable from a broken player, and a viewer
    // has no way to tell which. Loud is the recoverable mistake.
    expect(store('loud').load()).toBe(1);
  });

  it('clamps a stored level that is out of range', () => {
    expect(store('9').load()).toBe(1);
    expect(store('-2').load()).toBe(0);
  });

  it('clamps on the way in as well, and returns what it stored', () => {
    expect(store().save(4)).toBe(1);
    expect(store().save(-1)).toBe(0);
  });

  it('treats a non-finite level as full rather than storing NaN', () => {
    // `NaN` written to storage reads back as "loud" only by accident; storing
    // it means every later read has to defend against it.
    expect(store().save(Number.NaN)).toBe(1);
  });
});

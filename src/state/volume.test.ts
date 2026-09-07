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

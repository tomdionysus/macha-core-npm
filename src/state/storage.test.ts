import { describe, expect, it } from 'vitest';
import { readValidatedJson, writeJson, type StorageLike } from './storage.js';

class MemoryStorage implements StorageLike {
  constructor(private readonly values = new Map<string, string>()) {}
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
  has(key: string) { return this.values.has(key); }
}

const isNumbers = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'number');

describe('reading persisted state that may be anything', () => {
  it('returns the value when it parses and validates', () => {
    const storage = new MemoryStorage();
    writeJson(storage, 'k', [1, 2, 3]);
    expect(readValidatedJson(storage, 'k', isNumbers)).toEqual([1, 2, 3]);
  });

  it('returns undefined for a key that holds nothing', () => {
    expect(readValidatedJson(new MemoryStorage(), 'k', isNumbers)).toBeUndefined();
  });

  it('discards a value that is not JSON at all, rather than throwing', () => {
    // Storage is shared with whatever else runs on this origin, and a value
    // can survive a downgrade or a half-finished write. A parse error here
    // would take down whatever screen happened to read it first.
    const storage = new MemoryStorage();
    storage.setItem('k', '{not json');
    expect(readValidatedJson(storage, 'k', isNumbers)).toBeUndefined();
    expect(storage.has('k')).toBe(false);
  });

  it('discards a value that parses but is the wrong shape', () => {
    // A shape change between versions is the common case. Keeping the old
    // value would hand a caller something its types say cannot happen.
    const storage = new MemoryStorage();
    writeJson(storage, 'k', { not: 'an array' });
    expect(readValidatedJson(storage, 'k', isNumbers)).toBeUndefined();
    expect(storage.has('k')).toBe(false);
  });

  it('removes the bad key so the next read is cheap and the state is gone', () => {
    // Leaving it means re-parsing and re-rejecting on every read forever.
    const storage = new MemoryStorage();
    storage.setItem('k', 'null');
    readValidatedJson(storage, 'k', isNumbers);
    expect(storage.has('k')).toBe(false);
  });
});

describe('writing persisted state', () => {
  it('returns the value it wrote, so a caller can use it without re-reading', () => {
    const storage = new MemoryStorage();
    const written = writeJson(storage, 'k', [4]);
    expect(written).toEqual([4]);
    expect(storage.getItem('k')).toBe('[4]');
  });
});

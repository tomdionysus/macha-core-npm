import { describe, expect, it } from 'vitest';
import { ContinueWatchingStore, isFinished, progressFor } from './continueWatching.js';
import type { MediaSummary, PlaybackProgress } from '../types.js';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

function progress(mediaId: string, positionMs: number, durationMs = 100_000, updatedAt = positionMs): PlaybackProgress {
  return {
    mediaId,
    positionMs,
    durationMs,
    updatedAt,
    media: { id: mediaId, kind: 'movie', title: mediaId, durationMs, mediaIds: [mediaId] },
  };
}

describe('ContinueWatchingStore', () => {
  it('keeps only the three most recent playable items', () => {
    const store = new ContinueWatchingStore('client', new MemoryStorage());
    store.update(progress('one', 31_000, 100_000, 1));
    store.update(progress('two', 32_000, 100_000, 2));
    store.update(progress('three', 33_000, 100_000, 3));
    store.update(progress('four', 34_000, 100_000, 4));
    expect(store.list().map((entry) => entry.mediaId)).toEqual(['four', 'three', 'two']);
  });

  it('drops one unusable entry rather than every entry behind it', () => {
    // The only store that validated the array and not its contents: a single
    // `null` in the list threw out of `isFinished` on every `list()`, so one
    // bad write broke a viewer's whole Continue Watching row until somebody
    // cleared their history. The rest of the history is still true.
    const storage = new MemoryStorage();
    storage.setItem('macha.continueWatching.v1.client', JSON.stringify([
      null,
      progress('good', 50_000, 100_000, 2),
      { mediaId: 'half-written' },
    ]));
    const store = new ContinueWatchingStore('client', storage);

    expect(store.list().map((entry) => entry.mediaId)).toEqual(['good']);
  });

  it('does not clutter continue watching with accidental starts', () => {
    const store = new ContinueWatchingStore('client', new MemoryStorage());
    store.update(progress('one', 10_000));
    expect(store.list()).toEqual([]);
  });

  it('explicitly removes only the requested item', () => {
    const store = new ContinueWatchingStore('client', new MemoryStorage());
    store.update(progress('one', 50_000, 100_000, 1));
    store.update(progress('two', 50_000, 100_000, 2));
    expect(store.clear('two').map((entry) => entry.mediaId)).toEqual(['one']);
    expect(store.list().map((entry) => entry.mediaId)).toEqual(['one']);
  });

  it('removes media once it is effectively finished', () => {
    const store = new ContinueWatchingStore('client', new MemoryStorage());
    store.update(progress('one', 50_000));
    store.update(progress('one', 95_000));
    expect(store.list()).toEqual([]);
  });

  it('uses a 92% completion threshold', () => {
    expect(isFinished(progress('one', 91_999))).toBe(false);
    expect(isFinished(progress('one', 92_000))).toBe(true);
  });

  describe('the key rename', () => {
    const legacyKey = (clientId: string) => `macha-client-progress:${clientId}`;
    const currentKey = (clientId: string) => `macha.continueWatching.v1.${clientId}`;
    const entry = progress('m1', 40_000);

    it('keeps a viewer\'s place across the rename', () => {
      const storage = new MemoryStorage();
      storage.setItem(legacyKey('c1'), JSON.stringify([entry]));

      expect(new ContinueWatchingStore('c1', storage).list()).toEqual([entry]);
    });

    it('copies the legacy entries onto the current key so the read happens once', () => {
      const storage = new MemoryStorage();
      storage.setItem(legacyKey('c1'), JSON.stringify([entry]));

      new ContinueWatchingStore('c1', storage).list();

      expect(JSON.parse(storage.getItem(currentKey('c1'))!)).toEqual([entry]);
    });

    it('leaves the legacy key in place as the way back from a rollback', () => {
      const storage = new MemoryStorage();
      storage.setItem(legacyKey('c1'), JSON.stringify([entry]));

      new ContinueWatchingStore('c1', storage).list();

      expect(storage.getItem(legacyKey('c1'))).not.toBeNull();
    });

    it('never lets stale legacy data resurrect over current entries', () => {
      // The adoption fires only when the current key holds nothing. A viewer
      // who has watched since upgrading must not be sent back to where they
      // were before it.
      const storage = new MemoryStorage();
      const current = progress('m1', 60_000);
      storage.setItem(legacyKey('c1'), JSON.stringify([entry]));
      storage.setItem(currentKey('c1'), JSON.stringify([current]));

      expect(new ContinueWatchingStore('c1', storage).list()).toEqual([current]);
    });

    it('adopts nothing for a client id that has no history under either key', () => {
      const storage = new MemoryStorage();
      storage.setItem(legacyKey('someone-else'), JSON.stringify([entry]));

      expect(new ContinueWatchingStore('c1', storage).list()).toEqual([]);
      expect(storage.getItem(currentKey('c1'))).toBeNull();
    });

    it('ignores a legacy key holding something that is not a list', () => {
      const storage = new MemoryStorage();
      storage.setItem(legacyKey('c1'), '{"not":"an array"}');

      expect(new ContinueWatchingStore('c1', storage).list()).toEqual([]);
    });
  });

  describe('resuming, forgetting and building a record', () => {
    const legacyKey = (clientId: string) => `macha-client-progress:${clientId}`;
    const currentKey = (clientId: string) => `macha.continueWatching.v1.${clientId}`;

    it('answers where the viewer was', () => {
      const storage = new MemoryStorage();
      const store = new ContinueWatchingStore('c1', storage);
      store.update(progress('m1', 40_000));

      expect(store.positionFor('m1')).toBe(40_000);
    });

    it('answers zero for an item never started', () => {
      expect(new ContinueWatchingStore('c1', new MemoryStorage()).positionFor('m1')).toBe(0);
    });

    it('answers zero for a finished item rather than its stored position', () => {
      // Reading the raw value would drop a viewer two minutes from the end of
      // something they have already watched. Pressing play on a finished title
      // means start again.
      const storage = new MemoryStorage();
      storage.setItem(currentKey('c1'), JSON.stringify([progress('m1', 99_000, 100_000)]));

      expect(new ContinueWatchingStore('c1', storage).positionFor('m1')).toBe(0);
    });

    it('forgets everything, including the key the current one was adopted from', () => {
      // Clearing only the current key leaves the legacy entries for the next
      // read to adopt, and a viewer who deliberately erased their history
      // watches it come back.
      const storage = new MemoryStorage();
      storage.setItem(legacyKey('c1'), JSON.stringify([progress('m1', 40_000)]));
      const store = new ContinueWatchingStore('c1', storage);
      store.list();

      store.clearAll();

      expect(store.list()).toEqual([]);
      expect(new ContinueWatchingStore('c1', storage).list()).toEqual([]);
    });

    it('builds a record carrying the summary so the row has something to render', () => {
      const media: MediaSummary = { id: 'm1', kind: 'movie', title: 'Clerks', durationMs: 100_000, mediaIds: ['m1'] };
      const record = progressFor(media, 40_000, 100_000);

      expect(record).toMatchObject({ mediaId: 'm1', positionMs: 40_000, durationMs: 100_000, media });
      expect(record.updatedAt).toBeGreaterThan(0);
    });
  });
});

describe('safety for a reactive caller', () => {
  // A hook that subscribes and then reads memoises on the store, whose
  // identity never changes, so the Continue Watching row freezes at whatever
  // it first computed while the store goes on changing underneath.
  const storeWith = () => new ContinueWatchingStore('reactive', new MemoryStorage());

  it('hands back the same reference until something changes', () => {
    const store = storeWith();
    store.update(progress('a', 30_000));
    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });

  it('hands back a new reference after an update, so a memo re-runs', () => {
    const store = storeWith();
    store.update(progress('a', 30_000));
    const before = store.getSnapshot();
    store.update(progress('b', 40_000));
    const after = store.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.map((entry) => entry.mediaId)).toEqual(['b', 'a']);
  });

  it('notifies on update, clear and clearAll', () => {
    const store = storeWith();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => { notifications += 1; });
    store.update(progress('a', 30_000));
    store.clear('a');
    store.clearAll();
    expect(notifications).toBe(3);
    unsubscribe();
    store.update(progress('b', 30_000));
    expect(notifications).toBe(3);
  });

  it('reflects a clear in the next snapshot', () => {
    const store = storeWith();
    store.update(progress('a', 30_000));
    expect(store.getSnapshot()).toHaveLength(1);
    store.clearAll();
    expect(store.getSnapshot()).toHaveLength(0);
  });
});

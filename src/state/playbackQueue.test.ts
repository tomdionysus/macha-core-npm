import { describe, expect, it } from 'vitest';
import type { MediaSummary } from '../types.js';
import { PlaybackQueueStore } from './playbackQueue.js';

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const track = (id: string): MediaSummary => ({
  id,
  kind: 'track',
  title: id,
  mediaIds: [`media:${id}`],
});

describe('PlaybackQueueStore', () => {
  it('persists queue contents and the selected item', () => {
    const storage = new MemoryStorage();
    const store = new PlaybackQueueStore('client', storage);
    store.replace([track('one'), track('two'), track('three')], 1);

    expect(new PlaybackQueueStore('client', storage).load()).toMatchObject({
      currentIndex: 1,
      positionMs: 0,
      items: [{ id: 'one' }, { id: 'two' }, { id: 'three' }],
    });
  });

  it('updates only the current queue index when advancing', () => {
    const storage = new MemoryStorage();
    const store = new PlaybackQueueStore('client', storage);
    store.replace([track('one'), track('two')], 0);
    const next = store.select(1);

    expect(next?.currentIndex).toBe(1);
    expect(next?.items.map((item) => item.id)).toEqual(['one', 'two']);
  });

  it('persists the current item position without changing the queue', () => {
    const storage = new MemoryStorage();
    const store = new PlaybackQueueStore('client', storage);
    store.replace([track('one'), track('two')], 1);
    const next = store.updatePosition(42_500);

    expect(next?.positionMs).toBe(42_500);
    expect(next?.currentIndex).toBe(1);
    expect(next?.items.map((item) => item.id)).toEqual(['one', 'two']);
  });

  it('inserts items after the current item without disturbing playback position', () => {
    const storage = new MemoryStorage();
    const store = new PlaybackQueueStore('client', storage);
    store.replace([track('one'), track('two')], 0);
    store.updatePosition(12_000);
    const next = store.insertNext([track('next-a'), track('next-b')]);

    expect(next?.items.map((item) => item.id)).toEqual(['one', 'next-a', 'next-b', 'two']);
    expect(next?.currentIndex).toBe(0);
    expect(next?.positionMs).toBe(12_000);
  });

  it('appends items to the active queue without changing the current item', () => {
    const storage = new MemoryStorage();
    const store = new PlaybackQueueStore('client', storage);
    store.replace([track('one'), track('two')], 1);
    const next = store.append([track('later')]);

    expect(next?.items.map((item) => item.id)).toEqual(['one', 'two', 'later']);
    expect(next?.currentIndex).toBe(1);
  });

  it('discards malformed persisted state', () => {
    const storage = new MemoryStorage();
    storage.setItem('macha.playbackQueue.v1.client', '{"items":[],"currentIndex":99}');
    expect(new PlaybackQueueStore('client', storage).load()).toBeUndefined();
  });

  describe('editing a queue that is already playing', () => {
    const seeded = (storage: MemoryStorage) => {
      const store = new PlaybackQueueStore('client', storage);
      store.replace([track('one'), track('two'), track('three')], 1);
      store.updatePosition(42_000);
      return store;
    };

    it('keeps the position when a reorder leaves the current item playing', () => {
      // Dragging a row below the playing track is not starting a new queue.
      // With only `replace`, every rearrangement restarts the track.
      const storage = new MemoryStorage();
      const store = seeded(storage);

      expect(store.setItems([track('three'), track('two'), track('one')], 1)).toMatchObject({
        currentIndex: 1,
        positionMs: 42_000,
        items: [{ id: 'three' }, { id: 'two' }, { id: 'one' }],
      });
    });

    it('resets the position when the edit lands on a different item', () => {
      // Carrying a position across a change of item is how a viewer ends up
      // forty seconds into something that has just started.
      const storage = new MemoryStorage();
      const store = seeded(storage);

      expect(store.setItems([track('one'), track('three')], 1)).toMatchObject({
        currentIndex: 1,
        positionMs: 0,
        items: [{ id: 'one' }, { id: 'three' }],
      });
    });

    it('resets the position when the current item is removed', () => {
      const storage = new MemoryStorage();
      const store = seeded(storage);

      expect(store.setItems([track('one'), track('three')], 0)?.positionMs).toBe(0);
    });

    it('clears rather than leaving an empty queue when the last playable item goes', () => {
      const storage = new MemoryStorage();
      const store = seeded(storage);

      expect(store.setItems([])).toBeUndefined();
      expect(store.load()).toBeUndefined();
    });

    it('drops unplayable items exactly as replace does', () => {
      const storage = new MemoryStorage();
      const store = seeded(storage);
      const album = { id: 'album', kind: 'album', title: 'album', mediaIds: [] } as unknown as MediaSummary;

      expect(store.setItems([track('one'), album, track('two')], 0)?.items).toEqual([
        { id: 'one', kind: 'track', title: 'one', mediaIds: ['media:one'] },
        { id: 'two', kind: 'track', title: 'two', mediaIds: ['media:two'] },
      ]);
    });

    it('starts a queue when there is nothing to edit', () => {
      const storage = new MemoryStorage();
      const store = new PlaybackQueueStore('client', storage);

      expect(store.setItems([track('one')], 0)).toMatchObject({ positionMs: 0, currentIndex: 0 });
    });
  });
});

describe('safety for a reactive caller', () => {
  // The failure this prevents is not untidiness. A hook that subscribes and
  // then reads memoises on the store, whose identity never changes, so the
  // queue freezes at whatever it first computed while the store goes on
  // changing underneath. Code that looks correct, producing a list that
  // silently stops updating.
  const storeWith = () => new PlaybackQueueStore('reactive', new MemoryStorage());

  it('hands back the same reference until something changes', () => {
    const store = storeWith();
    store.replace([track('a'), track('b')]);
    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });

  it('hands back a new reference after a mutation, so a memo re-runs', () => {
    const store = storeWith();
    store.replace([track('a')]);
    const before = store.getSnapshot();
    store.append([track('b')]);
    expect(store.getSnapshot()).not.toBe(before);
    expect(store.getSnapshot()?.items.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('notifies a subscriber on every mutation, including a clear', () => {
    const store = storeWith();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => { notifications += 1; });
    store.replace([track('a')]);
    store.append([track('b')]);
    store.select(1);
    store.updatePosition(5_000);
    store.insertNext([track('c')]);
    store.setItems([track('a'), track('c')], 0);
    store.clear();
    expect(notifications).toBe(7);
    unsubscribe();
    store.replace([track('d')]);
    expect(notifications).toBe(7);
  });

  it('treats an absent queue as a real snapshot rather than an uncomputed one', () => {
    // `undefined` is a legitimate value here, so emptiness cannot be inferred
    // from the cache being unset without re-reading storage on every call.
    const store = storeWith();
    expect(store.getSnapshot()).toBeUndefined();
    store.replace([track('a')]);
    expect(store.getSnapshot()?.items).toHaveLength(1);
    store.clear();
    expect(store.getSnapshot()).toBeUndefined();
  });
});

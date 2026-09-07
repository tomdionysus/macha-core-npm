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
});

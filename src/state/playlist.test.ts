import { describe, expect, it } from 'vitest';
import type { MediaSummary } from '../types.js';
import { PlaylistStore } from './playlist.js';

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

describe('PlaylistStore', () => {
  it('keeps playlists distinct and appends without duplicating', () => {
    const storage = new MemoryStorage();
    const store = new PlaylistStore('client', storage);
    const first = store.create('Road trip', [track('one')]);
    store.create('Dinner');

    store.add(first.id, [track('one'), track('two')]);

    expect(store.list()).toHaveLength(2);
    expect(store.get(first.id)?.items.map((item) => item.id)).toEqual(['one', 'two']);
  });

  it('survives a reload, and rejects a malformed file rather than throwing', () => {
    const storage = new MemoryStorage();
    const created = new PlaylistStore('client', storage).create('Keep', [track('one')]);
    expect(new PlaylistStore('client', storage).get(created.id)?.name).toBe('Keep');

    storage.setItem('macha.playlists.v1.client', JSON.stringify({ version: 1, playlists: [{ id: 'x' }] }));
    expect(new PlaylistStore('client', storage).list()).toEqual([]);
  });

  it('adopts a single unnamed list from the store it replaces, once', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'macha.musicPlaylist.v1.client',
      JSON.stringify([{ entryId: 'a', track: track('one') }, { entryId: 'b', track: track('two') }]),
    );

    const store = new PlaylistStore('client', storage);
    const adopted = store.list();
    expect(adopted).toHaveLength(1);
    expect(adopted[0]?.name).toBe('');
    expect(adopted[0]?.items.map((item) => item.id)).toEqual(['one', 'two']);

    // Adoption must never overwrite a real collection on a later read.
    store.delete(adopted[0]!.id);
    expect(new PlaylistStore('client', storage).list()).toEqual([]);
  });

  it('moves an entry and treats an out-of-range index as a no-op', () => {
    const storage = new MemoryStorage();
    const store = new PlaylistStore('client', storage);
    const list = store.create('Order', [track('one'), track('two'), track('three')]);

    expect(store.move(list.id, 2, 0)?.items.map((item) => item.id)).toEqual(['three', 'one', 'two']);
    expect(store.move(list.id, 9, 0)?.items.map((item) => item.id)).toEqual(['three', 'one', 'two']);
  });

  it('purges an item from every playlist that holds it', () => {
    const storage = new MemoryStorage();
    const store = new PlaylistStore('client', storage);
    const a = store.create('A', [track('one'), track('two')]);
    const b = store.create('B', [track('one')]);

    store.purge('one');

    expect(store.get(a.id)?.items.map((item) => item.id)).toEqual(['two']);
    expect(store.get(b.id)?.items).toEqual([]);
  });

  it('invalidates the snapshot on mutation so a reactive caller sees the change', () => {
    const storage = new MemoryStorage();
    const store = new PlaylistStore('client', storage);
    const before = store.getSnapshot();

    let notified = 0;
    store.subscribe(() => { notified += 1; });
    store.create('New');

    expect(notified).toBe(1);
    expect(store.getSnapshot()).not.toBe(before);
  });

  it('treats an out-of-range removal as a no-op rather than a change', () => {
    // `move` already guards this. Without the same guard, a removal that
    // removes nothing still bumps `updatedAt` and so reorders a list sorted by
    // it — an action that did nothing visibly rearranging the screen.
    const store = new PlaylistStore('client', new MemoryStorage());
    const playlist = store.create('Road trip', [track('a'), track('b')]);
    const before = store.get(playlist.id)!.updatedAt;

    const after = store.removeAt(playlist.id, 7);

    expect(after?.items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(after?.updatedAt).toBe(before);
  });
});

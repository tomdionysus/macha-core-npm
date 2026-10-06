import { describe, expect, it } from 'vitest';
import type { MediaSummary } from '../types.js';
import { PlaylistStore } from './playlist.js';
import { MachaSavedRowLimitError, SAVED_ROW_LIMIT_BYTES, utf8Bytes } from './savedTitle.js';

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

    storage.setItem('macha.core.client.client.playlists', JSON.stringify({ version: 1, playlists: [{ id: 'x' }] }));
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
    // it: an action that did nothing visibly rearranging the screen.
    const store = new PlaylistStore('client', new MemoryStorage());
    const playlist = store.create('Road trip', [track('a'), track('b')]);
    const before = store.get(playlist.id)!.updatedAt;

    const after = store.removeAt(playlist.id, 7);

    expect(after?.items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(after?.updatedAt).toBe(before);
  });

  it('stores slim entries, without the synopsis or anything that is how things stand now', () => {
    const storage = new MemoryStorage();
    const store = new PlaylistStore('client', storage);
    const full: MediaSummary = {
      ...track('one'),
      synopsis: 'x'.repeat(5000),
      catalogueUpdatedNs: 1,
      releaseDate: '2020-01-01',
      availability: 'unavailable',
      artwork: { poster: { id: 'art', mimeType: 'image/jpeg', url: 'https://node/a' } },
      musicContext: { album: { id: 'album', title: 'Album' } },
    };
    const playlist = store.create('Slim', [full]);

    const saved = new PlaylistStore('client', storage).get(playlist.id)!.items[0]!;
    expect(saved).toEqual({
      id: 'one', kind: 'track', title: 'one', mediaIds: ['media:one'],
      artwork: { poster: { id: 'art', mimeType: 'image/jpeg', url: 'https://node/a' } },
      musicContext: { album: { id: 'album', title: 'Album' } },
    });
    expect(storage.getItem(`macha.core.client.client.playlists.${playlist.id}`)).not.toContain('xxxx');
  });

  it('keeps each playlist in a row of its own, so one bad row costs only its own items', () => {
    const storage = new MemoryStorage();
    const store = new PlaylistStore('client', storage);
    const a = store.create('A', [track('one')]);
    const b = store.create('B', [track('two')]);

    storage.setItem(`macha.core.client.client.playlists.${a.id}`, '{not json');

    const reread = new PlaylistStore('client', storage);
    expect(reread.get(a.id)?.items).toEqual([]);
    expect(reread.get(a.id)?.name).toBe('A');
    expect(reread.get(b.id)?.items.map((item) => item.id)).toEqual(['two']);
  });

  it('removes a deleted playlist\'s row', () => {
    const storage = new MemoryStorage();
    const store = new PlaylistStore('client', storage);
    const a = store.create('A', [track('one')]);

    store.delete(a.id);

    expect(storage.getItem(`macha.core.client.client.playlists.${a.id}`)).toBeNull();
    expect(store.list()).toEqual([]);
  });

  it('refuses a change that would make a row unreadable, and keeps what was saved', () => {
    const storage = new MemoryStorage();
    const store = new PlaylistStore('client', storage);
    const playlist = store.create('Big', [track('one')]);
    const many = Array.from({ length: 20_000 }, (_, index) => track(`track-${index}-${'y'.repeat(40)}`));

    expect(() => store.add(playlist.id, many)).toThrow(MachaSavedRowLimitError);

    expect(new PlaylistStore('client', storage).get(playlist.id)?.items.map((item) => item.id)).toEqual(['one']);
    for (const key of ['macha.core.client.client.playlists', `macha.core.client.client.playlists.${playlist.id}`]) {
      expect(utf8Bytes(storage.getItem(key)!)).toBeLessThanOrEqual(SAVED_ROW_LIMIT_BYTES);
    }
  });

  it('adopts the single-row form, slimmed and split, losing nothing', () => {
    const storage = new MemoryStorage();
    const old = (id: string, items: MediaSummary[]) => ({ id, name: id, items, createdAt: 1, updatedAt: id === 'a' ? 2 : 1 });
    storage.setItem('macha.core.client.client.playlists', JSON.stringify({
      version: 1,
      playlists: [old('a', [{ ...track('one'), synopsis: 'long' }]), old('b', [track('two'), track('three')])],
    }));

    const adopted = new PlaylistStore('client', storage).list();
    expect(adopted.map((playlist) => [playlist.id, playlist.items.map((item) => item.id)])).toEqual([
      ['a', ['one']],
      ['b', ['two', 'three']],
    ]);
    expect(adopted[0]!.items[0]).not.toHaveProperty('synopsis');
    expect(JSON.parse(storage.getItem('macha.core.client.client.playlists')!).version).toBe(2);
    expect(new PlaylistStore('client', storage).get('b')?.items).toHaveLength(2);
  });
});

describe('utf8Bytes', () => {
  it('counts what a row holds, not UTF-16 units', () => {
    expect(utf8Bytes('abc')).toBe(3);
    expect(utf8Bytes('é')).toBe(2);
    expect(utf8Bytes('日本')).toBe(6);
    expect(utf8Bytes('\u{1F3B5}')).toBe(4);
  });
});

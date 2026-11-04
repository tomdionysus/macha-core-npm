import { describe, expect, it } from 'vitest';
import { memoryStorage } from '../runtime/host.js';
import { READING_POSITION_LIMIT, ReadingPositionStore, readingPositionKey } from './readingPosition.js';
import { isMachaStorageKey, machaStorageKeyClientId } from '../runtime/storageKeys.js';

describe('ReadingPositionStore', () => {
  it('keeps one position per file, most recently read first, clamping progress', () => {
    const store = new ReadingPositionStore('c', memoryStorage());
    store.set({ mediaId: 'macha:a', itemId: 'book:a', position: 'epubcfi(/6/4)', progressPermille: 120.4, finished: false, updatedAt: 1 });
    store.set({ mediaId: 'macha:b', position: '12', progressPermille: 2000, finished: true, updatedAt: 3 });
    store.set({ mediaId: 'macha:a', position: 'epubcfi(/6/8)', progressPermille: -5, finished: false, updatedAt: 2 });
    expect(store.list().map((entry) => [entry.mediaId, entry.position, entry.progressPermille])).toEqual([
      ['macha:b', '12', 1000],
      ['macha:a', 'epubcfi(/6/8)', 0],
    ]);
    expect(store.get('macha:a')?.itemId).toBeUndefined();
    store.remove('macha:b');
    expect(store.list().map((entry) => entry.mediaId)).toEqual(['macha:a']);
  });

  it('keeps its key under core\'s per-client convention', () => {
    const storage = memoryStorage();
    new ReadingPositionStore('client-1', storage).set({ mediaId: 'macha:a', position: '1', progressPermille: 1, finished: false });
    const key = readingPositionKey('client-1');
    expect(storage.getItem(key)).not.toBeNull();
    expect(isMachaStorageKey(key)).toBe(true);
    expect(machaStorageKeyClientId(key)).toBe('client-1');
  });

  it('drops the least recently read past the limit, and an entry that does not read back', () => {
    const storage = memoryStorage();
    const store = new ReadingPositionStore('c', storage);
    for (let index = 0; index <= READING_POSITION_LIMIT; index += 1) {
      store.set({ mediaId: `macha:${index}`, position: '0', progressPermille: 0, finished: false, updatedAt: index });
    }
    expect(store.list()).toHaveLength(READING_POSITION_LIMIT);
    expect(store.get('macha:0')).toBeUndefined();
    storage.setItem(readingPositionKey('c'), JSON.stringify({ version: 1, positions: [{ mediaId: 'macha:x' }] }));
    expect(store.list()).toEqual([]);
  });

  it('tells subscribers, with a snapshot stable between changes', () => {
    const store = new ReadingPositionStore('c', memoryStorage());
    let calls = 0;
    store.subscribe(() => { calls += 1; });
    const before = store.getSnapshot();
    expect(store.getSnapshot()).toBe(before);
    store.set({ mediaId: 'macha:a', position: '1', progressPermille: 1, finished: false });
    expect(calls).toBe(1);
    expect(store.getSnapshot()).not.toBe(before);
  });
});

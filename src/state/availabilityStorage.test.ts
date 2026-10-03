import { describe, expect, it } from 'vitest';
import type { MediaSummary } from '../types.js';
import { memoryStorage } from '../runtime/host.js';
import { ContinueWatchingStore } from './continueWatching.js';
import { MusicPlaylistStore } from './musicPlaylist.js';
import { PlaybackQueueStore } from './playbackQueue.js';
import { PlaylistStore } from './playlist.js';

// A stored `unavailable` would grey out and lock the title after its node came
// back (the Android TV client, 2026-10-03), so no store keeps availability.
const unavailable = (id: string, kind: MediaSummary['kind'] = 'movie'): MediaSummary => ({
  id, kind, title: id, mediaIds: [`media:${id}`], availability: 'unavailable',
  availabilityMembers: { total: 1, complete: 0, partial: 0, unavailable: 1, unknown: 0 },
});

describe('stores keep no availability', () => {
  it('Continue Watching', () => {
    const storage = memoryStorage();
    new ContinueWatchingStore('c', storage).update({ itemId: 'm', positionMs: 60_000, durationMs: 600_000, updatedAt: 1, media: unavailable('m') });
    const [entry] = new ContinueWatchingStore('c', storage).list();
    expect(entry.media?.id).toBe('m');
    expect(entry.media).not.toHaveProperty('availability');
    expect(entry.media).not.toHaveProperty('availabilityMembers');
  });

  it('the play queue, while the live queue keeps it', () => {
    const storage = memoryStorage();
    const live = new PlaybackQueueStore('c', storage).replace([unavailable('a'), unavailable('b')]);
    expect(live.items[0].availability).toBe('unavailable');
    const stored = new PlaybackQueueStore('c', storage).load();
    expect(stored?.items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(stored?.items.some((item) => 'availability' in item)).toBe(false);
  });

  it('playlists and the music playlist', () => {
    const storage = memoryStorage();
    new PlaylistStore('c', storage).create('List', [unavailable('t', 'track')]);
    const [playlist] = new PlaylistStore('c', storage).list();
    expect(playlist.items[0]).not.toHaveProperty('availability');

    new MusicPlaylistStore('c', storage).add([unavailable('u', 'track')]);
    const [entry] = new MusicPlaylistStore('c', storage).load();
    expect(entry.track).not.toHaveProperty('availability');
  });
});

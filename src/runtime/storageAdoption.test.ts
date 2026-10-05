import { describe, expect, it } from 'vitest';
import { EndpointBandwidth } from '../cluster/EndpointBandwidth.js';
import { ArtworkHostPreference } from '../state/artworkHost.js';
import { ContinueWatchingStore } from '../state/continueWatching.js';
import { MusicPlaylistStore } from '../state/musicPlaylist.js';
import { PlaybackQueueStore } from '../state/playbackQueue.js';
import { PlaylistStore } from '../state/playlist.js';
import { QualityPreferenceStore } from '../state/qualityPreference.js';
import { memoryStorage } from './host.js';
import { MachaClientConfiguration } from './configuration.js';
import { isMachaStorageKey, machaClientKey, machaCoreKey, machaStorageKeyClientId } from './storageKeys.js';

/**
 * Tom, 2026-10-05: one storage convention that version churn cannot break.
 * Every store adopts its key from before that day on first read: the value
 * moves under `macha.core.`, and the old key is removed.
 */
describe('adopting the keys from before 2026-10-05', () => {
  const track = (id: string) => ({ id, kind: 'track' as const, title: id, mediaIds: [`media:${id}`] });

  it('keeps the client id, so no per-client store is orphaned', () => {
    const storage = memoryStorage({ 'macha-client-id': 'old-id' });
    const configuration = new MachaClientConfiguration({ storage });
    expect(configuration.existingClientId()).toBe('old-id');
    expect(configuration.clientId()).toBe('old-id');
    expect(storage.getItem(machaCoreKey('clientId'))).toBe('old-id');
    expect(storage.getItem('macha-client-id')).toBeNull();
  });

  it('keeps the bootstrap and discovered endpoints', () => {
    const list = (urls: string[]) => JSON.stringify({ version: 1, urls });
    const storage = memoryStorage({
      'macha-bootstrap-endpoints-v1': list(['http://a:7438']),
      'macha-discovered-endpoints-v1': list(['http://b:7438']),
    });
    const configuration = new MachaClientConfiguration({ storage });
    expect(configuration.bootstrapEndpoints()).toEqual(['http://a:7438']);
    expect(configuration.discoveredEndpoints()).toEqual(['http://b:7438']);
    expect(storage.getItem('macha-bootstrap-endpoints-v1')).toBeNull();
    expect(storage.getItem('macha-discovered-endpoints-v1')).toBeNull();
  });

  it('keeps Continue Watching, the queue and the single music list', () => {
    const progress = { itemId: 'm', positionMs: 10_000, durationMs: 600_000, updatedAt: 1 };
    const queue = { items: [track('one')], currentIndex: 0, positionMs: 0, updatedAt: 1 };
    const storage = memoryStorage({
      'macha.continueWatching.v1.c': JSON.stringify([progress]),
      'macha.playbackQueue.v1.c': JSON.stringify(queue),
      'macha.musicPlaylist.v1.c': JSON.stringify([{ entryId: 'e', track: track('one') }]),
    });
    expect(new ContinueWatchingStore('c', storage).list().map((entry) => entry.itemId)).toEqual(['m']);
    expect(new PlaybackQueueStore('c', storage).load()?.items.map((item) => item.id)).toEqual(['one']);
    expect(new MusicPlaylistStore('c', storage).load().map((entry) => entry.track.id)).toEqual(['one']);
    for (const old of ['macha.continueWatching.v1.c', 'macha.playbackQueue.v1.c', 'macha.musicPlaylist.v1.c']) {
      expect(storage.getItem(old)).toBeNull();
    }
    expect(storage.getItem(machaClientKey('c', 'continueWatching'))).not.toBeNull();
  });

  it('moves every playlist with its own row', () => {
    const storage = memoryStorage({
      'macha.playlists.v1.c': JSON.stringify({ version: 2, playlists: [{ id: 'p', name: 'Road trip', createdAt: 1, updatedAt: 1 }] }),
      'macha.playlists.v1.c.p': JSON.stringify({ version: 2, items: [track('one')] }),
    });
    const playlists = new PlaylistStore('c', storage).list();
    expect(playlists.map((playlist) => [playlist.name, playlist.items.map((item) => item.id)])).toEqual([['Road trip', ['one']]]);
    expect(storage.getItem(machaClientKey('c', 'playlists.p'))).not.toBeNull();
    expect(storage.getItem('macha.playlists.v1.c')).toBeNull();
    expect(storage.getItem('macha.playlists.v1.c.p')).toBeNull();
  });

  it('keeps the quality choice and the artwork host', () => {
    const storage = memoryStorage({
      'macha.qualityPreference.v1': JSON.stringify({ offerAll: true }),
      'macha.artworkHost.v1': 'http://a',
    });
    expect(new QualityPreferenceStore(storage).get()).toEqual({ offerAll: true });
    expect(new ArtworkHostPreference(storage).get()).toBe('http://a');
    expect(storage.getItem('macha.qualityPreference.v1')).toBeNull();
    expect(storage.getItem('macha.artworkHost.v1')).toBeNull();
  });

  it('keeps measured bandwidth', () => {
    const record = { bytesPerSecond: 1_000_000, samples: 3, updatedAt: Date.now() };
    const storage = memoryStorage({ 'macha-client-bandwidth:c': JSON.stringify({ 'http://a': record }) });
    const bandwidth = new EndpointBandwidth('c', storage);
    expect(bandwidth.bytesPerSecond('http://a')).toBe(1_000_000);
    expect(storage.getItem('macha-client-bandwidth:c')).toBeNull();
  });

  it('does not bring a cleared list back from its old key', () => {
    const storage = memoryStorage({ 'macha.musicPlaylist.v1.c': JSON.stringify([{ entryId: 'e', track: track('one') }]) });
    const store = new MusicPlaylistStore('c', storage);
    store.replace([]);
    expect(new MusicPlaylistStore('c', storage).load()).toEqual([]);
  });
});

describe('reading core keys without parsing them', () => {
  it('names the client a key belongs to, in either convention and with a row after it', () => {
    expect(machaStorageKeyClientId('macha.core.client.abc-1.playlists')).toBe('abc-1');
    expect(machaStorageKeyClientId('macha.core.client.abc-1.playlists.p9')).toBe('abc-1');
    expect(machaStorageKeyClientId('macha.playlists.v1.abc-1.p9')).toBe('abc-1');
    expect(machaStorageKeyClientId('macha-client-progress:abc-1')).toBe('abc-1');
    expect(machaStorageKeyClientId('macha.core.session')).toBeUndefined();
    expect(machaStorageKeyClientId('macha.clientId.v1')).toBeUndefined();
  });

  it('recognises every key under macha.core. as core\'s, and no client\'s own', () => {
    expect(isMachaStorageKey('macha.core.anything.new')).toBe(true);
    expect(isMachaStorageKey('macha.clientId.v1')).toBe(false);
    expect(isMachaStorageKey('macha.downloads.v1.abc')).toBe(false);
  });
});

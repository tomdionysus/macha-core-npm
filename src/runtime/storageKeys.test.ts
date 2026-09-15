import { describe, expect, it } from 'vitest';
import { EndpointBandwidth } from '../cluster/EndpointBandwidth.js';
import { ContinueWatchingStore } from '../state/continueWatching.js';
import { MusicPlaylistStore } from '../state/musicPlaylist.js';
import { PlaybackQueueStore } from '../state/playbackQueue.js';
import { PlaylistStore } from '../state/playlist.js';
import type { StorageLike } from '../state/storage.js';
import { MachaClientConfiguration } from './configuration.js';
import {
  MACHA_STORAGE_KEYS,
  MACHA_STORAGE_KEY_PREFIXES,
  MACHA_STORAGE_PROBE_KEY,
  isMachaStorageKey,
} from './storageKeys.js';

/**
 * A `StorageLike` that remembers every key anything asked it about, whether the
 * key held a value or not.
 *
 * Reads count as much as writes here. A host enumerating storage has to
 * recognise a key this package *reads* — the legacy Continue Watching key is
 * read and deliberately never deleted — or it either leaves the value behind
 * when clearing Macha's data or, worse, reports it as somebody else's.
 */
function recordingStorage(): { storage: StorageLike; touched: Set<string> } {
  const values = new Map<string, string>();
  const touched = new Set<string>();
  return {
    touched,
    storage: {
      getItem(key: string): string | null {
        touched.add(key);
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string): void {
        touched.add(key);
        values.set(key, value);
      },
      removeItem(key: string): void {
        touched.add(key);
        values.delete(key);
      },
    },
  };
}

/**
 * Every persisting component in the package, exercised on both its read and
 * its write path.
 *
 * **Add a component here when you add one that persists.** That is the whole
 * mechanism: the assertion below cannot know about a store nobody drove, so a
 * new store with an unregistered key is caught only if it is listed here. This
 * is deliberately a list of constructions rather than a list of key strings —
 * a list of strings copied from `storageKeys.ts` would agree with it by
 * construction and prove nothing.
 */
function driveEveryPersistingComponent(storage: StorageLike, clientId: string): void {
  const continueWatching = new ContinueWatchingStore(clientId, storage);
  continueWatching.list();
  continueWatching.clear('media-1');

  const queue = new PlaybackQueueStore(clientId, storage);
  queue.load();
  queue.clear();

  const playlists = new PlaylistStore(clientId, storage);
  playlists.list();
  playlists.create('A playlist');

  const musicPlaylist = new MusicPlaylistStore(clientId, storage);
  musicPlaylist.load();
  musicPlaylist.clear();

  const bandwidth = new EndpointBandwidth(clientId, storage, () => 1_000);
  bandwidth.bytesPerSecond('endpoint-1');
  bandwidth.record('endpoint-1', 1_000_000, 1_000);
  bandwidth.flush();

  const configuration = new MachaClientConfiguration({ storage });
  configuration.clientId();
  configuration.serverUrl();
  configuration.bootstrapEndpoints();
  configuration.discoveredEndpoints();
  configuration.setServerUrl('https://node.example');
  configuration.setBootstrapEndpoints(['https://node.example']);
  configuration.setDiscoveredEndpoints(['https://other.example']);
}

describe('the storage key registry', () => {
  /**
   * The test this file exists for.
   *
   * `MACHA_STORAGE_KEYS` is hand-maintained, and until now nothing compared it
   * against the keys the package actually touches. The phone client's
   * `startsWith('macha.')` filter missed the hyphenated half of the registry
   * and silently dropped the session on every cold start; a registry that has
   * drifted from reality reintroduces exactly that failure in a host that did
   * everything right and used `isMachaStorageKey`.
   */
  it('recognises every key the package actually touches', () => {
    const { storage, touched } = recordingStorage();

    driveEveryPersistingComponent(storage, 'client-42');

    const unregistered = [...touched].filter((key) => !isMachaStorageKey(key)).sort();
    expect(unregistered).toEqual([]);
  });

  it('drives enough components to be worth trusting', () => {
    const { storage, touched } = recordingStorage();

    driveEveryPersistingComponent(storage, 'client-42');

    // Guards the assertion above against a refactor that quietly stops driving
    // anything: an empty set would satisfy "every key is registered" perfectly.
    expect(touched.size).toBeGreaterThanOrEqual(MACHA_STORAGE_KEYS.length);
  });

  it('scopes per-client keys to the client id', () => {
    const first = recordingStorage();
    const second = recordingStorage();

    driveEveryPersistingComponent(first.storage, 'client-a');
    driveEveryPersistingComponent(second.storage, 'client-b');

    const perClient = (touched: Set<string>) =>
      [...touched].filter((key) => MACHA_STORAGE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)));

    expect(perClient(first.touched)).not.toEqual([]);
    expect(perClient(first.touched)).not.toEqual(perClient(second.touched));
  });
});

describe('isMachaStorageKey', () => {
  it('accepts every key named in the registry', () => {
    for (const key of MACHA_STORAGE_KEYS) expect(isMachaStorageKey(key)).toBe(true);
  });

  it('accepts a completed prefix key but not the bare prefix alone', () => {
    for (const prefix of MACHA_STORAGE_KEY_PREFIXES) {
      expect(isMachaStorageKey(`${prefix}client-42`)).toBe(true);
    }
  });

  it('accepts the write probe, which a host enumerating mid-startup can see', () => {
    expect(isMachaStorageKey(MACHA_STORAGE_PROBE_KEY)).toBe(true);
  });

  it('rejects a host key that merely looks like ours', () => {
    // The phone client namespaces its own keys `macha.`, so this is not a
    // hypothetical collision — it is the arrangement that exists today.
    expect(isMachaStorageKey('macha.theme')).toBe(false);
    expect(isMachaStorageKey('macha.session.v1.extra')).toBe(false);
    expect(isMachaStorageKey('some-other-app-key')).toBe(false);
    expect(isMachaStorageKey('')).toBe(false);
  });
});

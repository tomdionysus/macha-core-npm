import type { MediaSummary } from '../types.js';
import { machaHost } from '../runtime/host.js';
import { isPlayable } from './playbackQueue.js';
import { readValidatedJson, writeJson, type StorageLike } from './storage.js';

export interface Playlist {
  id: string;
  name: string;
  /**
   * Full item snapshots rather than catalogue ids.
   *
   * A playlist has to render and play with no node reachable — that is the
   * whole point once downloads exist — so it carries what it needs to draw a
   * row and start playback. It costs a little duplication against the
   * catalogue and buys working offline playlists.
   */
  items: MediaSummary[];
  createdAt: number;
  updatedAt: number;
}

interface PlaylistFile {
  version: 1;
  playlists: Playlist[];
}

/** The single unnamed list this store replaces. Read once, to adopt it. */
interface LegacyEntry {
  entryId: string;
  track: MediaSummary;
}


function validPlaylist(value: unknown): value is Playlist {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Playlist>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    Array.isArray(candidate.items) &&
    candidate.items.every((item) => item && typeof item === 'object' && typeof (item as MediaSummary).id === 'string') &&
    typeof candidate.createdAt === 'number' &&
    typeof candidate.updatedAt === 'number'
  );
}

function validFile(value: unknown): value is PlaylistFile {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PlaylistFile>;
  return candidate.version === 1 && Array.isArray(candidate.playlists) && candidate.playlists.every(validPlaylist);
}

function validLegacy(value: unknown): value is LegacyEntry[] {
  return Array.isArray(value)
    && value.every((entry) => entry && typeof entry === 'object'
      && typeof (entry as LegacyEntry).entryId === 'string'
      && typeof (entry as LegacyEntry).track?.id === 'string');
}

/**
 * User-curated playlists, held on this device only.
 *
 * Macha has no playlist API and deliberately stores no per-viewer state, so
 * playlists sit alongside Continue Watching and the play queue as client-owned
 * data. They are never sent to a node.
 *
 * There is deliberately no `replace`. The store this supersedes held a single
 * unnamed list, where "discard everything and substitute these tracks" read as
 * a scratch space being reused; against a collection the same call is data loss
 * with a friendly label. Its only caller was a Play-all button that was setting
 * the queue through the nearest store to hand. `create(name, items)` covers
 * making a playlist out of an album, explicitly and without destroying anything.
 */
export class PlaylistStore {
  private readonly key: string;
  private readonly legacyKey: string;
  private readonly listeners = new Set<() => void>();
  /**
   * The last read, held until something changes it.
   *
   * A reactive caller needs a *value* that changes to know this store has
   * changed, and it has to be the value it actually renders. A revision counter
   * is not enough: a hook that subscribes to one and then calls `list()` anyway
   * compiles to a memo keyed on the store itself, which never changes identity,
   * so the list freezes at whatever it first computed. That is a bug that looks
   * like correct code.
   */
  private cached: Playlist[] | undefined;

  constructor(clientId: string, private readonly storage: StorageLike = machaHost().storage) {
    this.key = `macha.playlists.v1.${clientId}`;
    this.legacyKey = `macha.musicPlaylist.v1.${clientId}`;
  }

  /** Stable between mutations, as `useSyncExternalStore` requires. */
  getSnapshot = (): Playlist[] => {
    this.cached ??= this.list();
    return this.cached;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private changed(): void {
    this.cached = undefined;
    for (const listener of this.listeners) listener();
  }

  list(): Playlist[] {
    const file = readValidatedJson(this.storage, this.key, validFile);
    if (file) return [...file.playlists].sort((a, b) => b.updatedAt - a.updatedAt);
    return this.adoptLegacy();
  }

  /**
   * Take over a single unnamed list left by the store this replaces.
   *
   * Only when nothing has been written here yet, so it can never overwrite a
   * collection. It arrives with no name, like any list the viewer did not
   * name: a host shows its own placeholder, and the viewer can rename it.
   */
  private adoptLegacy(): Playlist[] {
    const legacy = readValidatedJson(this.storage, this.legacyKey, validLegacy);
    if (!legacy || legacy.length === 0) return [];
    const now = Date.now();
    const adopted: Playlist = {
      id: machaHost().uuid(),
      name: '',
      items: legacy.map((entry) => entry.track).filter(isPlayable),
      createdAt: now,
      updatedAt: now,
    };
    writeJson<PlaylistFile>(this.storage, this.key, { version: 1, playlists: [adopted] });
    return [adopted];
  }

  get(id: string): Playlist | undefined {
    return this.list().find((playlist) => playlist.id === id);
  }

  create(name: string, items: readonly MediaSummary[] = []): Playlist {
    const now = Date.now();
    const playlist: Playlist = {
      id: machaHost().uuid(),
      // Empty when the viewer gave none. A host shows its own placeholder;
      // core writes no viewer text, and a stored default would be English
      // saved into the viewer's data.
      name: name.trim(),
      items: items.filter(isPlayable),
      createdAt: now,
      updatedAt: now,
    };
    this.write([playlist, ...this.list()]);
    return playlist;
  }

  rename(id: string, name: string): Playlist | undefined {
    return this.mutate(id, (playlist) => ({ ...playlist, name: name.trim() || playlist.name }));
  }

  delete(id: string): void {
    this.write(this.list().filter((playlist) => playlist.id !== id));
  }

  /** Appends, skipping anything already present so a double-tap cannot duplicate a track. */
  add(id: string, items: readonly MediaSummary[]): Playlist | undefined {
    return this.mutate(id, (playlist) => {
      const existing = new Set(playlist.items.map((item) => item.id));
      const additions = items.filter((item) => isPlayable(item) && !existing.has(item.id));
      return additions.length === 0 ? playlist : { ...playlist, items: [...playlist.items, ...additions] };
    });
  }

  /** Removes one entry. An out-of-range index is a no-op, as in `move`. */
  removeAt(id: string, index: number): Playlist | undefined {
    return this.mutate(id, (playlist) => {
      // Without this guard a removal that removes nothing still counts as a
      // change, bumping `updatedAt` and so moving the playlist to the top of a
      // list ordered by it — a reorder caused by an action that did nothing.
      if (index < 0 || index >= playlist.items.length) return playlist;
      return { ...playlist, items: playlist.items.filter((_, position) => position !== index) };
    });
  }

  /** Moves one entry, for drag-to-reorder. Out-of-range indices are a no-op rather than an error. */
  move(id: string, from: number, to: number): Playlist | undefined {
    return this.mutate(id, (playlist) => {
      if (from === to || from < 0 || to < 0 || from >= playlist.items.length || to >= playlist.items.length) {
        return playlist;
      }
      const items = [...playlist.items];
      const [moved] = items.splice(from, 1);
      items.splice(to, 0, moved);
      return { ...playlist, items };
    });
  }

  /** Drops an item from every playlist — used when a track disappears from the catalogue. */
  purge(itemId: string): void {
    this.write(
      this.list().map((playlist) => {
        const items = playlist.items.filter((item) => item.id !== itemId);
        return items.length === playlist.items.length ? playlist : { ...playlist, items, updatedAt: Date.now() };
      }),
    );
  }

  private mutate(id: string, change: (playlist: Playlist) => Playlist): Playlist | undefined {
    const playlists = this.list();
    const index = playlists.findIndex((playlist) => playlist.id === id);
    if (index < 0) return undefined;
    const changed = change(playlists[index]);
    const next = changed === playlists[index] ? changed : { ...changed, updatedAt: Date.now() };
    playlists[index] = next;
    this.write(playlists);
    return next;
  }

  private write(playlists: Playlist[]): void {
    writeJson<PlaylistFile>(this.storage, this.key, { version: 1, playlists });
    this.changed();
  }
}

import type { MediaSummary } from '../types.js';
import { machaHost } from '../runtime/host.js';
import { isPlayable } from './playbackQueue.js';
import { savedRow, savedTitle, type SavedTitle } from './savedTitle.js';
import { readAdoptedJson, readValidatedJson, type StorageLike } from './storage.js';
import { machaClientKey } from '../runtime/storageKeys.js';
import { legacyMusicPlaylistKeys, musicPlaylistKey } from './musicPlaylist.js';

export interface Playlist {
  id: string;
  name: string;
  /**
   * Item snapshots rather than catalogue ids, slimmed to what a row needs
   * (`SavedTitle`).
   *
   * A playlist has to render and play with no node reachable — that is the
   * whole point once downloads exist — so it carries what it needs to draw a
   * row and start playback. It costs a little duplication against the
   * catalogue and buys working offline playlists.
   */
  items: SavedTitle[];
  createdAt: number;
  updatedAt: number;
}

/** A playlist without its items: one entry in the index row. */
type PlaylistHeader = Omit<Playlist, 'items'>;

/** The index row: every playlist's header, in no particular order. */
interface PlaylistIndex {
  version: 2;
  playlists: PlaylistHeader[];
}

/** One playlist's items, in a row of its own. */
interface PlaylistItemsRow {
  version: 2;
  items: SavedTitle[];
}

/** The single-row form, before 2026-10-04: every playlist and every item under one key. */
interface PlaylistFileV1 {
  version: 1;
  playlists: Playlist[];
}

/** The single unnamed list this store replaces. Read once, to adopt it. */
interface LegacyEntry {
  entryId: string;
  track: MediaSummary;
}


function validItems(value: unknown): value is SavedTitle[] {
  return Array.isArray(value)
    && value.every((item) => item && typeof item === 'object' && typeof (item as SavedTitle).id === 'string');
}

function validHeader(value: unknown): value is PlaylistHeader {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PlaylistHeader>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.createdAt === 'number' &&
    typeof candidate.updatedAt === 'number'
  );
}

function validIndex(value: unknown): value is PlaylistIndex {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PlaylistIndex>;
  return candidate.version === 2 && Array.isArray(candidate.playlists) && candidate.playlists.every(validHeader);
}

function validItemsRow(value: unknown): value is PlaylistItemsRow {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PlaylistItemsRow>;
  return candidate.version === 2 && validItems(candidate.items);
}

function validFileV1(value: unknown): value is PlaylistFileV1 {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PlaylistFileV1>;
  return candidate.version === 1 && Array.isArray(candidate.playlists)
    && candidate.playlists.every((playlist) => validHeader(playlist) && validItems((playlist as Playlist).items));
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
 *
 * **Stored as a row per playlist**, under `macha.core.client.<clientId>.playlists.<id>`,
 * with an index row of names and times at `macha.core.client.<clientId>.playlists`, so
 * one large playlist cannot make the others unreadable. Entries are
 * `SavedTitle`s. A change that would take one row past
 * `SAVED_ROW_LIMIT_BYTES` throws `MachaSavedRowLimitError` and saves nothing:
 * a row larger than Android's read window cannot be read back at all. Every
 * row sits under `macha.core.`, which every host already keeps.
 */
export class PlaylistStore {
  private readonly key: string;
  /** The index's name before 2026-10-05; each row was this plus `.<id>`. */
  private readonly legacyIndexKey: string;
  private readonly clientId: string;
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
    this.key = machaClientKey(clientId, 'playlists');
    this.legacyIndexKey = `macha.playlists.v1.${clientId}`;
    this.clientId = clientId;
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
    this.adoptLegacyKeys();
    const index = this.readIndex();
    let playlists: Playlist[];
    if (validIndex(index)) playlists = index.playlists.map((header) => ({ ...header, items: this.readItems(header.id) }));
    else if (validFileV1(index)) playlists = this.adoptSingleRow(index);
    else {
      // Malformed, as `readValidatedJson` treats it: discarded, then the
      // unnamed list this store replaced is looked for.
      if (index !== undefined) this.storage.removeItem(this.key);
      playlists = this.adoptLegacy();
    }
    return [...playlists].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Move the index and every row it lists from their names before
   * 2026-10-05, when nothing is under the current ones yet. The rows go
   * first and the index last, as `store` writes them, so an interrupted move
   * leaves the old index in place to move again.
   */
  private adoptLegacyKeys(): void {
    if (this.storage.getItem(this.key) !== null) return;
    const raw = this.storage.getItem(this.legacyIndexKey);
    if (raw === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    const ids = validIndex(parsed) ? parsed.playlists.map((header) => header.id) : [];
    for (const id of ids) {
      const row = this.storage.getItem(`${this.legacyIndexKey}.${id}`);
      if (row !== null) this.storage.setItem(this.itemsKey(id), row);
    }
    this.storage.setItem(this.key, raw);
    this.storage.removeItem(this.legacyIndexKey);
    for (const id of ids) this.storage.removeItem(`${this.legacyIndexKey}.${id}`);
  }

  /**
   * The index row parsed and not judged, `undefined` when there is none, so
   * that the single-row form it replaces is still there to adopt.
   */
  private readIndex(): unknown {
    const raw = this.storage.getItem(this.key);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }

  /**
   * One playlist's items. A row that is missing or does not parse costs that
   * playlist its items and no other playlist anything, which is the point of
   * a row each.
   */
  private readItems(id: string): SavedTitle[] {
    return readValidatedJson(this.storage, this.itemsKey(id), validItemsRow)?.items ?? [];
  }

  private itemsKey(id: string): string {
    return `${this.key}.${id}`;
  }

  /**
   * Take over the single-row form this store wrote before 2026-10-04, slimmed
   * and split into a row each. Its key is the index's own, so the index
   * written here replaces it.
   */
  private adoptSingleRow(file: PlaylistFileV1): Playlist[] {
    const playlists = file.playlists.map((playlist) => ({ ...playlist, items: playlist.items.map(savedTitle) }));
    try {
      this.store(playlists, new Set(playlists.map((playlist) => playlist.id)));
    } catch {
      // A row that was readable whole splits into smaller ones, so this
      // should not refuse. If it does, nothing was written, and the old row
      // is still there to adopt next time.
    }
    return playlists;
  }

  /**
   * Take over a single unnamed list left by the store this replaces.
   *
   * Only when nothing has been written here yet, so it can never overwrite a
   * collection. It arrives with no name, like any list the viewer did not
   * name: a host shows its own placeholder, and the viewer can rename it.
   */
  private adoptLegacy(): Playlist[] {
    const legacy = readAdoptedJson(this.storage, musicPlaylistKey(this.clientId), legacyMusicPlaylistKeys(this.clientId), validLegacy);
    if (!legacy || legacy.length === 0) return [];
    const now = Date.now();
    const adopted: Playlist = {
      id: machaHost().uuid(),
      name: '',
      items: legacy.map((entry) => entry.track).filter(isPlayable).map(savedTitle),
      createdAt: now,
      updatedAt: now,
    };
    try {
      this.store([adopted], new Set([adopted.id]));
    } catch {
      // Too large for one row: still shown, and adopted again next time.
    }
    return [adopted];
  }

  get(id: string): Playlist | undefined {
    return this.list().find((playlist) => playlist.id === id);
  }

  /** Throws `MachaSavedRowLimitError`, saving nothing, when `items` will not fit one row. */
  create(name: string, items: readonly MediaSummary[] = []): Playlist {
    const now = Date.now();
    const playlist: Playlist = {
      id: machaHost().uuid(),
      // Empty when the viewer gave none. A host shows its own placeholder;
      // core writes no viewer text, and a stored default would be English
      // saved into the viewer's data.
      name: name.trim(),
      items: items.filter(isPlayable).map(savedTitle),
      createdAt: now,
      updatedAt: now,
    };
    this.write([playlist, ...this.list()], [playlist.id]);
    return playlist;
  }

  rename(id: string, name: string): Playlist | undefined {
    return this.mutate(id, (playlist) => ({ ...playlist, name: name.trim() || playlist.name }));
  }

  delete(id: string): void {
    this.write(this.list().filter((playlist) => playlist.id !== id), []);
  }

  /**
   * Appends, skipping anything already present so a double-tap cannot duplicate a track.
   * Throws `MachaSavedRowLimitError`, adding nothing, when the playlist would outgrow its row.
   */
  add(id: string, items: readonly MediaSummary[]): Playlist | undefined {
    return this.mutate(id, (playlist) => {
      const existing = new Set(playlist.items.map((item) => item.id));
      const additions = items.filter((item) => isPlayable(item) && !existing.has(item.id)).map(savedTitle);
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
    const changed: string[] = [];
    const playlists = this.list().map((playlist) => {
      const items = playlist.items.filter((item) => item.id !== itemId);
      if (items.length === playlist.items.length) return playlist;
      changed.push(playlist.id);
      return { ...playlist, items, updatedAt: Date.now() };
    });
    if (changed.length > 0) this.write(playlists, changed);
  }

  private mutate(id: string, change: (playlist: Playlist) => Playlist): Playlist | undefined {
    const playlists = this.list();
    const index = playlists.findIndex((playlist) => playlist.id === id);
    if (index < 0) return undefined;
    const changed = change(playlists[index]);
    if (changed === playlists[index]) return changed;
    const next = { ...changed, updatedAt: Date.now() };
    playlists[index] = next;
    this.write(playlists, [id]);
    return next;
  }

  /**
   * Save the playlists, rewriting the item rows of `changed` only.
   *
   * Throws `MachaSavedRowLimitError`, before writing anything, when a changed
   * playlist would outgrow its row; the caller's change is then not made and
   * what was saved stands.
   */
  private write(playlists: Playlist[], changed: Iterable<string>): void {
    this.store(playlists, new Set(changed));
    this.changed();
  }

  private store(playlists: Playlist[], changed: ReadonlySet<string>): void {
    const rows = playlists
      .filter((playlist) => changed.has(playlist.id))
      .map((playlist) => {
        const key = this.itemsKey(playlist.id);
        const row: PlaylistItemsRow = { version: 2, items: playlist.items.map(savedTitle) };
        return { key, raw: savedRow(key, row) };
      });
    const index: PlaylistIndex = { version: 2, playlists: playlists.map(({ items: _items, ...header }) => header) };
    const indexRaw = savedRow(this.key, index);
    const read = this.readIndex();
    const previous = validIndex(read) ? read.playlists : [];
    // Items first and the index last: an interrupted write leaves an item row
    // nothing lists, which is ignored, never a listed playlist with no row.
    for (const { key, raw } of rows) this.storage.setItem(key, raw);
    this.storage.setItem(this.key, indexRaw);
    const kept = new Set(playlists.map((playlist) => playlist.id));
    for (const header of previous) {
      if (!kept.has(header.id)) this.storage.removeItem(this.itemsKey(header.id));
    }
  }
}

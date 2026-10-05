import type { MediaSummary } from '../types.js';
import { savedRow, savedTitle, type SavedTitle } from './savedTitle.js';
import { readAdoptedJson, removeAdopted, type StorageLike } from './storage.js';
import { machaClientKey } from '../runtime/storageKeys.js';
import { machaHost } from '../runtime/host.js';

export interface MusicPlaylistEntry {
  entryId: string;
  /** Slimmed to what a row needs; see `SavedTitle`. */
  track: SavedTitle;
}

function validTrack(value: unknown): value is SavedTitle {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<SavedTitle>;
  return item.kind === 'track' && typeof item.id === 'string' && typeof item.title === 'string' && Array.isArray(item.mediaIds);
}

function validEntry(value: unknown): value is MusicPlaylistEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<MusicPlaylistEntry>;
  return typeof entry.entryId === 'string' && entry.entryId.length > 0 && validTrack(entry.track);
}

function newEntryId(index: number): string {
  return `${Date.now().toString(36)}-${index.toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * A single unnamed list of tracks, in one row. Entries are `SavedTitle`s, and
 * a change that would take the row past `SAVED_ROW_LIMIT_BYTES` throws
 * `MachaSavedRowLimitError` and saves nothing, because a row larger than
 * Android's read window cannot be read back. `PlaylistStore` is the
 * collection, with a row per playlist.
 */
/** Where `MusicPlaylistStore` keeps a client's list, and its names before 2026-10-05. */
export function musicPlaylistKey(clientId: string): string {
  return machaClientKey(clientId, 'musicPlaylist');
}

export function legacyMusicPlaylistKeys(clientId: string): readonly string[] {
  return [`macha.musicPlaylist.v1.${clientId}`];
}

export class MusicPlaylistStore {
  private readonly key: string;
  private readonly legacyKeys: readonly string[];

  constructor(clientId: string, private readonly storage: StorageLike = machaHost().storage) {
    this.key = musicPlaylistKey(clientId);
    this.legacyKeys = legacyMusicPlaylistKeys(clientId);
  }

  load(): MusicPlaylistEntry[] {
    return readAdoptedJson(this.storage, this.key, this.legacyKeys, isValidPlaylist) ?? [];
  }

  add(tracks: MediaSummary[]): MusicPlaylistEntry[] {
    const additions = this.entriesFor(tracks);
    if (additions.length === 0) return this.load();
    return this.save([...this.load(), ...additions]);
  }

  replace(tracks: MediaSummary[]): MusicPlaylistEntry[] {
    return this.save(this.entriesFor(tracks));
  }

  remove(entryId: string): MusicPlaylistEntry[] {
    return this.save(this.load().filter((entry) => entry.entryId !== entryId));
  }

  move(entryId: string, toIndex: number): MusicPlaylistEntry[] {
    const entries = this.load();
    const fromIndex = entries.findIndex((entry) => entry.entryId === entryId);
    if (fromIndex < 0 || entries.length < 2) return entries;
    const bounded = Math.max(0, Math.min(entries.length - 1, toIndex));
    if (fromIndex === bounded) return entries;
    const [entry] = entries.splice(fromIndex, 1);
    if (!entry) return entries;
    entries.splice(bounded, 0, entry);
    return this.save(entries);
  }

  clear(): MusicPlaylistEntry[] {
    removeAdopted(this.storage, this.key, this.legacyKeys);
    return [];
  }

  private entriesFor(tracks: MediaSummary[]): MusicPlaylistEntry[] {
    return tracks.filter((track) => track.kind === 'track').map((track, index) => ({
      entryId: newEntryId(index),
      track: savedTitle(track),
    }));
  }

  private save(entries: MusicPlaylistEntry[]): MusicPlaylistEntry[] {
    if (entries.length === 0) {
      removeAdopted(this.storage, this.key, this.legacyKeys);
      return [];
    }
    const saved = entries.map((entry) => ({ ...entry, track: savedTitle(entry.track) }));
    this.storage.setItem(this.key, savedRow(this.key, saved));
    // `replace` writes without reading, so an old key not yet adopted would
    // otherwise linger under the new one.
    for (const legacy of this.legacyKeys) this.storage.removeItem(legacy);
    return saved;
  }
}

function isValidPlaylist(value: unknown): value is MusicPlaylistEntry[] {
  return Array.isArray(value) && value.every(validEntry);
}

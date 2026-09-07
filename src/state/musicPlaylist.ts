import type { MediaSummary } from '../types.js';
import { readValidatedJson, writeJson, type StorageLike } from './storage.js';
import { machaHost } from '../runtime/host.js';

export interface MusicPlaylistEntry {
  entryId: string;
  track: MediaSummary;
}

function validTrack(value: unknown): value is MediaSummary {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<MediaSummary>;
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

export class MusicPlaylistStore {
  private readonly key: string;

  constructor(clientId: string, private readonly storage: StorageLike = machaHost().storage) {
    this.key = `macha.musicPlaylist.v1.${clientId}`;
  }

  load(): MusicPlaylistEntry[] {
    return readValidatedJson(this.storage, this.key, isValidPlaylist) ?? [];
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
    this.storage.removeItem(this.key);
    return [];
  }

  private entriesFor(tracks: MediaSummary[]): MusicPlaylistEntry[] {
    return tracks.filter((track) => track.kind === 'track').map((track, index) => ({
      entryId: newEntryId(index),
      track,
    }));
  }

  private save(entries: MusicPlaylistEntry[]): MusicPlaylistEntry[] {
    if (entries.length === 0) {
      this.storage.removeItem(this.key);
      return [];
    }
    return writeJson(this.storage, this.key, entries);
  }
}

function isValidPlaylist(value: unknown): value is MusicPlaylistEntry[] {
  return Array.isArray(value) && value.every(validEntry);
}

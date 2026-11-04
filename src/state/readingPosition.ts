import { machaHost } from '../runtime/host.js';
import { machaClientKey } from '../runtime/storageKeys.js';
import { readValidatedJson, writeJson, type StorageLike } from './storage.js';

/**
 * Where a reader is in one book file, kept on this device until the server
 * has per-user state.
 *
 * Shaped as the server's designed per-user media state is
 * (`/api/v1/users/me/media/{media_id}`: an opaque position token, progress
 * in permille, finished), so moving to it is a change of where, not of what.
 * Keyed by the file, not the title: an EPUB and a PDF of one edition are one
 * item with two files, and a position in one means nothing in the other.
 */
export interface ReadingPosition {
  /** The file: a `macha:` media id. */
  mediaId: string;
  /** The book's catalogue item, for a row that names it. */
  itemId?: string;
  /**
   * The reader's own place, opaque to core: an EPUB CFI, a page number, a
   * comic's image index. Only the reader that wrote it reads it.
   */
  position: string;
  /** How far through, 0 to 1000. */
  progressPermille: number;
  finished: boolean;
  /** Unix milliseconds. */
  updatedAt: number;
}

/** How many positions a device keeps; the least recently read goes first. */
export const READING_POSITION_LIMIT = 500;

interface StoredPositions {
  version: 1;
  positions: ReadingPosition[];
}

function isReadingPosition(value: unknown): value is ReadingPosition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.mediaId === 'string' && entry.mediaId !== ''
    && (entry.itemId === undefined || typeof entry.itemId === 'string')
    && typeof entry.position === 'string'
    && typeof entry.progressPermille === 'number' && Number.isFinite(entry.progressPermille)
    && typeof entry.finished === 'boolean'
    && typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt);
}

function isStoredPositions(value: unknown): value is StoredPositions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (record.version === undefined || record.version === 1) && Array.isArray(record.positions);
}

function permille(value: number): number {
  return Math.min(1000, Math.max(0, Math.round(value)));
}

/** The storage key for one client id's reading positions. */
export function readingPositionKey(clientId: string): string {
  return machaClientKey(clientId, 'readingPositions');
}

/**
 * Reading positions on this device, one per book file. Subscribable as the
 * other stores are; the snapshot is most recently read first.
 */
export class ReadingPositionStore {
  private readonly listeners = new Set<() => void>();
  private cached?: ReadingPosition[];
  private readonly key: string;

  constructor(clientId: string, private readonly storage: StorageLike = machaHost().storage) {
    this.key = readingPositionKey(clientId);
  }

  /** Stable between changes, as `useSyncExternalStore` requires. */
  getSnapshot = (): ReadingPosition[] => {
    this.cached ??= this.list();
    return this.cached;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Every position, most recently read first. An entry that does not read back is dropped. */
  list(): ReadingPosition[] {
    return this.read().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(mediaId: string): ReadingPosition | undefined {
    return this.read().find((entry) => entry.mediaId === mediaId);
  }

  /**
   * Record where the reader is. `progressPermille` is clamped to 0..1000 and
   * rounded; `updatedAt` defaults to now. The oldest positions past
   * `READING_POSITION_LIMIT` are dropped.
   */
  set(position: Omit<ReadingPosition, 'updatedAt'> & { updatedAt?: number }): ReadingPosition {
    const entry: ReadingPosition = {
      mediaId: position.mediaId,
      ...(position.itemId !== undefined ? { itemId: position.itemId } : {}),
      position: position.position,
      progressPermille: permille(position.progressPermille),
      finished: position.finished,
      // Absolute time, for ordering across sessions: `machaHost().now()` is a
      // duration clock with an arbitrary origin, so it is not used here.
      updatedAt: position.updatedAt ?? Date.now(),
    };
    const rest = this.read().filter((existing) => existing.mediaId !== entry.mediaId);
    const kept = [entry, ...rest].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, READING_POSITION_LIMIT);
    this.write(kept);
    return entry;
  }

  remove(mediaId: string): void {
    const entries = this.read();
    const rest = entries.filter((entry) => entry.mediaId !== mediaId);
    if (rest.length !== entries.length) this.write(rest);
  }

  private read(): ReadingPosition[] {
    const stored = readValidatedJson(this.storage, this.key, isStoredPositions);
    return stored ? stored.positions.filter(isReadingPosition) : [];
  }

  private write(positions: ReadingPosition[]): void {
    writeJson<StoredPositions>(this.storage, this.key, { version: 1, positions });
    this.cached = undefined;
    for (const listener of this.listeners) listener();
  }
}

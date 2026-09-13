import type { MediaSummary } from '../types.js';
import { readValidatedJson, writeJson, type StorageLike } from './storage.js';
import { machaHost } from '../runtime/host.js';

export interface PlaybackQueueState {
  items: MediaSummary[];
  currentIndex: number;
  positionMs: number;
  updatedAt: number;
}

/**
 * What a playback queue will accept.
 *
 * Exported because anything that feeds a queue has to agree with it about
 * this. A caller applying its own version silently accepts items the queue
 * then drops, which shows up as a list that is shorter after saving than it
 * was on screen and nowhere as an error.
 */
export function isPlayable(item: MediaSummary): boolean {
  return item.kind === 'movie' || item.kind === 'episode' || item.kind === 'track';
}

function validState(value: unknown): value is PlaybackQueueState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PlaybackQueueState>;
  if (!Array.isArray(candidate.items) || candidate.items.length === 0) return false;
  if (!candidate.items.every((item) => item && typeof item === 'object' && typeof item.id === 'string' && isPlayable(item as MediaSummary))) return false;
  return Number.isInteger(candidate.currentIndex)
    && Number(candidate.currentIndex) >= 0
    && Number(candidate.currentIndex) < candidate.items.length
    && typeof candidate.positionMs === 'number'
    && Number.isFinite(candidate.positionMs)
    && typeof candidate.updatedAt === 'number'
    && Number.isFinite(candidate.updatedAt);
}

export class PlaybackQueueStore {
  private readonly key: string;
  private readonly listeners = new Set<() => void>();
  /**
   * The snapshot handed to reactive callers, held so its identity is stable
   * between mutations.
   *
   * Without this, `load()` returns a freshly parsed object every call. A hook
   * that subscribes and then reads memoises on the store — whose identity never
   * changes — so the queue freezes at whatever it first computed while the
   * store underneath goes on changing. Code that looks correct, producing a
   * list that silently stops updating, and the kind of bug that surfaces as a
   * user saying the app "sometimes doesn't refresh".
   *
   * `undefined` is a legitimate snapshot here — an absent queue — so emptiness
   * is tracked separately rather than inferred from the cache being unset.
   */
  private cached?: PlaybackQueueState;
  private cacheLoaded = false;

  constructor(clientId: string, private readonly storage: StorageLike = machaHost().storage) {
    this.key = `macha.playbackQueue.v1.${clientId}`;
  }

  /** Stable between mutations, as `useSyncExternalStore` requires. */
  getSnapshot = (): PlaybackQueueState | undefined => {
    if (!this.cacheLoaded) {
      this.cached = this.load();
      this.cacheLoaded = true;
    }
    return this.cached;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private changed(): void {
    this.cacheLoaded = false;
    this.cached = undefined;
    for (const listener of this.listeners) listener();
  }

  load(): PlaybackQueueState | undefined {
    return readValidatedJson(this.storage, this.key, validState);
  }

  /** Persist and notify. Every mutation goes through here or `clear()`. */
  private commit(next: PlaybackQueueState): PlaybackQueueState {
    const written = writeJson(this.storage, this.key, next);
    this.changed();
    return written;
  }

  replace(items: readonly MediaSummary[], currentIndex = 0): PlaybackQueueState {
    const playableItems = items.filter(isPlayable);
    if (playableItems.length === 0) throw new Error('Playback queue cannot be empty.');
    const boundedIndex = Math.max(0, Math.min(playableItems.length - 1, currentIndex));
    const next: PlaybackQueueState = {
      items: playableItems,
      currentIndex: boundedIndex,
      positionMs: 0,
      updatedAt: Date.now(),
    };
    return this.commit(next);
  }

  /**
   * Apply an edit — a reorder, or a removal — to the queue that is already
   * playing, without sending the current item back to the start.
   *
   * Distinct from `replace`, which begins a new queue and resets the position
   * because there is nothing to preserve. Dragging a row in a queue editor is
   * not starting a new queue, and a client with only `replace` restarts the
   * track every time someone rearranges the list below it.
   *
   * The position is kept only while the item under `currentIndex` is still the
   * same item it was, compared by id. Removing the current item, or handing
   * back an index that lands on a different one, resets to zero: carrying a
   * position across a change of item is how a viewer ends up forty minutes
   * into something that has just started.
   *
   * An edit that removes every playable item clears the queue rather than
   * leaving an empty one behind, since `validState` would reject it on the
   * next read anyway and an empty queue object is not a state anything wants.
   */
  setItems(items: readonly MediaSummary[], currentIndex = 0): PlaybackQueueState | undefined {
    const playableItems = items.filter(isPlayable);
    if (playableItems.length === 0) {
      this.clear();
      return undefined;
    }
    const current = this.load();
    if (!current) return this.replace(playableItems, currentIndex);
    const boundedIndex = Math.max(0, Math.min(playableItems.length - 1, currentIndex));
    const wasPlaying = current.items[current.currentIndex]?.id;
    const nowPlaying = playableItems[boundedIndex]?.id;
    const next: PlaybackQueueState = {
      items: playableItems,
      currentIndex: boundedIndex,
      positionMs: wasPlaying !== undefined && wasPlaying === nowPlaying ? current.positionMs : 0,
      updatedAt: Date.now(),
    };
    return this.commit(next);
  }

  select(currentIndex: number): PlaybackQueueState | undefined {
    const current = this.load();
    if (!current || currentIndex < 0 || currentIndex >= current.items.length) return current;
    const next = { ...current, currentIndex, positionMs: 0, updatedAt: Date.now() };
    return this.commit(next);
  }

  updatePosition(positionMs: number): PlaybackQueueState | undefined {
    const current = this.load();
    if (!current) return undefined;
    const next = { ...current, positionMs: Number.isFinite(positionMs) ? Math.max(0, positionMs) : 0, updatedAt: Date.now() };
    return this.commit(next);
  }

  insertNext(items: readonly MediaSummary[]): PlaybackQueueState | undefined {
    const additions = items.filter(isPlayable);
    if (additions.length === 0) return this.load();
    const current = this.load();
    if (!current) return this.replace(additions, 0);
    const insertAt = current.currentIndex + 1;
    const next: PlaybackQueueState = {
      ...current,
      items: [...current.items.slice(0, insertAt), ...additions, ...current.items.slice(insertAt)],
      updatedAt: Date.now(),
    };
    return this.commit(next);
  }

  append(items: readonly MediaSummary[]): PlaybackQueueState | undefined {
    const additions = items.filter(isPlayable);
    if (additions.length === 0) return this.load();
    const current = this.load();
    if (!current) return this.replace(additions, 0);
    const next: PlaybackQueueState = {
      ...current,
      items: [...current.items, ...additions],
      updatedAt: Date.now(),
    };
    return this.commit(next);
  }

  clear(): void {
    this.storage.removeItem(this.key);
    this.changed();
  }
}

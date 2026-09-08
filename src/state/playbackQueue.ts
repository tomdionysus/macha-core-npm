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

  constructor(clientId: string, private readonly storage: StorageLike = machaHost().storage) {
    this.key = `macha.playbackQueue.v1.${clientId}`;
  }

  load(): PlaybackQueueState | undefined {
    return readValidatedJson(this.storage, this.key, validState);
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
    return writeJson(this.storage, this.key, next);
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
    return writeJson(this.storage, this.key, next);
  }

  select(currentIndex: number): PlaybackQueueState | undefined {
    const current = this.load();
    if (!current || currentIndex < 0 || currentIndex >= current.items.length) return current;
    const next = { ...current, currentIndex, positionMs: 0, updatedAt: Date.now() };
    return writeJson(this.storage, this.key, next);
  }

  updatePosition(positionMs: number): PlaybackQueueState | undefined {
    const current = this.load();
    if (!current) return undefined;
    const next = { ...current, positionMs: Number.isFinite(positionMs) ? Math.max(0, positionMs) : 0, updatedAt: Date.now() };
    return writeJson(this.storage, this.key, next);
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
    return writeJson(this.storage, this.key, next);
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
    return writeJson(this.storage, this.key, next);
  }

  clear(): void {
    this.storage.removeItem(this.key);
  }
}

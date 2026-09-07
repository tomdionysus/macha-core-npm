import type { PlaybackProgress } from '../types.js';
import type { StorageLike } from './storage.js';
import { machaHost } from '../runtime/host.js';

const PREFIX = 'macha-client-progress:';
export const CONTINUE_WATCHING_LIMIT = 3;
const FINISHED_THRESHOLD = 0.92;
const MINIMUM_PROGRESS_MS = 30_000;

export class ContinueWatchingStore {
  constructor(
    private readonly clientId: string,
    private readonly storage: StorageLike = machaHost().storage,
  ) {}

  list(): PlaybackProgress[] {
    return this.read()
      .filter((entry) => !isFinished(entry))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, CONTINUE_WATCHING_LIMIT);
  }

  update(progress: PlaybackProgress): PlaybackProgress[] {
    const entries = this.read().filter((entry) => entry.mediaId !== progress.mediaId);

    if (!isFinished(progress) && progress.positionMs >= MINIMUM_PROGRESS_MS) {
      entries.unshift(progress);
    }

    const limited = entries
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, CONTINUE_WATCHING_LIMIT);

    this.write(limited);
    return limited;
  }

  clear(mediaId: string): PlaybackProgress[] {
    this.write(this.read().filter((entry) => entry.mediaId !== mediaId));
    return this.list();
  }

  private key(): string {
    return `${PREFIX}${this.clientId}`;
  }

  private read(): PlaybackProgress[] {
    try {
      const value = this.storage.getItem(this.key());
      if (!value) return [];
      const parsed = JSON.parse(value) as PlaybackProgress[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private write(entries: PlaybackProgress[]): void {
    this.storage.setItem(this.key(), JSON.stringify(entries));
  }
}

export function isFinished(progress: PlaybackProgress): boolean {
  if (progress.durationMs <= 0) return false;
  return progress.positionMs / progress.durationMs >= FINISHED_THRESHOLD;
}

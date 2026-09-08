import type { MediaSummary, PlaybackProgress } from '../types.js';
import type { StorageLike } from './storage.js';
import { machaHost } from '../runtime/host.js';

/**
 * Client state keys are `macha.<store>.v1.<clientId>` throughout this package.
 * Continue Watching predates that convention and until now was the one store
 * that did not follow it — hyphenated, unversioned, and separating the client
 * id with a colon.
 */
const PREFIX = 'macha.continueWatching.v1.';
/**
 * The key this store used before it was brought into line. Read once, when the
 * current key holds nothing, so a viewer keeps their place across the upgrade.
 *
 * The old key is deliberately left in place rather than deleted. It costs a few
 * hundred bytes, and it is the only way back if a client is rolled back to a
 * build that still reads it — a wrong call here loses every viewer's position
 * in everything, which is not a failure anyone reports, they simply find the
 * app has forgotten them.
 */
const LEGACY_PREFIX = 'macha-client-progress:';
export const CONTINUE_WATCHING_LIMIT = 3;
const FINISHED_THRESHOLD = 0.92;
const MINIMUM_PROGRESS_MS = 30_000;

/**
 * A progress record from what a caller already has to hand.
 *
 * Trivial, and worth being in one place regardless: every caller building this
 * object by hand is a chance for two of them to disagree about whether `media`
 * is worth attaching, and an entry saved without it renders as a bare id in
 * Continue Watching with nothing to indicate why.
 */
export function progressFor(media: MediaSummary, positionMs: number, durationMs: number): PlaybackProgress {
  return { mediaId: media.id, positionMs, durationMs, updatedAt: Date.now(), media };
}

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

  /**
   * Where the viewer was in this item, or 0 if there is nothing to resume.
   *
   * A finished item deliberately answers 0 rather than its stored position. A
   * resume affordance reading the raw value would drop someone two minutes
   * from the end of something they have already watched, and "start again" is
   * what they meant by pressing play on a finished title. The stored entry is
   * left alone — this is a question about resuming, not about the record.
   */
  positionFor(mediaId: string): number {
    const entry = this.read().find((candidate) => candidate.mediaId === mediaId);
    if (!entry || isFinished(entry)) return 0;
    return entry.positionMs;
  }

  /**
   * Forget everything, for a "clear watch history" action.
   *
   * Removes the pre-rename key as well as the current one. Clearing only the
   * current key would leave the legacy entries in place for the next `read()`
   * to adopt, and a viewer who deliberately erased their history would watch
   * it come back — which is a worse outcome than never having offered the
   * button.
   */
  clearAll(): void {
    this.storage.removeItem(this.key());
    this.storage.removeItem(`${LEGACY_PREFIX}${this.clientId}`);
  }

  private key(): string {
    return `${PREFIX}${this.clientId}`;
  }

  private read(): PlaybackProgress[] {
    const current = this.parse(this.storage.getItem(this.key()));
    if (current !== undefined) return current;
    // Adopt on first read rather than in a migration the caller has to
    // remember to run: nothing may read this store before it is migrated, and
    // the only place that can be guaranteed is inside the read itself.
    const legacy = this.parse(this.storage.getItem(`${LEGACY_PREFIX}${this.clientId}`));
    if (legacy === undefined) return [];
    this.write(legacy);
    return legacy;
  }

  /** Parsed entries, or undefined when the key holds nothing usable. */
  private parse(value: string | null | undefined): PlaybackProgress[] | undefined {
    if (!value) return undefined;
    try {
      const parsed = JSON.parse(value) as PlaybackProgress[];
      return Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
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

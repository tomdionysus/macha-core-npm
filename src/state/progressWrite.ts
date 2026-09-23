/**
 * When a resume point is owed to storage.
 *
 * Core owns the store (`ContinueWatchingStore`, `progressFor`); this is the
 * cadence, which until now every client invented for itself. **The record has
 * to be on disk before it is needed, because nothing runs afterwards.**
 * Measured on the Android TV set at 10.35.1.133, 2026-09-22 20:42:15: the set
 * replaced Android System WebView and force-stopped the client at `adj 0`, in
 * the foreground, mid-use, recorded as `reason=10 (USER REQUESTED)` and not a
 * crash. A kill of that shape runs no teardown — no stop, no unmount, no final
 * write — and a client that wrote only on deliberate exit resumed a viewer
 * killed an hour into a film from wherever they last pressed Back.
 *
 * Taken from that client's `progressPersistence.ts` as it stood after two
 * corrections found on the set, so that there is one implementation of the
 * decision rather than one per client. **The host keeps the timer, the playback
 * subscription and where the writer lives** — the television's sits at app
 * scope because a player screen that unmounts on Back stops writing exactly
 * when there is still something to record. That is platform.
 *
 * **The interval is a parameter, deliberately.** What it bounds is how much
 * progress a viewer may lose to an unannounced kill: the stored position is
 * stale by at most one interval, whatever the node does. It has no
 * counterpart in the protocol, and in particular it is not to be derived from
 * a node's `session_idle_ms` — session reaping is the node reclaiming a slot,
 * this is the device surviving a process kill, and the two share a trigger
 * rather than a mechanism.
 */

/** Why a write is owed, kept for the trail rather than for the store. */
export type ProgressWrite = 'paused' | 'interval';

export interface ProgressWatermark {
  /** Whether playback was paused when the last decision was taken. */
  paused: boolean;
  /** When a record was last *stored*, on the same clock as `nowMs`. */
  wroteAtMs: number;
  /**
   * When a write was last *attempted*, stored or declined.
   *
   * Separate from `wroteAtMs` because a declined write deliberately does not
   * advance that one, and without this the retry would fire on every playback
   * snapshot — 4 Hz on the television — for the whole of the first 30 s of
   * every film.
   */
  attemptedAtMs: number;
}

/**
 * Whether a resume point is due now, and why.
 *
 * - No playback: nothing. That is the clean stop, and whoever stopped has
 *   already written; the last event's position would be stamped over it
 *   after the viewer left.
 * - No duration yet: nothing. The fraction is meaningless and renders in
 *   Continue Watching as an entry with no position.
 * - Playing to paused: `'paused'`, on **the edge and not the state**. Held
 *   paused, the position is not advancing and a rewrite is churn on storage
 *   that on React Native is AsyncStorage. The edge is exempt from
 *   `minAttemptGapMs`: it is a thing the viewer did once, not a timer.
 * - Playing, an interval since the last *stored* record, and no attempt within
 *   `minAttemptGapMs`: `'interval'`. The interval produces nothing while
 *   paused. Its clock does keep running, so the first evaluation after a long
 *   pause is due at once; that is one write of a position that has just begun
 *   to move again.
 *
 * Call it on every playback snapshot and on a host timer well under
 * `intervalMs`, since snapshots alone cannot be relied on to arrive while a
 * film simply plays. After any attempt, move the watermark with
 * `nextWatermark`; when nothing is due, carry `paused` forward so the next
 * pause is still an edge.
 */
export function progressWriteDue(
  previous: ProgressWatermark,
  current: { paused: boolean; durationMs: number } | undefined,
  nowMs: number,
  intervalMs: number,
  /** Floor between attempts, so a declined write retries on the tick rather than per snapshot. */
  minAttemptGapMs: number,
): ProgressWrite | undefined {
  if (!current) return undefined;
  if (current.durationMs <= 0) return undefined;

  if (current.paused) return previous.paused ? undefined : 'paused';

  if (nowMs - previous.wroteAtMs < intervalMs) return undefined;
  return nowMs - previous.attemptedAtMs >= minAttemptGapMs ? 'interval' : undefined;
}

/**
 * Where the watermark lands after an attempted write.
 *
 * **A write the store declined is not a write.** `ContinueWatchingStore.update`
 * stores nothing below its minimum position, and says so by returning a list
 * the entry is absent from rather than by throwing. Read `landed` off that
 * list — `stored.some((entry) => entry.mediaId === progress.mediaId)` — rather
 * than re-deriving the floor, so the floor can move without the host moving.
 *
 * Advancing the clock on a declined write pushed the next attempt a full
 * interval away: the first write of a film lands at a second or two, is
 * declined, and nothing was then written until the interval had passed.
 * Measured on the Android TV set 2026-09-22 — a film killed at about seventy
 * seconds recorded nothing at all, which is the case this exists for.
 *
 * The attempt is recorded either way, or `minAttemptGapMs` does nothing and
 * the next snapshot retries at once.
 */
export function nextWatermark(
  previous: ProgressWatermark,
  paused: boolean,
  nowMs: number,
  landed: boolean,
): ProgressWatermark {
  return {
    paused,
    wroteAtMs: landed ? nowMs : previous.wroteAtMs,
    attemptedAtMs: nowMs,
  };
}

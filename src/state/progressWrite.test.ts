import { describe, expect, it } from 'vitest';
import { nextWatermark, progressWriteDue, type ProgressWatermark } from './progressWrite.js';
import { ContinueWatchingStore, progressFor } from './continueWatching.js';
import type { StorageLike } from './storage.js';

const INTERVAL = 300_000;
/** The attempt floor. Wider than any gap these cases exercise, so it never masks one. */
const TICK = 30_000;
const playing = { paused: false, durationMs: 7_200_000 };
const paused = { paused: true, durationMs: 7_200_000 };

/**
 * When a resume point is written, and — as much — when it is not.
 *
 * Ported from the Android TV client's own suite along with the rule, so the
 * cases that found its two defects on the set are the ones that pin it here.
 * A kill runs no teardown, so the only resume point that survives is one
 * already on disk.
 */
describe('when a resume point is due', () => {
  it('writes when playback pauses', () => {
    expect(progressWriteDue({ paused: false, wroteAtMs: 0, attemptedAtMs: 0 }, paused, 1_000, INTERVAL, TICK)).toBe('paused');
  });

  it('writes once for a pause, not on every snapshot while held there', () => {
    // Position is not moving, so a second write records nothing new — and this
    // store is backed by AsyncStorage, where a write per playback event on a
    // paused film is pure churn.
    expect(progressWriteDue({ paused: true, wroteAtMs: 1_000, attemptedAtMs: 0 }, paused, 2_000, INTERVAL, TICK)).toBeUndefined();
  });

  it('writes again on the next pause after a resume', () => {
    expect(progressWriteDue({ paused: false, wroteAtMs: 1_000, attemptedAtMs: 0 }, paused, 9_000, INTERVAL, TICK)).toBe('paused');
  });

  it('writes on the interval while playing', () => {
    expect(progressWriteDue({ paused: false, wroteAtMs: 0, attemptedAtMs: 0 }, playing, INTERVAL, INTERVAL, TICK)).toBe('interval');
  });

  it('does not write before the interval has elapsed', () => {
    expect(progressWriteDue({ paused: false, wroteAtMs: 0, attemptedAtMs: 0 }, playing, INTERVAL - 1, INTERVAL, TICK)).toBeUndefined();
  });

  it('does not run the interval while paused', () => {
    // Nothing is advancing, and the pause itself already wrote. A film left
    // paused overnight would otherwise rewrite the same position every five
    // minutes until the node reaps it.
    expect(progressWriteDue({ paused: true, wroteAtMs: 0, attemptedAtMs: 0 }, paused, INTERVAL * 10, INTERVAL, TICK)).toBeUndefined();
  });

  it('prefers the pause when a pause and an elapsed interval land together', () => {
    // Same write either way; naming it `paused` keeps the reason honest for
    // anyone reading a trail.
    expect(progressWriteDue({ paused: false, wroteAtMs: 0, attemptedAtMs: 0 }, paused, INTERVAL * 2, INTERVAL, TICK)).toBe('paused');
  });
});

/**
 * The two states where writing would record a falsehood.
 */
describe('when there is nothing worth recording', () => {
  it('writes nothing when there is no playback at all', () => {
    // The clean stop. Writing here would stamp a resume point at whatever the
    // last event happened to say, after the viewer had already left.
    expect(progressWriteDue({ paused: false, wroteAtMs: 0, attemptedAtMs: 0 }, undefined, INTERVAL * 5, INTERVAL, TICK)).toBeUndefined();
  });

  it('writes nothing until a duration is known', () => {
    // Clients have always guarded their exit write on this: a duration of zero makes the
    // progress fraction meaningless, and Continue Watching renders it as an
    // item with no position at all.
    expect(
      progressWriteDue({ paused: false, wroteAtMs: 0, attemptedAtMs: 0 }, { paused: false, durationMs: 0 }, INTERVAL, INTERVAL, TICK),
    ).toBeUndefined();
  });

  it('writes nothing on a pause before a duration is known', () => {
    expect(
      progressWriteDue({ paused: false, wroteAtMs: 0, attemptedAtMs: 0 }, { paused: true, durationMs: 0 }, 1_000, INTERVAL, TICK),
    ).toBeUndefined();
  });
});

/**
 * The hole the television found, which no unit test there had: a write core declines
 * must not count as a write.
 */
describe('after an attempted write', () => {
  it('advances the clock when the entry landed', () => {
    expect(nextWatermark({ paused: false, wroteAtMs: 10, attemptedAtMs: 0 }, false, 5_000, true)).toEqual({
      paused: false,
      wroteAtMs: 5_000,
      attemptedAtMs: 5_000,
    });
  });

  it('leaves the clock alone when core declined the entry', () => {
    // Core stores nothing below 30 s of position and reports it by returning a
    // list the entry is absent from. Advancing here pushed the next attempt a
    // full interval out, so a film killed at seventy seconds recorded nothing —
    // measured on the set, 2026-09-22.
    expect(nextWatermark({ paused: false, wroteAtMs: 10, attemptedAtMs: 0 }, false, 5_000, false)).toEqual({
      paused: false,
      wroteAtMs: 10,
      attemptedAtMs: 5_000,
    });
  });

  it('tracks the pause either way, because that edge is not about storage', () => {
    expect(nextWatermark({ paused: false, wroteAtMs: 10, attemptedAtMs: 0 }, true, 5_000, false).paused).toBe(true);
    expect(nextWatermark({ paused: true, wroteAtMs: 10, attemptedAtMs: 0 }, false, 5_000, true).paused).toBe(false);
  });
});

/**
 * Retrying a declined write must not become a storage write four times a
 * second.
 *
 * The Android TV client's player sends playback snapshots at 4 Hz. A declined write leaves the clock where it was —
 * deliberately, so the next attempt is soon — which without a floor means every
 * one of those snapshots retries for the whole of the first 30 s of a film, on
 * a set whose load average reached 30 during a system update.
 */
describe('how often a declined write may be retried', () => {
  const fresh = { paused: false, wroteAtMs: 0, attemptedAtMs: 0 };
  const GAP = 30_000;

  it('does not retry again in the same second', () => {
    expect(
      progressWriteDue({ ...fresh, attemptedAtMs: 1_000_000 }, playing, 1_000_250, INTERVAL, GAP),
    ).toBeUndefined();
  });

  it('retries once the gap has passed', () => {
    expect(
      progressWriteDue({ ...fresh, attemptedAtMs: 1_000_000 }, playing, 1_030_000, INTERVAL, GAP),
    ).toBe('interval');
  });

  it('never delays a pause, which has to be recorded when it happens', () => {
    // The gap is about retry churn on a timer. A viewer pressing pause is an
    // edge that occurs once and must be written immediately.
    expect(
      progressWriteDue({ ...fresh, attemptedAtMs: 1_000_000 }, paused, 1_000_250, INTERVAL, GAP),
    ).toBe('paused');
  });

  it('records the attempt whether or not it landed', () => {
    // Otherwise the floor does nothing: the next snapshot 250 ms later sees the
    // same state and tries again.
    expect(nextWatermark(fresh, false, 5_000, false).attemptedAtMs).toBe(5_000);
    expect(nextWatermark(fresh, false, 5_000, true).attemptedAtMs).toBe(5_000);
  });
});

/**
 * The host reads `landed` off the list the real store returns. This is the half
 * only core can pin: that the store's floor and the watermark agree, so a film
 * killed early still gets a resume point on the first tick past the floor.
 */
describe('against the store', () => {
  function storage(): StorageLike {
    const values = new Map<string, string>();
    return {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    };
  }

  const media = { id: 'film', kind: 'movie' as const, title: 'Film', durationMs: 7_200_000, mediaIds: ['film'] };

  function attempt(store: ContinueWatchingStore, watermark: ProgressWatermark, positionMs: number, nowMs: number): ProgressWatermark {
    const progress = progressFor(media, positionMs, media.durationMs);
    const landed = store.update(progress).some((entry) => entry.mediaId === progress.mediaId);
    return nextWatermark(watermark, false, nowMs, landed);
  }

  it('retries a write declined below the floor on the next tick, and lands it', () => {
    const store = new ContinueWatchingStore('client', storage());
    let watermark: ProgressWatermark = { paused: true, wroteAtMs: 0, attemptedAtMs: 0 };

    // Starts playing at 2 s of position: due at once, and declined by the store.
    expect(progressWriteDue(watermark, playing, 2_000_000, INTERVAL, TICK)).toBe('interval');
    watermark = attempt(store, watermark, 2_000, 2_000_000);
    expect(watermark.wroteAtMs).toBe(0);
    expect(store.positionFor('film')).toBe(0);

    // One tick later, past the floor: due again, and it lands.
    expect(progressWriteDue(watermark, playing, 2_000_000 + TICK, INTERVAL, TICK)).toBe('interval');
    watermark = attempt(store, watermark, 2_000 + TICK + 1_000, 2_000_000 + TICK);
    expect(store.positionFor('film')).toBe(2_000 + TICK + 1_000);

    // And now the interval governs, not the tick.
    expect(progressWriteDue(watermark, playing, 2_000_000 + TICK * 2, INTERVAL, TICK)).toBeUndefined();
  });
});

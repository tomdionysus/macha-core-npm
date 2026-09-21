import { describe, expect, it } from 'vitest';
import { outpacesPlayback, productionRate, type PlaybackProduction } from './streamProtocol.js';

function production(overrides: Partial<PlaybackProduction> = {}): PlaybackProduction {
  return { producedMs: 34_031, producingMs: 10_832, producedAgeMs: 0, producerParked: false, ...overrides };
}

describe('how fast a generation is producing', () => {
  it('divides the two fields the node sent rather than anything it measured itself', () => {
    // es-1, 2026-09-20, one live 480p transcode, settled.
    expect(productionRate(production())).toBeCloseTo(3.14, 2);
  });

  it('ignores how long ago the last fragment landed, which is the whole trap', () => {
    // **The measurement that makes this a test rather than a preference.**
    // Left running with nobody pulling fragments, the same es-1 session
    // reported producedMs and producingMs frozen while producedAgeMs climbed
    // 15.9s -> 27.9s -> 39.9s. Against ~45s of wall clock that is 0.76x —
    // below realtime, so a handover would be refused — on a node actually
    // producing at 3.14x. Any implementation that lets the age reach the
    // arithmetic reproduces that, and it needs no new field to do it.
    const readings = [15_868, 27_883, 39_901].map((producedAgeMs) =>
      productionRate(production({ producedAgeMs, producerParked: true })));
    expect(readings.every((rate) => rate !== undefined && Math.abs(rate - 3.14) < 0.01)).toBe(true);
  });

  it('says it has no reading before the first fragment, rather than an infinite rate', () => {
    // Every generation starts here, and a PATCH response almost always shows
    // it: a PATCH that changes mode, quality, seek or media builds a new
    // generation with a new segment store.
    expect(productionRate(production({ producedMs: 0, producingMs: 0 }))).toBeUndefined();
  });

  it('carries the start-up bias rather than correcting for it', () => {
    // First fragment on that same node: 2000/771. Low by ~17% against the
    // settled 3.14x, and deliberately so — excluding the first fragment would
    // time n-1 fragments while counting the media of n, a 2x overstatement
    // arriving exactly when a handover call gets made.
    const first = productionRate(production({ producedMs: 2_000, producingMs: 771 }));
    expect(first).toBeCloseTo(2.59, 2);
    expect(first).toBeLessThan(3.14);
  });

  it('refuses a reading no node should have sent instead of propagating it', () => {
    expect(productionRate(production({ producingMs: -1 }))).toBeUndefined();
    expect(productionRate(production({ producedMs: Number.NaN }))).toBeUndefined();
    expect(productionRate(production({ producingMs: Number.POSITIVE_INFINITY }))).toBeUndefined();
  });

  it('distinguishes cannot say from cannot keep up', () => {
    // Direct play and any node older than 0.47.0 arrive here. Collapsing this
    // into `false` refuses every handover on a direct source and across a
    // mixed-version cluster — the failure mode absent-means-cannot-say exists
    // to prevent, and the one core spent 0.14.0 removing elsewhere.
    expect(outpacesPlayback(undefined)).toBeUndefined();
    expect(productionRate(undefined)).toBeUndefined();
  });

  it('calls realtime exactly not fast enough', () => {
    // A generation producing at exactly 1.0x never closes a gap: the join
    // point recedes as fast as the viewer approaches it.
    expect(outpacesPlayback(production({ producedMs: 1_000, producingMs: 1_000 }))).toBe(false);
    expect(outpacesPlayback(production({ producedMs: 1_001, producingMs: 1_000 }))).toBe(true);
  });
});

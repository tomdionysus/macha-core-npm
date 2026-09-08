import { describe, expect, it } from 'vitest';
import { bufferedTimelineSegments } from './BufferedTimeline.js';

describe('buffered timeline segments', () => {
  it('clips and merges resident ranges to keep the rendered segment count bounded', () => {
    expect(bufferedTimelineSegments([
      { startMs: -5_000, endMs: 10_000 },
      { startMs: 10_000, endMs: 25_000 },
      { startMs: 70_000, endMs: 120_000 },
    ], 100_000)).toEqual([
      { leftPercent: 0, widthPercent: 25 },
      { leftPercent: 70, widthPercent: 30 },
    ]);
  });

  it('preserves disjoint buffered ranges, including ranges behind the playhead', () => {
    expect(bufferedTimelineSegments([
      { startMs: 5_000, endMs: 20_000 },
      { startMs: 40_000, endMs: 60_000 },
    ], 100_000)).toEqual([
      { leftPercent: 5, widthPercent: 15 },
      { leftPercent: 40, widthPercent: 20 },
    ]);
  });

  it('drops invalid and empty ranges', () => {
    expect(bufferedTimelineSegments([
      { startMs: Number.NaN, endMs: 20_000 },
      { startMs: 50_000, endMs: 50_000 },
      { startMs: 80_000, endMs: 70_000 },
    ], 100_000)).toEqual([]);
  });
});

describe('a timeline with nothing to draw', () => {
  it('draws nothing when the player has reported no ranges', () => {
    expect(bufferedTimelineSegments(undefined, 100_000)).toEqual([]);
    expect(bufferedTimelineSegments([], 100_000)).toEqual([]);
  });

  it('draws nothing before a duration is known', () => {
    // `video.duration` is NaN until metadata loads. Dividing by it would put
    // every segment at NaN% and paint the whole bar.
    expect(bufferedTimelineSegments([{ startMs: 0, endMs: 1000 }], Number.NaN)).toEqual([]);
    expect(bufferedTimelineSegments([{ startMs: 0, endMs: 1000 }], 0)).toEqual([]);
    expect(bufferedTimelineSegments([{ startMs: 0, endMs: 1000 }], -5)).toEqual([]);
  });
});

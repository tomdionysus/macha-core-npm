import { describe, expect, it } from 'vitest';
import { formatPlaybackTime } from './formatDuration.js';

describe('the scrubber time contract', () => {
  it('renders the shapes all three clients already agreed on', () => {
    // Measured from the web client's implementation before it moved here, so
    // adopting this changes nothing a viewer has been looking at.
    expect(formatPlaybackTime(0)).toBe('0:00');
    expect(formatPlaybackTime(1_000)).toBe('0:01');
    expect(formatPlaybackTime(65_000)).toBe('1:05');
    expect(formatPlaybackTime(425_000)).toBe('7:05');
    expect(formatPlaybackTime(5_025_000)).toBe('1:23:45');
  });

  it('pads minutes only once there are hours', () => {
    // `7:05` below an hour and `1:07:05` above it. Padding below would change
    // every scrubber in every client.
    expect(formatPlaybackTime(425_000)).toBe('7:05');
    expect(formatPlaybackTime(4_025_000)).toBe('1:07:05');
  });

  it('lets hours grow past 24 rather than wrapping', () => {
    expect(formatPlaybackTime(90_000_000)).toBe('25:00:00');
  });

  it('clamps a negative position rather than rendering a minus', () => {
    // A position ahead of a reported duration can produce one.
    expect(formatPlaybackTime(-5_000)).toBe('0:00');
  });

  it('renders a duration that is not a number as not started', () => {
    // The case that separated the two implementations. A source reporting no
    // duration gives NaN, and the naive version renders "NaN:NaN".
    expect(formatPlaybackTime(Number.NaN)).toBe('0:00');
    expect(formatPlaybackTime(undefined as unknown as number)).toBe('0:00');
  });

  it('renders an unbounded duration as not started rather than as Infinity', () => {
    // A live or unknown-length source. The naive version renders
    // "Infinity:NaN:NaN", and nothing at the call site stopped it: the
    // truthiness chain guarding that path treats NaN as falsy and Infinity as
    // perfectly good.
    expect(formatPlaybackTime(Number.POSITIVE_INFINITY)).toBe('0:00');
  });
});

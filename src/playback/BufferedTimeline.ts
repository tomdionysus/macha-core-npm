import type { PlaybackTimeRange } from '../types.js';

export interface BufferedTimelineSegment {
  leftPercent: number;
  widthPercent: number;
}

/**
 * Convert player-reported buffered media ranges into clipped, merged timeline
 * segments. The UI renders current player residency, not historical fetches.
 * Merging also keeps DOM work bounded after repeated seeks.
 */
export function bufferedTimelineSegments(
  ranges: readonly PlaybackTimeRange[] | undefined,
  durationMs: number,
): BufferedTimelineSegment[] {
  if (!ranges?.length || !Number.isFinite(durationMs) || durationMs <= 0) return [];

  const clipped = ranges
    .map((range) => ({
      startMs: Math.max(0, Math.min(durationMs, range.startMs)),
      endMs: Math.max(0, Math.min(durationMs, range.endMs)),
    }))
    .filter((range) => Number.isFinite(range.startMs) && Number.isFinite(range.endMs) && range.endMs > range.startMs)
    .sort((left, right) => left.startMs - right.startMs);

  const merged: Array<{ startMs: number; endMs: number }> = [];
  for (const range of clipped) {
    const previous = merged[merged.length - 1];
    // A 1 ms tolerance avoids hairline segments from floating-point MSE
    // boundaries which are otherwise visually one resident range.
    if (previous && range.startMs <= previous.endMs + 1) {
      previous.endMs = Math.max(previous.endMs, range.endMs);
    } else {
      merged.push({ ...range });
    }
  }

  return merged.map((range) => ({
    leftPercent: range.startMs / durationMs * 100,
    widthPercent: (range.endMs - range.startMs) / durationMs * 100,
  }));
}

import type { KeyframeIndex, KeyframeStream } from '../api/CatalogueApi.js';

/** A range of a file's bytes held by the player, `[startByte, endByte)`. */
export interface ByteRange {
  startByte: number;
  endByte: number;
}

/** A range of the title's timeline, in milliseconds. */
export interface TimeRangeMs {
  startMs: number;
  endMs: number;
}

/** The streams actually playing, by their index in the file (`PlaybackSession.selected`). */
export interface PlayingStreams {
  videoStream?: number;
  audioStream?: number;
}

/**
 * What a Direct Play file's held bytes are in time: the ranges the viewer can
 * play from what is already downloaded.
 *
 * Chrome's `video.buffered` for a file served whole is not residency.
 * Chromium converts each buffered byte range to time as
 * `byte / size × duration`, so the scrubber drew an estimate: on gbni-1 a
 * Direct Play MP4 playing smoothly at 3000 s showed a phantom range 95 s
 * behind the playhead (the web client, 2026-09-28). A host that holds the
 * bytes (from Chrome's ranges inverted exactly, or its own read-ahead cache)
 * asks here instead. HLS ranges are real and need none of this, and a native
 * player reports real time.
 *
 * Per stream, a byte maps to time along its entries, linearly between them,
 * with the file's end, `(durationMs, sizeBytes)`, as the last anchor. A
 * video range counts only from its first keyframe, since nothing before it
 * decodes. The result is what every playing stream holds: video and the one
 * audio stream playing, not a commentary track. A stream with fewer than two
 * entries of its own (Matroska often cues only its video) drops out, since
 * mapping it would be Chrome's estimate again.
 */
export function bufferedTimeRanges(
  index: KeyframeIndex,
  held: readonly ByteRange[],
  playing: PlayingStreams = {},
): TimeRangeMs[] {
  const ranges = mergeBytes(held);
  if (ranges.length === 0) return [];
  const streams = playingStreams(index, playing).filter((stream) => stream.entries.length >= 2);
  if (streams.length === 0) return [];
  const perStream = streams.map((stream) => streamRanges(stream, index, ranges));
  return perStream.reduce(intersect);
}

function playingStreams(index: KeyframeIndex, playing: PlayingStreams): KeyframeStream[] {
  const pick = (type: 'video' | 'audio', named: number | undefined) => {
    const ofType = index.streams.filter((stream) => stream.type === type);
    return (named !== undefined ? ofType.find((stream) => stream.index === named) : undefined) ?? ofType[0];
  };
  return [pick('video', playing.videoStream), pick('audio', playing.audioStream)].filter((stream): stream is KeyframeStream => stream !== undefined);
}

function mergeBytes(held: readonly ByteRange[]): ByteRange[] {
  const sorted = held
    .filter((range) => range.endByte > range.startByte)
    .map((range) => ({ ...range }))
    .sort((a, b) => a.startByte - b.startByte);
  const merged: ByteRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.startByte <= last.endByte) last.endByte = Math.max(last.endByte, range.endByte);
    else merged.push(range);
  }
  return merged;
}

/** The stream's anchors in byte order, ending at the file's end. */
function anchors(stream: KeyframeStream, index: KeyframeIndex): Array<readonly [number, number]> {
  const points = [...stream.entries];
  const last = points[points.length - 1];
  if (!last || last[1] < index.sizeBytes) points.push([index.durationMs, index.sizeBytes]);
  return points;
}

/** The time a byte offset reaches along the anchors, interpolated between them. */
function timeAt(points: ReadonlyArray<readonly [number, number]>, byte: number): number {
  const first = points[0]!;
  if (byte <= first[1]) return first[0];
  const last = points[points.length - 1]!;
  if (byte >= last[1]) return last[0];
  let low = 0;
  let high = points.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (points[middle]![1] <= byte) low = middle;
    else high = middle;
  }
  const [t0, b0] = points[low]!;
  const [t1, b1] = points[high]!;
  return b1 === b0 ? t0 : t0 + ((byte - b0) / (b1 - b0)) * (t1 - t0);
}

function streamRanges(stream: KeyframeStream, index: KeyframeIndex, ranges: readonly ByteRange[]): TimeRangeMs[] {
  const points = anchors(stream, index);
  const out: TimeRangeMs[] = [];
  for (const range of ranges) {
    // Video decodes only from a keyframe: the first one inside the range.
    const startMs = stream.type === 'video'
      ? stream.entries.find(([, byte]) => byte >= range.startByte)?.[0] ?? index.durationMs
      : timeAt(points, range.startByte);
    const endMs = timeAt(points, range.endByte);
    if (endMs > startMs) out.push({ startMs, endMs });
  }
  return mergeTimes(out);
}

function mergeTimes(ranges: TimeRangeMs[]): TimeRangeMs[] {
  const sorted = [...ranges].sort((a, b) => a.startMs - b.startMs);
  const merged: TimeRangeMs[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.startMs <= last.endMs) last.endMs = Math.max(last.endMs, range.endMs);
    else merged.push({ ...range });
  }
  return merged;
}

function intersect(a: TimeRangeMs[], b: TimeRangeMs[]): TimeRangeMs[] {
  const out: TimeRangeMs[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const startMs = Math.max(a[i]!.startMs, b[j]!.startMs);
    const endMs = Math.min(a[i]!.endMs, b[j]!.endMs);
    if (endMs > startMs) out.push({ startMs, endMs });
    if (a[i]!.endMs < b[j]!.endMs) i += 1;
    else j += 1;
  }
  return out;
}

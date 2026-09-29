import { describe, expect, it } from 'vitest';
import type { KeyframeIndex } from '../api/CatalogueApi.js';
import { bufferedTimeRanges } from './bufferedTime.js';

// A 100 s file of 1000 bytes: a video keyframe every 10 s at bytes 0, 100,
// ... 900, and audio thinned to one entry per 10 s, interleaved 50 bytes on.
const every = (from: number) => Array.from({ length: 10 }, (_, n) => [n * 10_000, from + n * 100] as const);
const mp4 = (extraAudio = false): KeyframeIndex => ({
  mediaId: 'macha:f', container: 'mp4', offsets: 'sample', sizeBytes: 1000, durationMs: 100_000,
  streams: [
    { index: 0, type: 'video', codec: 'hevc', entries: every(0) },
    { index: 1, type: 'audio', codec: 'aac', entries: every(50) },
    ...(extraAudio ? [{ index: 2, type: 'audio' as const, codec: 'aac', entries: every(90) }] : []),
  ],
});

describe('bufferedTimeRanges', () => {
  it('maps held bytes to what every playing stream holds', () => {
    // Video to 50 s, audio (50 bytes behind) to 45 s: 0-45 s plays.
    expect(bufferedTimeRanges(mp4(), [{ startByte: 0, endByte: 500 }])).toEqual([{ startMs: 0, endMs: 45_000 }]);
  });

  it('starts a video range at its first keyframe, where it can decode', () => {
    // Bytes 250-620: video's first keyframe inside is byte 300 (30 s), audio
    // from 20 s; byte 620 is 62 s of video and 57 s of audio.
    expect(bufferedTimeRanges(mp4(), [{ startByte: 250, endByte: 620 }])).toEqual([{ startMs: 30_000, endMs: 57_000 }]);
  });

  it("runs the last stretch to the file's end", () => {
    expect(bufferedTimeRanges(mp4(), [{ startByte: 900, endByte: 1000 }])).toEqual([{ startMs: 90_000, endMs: 100_000 }]);
  });

  it('merges held ranges and keeps separate ones apart', () => {
    const ranges = bufferedTimeRanges(mp4(), [
      { startByte: 200, endByte: 400 }, { startByte: 0, endByte: 250 }, { startByte: 700, endByte: 800 },
    ]);
    expect(ranges).toEqual([{ startMs: 0, endMs: 35_000 }, { startMs: 70_000, endMs: 75_000 }]);
  });

  it('holds video to the audio playing, not a commentary track', () => {
    // Stream 2 sits 90 bytes behind; playing it cuts the held time sooner.
    expect(bufferedTimeRanges(mp4(true), [{ startByte: 0, endByte: 500 }], { audioStream: 2 })).toEqual([{ startMs: 0, endMs: 41_000 }]);
    expect(bufferedTimeRanges(mp4(true), [{ startByte: 0, endByte: 500 }], { audioStream: 1 })).toEqual([{ startMs: 0, endMs: 45_000 }]);
  });

  it('drops a stream with fewer than two entries, as Matroska audio often is', () => {
    const mkv: KeyframeIndex = { ...mp4(), container: 'matroska', offsets: 'cluster',
      streams: [mp4().streams[0]!, { index: 1, type: 'audio', codec: 'opus', entries: [[0, 40]] }] };
    expect(bufferedTimeRanges(mkv, [{ startByte: 0, endByte: 500 }])).toEqual([{ startMs: 0, endMs: 50_000 }]);
  });

  it('answers nothing for nothing held, or no stream it can map', () => {
    expect(bufferedTimeRanges(mp4(), [])).toEqual([]);
    expect(bufferedTimeRanges({ ...mp4(), streams: [] }, [{ startByte: 0, endByte: 500 }])).toEqual([]);
  });
});

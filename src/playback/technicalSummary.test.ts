import { describe, expect, it } from 'vitest';
import type { CatalogueMediaProfile } from '../api/CatalogueApi.js';
import { fileSummaries, technicalSummary } from './technicalSummary.js';

// The web client's own cases (macha-client src/text/mediaLines.test.ts), so
// core's labels are held to what all three clients showed on 2026-09-27.
const mediaProfileSummary = (profile: CatalogueMediaProfile) => technicalSummary(profile).parts.join(' · ');

describe('mediaProfileSummary', () => {
  it('presents immutable playback facts compactly without path-derived data', () => {
    const profile: CatalogueMediaProfile = {
      schema_version: 1,
      media_id: 'macha:immutable',
      format: 'mov,mp4,m4a,3gp,3g2,mj2',
      duration_ms: 5_876_036,
      bitrate: 4_474_649,
      streams: [
        { index: 0, type: 'video', codec: 'h264', profile: 'High', language: 'und', width: 1920, height: 1040, channels: 0, sample_rate: 0, bit_depth: 8, default: true, forced: false, bitrate: 3_554_235, attached_picture: false },
        { index: 1, type: 'audio', codec: 'aac', profile: 'LC', language: 'eng', width: 0, height: 0, channels: 2, sample_rate: 48_000, bit_depth: 0, default: true, forced: false, bitrate: 127_969, attached_picture: false },
      ],
    };

    expect(mediaProfileSummary(profile)).toBe('1h 37m · 1920×1040 (1080p) · H.264 · AAC · Stereo · 4.5 Mbps');
  });
});

describe('a film with several audio tracks', () => {
  it('names the default track\'s codec, not the first listed', () => {
    const profile: CatalogueMediaProfile = {
      schema_version: 1, media_id: 'macha:uhd', format: 'matroska,webm', duration_ms: 9_060_000, bitrate: 47_400_000,
      streams: [
        { index: 0, type: 'video', codec: 'hevc', profile: 'Main 10', language: 'und', width: 3840, height: 2160, channels: 0, sample_rate: 0, bit_depth: 10, default: true, forced: false, bitrate: 0, attached_picture: false },
        { index: 1, type: 'audio', codec: 'dts', profile: '', language: 'eng', width: 0, height: 0, channels: 6, sample_rate: 48_000, bit_depth: 0, default: false, forced: false, bitrate: 0, attached_picture: false },
        { index: 2, type: 'audio', codec: 'truehd', profile: '', language: 'eng', width: 0, height: 0, channels: 8, sample_rate: 48_000, bit_depth: 24, default: true, forced: false, bitrate: 0, attached_picture: false },
      ],
    };
    expect(mediaProfileSummary(profile)).toBe('2h 31m · 3840×2160 (4K) · HEVC · TRUEHD · 7.1 · 47.4 Mbps');
  });
});

describe('a track\'s line', () => {
  const track = (codec: string, bitDepth: number, sampleRate: number, channels: number, bitrate: number, durationMs = 225_000, cover = true): CatalogueMediaProfile => ({
    schema_version: 1, media_id: 'macha:track', format: 'flac', duration_ms: durationMs, bitrate,
    streams: [
      { index: 0, type: 'audio' as const, codec, profile: '', language: 'und', width: 0, height: 0, channels, sample_rate: sampleRate, bit_depth: bitDepth, default: true, forced: false, bitrate: 0, attached_picture: false },
      // Cover art arrives as a video stream marked as an attached picture; it is not a picture to describe.
      ...(cover ? [{ index: 1, type: 'video' as const, codec: 'mjpeg', profile: '', language: 'und', width: 600, height: 600, channels: 0, sample_rate: 0, bit_depth: 0, default: false, forced: false, bitrate: 0, attached_picture: true }] : []),
    ],
  });

  it('gives the length to the second, the codec, bit depth, sample rate, channels and bitrate', () => {
    expect(mediaProfileSummary(track('flac', 24, 96_000, 2, 2_304_000))).toBe('3:45 · FLAC · 24-bit · 96 kHz · Stereo · 2,304 kbps');
  });

  it('leaves out a bit depth the file does not state, and names a fractional sample rate', () => {
    expect(mediaProfileSummary(track('mp3', 0, 44_100, 1, 320_000, 45_000, false))).toBe('0:45 · MP3 · 44.1 kHz · Mono · 320 kbps');
  });

  it('runs past an hour as hours, minutes and seconds', () => {
    expect(mediaProfileSummary(track('flac', 16, 44_100, 6, 1_411_000, 3_723_000))).toBe('1:02:03 · FLAC · 16-bit · 44.1 kHz · 5.1 · 1,411 kbps');
  });
});

describe('the structured summary', () => {
  it('names the quality class beside the resolution, and each field raw and labelled', () => {
    const summary = technicalSummary({
      schema_version: 1, media_id: 'macha:uhd', format: 'matroska,webm', duration_ms: 9_060_000, bitrate: 47_400_000,
      streams: [{ index: 0, type: 'video', codec: 'hevc', profile: '', language: 'und', width: 3840, height: 1600, channels: 0, sample_rate: 0, bit_depth: 10, default: true, forced: false, bitrate: 0, attached_picture: false }],
    });
    expect(summary).toMatchObject({
      kind: 'video',
      quality: { class: 2160, label: '4K' },
      resolution: { width: 3840, height: 1600, label: '3840×1600' },
      videoCodec: { codec: 'hevc', label: 'HEVC' },
      bitrate: { bps: 47_400_000, label: '47.4 Mbps' },
    });
  });

  it('reads the facts profile too, knowing cover art by its codec', () => {
    const summary = technicalSummary({
      mediaId: 'macha:t', format: 'flac', durationMs: 225_000, bitrate: 2_304_000,
      streams: [
        { index: 0, type: 'audio', codec: 'flac', profile: '', language: '', default: true, forced: false, channels: 2, sampleRate: 96_000, bitDepth: 24 },
        { index: 1, type: 'video', codec: 'mjpeg', profile: '', language: '', default: false, forced: false, width: 600, height: 600 },
      ],
    });
    expect(summary.parts.join(' · ')).toBe('3:45 · FLAC · 24-bit · 96 kHz · Stereo · 2,304 kbps');
  });

  it('lists the files highest resolution first', () => {
    const film = (mediaId: string, width: number, height: number): CatalogueMediaProfile => ({
      schema_version: 1, media_id: mediaId, format: 'mp4', duration_ms: 9_060_000, bitrate: 1_000_000,
      streams: [{ index: 0, type: 'video', codec: 'h264', profile: '', language: 'und', width, height, channels: 0, sample_rate: 0, bit_depth: 8, default: true, forced: false, bitrate: 0, attached_picture: false }],
    });
    // The Martian's three, as the TV listed them unsorted.
    const order = fileSummaries([film('fhd', 1920, 1080), film('hd', 1280, 534), film('uhd', 3840, 2160)]);
    expect(order.map((entry) => entry.mediaIds[0])).toEqual(['uhd', 'fhd', 'hd']);
    expect(order[0]?.summary.parts[1]).toBe('3840×2160 (4K)');
  });

  it('combines files that read the same, naming each', () => {
    const file = (mediaId: string, bitrate: number): CatalogueMediaProfile => ({
      schema_version: 1, media_id: mediaId, format: 'mp4', duration_ms: 5_876_036, bitrate,
      streams: [{ index: 0, type: 'video', codec: 'h264', profile: '', language: 'und', width: 1920, height: 1080, channels: 0, sample_rate: 0, bit_depth: 8, default: true, forced: false, bitrate: 0, attached_picture: false }],
    });
    const combined = fileSummaries([file('a', 4_474_649), file('b', 4_474_649), file('c', 9_000_000)]);
    expect(combined.map((entry) => entry.mediaIds)).toEqual([['a', 'b'], ['c']]);
  });
});

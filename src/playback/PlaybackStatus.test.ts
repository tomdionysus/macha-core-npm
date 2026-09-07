import { describe, expect, it } from 'vitest';
import type { PlaybackSession } from './PlaybackResolver.js';
import { describePlaybackSession } from './PlaybackStatus.js';

function session(overrides: Partial<PlaybackSession> = {}): PlaybackSession {
  return {
    sessionId: 's1',
    mediaId: 'm1',
    mode: 'remux',
    mimeType: 'application/vnd.apple.mpegurl',
    source: { mediaId: 'm1', url: '/stream', mimeType: 'application/vnd.apple.mpegurl', isManifest: true, mode: 'remux', durationMs: 1000 },
    durationMs: 1000,
    seekMs: 0,
    preferences: {
      mode: 'auto', maxHeight: null, maxBitrate: null, audioStream: null,
      subtitleStream: null, audioLanguage: '', subtitleLanguage: '',
    },
    sourceInfo: {
      path: '/Movies/test.mkv', format: 'matroska,webm', size: 10_000_000, bitrate: 8_000_000,
      streams: [
        { index: 0, type: 'video', codec: 'hevc', profile: 'Main', language: '', default: true, forced: false, width: 1920, height: 1080, bitrate: 7_500_000 },
        { index: 1, type: 'audio', codec: 'eac3', profile: '', language: 'eng', default: true, forced: false, channels: 6, sampleRate: 48000, bitrate: 640_000 },
      ],
    },
    output: {
      format: 'mp4',
      video: { sourceStream: 0, transform: 'copy', codec: 'hevc', width: 1920, height: 1080 },
      audio: { sourceStream: 1, transform: 'copy', codec: 'eac3', channels: 6, sampleRate: 48000 },
    },
    selected: { videoStream: 0, audioStream: 1, subtitleStream: -1 },
    transform: { video: 'copy', audio: 'copy' },
    options: {
      modes: ['remux', 'transcode'], qualityHeights: [720, 480, 360], mediaIds: ['m1'],
      audioStreams: [], subtitleStreams: [], canSeek: true, canChangeQuality: true, canSwitchMedia: false,
    },
    ...overrides,
  };
}

describe('describePlaybackSession', () => {
  it('shows credential-safe active node and stream provenance', () => {
    const described = describePlaybackSession(session({
      endpoint: { id: 'node-corvus', baseUrl: 'https://user:secret@node.test:7438/api?token=hidden' },
      source: { ...session().source, url: 'https://node.test:7438/api/v1/playback/stream/s1?capability=secret' },
    }));

    expect(described?.endpoint).toBe('NODE node-corvus · API https://node.test:7438 · STREAM https://node.test:7438');
    expect(described?.endpoint).not.toContain('secret');
  });

  it('collapses provisional URL identity when API and stream share an origin', () => {
    const described = describePlaybackSession(session({
      endpoint: { id: 'http://node.test:7438', baseUrl: 'http://node.test:7438' },
      source: { ...session().source, url: 'http://node.test:7438/direct' },
    }));

    expect(described?.endpoint).toBe('NODE/STREAM http://node.test:7438');
  });

  it('shows the worker-selected stream origin after transparent Direct failover', () => {
    const described = describePlaybackSession(session({
      endpoint: { id: 'http://node-a.test:7438', baseUrl: 'http://node-a.test:7438' },
      source: { ...session().source, url: 'http://node-a.test:7438/direct' },
    }), 'http://node-b.test:7438');

    expect(described?.endpoint).toBe('API http://node-a.test:7438 · STREAM http://node-b.test:7438');
  });

  it('reports the server-resolved remux mode when both streams are copied', () => {
    expect(describePlaybackSession(session())).toEqual({
      video: 'REMUX · HEVC · 1920×1080 · 7.5 Mb/s',
      audio: 'AUDIO COPY · ENG · EAC3 · 5.1 · 48 kHz · 640 kb/s',
    });
  });

  it('reports mixed transforms per stream rather than as a blanket transcode', () => {
    expect(describePlaybackSession(session({
      mode: 'transcode',
      transform: { video: 'copy', audio: 'transcode' },
      output: {
        format: 'mp4',
        video: { sourceStream: 0, transform: 'copy', codec: 'hevc', width: 1920, height: 1080 },
        audio: { sourceStream: 1, transform: 'transcode', codec: 'aac', channels: 2, sampleRate: 48000, bitrate: 192_000 },
      },
    }))).toEqual({
      video: 'VIDEO COPY · HEVC · 1920×1080 · 7.5 Mb/s',
      audio: 'AUDIO TRANSCODE · SOURCE · ENG · EAC3 · 5.1 · 48 kHz · 640 kb/s → AAC · stereo · 48 kHz · 192 kb/s',
    });
  });

  it('shows server-supplied transcode output resolution and bitrate', () => {
    expect(describePlaybackSession(session({
      mode: 'transcode',
      transform: { video: 'transcode', audio: 'copy' },
      output: {
        format: 'mp4',
        video: { sourceStream: 0, transform: 'transcode', codec: 'h264', width: 1280, height: 720, bitrate: 4_000_000 },
        audio: { sourceStream: 1, transform: 'copy', codec: 'eac3', channels: 6, sampleRate: 48000 },
      },
    }))?.video).toBe('VIDEO TRANSCODE · SOURCE · HEVC · 1920×1080 · 7.5 Mb/s → H264 · 1280×720 · 4.0 Mb/s');
  });

  it('reports the selected subtitle stream only when subtitles are enabled', () => {
    const withSubtitles = session({
      sourceInfo: {
        path: '/Movies/test.mkv', format: 'matroska,webm', size: 10_000_000, bitrate: 8_000_000,
        streams: [
          { index: 0, type: 'video', codec: 'hevc', profile: 'Main', language: '', default: true, forced: false, width: 1920, height: 1080, bitrate: 7_500_000 },
          { index: 1, type: 'audio', codec: 'eac3', profile: '', language: 'eng', default: true, forced: false, channels: 6, sampleRate: 48000, bitrate: 640_000 },
          { index: 5, type: 'subtitle', codec: 'ass', profile: '', language: 'eng', default: false, forced: true },
        ],
      },
      selected: { videoStream: 0, audioStream: 1, subtitleStream: 5 },
    });

    expect(describePlaybackSession(withSubtitles)?.subtitle).toBe('SUBTITLES · ENG · ASS · FORCED');
    expect(describePlaybackSession(session())?.subtitle).toBeUndefined();
  });

});

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
      mode: 'direct', maxHeight: null, maxBitrate: null, audioStream: null,
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

describe('the container actually served', () => {
  it('reports the segment container the server says it produced', () => {
    const described = describePlaybackSession(session({
      output: { ...session().output, format: 'hls', container: 'mpegts' },
    }));
    expect(described?.container).toBe('mpegts');
  });

  it('reports fragmented MP4 under the name the server uses', () => {
    const described = describePlaybackSession(session({
      output: { ...session().output, format: 'hls', container: 'fmp4' },
    }));
    expect(described?.container).toBe('fmp4');
  });

  it('says nothing at all when neither container nor format was reported', () => {
    // A default here would be indistinguishable on screen from an answer, and
    // telling those apart is the entire reason the field exists.
    const described = describePlaybackSession(session({
      output: { video: session().output.video, audio: session().output.audio },
    }));
    expect(described?.container).toBeUndefined();
    expect('container' in (described ?? {})).toBe(true);
  });

  it('falls back to the output format when the server could not name a container', () => {
    // Six .avi files in the library answer `container: ""` with `format:
    // "avi"`. The fallback is still the server describing its own output.
    const described = describePlaybackSession(session({
      mode: 'direct',
      output: { format: 'avi', video: session().output.video, audio: session().output.audio },
    }));
    expect(described?.container).toBe('avi');
  });

  it('calls a copied session direct when the served container is the source container', () => {
    const described = describePlaybackSession(session({
      mode: 'direct',
      source: { ...session().source, mimeType: 'video/x-matroska', isManifest: false },
      output: { ...session().output, format: 'matroska', container: 'matroska' },
    }));
    expect(described?.delivery).toBe('direct');
  });

  it('does not call an MPEG-TS source in MPEG-TS segments a direct hand-off', () => {
    // The container genuinely did not change; what changed is that the viewer
    // is being handed a playlist and segments rather than the file. Container
    // equality cannot see that, and this lands on the television, where the
    // host policy asks for MPEG-TS carriage on everything.
    const described = describePlaybackSession(session({
      sourceInfo: { ...session().sourceInfo, format: 'mpegts', container: 'mpegts' },
      output: { ...session().output, format: 'hls', container: 'mpegts' },
    }));
    expect(described?.delivery).toBe('remux');
  });

  it('calls it remux when the container changed, whatever the mode field says', () => {
    // The server reported `direct` for a session whose container changed.
    // What arrived decides the badge; what was asked for does not. Handed
    // over whole, so the manifest shortcut is not what is under test here.
    const described = describePlaybackSession(session({
      mode: 'direct',
      source: { ...session().source, mimeType: 'video/mp2t', isManifest: false },
      output: { ...session().output, format: 'mpegts', container: 'mpegts' },
    }));
    expect(described?.delivery).toBe('remux');
  });
});

describe('describePlaybackSession', () => {
  it('shows credential-safe active node and stream provenance', () => {
    const described = describePlaybackSession(session({
      endpoint: { id: 'node-corvus', baseUrl: 'https://user:secret@node.test:7438/api?token=hidden' },
      source: { ...session().source, url: 'https://node.test:7438/api/v1/playback/stream/s1?capability=secret' },
    }));

    // Reduced to an origin, so neither the embedded userinfo nor the
    // capability query string can reach the panel.
    expect(described?.endpoint).toBe('https://node.test:7438');
    expect(described?.endpoint).not.toContain('secret');
    expect(described?.endpoint).not.toContain('hidden');
  });

  it('collapses provisional URL identity when API and stream share an origin', () => {
    const described = describePlaybackSession(session({
      endpoint: { id: 'http://node.test:7438', baseUrl: 'http://node.test:7438' },
      source: { ...session().source, url: 'http://node.test:7438/direct' },
    }));

    expect(described?.endpoint).toBe('http://node.test:7438');
  });

  it('shows the worker-selected stream origin after transparent Direct failover', () => {
    const described = describePlaybackSession(session({
      endpoint: { id: 'http://node-a.test:7438', baseUrl: 'http://node-a.test:7438' },
      source: { ...session().source, url: 'http://node-a.test:7438/direct' },
    }), 'http://node-b.test:7438');

    // The worker moved the transfer to node B while the session's own
    // bookkeeping stayed on node A. What is serving the picture is node B, and
    // that is what the panel shows — the change of origin is the signal.
    expect(described?.endpoint).toBe('http://node-b.test:7438');
  });

  it('reports the session as a remux when both streams are copied, with the streams as data', () => {
    const base = session();
    expect(describePlaybackSession(base)).toEqual({
      container: 'mp4',
      delivery: 'remux',
      video: { transform: 'copy', source: base.sourceInfo.streams[0], sourceBitrate: 8_000_000, output: undefined, outputBitrate: undefined },
      audio: { transform: 'copy', source: base.sourceInfo.streams[1], output: undefined },
    });
  });

  it('carries no viewer text anywhere in the description', () => {
    // Core writes none (Tom, 2026-09-24). Every string left is a server value
    // or an origin: no labels, units or separators of core's own.
    const text = JSON.stringify(describePlaybackSession(session({
      mode: 'transcode',
      transform: { video: 'transcode', audio: 'transcode' },
      output: {
        format: 'mp4',
        video: { sourceStream: 0, transform: 'transcode', codec: 'h264', width: 1280, height: 720, bitrate: 4_000_000 },
        audio: { sourceStream: 1, transform: 'transcode', codec: 'aac', channels: 2, sampleRate: 48000, bitrate: 192_000 },
      },
    })));
    for (const made of ['TRANSCODE', 'SOURCE', 'COPY', 'DIRECT', 'REMUX', 'Mb/s', 'kb/s', 'kHz', 'stereo', '·', '→']) {
      expect(text).not.toContain(made);
    }
  });

  it('calls the session direct when the file was handed over untouched', () => {
    // The server copied nothing: it served the source file. Calling the audio
    // a copy was true of the instruction and false of the operation.
    expect(describePlaybackSession(session({
      mode: 'direct',
      source: { ...session().source, mimeType: 'video/x-matroska', isManifest: false },
      output: { ...session().output, format: 'matroska', container: 'matroska' },
    }))?.delivery).toBe('direct');
  });

  it('calls a video with no selected audio direct too', () => {
    const described = describePlaybackSession(session({
      mode: 'direct',
      source: { ...session().source, mimeType: 'video/x-matroska', isManifest: false },
      transform: { video: 'copy', audio: 'omit' },
      output: { ...session().output, format: 'matroska', container: 'matroska' },
    }));
    expect(described?.delivery).toBe('direct');
    expect(described?.audio).toBeUndefined();
  });

  it('names no delivery when anything is transcoded, and gives each stream its own transform', () => {
    const described = describePlaybackSession(session({
      mode: 'transcode',
      transform: { video: 'copy', audio: 'transcode' },
      output: {
        format: 'mp4',
        video: { sourceStream: 0, transform: 'copy', codec: 'hevc', width: 1920, height: 1080 },
        audio: { sourceStream: 1, transform: 'transcode', codec: 'aac', channels: 2, sampleRate: 48000, bitrate: 192_000 },
      },
    }));
    expect(described?.delivery).toBeUndefined();
    expect(described?.video?.transform).toBe('copy');
    expect(described?.video?.output).toBeUndefined();
    expect(described?.audio).toMatchObject({ transform: 'transcode', output: { codec: 'aac', channels: 2, bitrate: 192_000 } });
  });

  it("carries the server's transcode output for a transcoded video", () => {
    expect(describePlaybackSession(session({
      mode: 'transcode',
      transform: { video: 'transcode', audio: 'copy' },
      output: {
        format: 'mp4',
        video: { sourceStream: 0, transform: 'transcode', codec: 'h264', width: 1280, height: 720, bitrate: 4_000_000 },
        audio: { sourceStream: 1, transform: 'copy', codec: 'eac3', channels: 6, sampleRate: 48000 },
      },
    }))?.video).toMatchObject({ transform: 'transcode', source: { codec: 'hevc', width: 1920 }, output: { codec: 'h264', width: 1280, height: 720, bitrate: 4_000_000 } });
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

    expect(describePlaybackSession(withSubtitles)?.subtitle).toMatchObject({ index: 5, codec: 'ass', language: 'eng', forced: true });
    expect(describePlaybackSession(session())?.subtitle).toBeUndefined();
  });

});

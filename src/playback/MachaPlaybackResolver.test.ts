import { afterEach, describe, expect, it, vi } from 'vitest';
import { MachaCatalogueApi } from '../api/MachaCatalogueApi.js';
import { MachaPlaybackResolver } from './MachaPlaybackResolver.js';
import { fixedBearerToken } from '../api/SessionManager.js';
import type { MediaSummary, PlaybackCapabilities } from '../types.js';

const media: MediaSummary = {
  id: 'movie:test',
  kind: 'movie',
  title: 'Test',
  mediaIds: ['file:abc'],
};

const capabilities: PlaybackCapabilities = {
  platform: 'web',
  videoCodecs: ['h264'],
  audioCodecs: ['aac', 'mp3'],
  containers: ['mp4', 'webm'],
  hlsFmp4: true,
  dash: false,
  hdr: [],
};

function sessionResponse(overrides: Record<string, unknown> = {}) {
  const base = {
    session_id: 'session-1',
    item_id: 'movie:test',
    media_id: 'file:abc',
    mode: 'remux',
    duration_ms: 5_400_000,
    seek_ms: 0,
    preferences: {
      mode: 'auto',
      max_height: null,
      max_bitrate: null,
      audio_stream: null,
      subtitle_stream: null,
      audio_language: '',
      subtitle_language: '',
    },
    selection: { video_stream: 0, audio_stream: 1, subtitle_stream: -1 },
    source: {
      path: '/Movies/Test.mkv',
      format: 'matroska,webm',
      size: 10_000_000,
      bitrate: 8_000_000,
      streams: [
        { index: 0, type: 'video', codec: 'h264', profile: 'High', language: '', default: true, forced: false, width: 1920, height: 1080, bitrate: 3_700_000 },
        { index: 1, type: 'audio', codec: 'aac', profile: 'LC', language: 'eng', default: true, forced: false, channels: 2, bitrate: 192_000 },
      ],
    },
    output: {
      format: 'mp4',
      video: { source_stream: 0, transform: 'copy', codec: 'h264', profile: 'High', width: 1920, height: 1080 },
      audio: { source_stream: 1, transform: 'copy', codec: 'aac', profile: 'LC', channels: 2 },
    },
    stream: {
      mime_type: 'application/vnd.apple.mpegurl',
      url: '/api/v1/playback/stream/session-1/cap/1/master.m3u8',
      subtitle_url: null,
    },
    options: {
      modes: ['remux', 'transcode'],
      quality_heights: [720, 480, 360],
      media_ids: ['file:abc'],
      audio_streams: [{ index: 1, type: 'audio', codec: 'aac', profile: 'LC', language: 'eng', default: true, forced: false, channels: 2, bitrate: 192_000 }],
      subtitle_streams: [],
      can_seek: true,
      can_change_quality: true,
      can_switch_media: false,
    },
  };
  return { ...base, ...overrides };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('MachaPlaybackResolver', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('creates a playback session with browser capabilities and bearer auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(sessionResponse(), 201));
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new MachaPlaybackResolver('http://node.test/', fixedBearerToken('secret'));

    const session = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.split('?')[0]).toBe('http://node.test/api/v1/playback/sessions');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer secret');
    expect(JSON.parse(String(init.body))).toEqual(expect.objectContaining({ item_id: 'movie:test' }));
    // Capabilities are not sent at all. The server never acted on them, so
    // asking implied a check that did not exist; the instruction is now the
    // entire contract.
    expect(JSON.parse(String(init.body))).not.toHaveProperty('capabilities');
    expect(session.mode).toBe('remux');
    expect(session.seekMs).toBe(0);
    expect(session.preferences.mode).toBe('auto');
    expect(session.source.url).toBe('http://node.test/api/v1/playback/stream/session-1/cap/1/master.m3u8');
    expect(session.source.sizeBytes).toBe(10_000_000);
    expect(session.sourceInfo).toEqual(expect.objectContaining({ path: '/Movies/Test.mkv', format: 'matroska,webm', bitrate: 8_000_000 }));
    expect(session.sourceInfo.streams[0]).toEqual(expect.objectContaining({ index: 0, codec: 'h264', width: 1920, height: 1080, bitrate: 3_700_000 }));
    expect(session.output.video).toEqual(expect.objectContaining({ sourceStream: 0, transform: 'copy', codec: 'h264' }));
    expect(session.options.modes).toEqual(['direct', 'remux', 'transcode']);
    expect(session.options.qualityHeights).toEqual([720, 480, 360]);
    expect(session.options.audioStreams[0]).toEqual(expect.objectContaining({ index: 1, language: 'eng', channels: 2, bitrate: 192_000 }));
  });

  it('sends the idempotency key as a query parameter, not a header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(sessionResponse(), 201));
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new MachaPlaybackResolver('http://node.test');

    await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const query = new URL(url, 'http://node.test').searchParams;
    expect(query.get('idempotency_key')).toBeTruthy();
    const headers = new Headers(init.headers);
    expect(headers.get('Idempotency-Key')).toBeNull();
    expect(headers.get('Macha-Viewer-Session')).toBeNull();
  });

  it('treats a non-conforming session profile_pending response as an endpoint failure without polling', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(
      JSON.stringify({ error: 'profile_pending', message: 'media profile is not available yet' }),
      { status: 425, headers: { 'Content-Type': 'application/json', 'Retry-After': '1' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const api = new MachaPlaybackResolver('http://node.test');

    await expect(api.resolve(media, capabilities, undefined, { mode: 'direct' })).rejects.toMatchObject({
      status: 425,
      code: 'profile_pending',
      retryAfterMs: 1_000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('starts normal session negotiation while an advisory profile request is still pending', async () => {
    let profileRequested = false;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/catalogue/media/')) {
        profileRequested = true;
        return new Promise<Response>(() => undefined);
      }
      if (url.includes('/playback/sessions')) return Promise.resolve(jsonResponse(sessionResponse(), 201));
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);
    const catalogue = new MachaCatalogueApi('http://node.test');
    const playback = new MachaPlaybackResolver('http://node.test');

    void catalogue.mediaProfile('macha:immutable');
    expect(profileRequested).toBe(true);
    await expect(playback.resolve(media, capabilities, undefined, { mode: 'direct' })).resolves.toMatchObject({ sessionId: 'session-1' });
    expect(fetchMock.mock.calls.map(([url]) => (url as string).split('?')[0])).toEqual([
      'http://node.test/api/v1/catalogue/media/macha%3Aimmutable/profile',
      'http://node.test/api/v1/playback/sessions',
    ]);
  });

  it.each([
    ['pending', new Response(JSON.stringify({ error: 'profile_pending', message: 'not available yet' }), {
      status: 202,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '1' },
    })],
    ['missing', new Response(JSON.stringify({ error: 'profile_not_available', message: 'not available yet' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })],
  ])('keeps an advisory %s profile out of the playback outcome', async (_state, profileResponse) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(profileResponse)
      .mockResolvedValueOnce(jsonResponse(sessionResponse(), 201));
    vi.stubGlobal('fetch', fetchMock);
    const catalogue = new MachaCatalogueApi('http://node.test');
    const playback = new MachaPlaybackResolver('http://node.test');

    await expect(catalogue.mediaProfile('macha:immutable')).resolves.toBeUndefined();
    await expect(playback.resolve(media, capabilities, undefined, { mode: 'direct' })).resolves.toMatchObject({ sessionId: 'session-1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });



  it('refuses to create a session without an explicit instruction', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(sessionResponse(), 201));
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new MachaPlaybackResolver('http://node.test', fixedBearerToken('secret'));

    // There is no `auto` and no server-side default. A silent fallback here
    // would be the worst of both: transcode quietly costs every viewer
    // quality, direct quietly hands a TV a stream it cannot decode.
    await expect(resolver.resolve(media, capabilities)).rejects.toMatchObject({ code: 'mode_required' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still sends an explicit mode when the viewer chose one', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(sessionResponse(), 201));
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new MachaPlaybackResolver('http://node.test', fixedBearerToken('secret'));

    // The Mode control must keep meaning what it says: an explicit Direct is
    // the operator's escape hatch when the gate is wrong.
    await resolver.resolve(media, { ...capabilities, platform: 'tizen' }, undefined, { mode: 'direct' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual(expect.objectContaining({
      preferences: { mode: 'direct' },
    }));
  });

  it('includes the initial resume position in session creation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(sessionResponse({ seek_ms: 42_000 }), 201));
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new MachaPlaybackResolver('http://node.test', fixedBearerToken('secret'));

    const session = await resolver.resolve(media, capabilities, 42_000, { mode: 'direct' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual(expect.objectContaining({ seek_ms: 42_000 }));
    expect(session.seekMs).toBe(42_000);
  });

  it('applies explicit initial playback preferences during session creation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(sessionResponse({
      mode: 'transcode',
      preferences: {
        mode: 'transcode', max_height: 720, max_bitrate: null,
        audio_stream: null, subtitle_stream: null, audio_language: '', subtitle_language: '',
      },
    }), 201));
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new MachaPlaybackResolver('http://node.test', fixedBearerToken('secret'));

    await resolver.resolve(media, capabilities, 42_000, { mode: 'transcode', maxHeight: 720 });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual(expect.objectContaining({
      seek_ms: 42_000,
      preferences: { mode: 'transcode', max_height: 720 },
    }));
  });

  it('carries stream level and colour transfer through from the session response', async () => {
    const response = sessionResponse();
    // 0.32.12 reports these alongside bit_depth on each video stream.
    (response as { source: { streams: Record<string, unknown>[] } }).source.streams[0] = {
      index: 0, type: 'video', codec: 'hevc', profile: 'Main 10', language: '',
      default: true, forced: false, width: 3840, height: 2160,
      bit_depth: 10, level: 153, color_transfer: 'smpte2084',
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(response, 201));
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new MachaPlaybackResolver('http://node.test', fixedBearerToken('secret'));

    const session = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });

    expect(session.sourceInfo.streams[0]).toEqual(expect.objectContaining({
      bitDepth: 10,
      level: 153,
      colorTransfer: 'smpte2084',
    }));
  });

  it('leaves level and colour transfer undefined on a server that does not report them', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(sessionResponse(), 201));
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new MachaPlaybackResolver('http://node.test', fixedBearerToken('secret'));

    const session = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });

    expect(session.sourceInfo.streams[0].level).toBeUndefined();
    expect(session.sourceInfo.streams[0].colorTransfer).toBeUndefined();
  });

  it('reports what the source carries and what was served', async () => {
    const response = sessionResponse();
    const typed = response as {
      source: { streams: Record<string, unknown>[] };
      output: { video: Record<string, unknown> };
    };
    typed.source.streams[0] = {
      index: 0, type: 'video', codec: 'hevc', profile: 'Main 10', language: '',
      default: true, forced: false, width: 3840, height: 2160,
      bit_depth: 10, level: 153, color_transfer: 'smpte2084',
      dolby_vision_profile: 5, dolby_vision_compatibility: 0,
    };
    // 0.32.12's downconvert: the encoder emits 8-bit bt709 regardless of source.
    typed.output.video = {
      source_stream: 0, transform: 'transcode', codec: 'h264', profile: 'High',
      width: 1920, height: 1080, bit_depth: 8, level: 40, color_transfer: 'bt709',
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(response, 201));
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new MachaPlaybackResolver('http://node.test', fixedBearerToken('secret'));

    const session = await resolver.resolve(media, { ...capabilities, videoBitDepth: 10, dolbyVision: [5, 8] }, undefined, { mode: 'direct' });

    // Source: PQ, 10-bit, Dolby Vision profile 5.
    expect(session.sourceInfo.streams[0]).toEqual(expect.objectContaining({
      bitDepth: 10, colorTransfer: 'smpte2084', dolbyVisionProfile: 5, dolbyVisionCompatibility: 0,
    }));
    // Served: downconverted. The disagreement is the diagnostic.
    expect(session.output.video).toEqual(expect.objectContaining({
      transform: 'transcode', bitDepth: 8, colorTransfer: 'bt709', level: 40,
    }));
  });

  it('carries the container actually served, which the request could never tell us', async () => {
    const response = sessionResponse();
    const typed = response as { source: Record<string, unknown>; output: Record<string, unknown> };
    typed.source.container = 'matroska';
    typed.output.container = 'mpegts';
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(response, 201));
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new MachaPlaybackResolver('http://node.test', fixedBearerToken('secret'));

    const session = await resolver.resolve(media, capabilities, undefined, { mode: 'remux', container: 'mpegts' });

    // Asking for a segment container and never seeing what came back was the
    // one instruction with no confirmation anywhere in the response.
    expect(session.output.container).toBe('mpegts');
    expect(session.sourceInfo.container).toBe('matroska');
  });

  it('treats a container the server could not name as absent, not as empty', async () => {
    const response = sessionResponse();
    const typed = response as { source: Record<string, unknown>; output: Record<string, unknown> };
    typed.source.container = '';
    typed.output.container = '';
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(response, 201));
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new MachaPlaybackResolver('http://node.test', fixedBearerToken('secret'));

    const session = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });

    expect(session.output.container).toBeUndefined();
    expect(session.sourceInfo.container).toBeUndefined();
  });

  it('declares whether the source is a manifest, so a native player need not sniff', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(sessionResponse(), 201));
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new MachaPlaybackResolver('http://node.test', fixedBearerToken('secret'));

    const session = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });

    // The fixture serves application/vnd.apple.mpegurl.
    expect(session.source.isManifest).toBe(true);
  });

  it('declares progressive media as not a manifest', async () => {
    const response = sessionResponse();
    (response as { stream: Record<string, unknown> }).stream = {
      mime_type: 'video/mp4', url: '/api/v1/playback/stream/session-1', subtitle_url: null,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(response, 201));
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new MachaPlaybackResolver('http://node.test', fixedBearerToken('secret'));

    const session = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });

    expect(session.source.isManifest).toBe(false);
  });

  it('keeps a configured reverse-proxy prefix on returned capability URLs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(sessionResponse(), 201));
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new MachaPlaybackResolver('/macha', fixedBearerToken('secret'));

    const session = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });

    expect((fetchMock.mock.calls[0][0] as string).split('?')[0]).toBe('/macha/api/v1/playback/sessions');
    expect(session.source.url).toBe('/macha/api/v1/playback/stream/session-1/cap/1/master.m3u8');
  });

  it('sends seek-only PATCHes without preferences so the server can use its fast path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(sessionResponse({ seek_ms: 42000 })));
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new MachaPlaybackResolver('http://node.test', fixedBearerToken('secret'));

    const session = await resolver.update('session-1', { seekMs: 42_000 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://node.test/api/v1/playback/sessions/session-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ seek_ms: 42_000 });
    expect(session.seekMs).toBe(42_000);
  });

  it('makes playback PATCH requests cancellable', async () => {
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new MachaPlaybackResolver('http://node.test', fixedBearerToken('secret'));
    const controller = new AbortController();

    const request = resolver.update('session-1', { seekMs: 42_000 }, controller.signal);
    controller.abort(new DOMException('superseded', 'AbortError'));

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(requestSignal).toBe(controller.signal);
  });

  it('sends subtitle-only PATCHes without an implicit seek', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(sessionResponse({
      stream: {
        mime_type: 'application/vnd.apple.mpegurl',
        url: '/api/v1/playback/stream/session-1/cap/1/master.m3u8',
        subtitle_url: '/api/v1/playback/stream/session-1/cap/1/subtitle-5/manifest.json',
      },
      selection: { video_stream: 0, audio_stream: 1, subtitle_stream: 5 },
    })));
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new MachaPlaybackResolver('http://node.test', fixedBearerToken('secret'));

    await resolver.update('session-1', {
      preferences: { subtitleStream: 5, subtitleLanguage: '' },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      preferences: { subtitle_stream: 5, subtitle_language: '' },
    });
  });

  it('sends an explicit Direct preference even when the server options omitted Direct', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(sessionResponse({
      mode: 'direct',
      preferences: {
        mode: 'direct', max_height: null, max_bitrate: null,
        audio_stream: null, subtitle_stream: null, audio_language: '', subtitle_language: '',
      },
      stream: {
        mime_type: 'video/x-matroska',
        url: '/api/v1/playback/stream/session-1/direct',
        subtitle_url: null,
      },
      options: {
        ...sessionResponse().options,
        modes: ['remux', 'transcode'],
      },
    })));
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new MachaPlaybackResolver('http://node.test', fixedBearerToken('secret'));

    const session = await resolver.update('session-1', { preferences: { mode: 'direct' } });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ preferences: { mode: 'direct' } });
    expect(session.preferences.mode).toBe('direct');
    expect(session.mode).toBe('direct');
  });

  it('maps PATCH controls to the server field names', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(sessionResponse({
      mode: 'transcode',
      stream: {
        mime_type: 'application/vnd.apple.mpegurl',
        url: '/api/v1/playback/stream/session-1/cap/2/master.m3u8',
        subtitle_url: '/api/v1/playback/stream/session-1/cap/2/subtitle-5/manifest.json',
      },
      selection: { video_stream: 0, audio_stream: 2, subtitle_stream: 5 },
      preferences: {
        mode: 'transcode', max_height: 720, max_bitrate: 4_000_000,
        audio_stream: 2, subtitle_stream: 5, audio_language: '', subtitle_language: '',
      },
    })));
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new MachaPlaybackResolver('http://node.test', fixedBearerToken('secret'));

    const session = await resolver.update('session-1', {
      seekMs: 5_040_000,
      mediaId: 'file:def',
      preferences: {
        mode: 'transcode',
        maxHeight: 720,
        maxBitrate: 4_000_000,
        audioStream: 2,
        subtitleStream: 5,
      },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://node.test/api/v1/playback/sessions/session-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({
      preferences: {
        mode: 'transcode',
        max_height: 720,
        max_bitrate: 4_000_000,
        audio_stream: 2,
        subtitle_stream: 5,
      },
      seek_ms: 5_040_000,
      media_id: 'file:def',
    });
    expect(session.source.subtitleUrl).toBe('http://node.test/api/v1/playback/stream/session-1/cap/2/subtitle-5/manifest.json');
  });

  it('deletes the playback session explicitly', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new MachaPlaybackResolver('http://node.test', fixedBearerToken('secret'));

    await resolver.stop('session-1');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://node.test/api/v1/playback/sessions/session-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('can keep the DELETE alive during browser navigation teardown', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new MachaPlaybackResolver('http://node.test', fixedBearerToken('secret'));

    await resolver.stop('session-1', { keepalive: true });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://node.test/api/v1/playback/sessions/session-1',
      expect.objectContaining({ method: 'DELETE', keepalive: true }),
    );
  });

  it('surfaces structured server playback errors without object coercion', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      error: {
        code: 'media_unavailable',
        message: 'No playable media source',
      },
    }, 409));
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new MachaPlaybackResolver('http://node.test', fixedBearerToken('secret'));

    await expect(resolver.resolve(media, capabilities, undefined, { mode: 'direct' })).rejects.toMatchObject({
      message: 'Macha playback request failed: No playable media source',
      status: 409,
      code: 'media_unavailable',
    });
  });

});

describe('quality caps and copy instructions', () => {
  it('upgrades a copy to a transcode when the viewer caps quality', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(sessionResponse(), 201));
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new MachaPlaybackResolver('http://node.test', fixedBearerToken('secret'));

    // Copy passes the encoded stream through untouched, so there is no step
    // at which a cap could apply; the server returns 400 rather than ignore
    // one. Asking to cap quality is asking to re-encode.
    await resolver.resolve(media, capabilities, undefined, {
      mode: 'remux', video: 'copy', audio: 'copy', maxHeight: 720,
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as { preferences: Record<string, unknown> };
    expect(body.preferences).toMatchObject({ mode: 'remux', video: 'transcode', audio: 'copy', max_height: 720 });
  });

  it('turns a capped direct instruction into a transcode', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(sessionResponse(), 201));
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new MachaPlaybackResolver('http://node.test', fixedBearerToken('secret'));

    await resolver.resolve(media, capabilities, undefined, { mode: 'direct', maxBitrate: 4_000_000 });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as { preferences: Record<string, unknown> };
    expect(body.preferences).toMatchObject({ mode: 'transcode', video: 'transcode' });
  });

  it('leaves an uncapped copy instruction alone', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(sessionResponse(), 201));
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new MachaPlaybackResolver('http://node.test', fixedBearerToken('secret'));

    await resolver.resolve(media, capabilities, undefined, { mode: 'direct', video: 'copy', audio: 'copy' });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as { preferences: Record<string, unknown> };
    expect(body.preferences).toMatchObject({ mode: 'direct', video: 'copy', audio: 'copy' });
  });
});

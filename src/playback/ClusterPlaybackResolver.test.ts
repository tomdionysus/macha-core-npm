import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapEndpoints, EndpointRegistry } from '../cluster/EndpointRegistry.js';
import type { MediaSummary, PlaybackCapabilities } from '../types.js';
import { ClusterPlaybackResolver } from './ClusterPlaybackResolver.js';

const media: MediaSummary = { id: 'movie:test', kind: 'movie', title: 'Test', mediaIds: ['macha:media'] };
const capabilities: PlaybackCapabilities = {
  platform: 'web', videoCodecs: ['h264'], audioCodecs: ['aac'], containers: ['mp4'], hlsFmp4: true, dash: false, hdr: [],
};

function wireSession(id: string) {
  return {
    session_id: id, item_id: media.id, media_id: 'macha:media', mode: 'direct', duration_ms: 60_000, seek_ms: 12_000,
    preferences: { mode: 'auto', max_height: null, max_bitrate: null, audio_stream: null, subtitle_stream: null, audio_language: '', subtitle_language: '' },
    selection: { video_stream: 0, audio_stream: 1, subtitle_stream: -1 },
    source: { path: '/movie.mp4', format: 'mp4', size: 1000, bitrate: 100, streams: [] },
    output: {}, stream: { url: `/api/v1/playback/stream/${id}`, mime_type: 'video/mp4', subtitle_url: null },
    options: { modes: ['direct'], quality_heights: [], media_ids: ['macha:media'], audio_streams: [], subtitle_streams: [], can_seek: true, can_change_quality: false, can_switch_media: false },
  };
}

/**
 * Admission requests only, located by method rather than by position.
 *
 * `failover` also closes the session it abandons, so counting calls
 * positionally breaks the moment any request is added — which is exactly what
 * happened when it did. Filtering on what a call *is* survives that.
 */
function admissionCalls(fetchMock: ReturnType<typeof vi.fn>): Array<[string, RequestInit]> {
  return (fetchMock.mock.calls as Array<[string, RequestInit]>)
    .filter(([, init]) => (init?.method ?? 'GET').toUpperCase() === 'POST');
}

/**
 * Answer `DELETE` with `204` and serve everything else from the queued
 * responses in order.
 *
 * The fixtures here were built from `mockResolvedValueOnce` chains, which
 * assume every request is an admission. Once `failover` began closing the
 * session it abandons, a `DELETE` consumed the response meant for the next
 * `POST` and the failures read as protocol errors rather than as fixture
 * drift. Making the double answer by *method* removes the coupling between
 * how many requests happen and which response each one gets.
 */
function withSessionCloses(fetchMock: ReturnType<typeof vi.fn>): ReturnType<typeof vi.fn> {
  const wrapped = vi.fn(async (url: unknown, init?: RequestInit) => {
    if ((init?.method ?? 'GET').toUpperCase() === 'DELETE') return new Response(null, { status: 204 });
    return (fetchMock as unknown as (u: unknown, i?: RequestInit) => Promise<Response>)(url, init);
  });
  return wrapped as unknown as ReturnType<typeof vi.fn>;
}

describe('ClusterPlaybackResolver', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('creates a disposable generation on an alternate endpoint after node failure', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('node A unreachable'))
      .mockResolvedValueOnce(new Response(JSON.stringify(wireSession('session-b')), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', withSessionCloses(fetchMock));
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
    const resolver = new ClusterPlaybackResolver(registry);

    const session = await resolver.resolve(media, capabilities, 12_000, { mode: 'direct', audioLanguage: 'eng' });
    expect(session.endpoint).toEqual({ id: 'http://b', baseUrl: 'http://b' });
    expect(session.source.url).toBe('http://b/api/v1/playback/stream/session-b');
    expect(fetchMock.mock.calls.map(([url]) => (url as string).split('?')[0])).toEqual([
      'http://a/api/v1/playback/sessions',
      'http://b/api/v1/playback/sessions',
    ]);
    const attemptKeys = fetchMock.mock.calls.map(([url]) => new URL(url as string, 'http://x').searchParams.get('idempotency_key'));
    expect(attemptKeys[0]).toBeTruthy();
    expect(attemptKeys[1]).toBe(attemptKeys[0]);
    const secondBody = JSON.parse(String(admissionCalls(fetchMock)[1][1].body));
    expect(secondBody).toEqual(expect.objectContaining({ seek_ms: 12_000, preferences: expect.objectContaining({ audio_language: 'eng' }) }));
  });

  it('recovers on another node when a non-conforming server gates session admission on profile_pending', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: 'profile_pending', message: 'media profile is not available yet' }),
        { status: 425, headers: { 'Content-Type': 'application/json', 'Retry-After': '5' } },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify(wireSession('session-b')), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', withSessionCloses(fetchMock));
    const resolver = new ClusterPlaybackResolver(new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b'])));

    await expect(resolver.resolve(media, capabilities, undefined, { mode: 'direct' })).resolves.toMatchObject({
      endpoint: { id: 'http://b' },
      sessionId: expect.stringContaining('session-b'),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const keys = fetchMock.mock.calls.map(([url]) => new URL(url as string, 'http://x').searchParams.get('idempotency_key'));
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it('gives each top-level admission call its own idempotency key', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(wireSession('session-a')), { status: 201, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(wireSession('session-b')), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', withSessionCloses(fetchMock));
    const resolver = new ClusterPlaybackResolver(new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b'])));

    const primary = await resolver.resolve(media, capabilities, 0, { mode: 'direct' });
    await resolver.failover(primary, media, capabilities, 20_000, { mode: 'direct' }, undefined);

    const urls = fetchMock.mock.calls.map(([url]) => new URL(url as string, 'http://x').searchParams.get('idempotency_key'));
    expect(urls[0]).toBeTruthy();
    expect(urls[1]).toBeTruthy();
    expect(urls[1]).not.toBe(urls[0]);
  });

  it('routes updates and teardown to the generation endpoint', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(wireSession('session-a')), { status: 201, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(wireSession('session-a')), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    // Deliberately unwrapped: this test asserts the teardown request itself,
    // so the method-aware double must not answer it in the resolver's place.
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new ClusterPlaybackResolver(new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b'])));

    const session = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });
    await resolver.update(session.sessionId, { seekMs: 20_000 });
    await resolver.stop(session.sessionId);
    expect(fetchMock.mock.calls.map(([url]) => (url as string).split('?')[0])).toEqual([
      'http://a/api/v1/playback/sessions',
      'http://a/api/v1/playback/sessions/session-a',
      'http://a/api/v1/playback/sessions/session-a',
    ]);
  });

  it('does not mark the session endpoint unhealthy when the viewer cancels a superseded update', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(wireSession('session-a')), { status: 201, headers: { 'Content-Type': 'application/json' } }))
      .mockImplementationOnce((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }));
    vi.stubGlobal('fetch', withSessionCloses(fetchMock));
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
    const resolver = new ClusterPlaybackResolver(registry);
    const active = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });
    const controller = new AbortController();

    const update = resolver.update(active.sessionId, { seekMs: 20_000 }, controller.signal);
    controller.abort(new DOMException('superseded', 'AbortError'));

    await expect(update).rejects.toMatchObject({ name: 'AbortError' });
    expect(registry.snapshot().find((entry) => entry.endpoint.id === 'http://a')?.health).not.toBe('unreachable');
  });

  it('recreates a failed generation on an untried node and then exhausts candidates', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(wireSession('session-a')), { status: 201, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(wireSession('session-b')), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', withSessionCloses(fetchMock));
    const resolver = new ClusterPlaybackResolver(new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b'])));

    const first = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });
    const second = await resolver.failover(first, media, capabilities, 21_000, { mode: 'direct' });
    expect(second.endpoint?.id).toBe('http://b');
    await expect(resolver.failover(second, media, capabilities, 22_000, { mode: 'direct' }))
      .rejects.toThrow('No untried Macha playback endpoint remains');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('continues failover after one surviving node cannot open the media', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(wireSession('session-a')), { status: 201, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'media_open_failed', message: 'open media: Input/output error' }), { status: 500, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(wireSession('session-c')), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', withSessionCloses(fetchMock));
    const resolver = new ClusterPlaybackResolver(new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b', 'http://c'])));
    const active = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });

    const replacement = await resolver.failover(active, media, capabilities, 21_000, { mode: 'direct' });

    expect(replacement.endpoint?.id).toBe('http://c');
    expect(fetchMock.mock.calls.map(([url]) => (url as string).split('?')[0])).toEqual([
      'http://a/api/v1/playback/sessions',
      'http://b/api/v1/playback/sessions',
      'http://c/api/v1/playback/sessions',
    ]);
    const replacementAttempts = fetchMock.mock.calls.slice(1).map(([url, init]) => ({
      key: new URL(url as string, 'http://x').searchParams.get('idempotency_key'),
      body: (init as RequestInit).body,
    }));
    expect(replacementAttempts[0]?.key).toBeTruthy();
    expect(replacementAttempts[1]).toEqual(replacementAttempts[0]);
  });

  it('prepares one Direct standby without displacing the active endpoint', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(wireSession('session-a')), { status: 201, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(wireSession('session-b')), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', withSessionCloses(fetchMock));
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
    const resolver = new ClusterPlaybackResolver(registry);
    const primary = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });

    const alternate = await resolver.prepareAlternate(primary, media, capabilities, 5_000, { mode: 'direct' });

    expect(alternate?.endpoint?.id).toBe('http://b');
    expect(registry.candidates()[0]?.endpoint.id).toBe('http://a');
    const body = JSON.parse(String(admissionCalls(fetchMock)[1][1].body));
    expect(body.preferences.mode).toBe('direct');
    const idempotencyKeys = fetchMock.mock.calls.map(([url]) => new URL(url as string, 'http://x').searchParams.get('idempotency_key'));
    expect(idempotencyKeys[1]).not.toBe(idempotencyKeys[0]);
  });

  it('abandons a hung standby POST and attempts the next known endpoint', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(wireSession('session-a')), { status: 201, headers: { 'Content-Type': 'application/json' } }))
      .mockImplementationOnce((_url: string, init?: RequestInit) => {
        expect(init?.signal).toBeUndefined();
        return new Promise<Response>(() => undefined);
      })
      .mockResolvedValueOnce(new Response(JSON.stringify(wireSession('session-c')), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', withSessionCloses(fetchMock));
    const resolver = new ClusterPlaybackResolver(
      new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b', 'http://c'])),
      undefined,
      5,
    );
    const primary = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });

    const alternate = await resolver.prepareAlternate(primary, media, capabilities, 0, { mode: 'direct' });

    expect(alternate?.endpoint?.id).toBe('http://c');
    expect(fetchMock.mock.calls.map(([url]) => (url as string).split('?')[0])).toEqual([
      'http://a/api/v1/playback/sessions',
      'http://b/api/v1/playback/sessions',
      'http://c/api/v1/playback/sessions',
    ]);
  });

  it('abandons a hung initial session POST and attempts the next known endpoint', async () => {
    // Unlike failover()/prepareAlternate(), the very first resolve() must
    // also be timeout-bounded — a node that accepts the connection but never
    // answers must not hang playback forever with nothing else queued behind
    // it, exactly like the standby-POST case above.
    const fetchMock = vi.fn()
      .mockImplementationOnce((_url: string, init?: RequestInit) => {
        expect(init?.signal).toBeUndefined();
        return new Promise<Response>(() => undefined);
      })
      .mockResolvedValueOnce(new Response(JSON.stringify(wireSession('session-b')), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', withSessionCloses(fetchMock));
    const resolver = new ClusterPlaybackResolver(
      new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b'])),
      undefined,
      5,
    );

    const session = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });

    expect(session.endpoint?.id).toBe('http://b');
    expect(fetchMock.mock.calls.map(([url]) => (url as string).split('?')[0])).toEqual([
      'http://a/api/v1/playback/sessions',
      'http://b/api/v1/playback/sessions',
    ]);
  });

  it('closes a generation the node admits after the deadline gave up waiting for it', async () => {
    // The deadline abandons the wait and deliberately leaves the POST
    // running, so a node slow enough to miss it can still admit the session
    // afterwards. Sessions are node-local, so the idempotency key does not
    // reach across to the node that actually served the retry: nothing else
    // knows this session exists, nothing will ever close it, and on a
    // one-slot node it holds the only transcode slot until `session_idle`
    // reclaims it thirty minutes later. The slow node the deadline exists to
    // route around is the one that pays, in the resource that made it slow.
    let admitLate: (() => void) | undefined;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        admitLate = () => resolve(new Response(JSON.stringify(wireSession('session-late')), {
          status: 201, headers: { 'Content-Type': 'application/json' },
        }));
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(wireSession('session-b')), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    const fetchWithCloses = withSessionCloses(fetchMock);
    vi.stubGlobal('fetch', fetchWithCloses);
    const resolver = new ClusterPlaybackResolver(
      new EndpointRegistry(bootstrapEndpoints(['http://slow', 'http://b'])),
      undefined,
      5,
    );

    const session = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });
    expect(session.endpoint?.id).toBe('http://b');

    admitLate?.();

    // Closed with the node-local session id, which is the only identifier the
    // slow node has ever heard of — the cluster-prefixed one is minted here,
    // after the await this attempt never came back from.
    await vi.waitFor(() => expect(fetchWithCloses.mock.calls).toContainEqual([
      'http://slow/api/v1/playback/sessions/session-late',
      expect.objectContaining({ method: 'DELETE' }),
    ]));
  });

  it('promotes a prepared transformed generation without creating a duplicate lease', async () => {
    const transformed = (id: string) => ({
      ...wireSession(id),
      mode: 'remux',
      preferences: { ...wireSession(id).preferences, mode: 'remux' },
      stream: { url: `/api/v1/playback/stream/${id}/index.m3u8`, mime_type: 'application/vnd.apple.mpegurl', subtitle_url: null },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(transformed('session-a')), { status: 201, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(transformed('session-b')), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', withSessionCloses(fetchMock));
    const resolver = new ClusterPlaybackResolver(new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b'])));
    const primary = await resolver.resolve(media, capabilities, 0, { mode: 'remux' });
    const standby = await resolver.prepareAlternate(primary, media, capabilities, 0, { mode: 'remux' });

    const promoted = await resolver.failover(primary, media, capabilities, 5_000, { mode: 'remux' }, standby);

    expect(promoted.sessionId).toBe(standby?.sessionId);
    expect(promoted.endpoint?.id).toBe('http://b');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('asks a standby for the carriage the generation it stands by for is actually being served', async () => {
    // The fix that put this on `failover` stopped at the fresh-create branch.
    // A host that needs MPEG-TS because fMP4 black-screens on its device gets
    // the right thing when a replacement is built after the fact and the
    // wrong thing when one was prepared in advance — same defect, through
    // whichever door nobody looked at.
    const served = (id: string, container: string) => ({
      ...wireSession(id),
      mode: 'transcode',
      preferences: { ...wireSession(id).preferences, mode: 'transcode' },
      output: { container },
      stream: { url: `/api/v1/playback/stream/${id}/index.m3u8`, mime_type: 'application/vnd.apple.mpegurl', subtitle_url: null },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(served('session-a', 'mpegts')), { status: 201, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(served('session-b', 'mpegts')), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', withSessionCloses(fetchMock));
    const resolver = new ClusterPlaybackResolver(new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b'])));
    const primary = await resolver.resolve(media, capabilities, 0, { mode: 'transcode' });

    await resolver.prepareAlternate(primary, media, capabilities, 0, { mode: 'transcode' });

    expect(JSON.parse(String(admissionCalls(fetchMock)[1][1].body)).preferences.container).toBe('mpegts');
  });

  it('refuses a prepared standby that is being served a different carriage', async () => {
    // A standby is only a rescue if the device can play it. Two transformed
    // generations reporting different segment containers are not
    // interchangeable, and promoting one because it is on another node and
    // holds the same media is how the carriage check gets bypassed entirely.
    const served = (id: string, container: string) => ({
      ...wireSession(id),
      mode: 'transcode',
      preferences: { ...wireSession(id).preferences, mode: 'transcode' },
      output: { container },
      stream: { url: `/api/v1/playback/stream/${id}/index.m3u8`, mime_type: 'application/vnd.apple.mpegurl', subtitle_url: null },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(served('session-a', 'mpegts')), { status: 201, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(served('session-b', 'fmp4')), { status: 201, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(served('session-c', 'mpegts')), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', withSessionCloses(fetchMock));
    const resolver = new ClusterPlaybackResolver(new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b'])));
    const primary = await resolver.resolve(media, capabilities, 0, { mode: 'transcode' });
    const standby = await resolver.prepareAlternate(primary, media, capabilities, 0, { mode: 'transcode' });
    expect(standby?.output?.container).toBe('fmp4');

    const promoted = await resolver.failover(primary, media, capabilities, 5_000, { mode: 'transcode' }, standby);

    expect(promoted.sessionId).not.toBe(standby?.sessionId);
    expect(JSON.parse(String(admissionCalls(fetchMock)[2][1].body)).preferences.container).toBe('mpegts');
  });

  it('keeps identical node-local session IDs distinct across endpoints', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(wireSession('same-id')), { status: 201, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(wireSession('same-id')), { status: 201, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValue(new Response(null, { status: 204 }));
    // Deliberately unwrapped: this test asserts the teardown request itself,
    // so the method-aware double must not answer it in the resolver's place.
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new ClusterPlaybackResolver(new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b'])));
    const primary = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });
    const alternate = await resolver.prepareAlternate(primary, media, capabilities, 0, { mode: 'direct' });

    expect(primary.sessionId).not.toBe(alternate?.sessionId);
    await resolver.stop(primary.sessionId);
    await resolver.stop(alternate!.sessionId);
    expect(fetchMock.mock.calls.slice(2).map(([url]) => url)).toEqual([
      'http://a/api/v1/playback/sessions/same-id',
      'http://b/api/v1/playback/sessions/same-id',
    ]);
  });
});

describe('the carriage a replacement generation asks for', () => {
  afterEach(() => vi.unstubAllGlobals());

  const remuxWire = (id: string, container?: string) => ({
    ...wireSession(id),
    mode: 'remux',
    output: container === undefined ? {} : { container },
  });
  const preferencesOf = (fetchMock: ReturnType<typeof vi.fn>, call: number) =>
    JSON.parse(String(admissionCalls(fetchMock)[call][1].body)).preferences ?? {};

  const failoverFrom = async (container: string | undefined, preferences: Record<string, unknown> = { mode: 'remux' }) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(remuxWire('session-a', container)), { status: 201, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(remuxWire('session-b', container)), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', withSessionCloses(fetchMock));
    const resolver = new ClusterPlaybackResolver(new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b'])));
    const primary = await resolver.resolve(media, capabilities, 0, { mode: 'remux' });
    await resolver.failover(primary, media, capabilities, 20_000, preferences as never);
    return preferencesOf(fetchMock, 1);
  };

  it('asks for the carriage the failed generation was actually served with', async () => {
    // `container` is not among a session's confirmed preferences, so a
    // replacement built from those asks for whatever the node defaults to. A
    // set that asked for MPEG-TS then gets fMP4 from every replacement — the
    // one carriage it cannot play — and a native player fetches nothing and
    // reports nothing about it.
    expect(await failoverFrom('mpegts')).toMatchObject({ container: 'mpegts' });
  });

  it('uses what was served rather than what was asked for', async () => {
    // The two agree until they do not, and a node answering with something
    // other than the request is exactly what a failover is recovering from.
    expect(await failoverFrom('fmp4', { mode: 'remux' })).toMatchObject({ container: 'fmp4' });
  });

  it('never overrides a container the caller stated', async () => {
    expect(await failoverFrom('fmp4', { mode: 'remux', container: 'mpegts' })).toMatchObject({ container: 'mpegts' });
  });

  it('asks for nothing when the node reported no container', async () => {
    // No grounds to choose one, so today's behaviour is the right no-op.
    expect(await failoverFrom(undefined)).not.toHaveProperty('container');
  });

  it('asks for nothing when the node reported a container it does not recognise', async () => {
    expect(await failoverFrom('matroska')).not.toHaveProperty('container');
  });

  it('leaves a direct generation alone, which has no carriage to choose', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...wireSession('session-a'), output: { container: 'fmp4' } }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(wireSession('session-b')), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', withSessionCloses(fetchMock));
    const resolver = new ClusterPlaybackResolver(new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b'])));
    const primary = await resolver.resolve(media, capabilities, 0, { mode: 'direct' });
    await resolver.failover(primary, media, capabilities, 20_000, { mode: 'direct' });

    expect(preferencesOf(fetchMock, 1)).not.toHaveProperty('container');
  });
});

describe('the session a failover walks away from', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is closed, without the caller having to ask', async () => {
    // A node counts a session against `max_video_transcodes` from admission
    // until the record is erased — `session_idle`, 30 minutes — and reclaiming
    // the idle pipeline at 60 s does not release it. With one slot per node,
    // failing away from a node that is alive but slow closes it to every other
    // viewer's transcode for half an hour.
    const deletes: string[] = [];
    let admissions = 0;
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'DELETE') {
        deletes.push(String(url));
        return new Response(null, { status: 204 });
      }
      admissions += 1;
      return new Response(JSON.stringify(wireSession(`session-${admissions}`)), { status: 201, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new ClusterPlaybackResolver(new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b'])));

    const primary = await resolver.resolve(media, capabilities, 0, { mode: 'direct' });
    await resolver.failover(primary, media, capabilities, 20_000, { mode: 'direct' });
    await flushMicrotasks();

    // Session ids are namespaced by endpoint (`http://a::session-1`) while the
    // URL carries the node-local half, so match on that rather than the whole.
    const nodeLocalId = primary.sessionId.split('::').at(-1)!;
    expect(deletes).toEqual([`http://a/api/v1/playback/sessions/${nodeLocalId}`]);
  });

  it('still fails over when the close cannot be delivered', async () => {
    // Never awaited and never allowed to fail the failover: a slow node is
    // exactly where failover fires, so waiting on this would hang the recovery
    // it is part of.
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'DELETE') throw new TypeError('node gone');
      return new Response(JSON.stringify(wireSession('session-b')), { status: 201, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new ClusterPlaybackResolver(new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b'])));

    const primary = await resolver.resolve(media, capabilities, 0, { mode: 'direct' });
    await expect(resolver.failover(primary, media, capabilities, 20_000, { mode: 'direct' })).resolves.toBeTruthy();
    await flushMicrotasks();
  });
});

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

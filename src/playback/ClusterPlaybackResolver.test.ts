import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapEndpoints, EndpointRegistry } from '../cluster/EndpointRegistry.js';
import type { MediaSummary, PlaybackCapabilities } from '../types.js';
import type { PlaybackSession } from './PlaybackResolver.js';
import { ClusterPlaybackResolver } from './ClusterPlaybackResolver.js';
import { clearClientDiagnostics, clientDiagnosticsSnapshot } from '../diagnostics/ClientLog.js';

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

  describe('measuring what a generation start costs on each node', () => {
    const remux = () => ({
      ...wireSession('session-b'),
      mode: 'remux',
      stream: { url: '/api/v1/playback/sessions/session-b/stream/t/1/index.m3u8', mime_type: 'application/vnd.apple.mpegurl', subtitle_url: null },
    });
    const readyNode = () => vi.fn(async (url: string) => url.endsWith('.m3u8')
      ? new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg0.m4s\n#EXT-X-ENDLIST\n', { status: 200 })
      : new Response(new Uint8Array([0]), { status: 206 }));

    it('records the start of every generation it creates, per node and kind, from its own probe', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(remux()), { status: 201, headers: { 'Content-Type': 'application/json' } }));
      vi.stubGlobal('fetch', withSessionCloses(fetchMock));
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://b']));
      const probe = readyNode();
      const resolver = new ClusterPlaybackResolver(registry, undefined, undefined, probe);

      const session = await resolver.resolve(media, capabilities, undefined, { mode: 'remux' });

      await vi.waitFor(() => expect(registry.generationStartEstimate('http://b', 'remux')).toBeDefined());
      expect(resolver.startCostEstimate('http://b', session)).toBe(registry.generationStartEstimate('http://b', 'remux'));
      // Measured on the probe fetch, never on the API's.
      expect(probe).toHaveBeenCalled();
    });

    it('records a relocating seek, which restarts the pipeline, and not a change that does not', async () => {
      const created = () => new Response(JSON.stringify(remux()), { status: 201, headers: { 'Content-Type': 'application/json' } });
      const patched = () => new Response(JSON.stringify(remux()), { status: 200, headers: { 'Content-Type': 'application/json' } });
      const fetchMock = vi.fn().mockResolvedValueOnce(created()).mockResolvedValueOnce(patched()).mockResolvedValueOnce(patched());
      vi.stubGlobal('fetch', withSessionCloses(fetchMock));
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://b']));
      const recorded = vi.spyOn(registry, 'recordGenerationStart');
      const resolver = new ClusterPlaybackResolver(registry, undefined, undefined, readyNode());
      const session = await resolver.resolve(media, capabilities, undefined, { mode: 'remux' });
      await vi.waitFor(() => expect(recorded).toHaveBeenCalledTimes(1));

      await resolver.update(session.sessionId, { preferences: { subtitleStream: 2 } });
      await resolver.update(session.sessionId, { seekMs: 90_000 });

      await vi.waitFor(() => expect(recorded).toHaveBeenCalledTimes(2));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(recorded).toHaveBeenCalledTimes(2);
    });

    it('measures nothing without a probe fetch, so no estimate can ever exist', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(remux()), { status: 201, headers: { 'Content-Type': 'application/json' } }));
      vi.stubGlobal('fetch', withSessionCloses(fetchMock));
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://b']));
      const session = await new ClusterPlaybackResolver(registry).resolve(media, capabilities, undefined, { mode: 'remux' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(registry.generationStartEstimate('http://b', 'remux')).toBeUndefined();
      expect(session.mode).toBe('remux');
    });
  });

  it('hands the host the deadlines of the node that actually served the session', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(wireSession('session-b')), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', withSessionCloses(fetchMock));
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://b']));
    // As the health cycle records it, for every known node, before any session
    // exists on it.
    registry.recordPlaybackBudgets('http://b', {
      startupTimeoutMs: 15_000,
      segmentTimeoutMs: 6_000,
      observedAt: 1,
    });
    const resolver = new ClusterPlaybackResolver(registry);

    const session = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });
    // The stated figure plus transport, so a host and core cannot disagree
    // about what this node will wait for.
    expect(session.source.budgets).toEqual({ deadlineMs: 19_000, segmentHoldMs: 6_000 });
  });

  it('falls back to the published defaults for a node that has said nothing', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(wireSession('session-b')), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', withSessionCloses(fetchMock));
    const resolver = new ClusterPlaybackResolver(new EndpointRegistry(bootstrapEndpoints(['http://b'])));

    const session = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });
    // Absent is not zero and not a shorter guess: a node too old to report
    // still gets the full conservative allowance.
    expect(session.source.budgets).toEqual({ deadlineMs: 19_000, segmentHoldMs: 6_000 });
  });

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

  it('retries a node excluded earlier rather than going terminal while it sits healthy', async () => {
    // The exclusion set only grows — `resolve()` clears it and nothing else —
    // so on a long item it eventually names every node. Two nodes and a
    // two-hour film: A blips at minute ten, B at minute ninety, and the
    // viewer got a bare "No untried Macha playback endpoint remains" while A
    // had been probed healthy for eighty minutes. It exists to stop one
    // recovery walking back onto a node another recovery gave up on, not to
    // retire that node for the rest of the film.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(wireSession('session-a')), { status: 201, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(wireSession('session-b')), { status: 201, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(wireSession('session-c')), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', withSessionCloses(fetchMock));
    const resolver = new ClusterPlaybackResolver(new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b'])));

    const first = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });
    const second = await resolver.failover(first, media, capabilities, 21_000, { mode: 'direct' });
    expect(second.endpoint?.id).toBe('http://b');

    const third = await resolver.failover(second, media, capabilities, 22_000, { mode: 'direct' });

    // A again — and not B, which is the one endpoint that must never be
    // chosen here, because it is the one being failed away from this second.
    expect(third.endpoint?.id).toBe('http://a');
    expect(admissionCalls(fetchMock).map(([url]) => url.split('?')[0])).toEqual([
      'http://a/api/v1/playback/sessions',
      'http://b/api/v1/playback/sessions',
      'http://a/api/v1/playback/sessions',
    ]);
  });

  it('retries a recovered node rather than the one node it has not excluded yet', async () => {
    // "Is the candidate list empty" only answers this correctly in a two-node
    // cluster, and two nodes is not the cluster. With three, a node cooling
    // down from failed health probes keeps the list non-empty, so the
    // recovery walks to the one endpoint already known to be unwell, fails,
    // and gives up — while a node that recovered long ago sits excluded and
    // idle. The question is whether anything outside the exclusion is
    // *usable*, which only the registry can answer: `retryAt` is a reading of
    // its clock and nothing else shares it.
    let now = 1_000;
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if ((init?.method ?? 'GET').toUpperCase() === 'DELETE') return new Response(null, { status: 204 });
      if (target.startsWith('http://c')) throw new TypeError('node c is down');
      const id = target.startsWith('http://a') ? 'session-a' : 'session-b';
      return new Response(JSON.stringify(wireSession(id)), { status: 201, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b', 'http://c']), () => now);
    const resolver = new ClusterPlaybackResolver(registry);

    const first = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });
    const second = await resolver.failover(first, media, capabilities, 21_000, { mode: 'direct' });
    expect(second.endpoint?.id).toBe('http://b');

    // The health loop finds C unwell and puts it on the long end of the
    // cooldown ladder; A's own blip has long since expired.
    for (let probe = 0; probe < 4; probe += 1) registry.recordProbeFailure('http://c');
    now += 1_000;
    expect(registry.snapshot().find((entry) => entry.endpoint.id === 'http://a')?.ready).toBe(true);
    expect(registry.snapshot().find((entry) => entry.endpoint.id === 'http://c')?.ready).toBe(false);

    const third = await resolver.failover(second, media, capabilities, 22_000, { mode: 'direct' });

    expect(third.endpoint?.id).toBe('http://a');
    expect(admissionCalls(fetchMock).map(([url]) => url.split('?')[0])).toEqual([
      'http://a/api/v1/playback/sessions',
      'http://b/api/v1/playback/sessions',
      'http://a/api/v1/playback/sessions',
    ]);
  });

  it('reports the endpoint that actually failed when the relaxed retry fails too', async () => {
    // The bare "no untried endpoint remains" said nothing about why. Once the
    // exclusion relaxes there is always an endpoint left to try, so what
    // reaches the viewer is the real failure of a real node.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(wireSession('session-a')), { status: 201, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(wireSession('session-b')), { status: 201, headers: { 'Content-Type': 'application/json' } }))
      .mockRejectedValue(new TypeError('node A unreachable'));
    vi.stubGlobal('fetch', withSessionCloses(fetchMock));
    const resolver = new ClusterPlaybackResolver(new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b'])));

    const first = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });
    const second = await resolver.failover(first, media, capabilities, 21_000, { mode: 'direct' });

    await expect(resolver.failover(second, media, capabilities, 22_000, { mode: 'direct' }))
      .rejects.toThrow('http://a');
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

  it('charges the failed endpoint once, however the close goes', async () => {
    // One observation, one record. The DELETE goes to a node that has just
    // died, so it throws — and going through `stop()` charged the registry
    // again for the same outage. Worse, `stop()` drops the map entry only on
    // success, so the entry survived for every later cleanup path to find and
    // charge a third time. The cooldown ladder — 500 ms, 2 s, 10 s, 30 s —
    // was being walked by a node that had failed exactly once.
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
        if ((init?.method ?? 'GET').toUpperCase() === 'DELETE') throw new TypeError('node a unreachable');
        const id = String(url).startsWith('http://a') ? 'session-a' : 'session-b';
        return new Response(JSON.stringify(wireSession(id)), { status: 201, headers: { 'Content-Type': 'application/json' } });
      });
      vi.stubGlobal('fetch', fetchMock);
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
      const resolver = new ClusterPlaybackResolver(registry);
      const primary = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });

      await resolver.failover(primary, media, capabilities, 0, { mode: 'direct' });
      for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();

      expect(registry.snapshot().find((entry) => entry.endpoint.id === 'http://a')?.health.consecutiveFailures).toBe(1);
      // And the abandoned session is gone from the map whether or not the node
      // ever acknowledged the close, so nothing can find it to charge again.
      await expect(resolver.stop(primary.sessionId)).resolves.toBeUndefined();
      expect(registry.snapshot().find((entry) => entry.endpoint.id === 'http://a')?.health.consecutiveFailures).toBe(1);
    } finally {
      vi.useRealTimers();
    }
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

describe('regenerating on the node that reaped the session', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks the same node again, and does not charge it for having forgotten', async () => {
    // The `404` was about one session's existence. The node is fine, holds the
    // title's pipeline, and is the right place to ask — and until this existed
    // the only exit was `failover`, whose first act is to condemn it.
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'DELETE') return new Response(null, { status: 404 });
      const id = String(url).startsWith('http://a') ? 'session-a2' : 'session-b';
      return new Response(JSON.stringify(wireSession(id)), { status: 201, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
    const resolver = new ClusterPlaybackResolver(registry);
    const primary = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });

    const next = await resolver.regenerate(primary, media, capabilities, 45_000, { mode: 'direct' });

    expect(next.endpoint?.id).toBe('http://a');
    expect(registry.snapshot().find((entry) => entry.endpoint.id === 'http://a')?.health.consecutiveFailures).toBe(0);
    // And node B was never asked, though it was sitting there healthy.
    expect(admissionCalls(fetchMock).every(([url]) => String(url).startsWith('http://a'))).toBe(true);
  });

  it('releases the old session before asking for the new one', async () => {
    // Load-bearing ordering, not tidiness. With `max_video_transcodes` at 1 the
    // session being replaced is holding the only slot the replacement needs, so
    // asking first is asking to be refused.
    const order: string[] = [];
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (String(url).startsWith('http://a')) order.push(method);
      if (method === 'DELETE') return new Response(null, { status: 204 });
      return new Response(JSON.stringify(wireSession('session-a2')), { status: 201, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new ClusterPlaybackResolver(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    const primary = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });
    order.length = 0;

    await resolver.regenerate(primary, media, capabilities, 45_000, { mode: 'direct' });

    expect(order).toEqual(['DELETE', 'POST']);
  });

  it('charges the node when it refuses fresh work, which is a claim about itself', async () => {
    // The distinction the whole change rests on. Forgetting a session says
    // nothing about the node; refusing to issue one says a great deal, and the
    // registry is entitled to hear the second.
    let admissions = 0;
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'DELETE') return new Response(null, { status: 404 });
      admissions += 1;
      if (admissions === 1) {
        return new Response(JSON.stringify(wireSession('session-a')), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { code: 'unavailable', message: 'no capacity' } }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a']));
    const resolver = new ClusterPlaybackResolver(registry);
    const primary = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });

    await expect(resolver.regenerate(primary, media, capabilities, 45_000, { mode: 'direct' })).rejects.toThrow();

    expect(registry.snapshot().find((entry) => entry.endpoint.id === 'http://a')?.health.consecutiveFailures).toBe(1);
  });

  it('refuses to guess at an endpoint it no longer has', async () => {
    // Failing over instead is the caller's decision, and the caller already has
    // to make it for a refused admission. Making it here too would put one
    // decision in two places.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(wireSession('session-a')), { status: 201, headers: { 'Content-Type': 'application/json' } })));
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a']));
    const resolver = new ClusterPlaybackResolver(registry);
    const primary = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });

    registry.replace([]);

    await expect(resolver.regenerate(primary, media, capabilities, 0, { mode: 'direct' })).rejects.toThrow(/no endpoint to regenerate on/);
  });
});

describe('asking whether a session still exists', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function owned() {
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
    const resolver = new ClusterPlaybackResolver(registry);
    const session = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });
    return { registry, resolver, session };
  }

  it('reads a 404 as the answer, and asks only the node that issued it', async () => {
    // Every other node would answer 404 truthfully for a session it never had,
    // so a walk here could only produce a confident wrong answer.
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
        return new Response(JSON.stringify(wireSession('session-a')), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { code: 'not_found', message: 'playback session not found' } }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { registry, resolver, session } = await owned();

    await expect(resolver.sessionAlive(session.sessionId)).resolves.toBe(false);
    const probes = (fetchMock.mock.calls as Array<[string, RequestInit]>)
      .filter(([, init]) => (init?.method ?? 'GET').toUpperCase() === 'GET');
    expect(probes).toHaveLength(1);
    expect(probes[0]![0]).toBe('http://a/api/v1/playback/sessions/session-a');
    // Answering correctly is not a fault, and a probe that moved the registry
    // would make asking a question cost the node something.
    expect(registry.snapshot().find((entry) => entry.endpoint.id === 'http://a')?.health.consecutiveFailures).toBe(0);
  });

  it('throws rather than answering when it could not find out', async () => {
    // "I could not find out" is not "it is gone". Collapsing them tears down a
    // live session because a node was briefly unreachable.
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
        return new Response(JSON.stringify(wireSession('session-a')), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);
    const { resolver, session } = await owned();

    await expect(resolver.sessionAlive(session.sessionId)).rejects.toThrow();
  });

  it('says a session the node still holds is alive', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(wireSession('session-a')), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { resolver, session } = await owned();

    await expect(resolver.sessionAlive(session.sessionId)).resolves.toBe(true);
  });
});

describe('closing a generation that will not close', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('charges the node once for a teardown it refuses, and reports which node it was', async () => {
    // `stop()` is the caller-facing close, unlike the fire-and-forget ladder
    // that follows a failover. A DELETE that throws here is ordinary endpoint
    // evidence and the caller has to be told which endpoint produced it, or a
    // host's failure report names the cluster instead of the node.
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'DELETE') throw new TypeError('node a unreachable');
      return new Response(JSON.stringify(wireSession('session-a')), { status: 201, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a']));
    const resolver = new ClusterPlaybackResolver(registry);
    const live = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });

    await expect(resolver.stop(live.sessionId)).rejects.toThrow(/http:\/\/a/);
    expect(registry.snapshot().find((entry) => entry.endpoint.id === 'http://a')?.health.consecutiveFailures).toBe(1);
  });

  it('does not charge again for a teardown the caller has already charged for', async () => {
    // The seam that stops one outage walking the cooldown ladder. A caller
    // that has already recorded the failure passes `endpointAlreadyCharged`,
    // and the entry goes before the attempt rather than on success — so a
    // throwing DELETE cannot leave a session behind for a later cleanup path
    // to find and charge a third time.
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'DELETE') throw new TypeError('node a unreachable');
      return new Response(JSON.stringify(wireSession('session-a')), { status: 201, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a']));
    const resolver = new ClusterPlaybackResolver(registry);
    const live = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });

    await expect(resolver.stop(live.sessionId, { endpointAlreadyCharged: true })).rejects.toThrow(/http:\/\/a/);
    expect(registry.snapshot().find((entry) => entry.endpoint.id === 'http://a')?.health.consecutiveFailures).toBe(0);

    // Gone whether or not the node ever acknowledged it.
    const deletesSoFar = fetchMock.mock.calls.filter(([, init]) => (init?.method ?? 'GET').toUpperCase() === 'DELETE').length;
    await expect(resolver.stop(live.sessionId, { endpointAlreadyCharged: true })).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.filter(([, init]) => (init?.method ?? 'GET').toUpperCase() === 'DELETE').length).toBe(deletesSoFar);
  });

  it('gives up the abandoned session after a bounded ladder rather than retrying for ever', async () => {
    // The ladder exists because the DELETE usually goes to a node that is
    // already gone, so one attempt is not a policy. It is bounded because the
    // node's own `session_idle` reclaims the lease after thirty minutes and
    // this only has to cover a node that comes back sooner — roughly half a
    // minute of it. Longer would be a timer nothing in this class can cancel.
    vi.useFakeTimers();
    try {
      const deleteUrls: string[] = [];
      const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
        if ((init?.method ?? 'GET').toUpperCase() === 'DELETE') {
          deleteUrls.push(String(url));
          throw new TypeError('node a unreachable');
        }
        const id = String(url).startsWith('http://a') ? 'session-a' : 'session-b';
        return new Response(JSON.stringify(wireSession(id)), { status: 201, headers: { 'Content-Type': 'application/json' } });
      });
      vi.stubGlobal('fetch', fetchMock);
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
      const resolver = new ClusterPlaybackResolver(registry);
      const primary = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });

      await resolver.failover(primary, media, capabilities, 0, { mode: 'direct' });

      // 1 s, 2 s, 4 s, 8 s between the five attempts, capped at 16 s.
      for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
      expect(deleteUrls.length).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(deleteUrls.length).toBe(5);
      expect(new Set(deleteUrls)).toEqual(new Set(['http://a/api/v1/playback/sessions/session-a']));

      // And it stops. A ladder that kept climbing would hold a timer for the
      // life of the process against a node nobody is waiting for.
      await vi.advanceTimersByTimeAsync(300_000);
      expect(deleteUrls.length).toBe(5);
      // One observation, one record, however many attempts it took.
      expect(registry.snapshot().find((entry) => entry.endpoint.id === 'http://a')?.health.consecutiveFailures).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes a standby that came back as a different mode rather than offering it', async () => {
    // A standby prepared as a rescue for a transcode is not a rescue if the
    // node handed back Direct Play. Returning it would swap the viewer onto a
    // different kind of generation mid-recovery; keeping it would hold a slot
    // on a node for a session nothing will ever promote.
    const transcoded = {
      ...wireSession('session-a'),
      mode: 'transcode',
      preferences: { ...wireSession('session-a').preferences, mode: 'transcode' },
      output: { container: 'fmp4' },
      stream: { url: '/api/v1/playback/stream/session-a/index.m3u8', mime_type: 'application/vnd.apple.mpegurl', subtitle_url: null },
    };
    const deletes: string[] = [];
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'DELETE') {
        deletes.push(String(url));
        return new Response(null, { status: 204 });
      }
      return String(url).startsWith('http://a')
        ? new Response(JSON.stringify(transcoded), { status: 201, headers: { 'Content-Type': 'application/json' } })
        // Node B ignores the requested mode and serves Direct Play.
        : new Response(JSON.stringify(wireSession('session-b')), { status: 201, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new ClusterPlaybackResolver(new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b'])));
    const primary = await resolver.resolve(media, capabilities, 0, { mode: 'transcode' });

    const standby = await resolver.prepareAlternate(primary, media, capabilities, 0, { mode: 'transcode' });

    expect(standby).toBeUndefined();
    expect(deletes).toEqual(['http://b/api/v1/playback/sessions/session-b']);
  });
});

describe('a regeneration whose close never comes back', () => {
  // **The one unbounded wait on the recovery path, measured on hardware.**
  // `releaseFailedSession` resolves when the first DELETE settles, and nothing
  // bounds that DELETE - the attempt deadline wraps only the POST in
  // `createOn`. Its own docblock says it must never be awaited, because "a
  // slow node is exactly where failover fires"; `regenerate` awaits it anyway,
  // because the node's transcode slot is held by the session being replaced.
  //
  // On the Android TV client on 2026-09-20 that hung a viewer indefinitely:
  // the chrome sat on "Preparing new stream", the position froze at 5:00, and
  // no failure screen ever arrived - because nothing threw, and a hang is not
  // an error. Every bounded thing below was waiting on the one unbounded thing
  // above it.

  it('asks for the replacement anyway rather than waiting for ever', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      // A close that never comes back, which is what "no timeout anywhere"
      // means in practice.
      if ((init?.method ?? 'GET').toUpperCase() === 'DELETE') return new Promise<Response>(() => {});
      return new Response(JSON.stringify(wireSession('session-2')), {
        status: 201, headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a']));
    const resolver = new ClusterPlaybackResolver(registry, undefined, 50);

    const dead = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });
    const next = await resolver.regenerate(dead, media, capabilities, 30_000, { mode: 'direct' });

    // The replacement exists. Before the bound, this line was never reached.
    expect(next.sessionId).toContain('session-2');
    expect(admissionCalls(fetchMock)).toHaveLength(2);
  });

  it('says the close timed out rather than letting it pass unrecorded', async () => {
    // The node is now holding a transcode slot nothing has released, which is
    // the operator-visible half of Law 4's discipline. It is a warn because
    // the recovery continued; the leak is real and needs somewhere to be read.
    clearClientDiagnostics();
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'DELETE') return new Promise<Response>(() => {});
      return new Response(JSON.stringify(wireSession('session-2')), {
        status: 201, headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a']));
    const resolver = new ClusterPlaybackResolver(registry, undefined, 50);
    const dead = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });
    await resolver.regenerate(dead, media, capabilities, 30_000, { mode: 'direct' });

    expect(clientDiagnosticsSnapshot().filter((e) => e.event === 'failed-session-close-timeout')).toHaveLength(1);
  });

  it('does not wait out the bound when the close answers promptly', async () => {
    // The ordinary path must not have acquired a delay. A 404 on the DELETE is
    // the commonest case of all - the session was reaped, so there is nothing
    // to close - and it has to stay fast.
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'DELETE') return new Response(null, { status: 404 });
      return new Response(JSON.stringify(wireSession('session-2')), {
        status: 201, headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a']));
    const resolver = new ClusterPlaybackResolver(registry, undefined, 10_000);
    const dead = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });

    const startedAt = Date.now();
    await resolver.regenerate(dead, media, capabilities, 30_000, { mode: 'direct' });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});

describe('a close the ladder gave up on', () => {
  // The ladder gives up after ~31 s; the node holds the slot for thirty
  // minutes. Between those sits a session nothing will release, and only core
  // can close it - the node enforcing the cap is the node holding the session
  // and it considers itself perfectly reachable. It never saw a failed
  // connection; it saw requests stop arriving.
  //
  // Measured by the web client 2026-09-21 and it is the LONG strand: it
  // isolated the node inside the browser, so the process never died and the
  // session map stayed intact. The session had been playing, so the node's
  // 120-second unused-idle never applies and it holds one of max_sessions
  // (8 on es-1, node-wide across every account) for the full session_idle_ms.

  function deleteFailingFetch(sessionBody: (id: string) => string) {
    const deletes: string[] = [];
    let deletesFail = true;
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'DELETE') {
        deletes.push(String(url));
        if (deletesFail) throw new TypeError('Failed to fetch');
        return new Response(null, { status: 404 });
      }
      return new Response(sessionBody(`s${deletes.length}`), {
        status: 201, headers: { 'Content-Type': 'application/json' },
      });
    });
    return { fetchMock, deletes, reachable: () => { deletesFail = false; } };
  }

  it('retries the close when that node next answers, rather than stranding it', async () => {
    vi.useFakeTimers();
    try {
      const { fetchMock, deletes, reachable } = deleteFailingFetch((id) => JSON.stringify(wireSession(id)));
      vi.stubGlobal('fetch', fetchMock);
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://a']));
      const resolver = new ClusterPlaybackResolver(registry, undefined, 5_000);

      const dead = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });
      await resolver.regenerate(dead, media, capabilities, 30_000, { mode: 'direct' });

      // The ladder is five attempts over ~31 s. Nothing is remembered until it
      // has actually given up - before that it is still trying, and a second
      // mechanism racing the first is how a close gets sent twice.
      await vi.advanceTimersByTimeAsync(40_000);
      const afterLadder = deletes.length;
      expect(afterLadder).toBe(5);

      // The node comes back and core admits a generation on it again.
      reachable();
      await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });
      await vi.advanceTimersByTimeAsync(10);
      expect(deletes.length).toBeGreaterThan(afterLadder);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not delay the admission it rides on', async () => {
    // Fire-and-forget deliberately: this runs on a viewer's critical path and
    // must not cost them a millisecond. A DELETE for an id the node no longer
    // holds answers 404, which is already treated as success.
    const { fetchMock, reachable } = deleteFailingFetch((id) => JSON.stringify(wireSession(id)));
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a']));
    const resolver = new ClusterPlaybackResolver(registry, undefined, 5_000);
    const dead = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });
    await resolver.regenerate(dead, media, capabilities, 30_000, { mode: 'direct' });
    reachable();

    const startedAt = Date.now();
    await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });
    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});

describe('a standby the node would not build', () => {
  // `prepareAlternate` swallowed every failure into a bare `undefined`, so
  // core could not tell "nothing suitable was available" from "the node
  // refused" from "this threw". Three states, one silence.
  //
  // The per-account session cap makes that acute rather than untidy. A standby
  // is the FIRST thing an account at its limit gets refused, because it is the
  // speculative request rather than the one a viewer is waiting on - so the
  // mechanism most likely to meet the cap first was the one that could not
  // report meeting it. Seamless failover would stop happening with nothing on
  // any trail, and the first evidence would be a viewer watching a stall.

  function refusals(): Array<Record<string, unknown>> {
    return clientDiagnosticsSnapshot()
      .filter((entry) => entry.event === 'standby-preparation-refused')
      .map((entry) => ((entry.data as { detail?: unknown })?.detail ?? entry.data ?? {}) as Record<string, unknown>);
  }

  function refusingCluster(status: number, code: string) {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'DELETE') return new Response(null, { status: 204 });
      if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
        return new Response(JSON.stringify({ code, message: 'refused' }), {
          status, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(null, { status: 404 });
    });
    return fetchMock;
  }

  it('deletes a session whose provenance it no longer holds, because the id carries it', async () => {
    // **Why every client leaked sessions all day.** `stop()` looked the id up
    // in an in-memory map and returned silently when it was missing — no
    // request, no log, a resolved promise. A caller could close every session
    // it had and produce zero DELETEs on the node while believing it had
    // cleaned up. Measured on fi-1: 57 creates and 0 deletes since 13:00.
    //
    // The map does not survive a reload, and a re-resolution deletes the entry
    // for the id a host is still holding, so "provenance missing" is the
    // ordinary case rather than the exotic one. It never needed the map: core
    // mints `${endpoint.id}::${nodeSessionId}` itself, so the id states which
    // node holds it.
    const deleted: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'DELETE') {
        deleted.push(String(url));
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    }));
    const resolver = new ClusterPlaybackResolver(new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b'])));

    // An id from a previous process: never created through this instance.
    await resolver.stop('http://b::orphaned-session');

    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toContain('http://b/api/v1/playback/sessions/orphaned-session');
  });

  it('builds on the node it is told to, not the one ranked first', async () => {
    // The whole point of the verb. Every other route into another node takes
    // whichever candidate ranks highest; this one takes an instruction. `a` is
    // first in configured order and would win any ranked walk.
    let moving = false;
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if ((init?.method ?? 'GET').toUpperCase() === 'DELETE') return new Response(null, { status: 204 });
      // `a` serves the original session, then must never be asked again.
      if (moving && target.startsWith('http://a')) throw new Error('fakeCluster: a must not be asked');
      return new Response(JSON.stringify(wireSession(moving ? 'session-c' : 'session-a')), {
        status: 201, headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b', 'http://c']));
    const resolver = new ClusterPlaybackResolver(registry);
    const active = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });
    fetchMock.mockClear();
    moving = true;

    const moved = await resolver.prepareOn('http://c', active, media, capabilities, 5_000, { mode: 'direct' });

    expect(moved?.endpoint?.id).toBe('http://c');
    // And exactly one node was asked. A move that quietly walks is a failover
    // wearing a viewer's instruction.
    const asked = new Set(fetchMock.mock.calls
      .filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === 'POST')
      .map(([target]) => String(target).split('/api')[0]));
    expect([...asked]).toEqual(['http://c']);
  });

  it('leaves the outgoing generation alone, because someone is watching it', async () => {
    // Acquire before release. The cap is counted per node, so holding both is
    // free — and closing first is exactly the 13.2 s gap this exists to remove.
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'DELETE') return new Response(null, { status: 204 });
      return new Response(JSON.stringify(wireSession('session-b')), {
        status: 201, headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new ClusterPlaybackResolver(new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b'])));
    const active = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });
    fetchMock.mockClear();

    await resolver.prepareOn('http://b', active, media, capabilities, 5_000, { mode: 'direct' });

    const deletes = fetchMock.mock.calls
      .filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === 'DELETE');
    expect(deletes).toHaveLength(0);
  });

  it('declines a node that is already serving, and one it has never heard of', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'DELETE') return new Response(null, { status: 204 });
      return new Response(JSON.stringify(wireSession('session-a')), {
        status: 201, headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const resolver = new ClusterPlaybackResolver(new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b'])));
    const active = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });

    await expect(resolver.prepareOn(active.endpoint!.id, active, media, capabilities, 0, { mode: 'direct' }))
      .resolves.toBeUndefined();
    await expect(resolver.prepareOn('http://nowhere', active, media, capabilities, 0, { mode: 'direct' }))
      .resolves.toBeUndefined();
  });

  it('walks to a node with room when the account is at its limit on this one', async () => {
    // **The defect this exists for.** The cap is counted per node -- the
    // server's `sessions_held_by_locked` iterates that node's own session map
    // -- so a refusal from `a` says nothing about `b`. Core used to read the
    // refusal as cluster-wide and give up on the spot, which refused a viewer
    // outright while a node with capacity sat idle beside it. The realistic
    // way to arrive here is orphaned sessions accumulating on whichever node a
    // client keeps using, which is exactly what was measured on a television.
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if ((init?.method ?? 'GET').toUpperCase() === 'DELETE') return new Response(null, { status: 204 });
      if (target.startsWith('http://a')) {
        return new Response(JSON.stringify({ code: 'account_session_limit', message: 'account at its session limit' }), {
          status: 429, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(wireSession('session-b')), {
        status: 201, headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
    const resolver = new ClusterPlaybackResolver(registry);

    const session = await resolver.resolve(media, capabilities, undefined, { mode: 'direct' });

    expect(session.endpoint?.id).toBe('http://b');
    // And nobody is charged for it on the way past. `a` is not unwell: it is
    // holding this account's limit and serving everyone else perfectly.
    expect(registry.snapshot().find((entry) => entry.endpoint.id === 'http://a')?.health.consecutiveFailures).toBe(0);
    expect(registry.snapshot().find((entry) => entry.endpoint.id === 'http://b')?.health.consecutiveFailures).toBe(0);
  });

  it('says the account was at its session limit rather than going quiet', async () => {
    clearClientDiagnostics();
    vi.stubGlobal('fetch', refusingCluster(429, 'account_session_limit'));
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
    const resolver = new ClusterPlaybackResolver(registry, undefined, 5_000);
    const active = { ...wireSession('s1') } as unknown as PlaybackSession;

    const standby = await resolver.prepareAlternate(
      { sessionId: 's1', mediaId: 'macha:media', mode: 'transcode', endpoint: { id: 'http://a', baseUrl: 'http://a' },
        source: { mediaId: 'macha:media', url: 'http://a/s.m3u8', mimeType: 'application/vnd.apple.mpegurl', isManifest: true, mode: 'transcode', durationMs: 1 },
      } as unknown as PlaybackSession,
      media, capabilities, 0, { mode: 'transcode' },
    );

    expect(standby).toBeUndefined();
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0].accountAtSessionLimit).toBe(true);
    expect(refusals()[0].code).toBe('account_session_limit');
    expect(active).toBeTruthy();
  });

  it('does not call an ordinary refusal an account limit', async () => {
    // A node genuinely full is a different state and must read as one, or the
    // sentence a host shows a viewer is wrong in the most confusing direction.
    clearClientDiagnostics();
    vi.stubGlobal('fetch', refusingCluster(429, 'resource_limit'));
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
    const resolver = new ClusterPlaybackResolver(registry, undefined, 5_000);

    await resolver.prepareAlternate(
      { sessionId: 's1', mediaId: 'macha:media', mode: 'transcode', endpoint: { id: 'http://a', baseUrl: 'http://a' },
        source: { mediaId: 'macha:media', url: 'http://a/s.m3u8', mimeType: 'application/vnd.apple.mpegurl', isManifest: true, mode: 'transcode', durationMs: 1 },
      } as unknown as PlaybackSession,
      media, capabilities, 0, { mode: 'transcode' },
    );

    expect(refusals()).toHaveLength(1);
    expect(refusals()[0].accountAtSessionLimit).toBe(false);
    expect(refusals()[0].code).toBe('resource_limit');
  });
});

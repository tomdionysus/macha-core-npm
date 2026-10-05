import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClusterPlaybackFactsApi, FACTS_RETRY_DELAYS_MS } from './ClusterPlaybackFactsApi.js';
import { bootstrapEndpoints, EndpointRegistry } from '../cluster/EndpointRegistry.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const facts = {
  item_id: 'movie:1',
  media: [{
    media_id: 'macha:abc', container: 'matroska', format: 'matroska,webm',
    duration_ms: 1_000, bitrate: 1_000, size: 10,
    operations: { direct: true, copy_into_fmp4: { video: true, audio: true }, transcode_video: true, transcode_audio: true },
    streams: [{ index: 0, type: 'video', codec: 'hevc', bit_depth: 10, color_transfer: 'smpte2084', dolby_vision_profile: 8 }],
  }],
};

describe('ClusterPlaybackFactsApi', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('passes a node whose build predates the facts endpoint', async () => {
    // A partial cluster upgrade: the preferred node 404s the route itself.
    // Treating that as terminal would leave the chooser with no facts and
    // silently transcode everything.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: { code: 'not_found', message: 'endpoint not found' } }, 404))
      .mockResolvedValueOnce(json(facts));
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://old', 'http://new']));

    const result = await new ClusterPlaybackFactsApi(registry).facts({ itemId: 'movie:1' });

    expect(result[0]?.profile.container).toBe('matroska');
    expect(result[0]?.operations.copyIntoFmp4.audio).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not blame a node for lacking the endpoint', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: { code: 'not_found' } }, 404))
      .mockResolvedValueOnce(json(facts));
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://old', 'http://new']));
    const failures = vi.spyOn(registry, 'recordFailure');

    await new ClusterPlaybackFactsApi(registry).facts({ itemId: 'movie:1' });

    // An old build is not an unhealthy node; cooling it down would take it
    // out of rotation for work it can perfectly well do.
    expect(failures).not.toHaveBeenCalled();
  });

  it('does not blame a node for one title it cannot read', async () => {
    // `stream_failed` is a fact about that extent on that node. Cooling the
    // endpoint down for it takes a healthy node out of rotation for every
    // other title on it — the guard `ClusterPlaybackResolver.create` has had
    // all along, and this call did not.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: { code: 'stream_failed', message: 'source unreadable' } }, 500))
      .mockResolvedValueOnce(json(facts));
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
    const failures = vi.spyOn(registry, 'recordFailure');

    const result = await new ClusterPlaybackFactsApi(registry).facts({ itemId: 'movie:1' });

    // It still moves on to the next node — this is about the node's health
    // record, not about giving up on the read.
    expect(result[0]?.profile.container).toBe('matroska');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(failures).not.toHaveBeenCalled();
  });

  it('still reports a 404 when no node can answer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: { code: 'not_found' } }, 404)));
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));

    await expect(new ClusterPlaybackFactsApi(registry).facts({ mediaId: 'macha:missing' }))
      .rejects.toMatchObject({ status: 404 });
  });

  it('maps the per-node operations object', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      ...facts,
      media: [{ ...facts.media[0], operations: { direct: true, copy_into_fmp4: { video: true } } }],
    })));
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a']));

    const [result] = await new ClusterPlaybackFactsApi(registry).facts({ itemId: 'movie:1' });

    // An absent operation reads as cannot, never can.
    expect(result.operations.copyIntoFmp4).toEqual({ video: true, audio: false });
    expect(result.operations.transcodeVideo).toBe(false);
  });
});

describe('an item with a file one node could not read', () => {
  afterEach(() => vi.unstubAllGlobals());
  const second = { ...facts.media[0]!, media_id: 'macha:def' };
  const partial = { item_id: 'movie:1', media: facts.media, unavailable: [{ media_id: 'macha:def', reason: 'probe_timeout', message: 'probe timed out' }] };

  function nodes(answer: (url: string) => Response) {
    const fetchMock = vi.fn(async (url: string) => answer(url));
    vi.stubGlobal('fetch', fetchMock);
    return { fetchMock, registry: new EndpointRegistry(bootstrapEndpoints(['http://fi-1', 'http://gbni-1'])) };
  }

  it('asks the next node for the missing file, and reports the item whole', async () => {
    // The Android TV client, The Martian, 2026-09-27: one node answered with
    // one of two files, and the host drew versions from that one alone.
    const { registry } = nodes((url) => url.startsWith('http://fi-1')
      ? json(partial)
      : json({ media: [second] }));
    const report = await new ClusterPlaybackFactsApi(registry).factsReport({ itemId: 'movie:1' });
    expect(report.files.map((file) => file.mediaId)).toEqual(['macha:abc', 'macha:def']);
    expect(report.unavailable).toEqual([]);
  });

  it('says which file no node could read, rather than answering short in silence', async () => {
    const { registry } = nodes((url) => url.startsWith('http://fi-1')
      ? json(partial)
      : json({ error: { code: 'facts_unavailable', message: 'no', reason: 'read_failed' } }, 422));
    const api = new ClusterPlaybackFactsApi(registry);
    const report = await api.factsReport({ itemId: 'movie:1' });
    expect(report.files.map((file) => file.mediaId)).toEqual(['macha:abc']);
    expect(report.unavailable).toEqual([{ mediaId: 'macha:def', reason: 'probe_timeout', message: 'probe timed out' }]);
    // `facts` keeps its shape: the files that answered.
    expect((await api.facts({ itemId: 'movie:1' })).map((file) => file.mediaId)).toEqual(['macha:abc']);
  });
});

/**
 * Tom, 2026-10-06: the bounded retry is in core's facts lookup itself, so a
 * playback start or a download on any client gets it, not only a start
 * through `PlaybackCoordinator`.
 */
describe('a facts lookup that fails for a moment', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('retries after each wait, and answers once a node does', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: 'internal', message: 'boom' }, 500))
      .mockResolvedValueOnce(json({ error: 'internal', message: 'boom' }, 500))
      .mockResolvedValueOnce(json(facts));
    vi.stubGlobal('fetch', fetchMock);
    const lookup = new ClusterPlaybackFactsApi(new EndpointRegistry(bootstrapEndpoints(['http://a']))).facts({ itemId: 'movie:1' });

    await vi.advanceTimersByTimeAsync(FACTS_RETRY_DELAYS_MS.reduce((sum, wait) => sum + wait, 0));

    await expect(lookup).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(FACTS_RETRY_DELAYS_MS.length + 1);
  });

  it('gives up after the last wait with the failure', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => json({ error: 'internal', message: 'boom' }, 500));
    vi.stubGlobal('fetch', fetchMock);
    const lookup = new ClusterPlaybackFactsApi(new EndpointRegistry(bootstrapEndpoints(['http://a']))).facts({ itemId: 'movie:1' });
    const settled = expect(lookup).rejects.toBeDefined();

    await vi.advanceTimersByTimeAsync(10_000);

    await settled;
    expect(fetchMock).toHaveBeenCalledTimes(FACTS_RETRY_DELAYS_MS.length + 1);
  });

  it('does not retry a media no node has', async () => {
    const fetchMock = vi.fn(async () => json({ error: 'not_found', message: 'no such media' }, 404));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new ClusterPlaybackFactsApi(new EndpointRegistry(bootstrapEndpoints(['http://a']))).facts({ itemId: 'movie:1' }))
      .rejects.toMatchObject({ status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops waiting when its caller goes away', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => json({ error: 'internal', message: 'boom' }, 500));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const lookup = new ClusterPlaybackFactsApi(new EndpointRegistry(bootstrapEndpoints(['http://a']))).facts({ itemId: 'movie:1' }, controller.signal);
    const settled = expect(lookup).rejects.toBeDefined();

    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await settled;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});


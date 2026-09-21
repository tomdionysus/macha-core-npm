import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClusterPlaybackFactsApi } from './ClusterPlaybackFactsApi.js';
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

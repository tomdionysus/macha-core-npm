import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapEndpoints, EndpointRegistry } from '../cluster/EndpointRegistry.js';
import { ClusterEndpointRouter } from '../cluster/endpointRouting.js';
import { ClusterStatusRouter } from './ClusterStatusRouter.js';
import { MachaClusterStatusApiError } from './ClusterStatusApi.js';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

describe('ClusterStatusRouter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fails a safe status read over without handing authority to the node that answered', async () => {
    const payload = { cluster: {}, nodes: [], generated_at_unix_ms: 1 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ message: 'starting' }, 503))
      .mockResolvedValueOnce(json(payload));
    vi.stubGlobal('fetch', fetchMock);
    let now = 1_000;
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']), () => now);
    const router = new ClusterEndpointRouter(registry);
    // Real work decides authority; this read is the ten-second health cycle's.
    await router.request(async (endpoint) => endpoint.id);
    const api = new ClusterStatusRouter(router);

    await expect(api.status()).resolves.toEqual(payload);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://a/api/v1/status',
      'http://b/api/v1/status',
    ]);
    // It still failed over, and the 503 still cost the node a cooldown.
    expect(registry.candidates()[0]?.endpoint.id).toBe('http://b');
    // Past the cooldown, the viewer's node is still the viewer's node: a
    // status timeout is not a demotion and a status success is not a promotion.
    now += 60_000;
    expect(registry.candidates()[0]?.endpoint.id).toBe('http://a');
  });

  it('never replays a connectivity action with an uncertain outcome', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('connection lost'));
    vi.stubGlobal('fetch', fetchMock);
    const api = new ClusterStatusRouter(new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b'])));

    await expect(api.checkConnectivity()).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks the node itself for what each node states only for itself', async () => {
    // Server 0.86.0: `diagnostics.repair` is the answering node's own.
    const repair = { pace: 'paced', paced_by: ['playback'] };
    const fetchMock = vi.fn(async (url: string) => json({
      node_id: url.startsWith('http://b') ? 'node-b' : 'node-a',
      cluster: {}, nodes: [], generated_at_unix_ms: 1,
      diagnostics: url.startsWith('http://b') ? { repair } : {},
    }));
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
    registry.claimNodeId('http://a', 'node-a');
    registry.claimNodeId('http://b', 'node-b');
    const api = new ClusterStatusRouter(registry);

    const snapshot = await api.statusOf('node-b');

    expect(snapshot.diagnostics?.repair).toEqual(repair);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['http://b/api/v1/status']);
  });

  it('takes no other node\'s answer, and says when no endpoint is that node', async () => {
    const fetchMock = vi.fn(async () => json({ node_id: 'node-a', cluster: {}, nodes: [], generated_at_unix_ms: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
    registry.claimNodeId('http://a', 'node-a');
    // A stale claim: the address now answers as another node.
    registry.claimNodeId('http://b', 'node-b');
    const api = new ClusterStatusRouter(registry);

    await expect(api.statusOf('node-b')).rejects.toMatchObject({ status: 404 });
    await expect(api.statusOf('node-c')).rejects.toBeInstanceOf(MachaClusterStatusApiError);
  });
});

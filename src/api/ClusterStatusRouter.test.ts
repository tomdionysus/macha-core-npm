import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapEndpoints, EndpointRegistry } from '../cluster/EndpointRegistry.js';
import { ClusterStatusRouter } from './ClusterStatusRouter.js';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

describe('ClusterStatusRouter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fails a safe status read over and keeps the successful endpoint sticky', async () => {
    const payload = { cluster: {}, nodes: [], generated_at_unix_ms: 1 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ message: 'starting' }, 503))
      .mockResolvedValueOnce(json(payload));
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
    const api = new ClusterStatusRouter(registry);

    await expect(api.status()).resolves.toEqual(payload);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://a/api/v1/status',
      'http://b/api/v1/status',
    ]);
    expect(registry.candidates()[0]?.endpoint.id).toBe('http://b');
  });

  it('never replays a connectivity action with an uncertain outcome', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('connection lost'));
    vi.stubGlobal('fetch', fetchMock);
    const api = new ClusterStatusRouter(new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b'])));

    await expect(api.checkConnectivity()).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

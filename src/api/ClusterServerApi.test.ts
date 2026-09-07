import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapEndpoints, EndpointRegistry } from '../cluster/EndpointRegistry.js';
import { ClusterServerApi } from './ClusterServerApi.js';

describe('ClusterServerApi', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('finds playback capability status through another healthy endpoint', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'starting' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ enabled: true, server_version: '1.0' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));

    await expect(new ClusterServerApi(registry).status()).resolves.toEqual(expect.objectContaining({
      playbackAvailable: true,
      version: '1.0',
    }));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://a/api/v1/playback/status',
      'http://b/api/v1/playback/status',
    ]);
  });
});

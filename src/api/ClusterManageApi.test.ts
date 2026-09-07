import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapEndpoints, EndpointRegistry } from '../cluster/EndpointRegistry.js';
import { ClusterEndpointRouter } from '../cluster/endpointRouting.js';
import { ClusterManageApi } from './ClusterManageApi.js';

describe('ClusterManageApi', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('routes management reads away from a failed configured-first node and keeps the winner authoritative', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('node 200 unavailable'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ path: '/', entries: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://200', 'http://50']));
    const api = new ClusterManageApi(new ClusterEndpointRouter(registry));

    await expect(api.unmatched()).resolves.toEqual([]);
    await api.browse('/');

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://200/api/v1/manage/unmatched',
      'http://50/api/v1/manage/unmatched',
      'http://50/api/v1/manage/filesystem?path=%2F',
    ]);
  });
});

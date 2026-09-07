import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapEndpoints, EndpointRegistry } from '../cluster/EndpointRegistry.js';
import { ClusterEndpointRouter } from '../cluster/endpointRouting.js';
import { ClusterAcquisitionApi } from './ClusterAcquisitionApi.js';

describe('ClusterAcquisitionApi', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('loads import status through the first working node and makes it authoritative', async () => {
    const fetchMock = vi.fn(async (urlValue: string | URL | Request) => {
      const url = String(urlValue);
      if (url.startsWith('http://200')) throw new TypeError('node 200 unavailable');
      if (url.endsWith('/api/v1/ingest/status')) return new Response(JSON.stringify({
        enabled: true,
        staging: { path: '/stage', limit_bytes: 1, disk_bytes: 1, reserved_bytes: 0, accounted_bytes: 0 },
      }), { status: 200 });
      if (url.endsWith('/api/v1/torrents/status')) return new Response(JSON.stringify({ enabled: true, build_available: true, search_enabled: false }), { status: 200 });
      return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://200', 'http://50']));
    const api = new ClusterAcquisitionApi(new ClusterEndpointRouter(registry));

    await expect(api.snapshot()).resolves.toMatchObject({ ingestStatus: { enabled: true }, ingestJobs: [], torrentJobs: [] });
    expect(registry.candidates()[0]?.endpoint.id).toBe('http://50');
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('http://50'))).toBe(true);
  });
});

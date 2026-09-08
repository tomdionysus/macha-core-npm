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

describe('which management calls may move between nodes', () => {
  afterEach(() => vi.unstubAllGlobals());

  const clusterApi = () => {
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
    return new ClusterManageApi(new ClusterEndpointRouter(registry));
  };
  const urls = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map(([url]) => url as string);

  it('never retries a filesystem mutation on a second node', async () => {
    // A rename that failed ambiguously may already have happened. Repeating
    // it elsewhere is a second, different filesystem operation, and there is
    // no way to tell afterwards which one took effect.
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('node a unavailable'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(clusterApi().rename('/media/a', '/media/b')).rejects.toThrow();

    expect(urls(fetchMock)).toEqual(['http://a/api/v1/manage/filesystem/rename']);
  });

  it('never retries an identity reset, for the same reason', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('node a unavailable'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(clusterApi().resetNodeIdentityAssociation('node-1', '10.0.0.1', 7437, 'operator'))
      .rejects.toThrow();

    expect(urls(fetchMock)).toHaveLength(1);
  });

  it('carries the reset arguments through to the node it picked', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ reset: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await clusterApi().resetNodeIdentityAssociation('node-1', '10.0.0.1', 7437, 'operator');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // The node is named in the path; host and port are the RPC address the
    // reset is about, which is why they survive the api_endpoint change.
    expect(url).toBe('http://a/api/v1/manage/nodes/node-1/identity-association/reset');
    expect(JSON.parse(String(init.body))).toEqual({ host: '10.0.0.1', port: 7437, reason: 'operator' });
  });

  it('walks the cluster for a filesystem browse, which is a safe read', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('node a unavailable'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ path: '/', entries: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(clusterApi().browse('/')).resolves.toMatchObject({ path: '/' });

    expect(urls(fetchMock)).toHaveLength(2);
  });

  it('reuses one node API per endpoint rather than building one per call', async () => {
    // The per-endpoint instances hold connection-level state; rebuilding them
    // each call would discard it silently.
    // A fresh Response per call: a body can only be read once, so reusing one
    // would fail the second call for a reason unrelated to routing.
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ path: '/', entries: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = clusterApi();

    await api.browse('/');
    await api.browse('/media');

    expect(urls(fetchMock).every((url) => url.startsWith('http://a'))).toBe(true);
  });
});

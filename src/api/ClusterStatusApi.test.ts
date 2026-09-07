import { afterEach, describe, expect, it, vi } from 'vitest';
import { MachaClusterStatusApi } from './ClusterStatusApi.js';
import { fixedBearerToken } from './SessionManager.js';

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('MachaClusterStatusApi', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('loads cluster status through the status root with bearer authentication', async () => {
    const payload = { cluster: { health: 'recovering' }, startup: { phase: 'recovering', control_plane: 'ready', api: 'ready' }, nodes: [], generated_at_unix_ms: 1 };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload));
    vi.stubGlobal('fetch', fetchMock);
    const api = new MachaClusterStatusApi('http://node.test/', fixedBearerToken('secret'));

    await expect(api.status()).resolves.toEqual(payload);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://node.test/api/v1/status');
    expect(init.method).toBe('GET');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer secret');
  });

  it('checks one node through the diagnostic connectivity action', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [], checked_at_unix_ms: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new MachaClusterStatusApi('http://node.test');

    await api.checkConnectivity('node/one');

    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://node.test/api/v1/status/nodes/node%2Fone/connectivity/check',
    );
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('POST');
  });
});

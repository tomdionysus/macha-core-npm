import { afterEach, describe, expect, it, vi } from 'vitest';
import { MachaManageApi } from './MachaManageApi.js';
import { fixedBearerToken } from './SessionManager.js';

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

const unmatched = {
  id: 'hint:one',
  path: '/Movies/Unknown Movie.mkv',
  provider: 'movies',
  media_id: 'macha:abc',
  result: 'no match',
  attempts: 1,
  updated_unix_ms: 1,
  size: 123,
  mtime_ns: 456,
  current: true,
};

describe('MachaManageApi', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('loads only the server-provided actionable unmatched set with authentication', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ count: 1, items: [unmatched] }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new MachaManageApi('http://node.test/', fixedBearerToken('secret'));

    await expect(api.unmatched()).resolves.toEqual([unmatched]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://node.test/api/v1/manage/unmatched');
    expect(init.method).toBe('GET');
    expect(init.cache).toBe('no-store');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer secret');
  });

  it('searches prospective catalogue matches with an encoded query', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ query: 'Alien (1979)', matches: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new MachaManageApi('http://node.test');

    await api.prospectiveMatches('hint/one', 'Alien (1979)');

    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://node.test/api/v1/manage/unmatched/hint%2Fone/matches?q=Alien%20(1979)',
    );
  });

  it('renames through MachaDFS with no-replace semantics', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new MachaManageApi('http://node.test');

    await api.rename('/Incoming/foo.mkv', '/Movies/Foo.mkv');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://node.test/api/v1/manage/filesystem/rename');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      path: '/Incoming/foo.mkv',
      destination: '/Movies/Foo.mkv',
      no_replace: true,
    });
  });

  it('deletes an exact MachaDFS path through the management endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new MachaManageApi('http://node.test');

    await api.deletePath('/Movies/A B.mkv');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://node.test/api/v1/manage/filesystem?path=%2FMovies%2FA%20B.mkv');
    expect(init.method).toBe('DELETE');
  });

  it('always refreshes filesystem listings from the server', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ path: '/Movies', parent: '/', entries: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new MachaManageApi('http://node.test');

    await api.browse('/Movies');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.cache).toBe('no-store');
  });
  it('resets a stale identity association by IP without requiring a NodeId', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      reset: {
        scope: '[10.44.1.50]:*', host: '10.44.1.50', port: null, stale_node_id: null,
        epoch: 2, reset_at_unix_ms: 1234, reset_by_node_id: '00112233445566778899aabbccddeeff',
        reason: 'clear by ip',
      },
      metadata_generation: 42,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new MachaManageApi('http://node.test', fixedBearerToken('secret'));

    const result = await api.resetIdentityAssociation({ host: '10.44.1.50', reason: 'clear by ip' });

    expect(result.reset.scope).toBe('[10.44.1.50]:*');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://node.test/api/v1/manage/identity-associations/reset');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer secret');
    expect(JSON.parse(String(init.body))).toEqual({ host: '10.44.1.50', reason: 'clear by ip' });
  });

  it('supports the node-scoped identity reset convenience route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      reset: {
        scope: '[10.44.1.50]:57401', host: '10.44.1.50', port: 57401,
        stale_node_id: '00112233445566778899aabbccddeeff', epoch: 1,
        reset_at_unix_ms: 1234, reset_by_node_id: 'ffeeddccbbaa99887766554433221100', reason: null,
      },
      metadata_generation: 43,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new MachaManageApi('http://node.test');

    const result = await api.resetNodeIdentityAssociation(
      '00112233445566778899aabbccddeeff', '10.44.1.50', 57401,
    );

    expect(result.metadata_generation).toBe(43);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://node.test/api/v1/manage/nodes/00112233445566778899aabbccddeeff/identity-association/reset');
    expect(JSON.parse(String(init.body))).toEqual({ host: '10.44.1.50', port: 57401 });
  });

  it('accepts a queued asynchronous node reset without waiting for metadata audit', async () => {
    const queued = {
      reset: {
        scope: '[10.44.1.50]:57401', host: '10.44.1.50', port: 57401,
        stale_node_id: '00112233445566778899aabbccddeeff', epoch: 2,
        reset_at_unix_ms: 1234, reset_by_node_id: 'ffeeddccbbaa99887766554433221100', reason: null,
      },
      audit_state: 'queued',
      metadata_persisted: false,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(queued, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new MachaManageApi('http://node.test');

    await expect(api.resetNodeIdentityAssociation(
      '00112233445566778899aabbccddeeff', '10.44.1.50', 57401,
    )).resolves.toEqual(queued);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

});

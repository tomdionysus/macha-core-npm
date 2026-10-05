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

  it('says which array the unmatched envelope is missing rather than returning undefined', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ unmatched: [unmatched] }));
    vi.stubGlobal('fetch', fetchMock);

    const error = await new MachaManageApi('http://node.test').unmatched().catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 502, code: 'invalid_response' });
    expect((error as Error).message).toContain('items');
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

describe('the management operations an operator drives', () => {
  afterEach(() => vi.unstubAllGlobals());

  const api = () => new MachaManageApi('http://node.test', fixedBearerToken('secret'));
  const stub = (response: Response) => {
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };
  const sent = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls[0] as [string, RequestInit];

  it('escapes an id into the path so a filename cannot alter the route', async () => {
    // Unmatched ids carry provider prefixes and, in practice, paths. An
    // unescaped `/` would silently address a different endpoint.
    const fetchMock = stub(jsonResponse({ id: 'hint:a/b' }));
    await api().unmatchedDetail('hint:a/b');
    expect(sent(fetchMock)[0]).toBe('http://node.test/api/v1/manage/unmatched/hint%3Aa%2Fb');
  });

  it('omits the query entirely when no search text was given', async () => {
    // `?q=` is not the same request as no query, and the server need not read
    // them the same way.
    const fetchMock = stub(jsonResponse({ candidates: [] }));
    await api().prospectiveMatches('hint:one');
    expect(sent(fetchMock)[0]).toBe('http://node.test/api/v1/manage/unmatched/hint%3Aone/matches');
  });

  it('includes the search text when there is some', async () => {
    const fetchMock = stub(jsonResponse({ candidates: [] }));
    await api().prospectiveMatches('hint:one', 'blade runner');
    expect(sent(fetchMock)[0]).toContain('matches?q=blade%20runner');
  });

  it('retries a match as a POST with no body', async () => {
    const fetchMock = stub(new Response(null, { status: 204 }));
    await expect(api().retry('hint:one')).resolves.toBeUndefined();
    expect(sent(fetchMock)[1].method).toBe('POST');
  });

  it('sends the chosen catalogue item when matching by hand', async () => {
    const fetchMock = stub(new Response(null, { status: 204 }));
    await api().match('hint:one', 'macha:abc');
    expect(JSON.parse(String(sent(fetchMock)[1].body))).toEqual({ catalogue_item_id: 'macha:abc' });
  });

  it('sends manual metadata as the body and returns what the server made of it', async () => {
    const fetchMock = stub(jsonResponse({ catalogue_item_id: 'macha:new' }));
    const metadata = { kind: 'movie', title: 'Solaris', year: 1972 } as never;
    await expect(api().manual('hint:one', metadata)).resolves.toEqual({ catalogue_item_id: 'macha:new' });
    expect(JSON.parse(String(sent(fetchMock)[1].body))).toEqual({ kind: 'movie', title: 'Solaris', year: 1972 });
  });

  it('deletes an unmatched entry with DELETE, not a POST', async () => {
    const fetchMock = stub(new Response(null, { status: 204 }));
    await api().deleteUnmatched('hint:one');
    expect(sent(fetchMock)[1].method).toBe('DELETE');
  });

  it('browses the filesystem without caching, since it changes underneath', async () => {
    const fetchMock = stub(jsonResponse({ path: '/media', entries: [] }));
    await api().browse('/media');
    const [url, init] = sent(fetchMock);
    expect(url).toBe('http://node.test/api/v1/manage/filesystem?path=%2Fmedia');
    expect(init.cache).toBe('no-store');
  });

  it('creates a directory through its own endpoint', async () => {
    const mkdir = stub(new Response(null, { status: 204 }));
    await api().mkdir('/media/new');
    expect(sent(mkdir)[0]).toBe('http://node.test/api/v1/manage/filesystem/mkdir');
    expect(JSON.parse(String(sent(mkdir)[1].body))).toEqual({ path: '/media/new' });
  });

  it('renames without replacing, so a move cannot silently destroy a file', async () => {
    // `no_replace` is the whole safety of this operation: an operator moving
    // a file onto an existing name should be told, not have the other one
    // disappear. Asserted because it is invisible at the call site.
    const rename = stub(new Response(null, { status: 204 }));
    await api().rename('/media/a', '/media/b');
    expect(JSON.parse(String(sent(rename)[1].body))).toEqual({
      path: '/media/a', destination: '/media/b', no_replace: true,
    });
  });

  it('deletes a path by query rather than by body', async () => {
    const remove = stub(new Response(null, { status: 204 }));
    await api().deletePath('/media/gone.mkv');
    const [url, init] = sent(remove);
    expect(url).toBe('http://node.test/api/v1/manage/filesystem?path=%2Fmedia%2Fgone.mkv');
    expect(init.method).toBe('DELETE');
  });
});

describe('how a management failure is reported', () => {
  afterEach(() => vi.unstubAllGlobals());
  const api = () => new MachaManageApi('http://node.test', fixedBearerToken('secret'));

  it('carries the server\'s own message, status and code', async () => {
    // An operator acting on a node needs the node's reason, not a generic
    // failure: "path is outside the library root" is actionable and "500" is not.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
      { error: 'path_outside_root', message: 'path is outside the library root' },
      { status: 400, statusText: 'Bad Request' },
    )));

    await expect(api().mkdir('/etc')).rejects.toMatchObject({
      name: 'MachaManageApiError',
      status: 400,
      code: 'path_outside_root',
      message: expect.stringContaining('path is outside the library root'),
    });
  });

  it('reports an unreachable server rather than an API error for a bodyless 502', async () => {
    // A proxy answering instead of the node is a connection problem, and an
    // operator told "management request failed" would go looking at the node.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 502 })));
    await expect(api().unmatched()).rejects.toMatchObject({ name: 'MachaConnectionError' });
  });

  it('treats a 204 as success with nothing to decode', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(api().retry('hint:one')).resolves.toBeUndefined();
  });
});

function paramsOf(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  url.searchParams.forEach((value, key) => { out[key] = value; });
  return out;
}

describe('the metadata editor (server 0.67.0)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const calls = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls as Array<[string, RequestInit]>;

  it('matches an unmatched file to a provider record with the numbers that pick the episode', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: 'matched', leaf_item_id: 'tmdb:episode:1', items: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await new MachaManageApi('http://n').matchProvider('hint:one', { ref: 'tmdb:tv:1399', season_number: 1, episode_number: 4 });
    const [url, init] = calls(fetchMock)[0]!;
    expect(url).toBe('http://n/api/v1/manage/unmatched/hint%3Aone/match');
    expect(JSON.parse(String(init.body))).toEqual({ ref: 'tmdb:tv:1399', season_number: 1, episode_number: 4 });
    expect(result.leaf_item_id).toBe('tmdb:episode:1');
  });

  it('searches the provider by kind, with the optional narrowing', async () => {
    const result = { ref: 'musicbrainz:release:x', provider: 'musicbrainz', kind: 'album', title: 'Kid A', year: 2000, artist: 'Radiohead' };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: 'ok', results: [result] }));
    vi.stubGlobal('fetch', fetchMock);
    const results = await new MachaManageApi('http://n').providerSearch('kid a', 'album', { artist: 'Radiohead', limit: 5 });
    const url = new URL(calls(fetchMock)[0]![0]);
    expect(url.pathname).toBe('/api/v1/manage/providers/search');
    expect(paramsOf(url)).toEqual({ q: 'kid a', kind: 'album', artist: 'Radiohead', limit: '5' });
    expect(results).toEqual([result]);
  });

  it("lists a release's tracks from its reference, by the release's own path", async () => {
    const track = { disc_number: 1, track_number: 4, title: 'Kid A', length_ms: 284000, recording_id: 'rec' };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: 'ok', tracks: [track, { ...track, track_number: null, length_ms: null, recording_id: null }] }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new MachaManageApi('http://n');

    const tracks = await api.providerReleaseTracks('musicbrainz:release:b1392450-e666-3926-a536-22c65f834433');

    const url = new URL(calls(fetchMock)[0]![0]);
    expect(url.pathname).toBe('/api/v1/manage/providers/musicbrainz/releases/b1392450-e666-3926-a536-22c65f834433/tracks');
    expect(url.search).toBe('');
    expect(tracks).toHaveLength(2);
    expect(tracks[1]?.track_number).toBeNull();
  });

  it('refuses a reference that is not a MusicBrainz release, before any request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const api = new MachaManageApi('http://n');

    await expect(api.providerReleaseTracks('tmdb:movie:603')).rejects.toMatchObject({ status: 400, code: 'bad_ref' });
    await expect(api.providerReleaseTracks('musicbrainz:release:')).rejects.toMatchObject({ code: 'bad_ref' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists a role's artwork options and chooses one", async () => {
    const option = { option_id: 'o1', role: 'still', width: 1920, height: 1080, language: null, preview_url: 'https://image/w300.jpg' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'ok', options: [option] }))
      .mockResolvedValueOnce(jsonResponse({ status: 'chosen', item: { id: 'manual:ep' } }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new MachaManageApi('http://n');
    expect(await api.providerArtwork('tmdb:tv:1399', 'still', { season_number: 1, episode_number: 4 })).toEqual([option]);
    expect(paramsOf(new URL(calls(fetchMock)[0]![0]))).toEqual({ ref: 'tmdb:tv:1399', role: 'still', season_number: '1', episode_number: '4' });
    const item = await api.chooseArtwork('manual:ep', 'still', 'o1', { ref: 'tmdb:tv:1399', season_number: 1, episode_number: 4, lock: false });
    expect(JSON.parse(String(calls(fetchMock)[1]![1].body))).toEqual({ item_id: 'manual:ep', role: 'still', option_id: 'o1', ref: 'tmdb:tv:1399', season_number: 1, episode_number: 4, lock: false });
    expect(item).toEqual({ id: 'manual:ep' });
  });

  it('sends manual entry joining an existing season by id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ leaf_item_id: 'manual:ep', items: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await new MachaManageApi('http://n').manual('hint:one', { kind: 'episode', season_id: 'tmdb:season:1399:1', episode_number: 4, title: 'Pilot' });
    expect(JSON.parse(String(calls(fetchMock)[0]![1].body))).toEqual({ kind: 'episode', season_id: 'tmdb:season:1399:1', episode_number: 4, title: 'Pilot' });
  });
});

describe('a management write on a node that runs them one at a time', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('waits past the 8 s default for a delete the node is still doing', async () => {
    // A node commits management writes one after another at 2 to 3 s each,
    // so a delete late in a burst answers after the default budget.
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(null, { status: 204 })), 20_000);
      init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
    })));
    const deleted = new MachaManageApi('http://n').deleteUnmatched('u1');
    const settled = expect(deleted).resolves.toBeUndefined();

    await vi.advanceTimersByTimeAsync(20_000);
    await settled;
  });
});

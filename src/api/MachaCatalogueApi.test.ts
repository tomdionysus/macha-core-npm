import { MachaConnectionError } from './serverConnection.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MachaCatalogueApi } from './MachaCatalogueApi.js';
import { fixedBearerToken } from './SessionManager.js';
import { configureMachaHost } from '../runtime/host.js';
import { retryableEndpointFailure } from '../cluster/endpointFailure.js';

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

const item = {
  id: 'show:black-books',
  kind: 'show' as const,
  title: 'Black Books',
  sort_title: 'Black Books',
  synopsis: '',
  parent_id: null,
  year: 2000,
  season_number: null,
  episode_number: null,
  disc_number: null,
  track_number: null,
  aliases: [],
  external_ids: {},
  media_ids: [],
  artwork: [],
  revision: 1,
  updated_ns: 0,
};

describe('MachaCatalogueApi', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the Macha catalogue list endpoint and query names', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [item] }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new MachaCatalogueApi('http://node.test/');

    const result = await api.list('season', 'show:black-books');

    expect(result).toEqual([item]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://node.test/api/v1/catalogue/items?type=season&parent=show%3Ablack-books',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('names the server when a success body is not the envelope, and stays retryable', async () => {
    // `response.items.map` on a 200 without `items` threw `TypeError` at the
    // call site, and `retryableEndpointFailure` reads a bare `TypeError` as a
    // transport failure, so a schema mismatch cooled the node down as though
    // it had been unreachable, and the caller was told about `.map`.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [item] }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new MachaCatalogueApi('http://node.test/');

    const error = await api.list().catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 502, code: 'invalid_response' });
    expect((error as Error).message).toContain('items');
    // 502 rather than a bare throw: in a mixed-version endpoint set the next
    // node may answer a shape this build can read.
    expect(retryableEndpointFailure(error)).toBe(true);
  });

  it('reports a 200 that is not JSON as the server failing, not as a parse accident', async () => {
    // A captive portal or a proxy answering HTML used to surface as a raw
    // `SyntaxError`, which carries no status, so the router read it as
    // non-retryable and 'Unexpected token <' reached the viewer with no
    // failover attempted.
    const fetchMock = vi.fn().mockResolvedValue(new Response('<html>sign in</html>', {
      status: 200, headers: { 'Content-Type': 'text/html' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new MachaCatalogueApi('http://node.test/');

    const error = await api.list().catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 502, code: 'invalid_response' });
    expect(retryableEndpointFailure(error)).toBe(true);
  });

  it('absolutizes a relative signed artwork capability URL against the node origin', async () => {
    const withArtwork = {
      ...item,
      artwork: [
        { role: 'poster', id: 'sig-1', mime_type: 'image/jpeg', url: '/api/v1/catalogue/artwork/sig-1?exp=1&sig=abc' },
        { role: 'backdrop', id: 'sig-2', mime_type: 'image/jpeg' },
      ],
      effective_artwork: [
        { role: 'cover', id: 'sig-3', mime_type: 'image/jpeg', url: 'https://cdn.example/sig-3' },
      ],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ items: [withArtwork] })));
    const api = new MachaCatalogueApi('http://node.test');

    const [result] = await api.list();

    // A relative capability URL is meaningless resolved against the client
    // application's own origin; it must be resolved against this node's.
    expect(result.artwork[0].url).toBe('http://node.test/api/v1/catalogue/artwork/sig-1?exp=1&sig=abc');
    expect(result.artwork[1].url).toBeUndefined();
    // Already-absolute (e.g. a CDN) and missing URLs both pass through untouched.
    expect(result.effective_artwork?.[0].url).toBe('https://cdn.example/sig-3');
  });

  it('absolutizes artwork capability URLs from get() the same way as list()', async () => {
    const withArtwork = {
      ...item,
      artwork: [{ role: 'poster', id: 'sig-1', mime_type: 'image/jpeg', url: '/api/v1/catalogue/artwork/sig-1?sig=abc' }],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(withArtwork)));
    const api = new MachaCatalogueApi('http://node.test');

    const result = await api.get('show:black-books');

    expect(result.artwork[0].url).toBe('http://node.test/api/v1/catalogue/artwork/sig-1?sig=abc');
  });

  it('reads immutable media profiles and treats profile_not_available as temporary', async () => {
    const profile = { schema_version: 1, media_id: 'macha:abc', format: 'mp4', duration_ms: 60_000, bitrate: 1_000, streams: [] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(profile))
      .mockResolvedValueOnce(jsonResponse(
        { error: 'profile_not_available', message: 'media profile is not available yet' },
        { status: 404 },
      ));
    vi.stubGlobal('fetch', fetchMock);
    const api = new MachaCatalogueApi('http://node.test');

    await expect(api.mediaProfile('macha:abc')).resolves.toEqual(profile);
    await expect(api.mediaProfile('macha:pending')).resolves.toBeUndefined();
    await expect(api.mediaProfile('path:/mutable.mp4')).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://node.test/api/v1/catalogue/media/macha%3Aabc/profile',
      'http://node.test/api/v1/catalogue/media/macha%3Apending/profile',
    ]);
  });

  it('accepts successful not-available-yet profile responses as temporary absence', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'profile_pending', message: 'not available yet' }, { status: 202, headers: { 'Retry-After': '1' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new MachaCatalogueApi('http://node.test');

    await expect(api.mediaProfile('macha:pending-202')).resolves.toBeUndefined();
    await expect(api.mediaProfile('macha:pending-204')).resolves.toBeUndefined();
  });

  it("reads the node's own 202 while it prepares the profile as not ready yet", async () => {
    // The shape the server actually sends (catalogue_api.cpp, since 0.22):
    // `202 { status: "pending", media_id }`. Core read it as an invalid
    // profile, a 502, until 0.56.0's review found it.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
      { status: 'pending', media_id: 'macha:abc' }, { status: 202, headers: { 'Retry-After': '1' } },
    )));
    await expect(new MachaCatalogueApi('http://node.test').mediaProfile('macha:abc')).resolves.toBeUndefined();
  });

  it("parses a 0.56.0 profile carrying the new top-level status: 'ok'", async () => {
    const profile = { status: 'ok', schema_version: 2, media_id: 'macha:abc', format: 'mp4', duration_ms: 1, bitrate: 1, streams: [] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(profile)));
    await expect(new MachaCatalogueApi('http://node.test').mediaProfile('macha:abc')).resolves.toMatchObject({ media_id: 'macha:abc' });
  });

  it("reads a 0.56.0 list, whose envelope gains status: 'ok' before items", async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ status: 'ok', items: [item] })));
    await expect(new MachaCatalogueApi('http://node.test').list('show')).resolves.toHaveLength(1);
  });

  it('rejects a profile whose immutable identity does not match the request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      schema_version: 1, media_id: 'macha:other', format: 'mp4', duration_ms: 1, bitrate: 1, streams: [],
    })));
    const api = new MachaCatalogueApi('http://node.test');

    await expect(api.mediaProfile('macha:requested')).rejects.toMatchObject({ code: 'invalid_media_profile' });
  });

  it('uses the catalogue search envelope and configured bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [item] }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new MachaCatalogueApi('http://node.test', fixedBearerToken('secret'));

    await api.search('black books', 25);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://node.test/api/v1/catalogue/search?q=black%20books&limit=25');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer secret');
  });

  it('uploads manual artwork through the catalogue item artwork endpoint', async () => {
    const artwork = { role: 'poster', id: 'sha256:abcd', mime_type: 'image/jpeg' };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(artwork));
    vi.stubGlobal('fetch', fetchMock);
    const api = new MachaCatalogueApi('http://node.test', fixedBearerToken('secret'));
    const blob = new Blob(['image'], { type: 'image/jpeg' });

    await expect(api.putArtwork('movie:one', 'poster', 'image/jpeg', blob)).resolves.toEqual(artwork);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://node.test/api/v1/catalogue/items/movie%3Aone/artwork?role=poster&mime=image%2Fjpeg');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(blob);
    expect(new Headers(init.headers).get('Content-Type')).toBe('image/jpeg');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer secret');
  });

  it('fetches content-addressed artwork with authentication', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Blob(['image']), { status: 200, headers: { 'Content-Type': 'image/jpeg' } }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new MachaCatalogueApi('http://node.test', fixedBearerToken('secret'));
    await api.artwork('abcd');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://node.test/api/v1/catalogue/artwork/abcd');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer secret');
  });

  it('rejects empty and non-image artwork responses', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(new Blob([]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } }))
      .mockResolvedValueOnce(new Response(new Blob(['not an image'], { type: 'text/plain' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new MachaCatalogueApi('http://node.test');

    await expect(api.artwork('empty')).rejects.toThrow('empty artwork');
    await expect(api.artwork('text')).rejects.toThrow('non-image artwork');
  });

  it('passes artwork cancellation through to fetch', async () => {
    let capturedSignal: AbortSignal | undefined;
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => { resolveFetch = resolve; });
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = new MachaCatalogueApi('http://node.test');
    const controller = new AbortController();

    // The bounded-timeout wrapper composes the caller's signal into its own
    // AbortController rather than passing the same object through (no
    // `AbortSignal.any` on the legacy browsers this app also targets), so
    // cancelling the caller's controller must still abort whatever signal
    // fetch actually received, even though it is no longer the same object.
    const request = api.artwork('abcd', controller.signal);
    expect(capturedSignal?.aborted).toBe(false);
    controller.abort();
    expect(capturedSignal?.aborted).toBe(true);

    resolveFetch(new Response(new Blob(['image']), { status: 200 }));
    await request;
  });

  it('clears catalogue metadata with optimistic revision protection', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new MachaCatalogueApi('http://node.test', fixedBearerToken('secret'));

    await api.clearMetadata('show:black-books', 7);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://node.test/api/v1/catalogue/items/show%3Ablack-books/metadata');
    expect(init.method).toBe('DELETE');
    expect(new Headers(init.headers).get('If-Match')).toBe('"rev-7"');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer secret');
  });

  it('surfaces Macha JSON errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
      { error: 'catalogue_unavailable', message: 'catalogue root object unavailable' },
      { status: 503 },
    )));
    const api = new MachaCatalogueApi('');

    await expect(api.status()).rejects.toThrow('catalogue root object unavailable');
  });
  it('reports a network failure as an unreachable Macha server', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const api = new MachaCatalogueApi('http://node.test');

    await expect(api.status()).rejects.toBeInstanceOf(MachaConnectionError);
  });

  it('treats a proxy-generated non-JSON 500 as an unreachable Macha server', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('connect ECONNREFUSED', { status: 500 })));
    const api = new MachaCatalogueApi('');

    await expect(api.status()).rejects.toBeInstanceOf(MachaConnectionError);
  });

  it('keeps a JSON 500 from Macha as a catalogue error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
      { error: 'catalogue_failed', message: 'catalogue exploded' },
      { status: 500 },
    )));
    const api = new MachaCatalogueApi('');

    await expect(api.status()).rejects.toThrow('Macha catalogue request failed: catalogue exploded');
  });

});

describe('artwork URL absolutization', () => {
  const withArtwork = { ...item, artwork: [{ role: 'poster', id: 'a1', mime_type: 'image/jpeg', url: '/artwork/a1' }] };

  it('refuses a relative artwork URL when no node base and no host origin can absolutize it', async () => {
    // Silently returning the relative path lets it resolve against whatever
    // the presentation layer's own origin happens to be (on React Native,
    // nothing at all) and fails later with no evidence of why.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [withArtwork] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new MachaCatalogueApi('').list()).rejects.toThrow(/Cannot absolutize the artwork URL/);
  });

  it('absolutizes against the host origin for a same-origin deployment', async () => {
    configureMachaHost({ origin: 'http://node-a:7438' });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [withArtwork] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new MachaCatalogueApi('').list();

    expect(result[0]?.artwork[0]?.url).toBe('http://node-a:7438/artwork/a1');
  });

  it('prefers the configured node base over any host origin', async () => {
    configureMachaHost({ origin: 'http://the-app-itself' });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [withArtwork] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new MachaCatalogueApi('http://node-b:7438').list();

    expect(result[0]?.artwork[0]?.url).toBe('http://node-b:7438/artwork/a1');
  });
});

describe('immutable media profile schema versions', () => {
  const profile = (schemaVersion: number) => ({
    schema_version: schemaVersion,
    media_id: 'macha:abc',
    format: 'matroska,webm',
    duration_ms: 1_000,
    bitrate: 1_000,
    streams: [{
      index: 0, type: 'video', codec: 'hevc', profile: 'Main 10', language: '',
      width: 1920, height: 802, channels: 0, sample_rate: 0, bit_depth: 0,
      default: true, forced: false, bitrate: 0, attached_picture: false,
      level: 153, color_transfer: 'smpte2084',
    }],
  });

  it('accepts a newer additive profile schema instead of rejecting the server', async () => {
    // Pinning schema_version to 1 meant a server upgrade silently disabled
    // opportunistic player preparation on every client, with a 502 nobody saw.
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(profile(2)), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new MachaCatalogueApi('http://node.test').mediaProfile('macha:abc');

    expect(result?.streams[0]).toEqual(expect.objectContaining({
      color_transfer: 'smpte2084',
      level: 153,
    }));
  });

  it('still rejects a profile with no usable schema at all', async () => {
    const bad = { ...profile(2), schema_version: 'two' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(bad), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));

    await expect(new MachaCatalogueApi('http://node.test').mediaProfile('macha:abc'))
      .rejects.toMatchObject({ code: 'invalid_media_profile' });
  });
});

describe('catalogue edits and filtered search (server 0.67.0)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('patches only the fields given, with the revision', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'tmdb:movie:1', kind: 'movie', title: 'New', revision: 4, artwork: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await new MachaCatalogueApi('http://n').patch('tmdb:movie:1', { title: 'New', synopsis: null, lock: false }, 3);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://n/api/v1/catalogue/items/tmdb%3Amovie%3A1');
    expect(init.method).toBe('PATCH');
    expect(new Headers(init.headers).get('If-Match')).toBe('"rev-3"');
    expect(JSON.parse(String(init.body))).toEqual({ title: 'New', synopsis: null, lock: false });
  });

  it('searches by kinds and parent on the server', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await new MachaCatalogueApi('http://n').search('plan', 20, undefined, { kinds: ['movie', 'show'], parent: 'tmdb:show:9' });
    const url = new URL((fetchMock.mock.calls[0] as [string])[0]);
    expect(url.searchParams.getAll('kind')).toEqual(['movie', 'show']);
    expect(url.searchParams.get('parent')).toBe('tmdb:show:9');
    expect(url.searchParams.get('q')).toBe('plan');
  });
});

describe('books (server 0.92.0)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lists and searches by a book\'s author or series', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({ items: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new MachaCatalogueApi('http://node.test');

    await api.list('book', undefined, undefined, { author: 'author:terry-pratchett' });
    await api.search('mort', 10, undefined, { kinds: ['book'], series: 'series:discworld' });

    expect(fetchMock.mock.calls[0][0]).toBe('http://node.test/api/v1/catalogue/items?type=book&author=author%3Aterry-pratchett');
    const search = new URL(fetchMock.mock.calls[1][0] as string);
    expect(search.searchParams.getAll('kind')).toEqual(['book']);
    expect(search.searchParams.get('series')).toBe('series:discworld');
    expect(search.searchParams.has('author')).toBe(false);
  });

  it('reads one range of a file, with what the server said of its size', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('PK', {
      status: 206,
      headers: { 'Content-Type': 'application/epub+zip', 'Content-Range': 'bytes 0-1/5000', 'Content-Length': '2' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new MachaCatalogueApi('http://node.test');

    const content = await api.content('macha:book', { range: { start: 0, end: 1 } });

    expect(fetchMock.mock.calls[0][0]).toBe('http://node.test/api/v1/catalogue/media/macha%3Abook/content');
    expect(new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers).get('Range')).toBe('bytes=0-1');
    expect(content).toMatchObject({ mediaId: 'macha:book', contentType: 'application/epub+zip', totalBytes: 5000, range: { start: 0, end: 1 } });
    expect(await content.body.text()).toBe('PK');
  });

  it('reads a whole file without a Range, and sizes it from the response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('%PDF-1.7', { status: 200, headers: { 'Content-Type': 'application/pdf' } }));
    vi.stubGlobal('fetch', fetchMock);

    const content = await new MachaCatalogueApi('http://node.test').content('macha:pdf');

    expect(new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers).has('Range')).toBe(false);
    expect(content.range).toBeUndefined();
    expect(content.totalBytes).toBe(8);
  });

  it('keeps the server\'s code on a refusal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: { code: 'bad_range', message: 'no' } }, { status: 416 })));
    await expect(new MachaCatalogueApi('http://node.test').content('macha:x', { range: { start: 9_000 } }))
      .rejects.toMatchObject({ status: 416, code: 'bad_range' });
  });

  it('names the content URL, as an attachment when asked, needing the token', () => {
    expect(new MachaCatalogueApi('http://node.test').contentUrls('macha:book', { download: true })).toEqual([
      { url: 'http://node.test/api/v1/catalogue/media/macha%3Abook/content?download=1', requiresAuthorization: true },
    ]);
  });
});

describe('book conversion (server 0.92.1)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const wire = (status: string, extra: Record<string, unknown> = {}) => ({
    status, media_id: 'macha:book', format: 'epub', size: null, mime_type: null, error_code: null, ...extra,
  });

  it('starts one with a PUT, and reads the wait the server asks for', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(wire('converting'), { status: 202, headers: { 'Content-Type': 'application/json', 'Retry-After': '2' } }));
    vi.stubGlobal('fetch', fetchMock);

    const conversion = await new MachaCatalogueApi('http://node.test').convert('macha:book', 'epub');

    expect(fetchMock.mock.calls[0][0]).toBe('http://node.test/api/v1/catalogue/media/macha%3Abook/conversions/epub');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('PUT');
    expect(conversion).toEqual({
      mediaId: 'macha:book', format: 'epub', status: 'converting', size: null, mimeType: null, errorCode: null, retryAfterMs: 2000,
    });
  });

  it('answers a conversion that failed at once as a failed conversion, not an error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(wire('failed', { error_code: 'unsupported_source' }), { status: 422 })));
    await expect(new MachaCatalogueApi('http://node.test').convert('macha:pdf', 'epub'))
      .resolves.toMatchObject({ status: 'failed', errorCode: 'unsupported_source' });
  });

  it('throws any other 422 with its code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: { code: 'not_a_book', message: 'no' } }, { status: 422 })));
    await expect(new MachaCatalogueApi('http://node.test').convert('macha:film', 'epub'))
      .rejects.toMatchObject({ status: 422, code: 'not_a_book' });
  });

  it('reads a ready one\'s size and type', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(wire('ready', { size: 4096, mime_type: 'application/epub+zip' }))));
    const conversion = await new MachaCatalogueApi('http://node.test').conversion({ mediaId: 'macha:book', format: 'epub' });
    expect(conversion).toMatchObject({ status: 'ready', size: 4096, mimeType: 'application/epub+zip' });
    expect(conversion.retryAfterMs).toBeUndefined();
  });

  it('reads the converted file from its own route, and keeps not_ready', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'not_ready', message: 'running' } }, { status: 409 }))
      .mockResolvedValueOnce(new Response('PK', { status: 200, headers: { 'Content-Type': 'application/epub+zip' } }));
    vi.stubGlobal('fetch', fetchMock);
    const api = new MachaCatalogueApi('http://node.test');
    const ref = { mediaId: 'macha:book', format: 'epub' as const };

    await expect(api.conversionContent(ref)).rejects.toMatchObject({ status: 409, code: 'not_ready' });
    const content = await api.conversionContent(ref);

    expect(fetchMock.mock.calls[1][0]).toBe('http://node.test/api/v1/catalogue/media/macha%3Abook/conversions/epub/content');
    expect(await content.body.text()).toBe('PK');
    expect(api.conversionContentUrls(ref, { download: true })).toEqual([
      { url: 'http://node.test/api/v1/catalogue/media/macha%3Abook/conversions/epub/content?download=1', requiresAuthorization: true },
    ]);
  });

  it('drops one, and says false when there was none', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'not_found', message: 'none' } }, { status: 404 })));
    const api = new MachaCatalogueApi('http://node.test');
    const ref = { mediaId: 'macha:book', format: 'epub' as const };
    expect(await api.dropConversion(ref)).toBe(true);
    expect(await api.dropConversion(ref)).toBe(false);
  });
});

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
    // transport failure — so a schema mismatch cooled the node down as though
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
    // `AbortSignal.any` on the legacy browsers this app also targets) — so
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
    // the presentation layer's own origin happens to be — on React Native,
    // nothing at all — and fails later with no evidence of why.
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

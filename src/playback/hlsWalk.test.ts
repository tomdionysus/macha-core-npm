import { describe, expect, it } from 'vitest';
import type { PlaybackSource } from '../types.js';
import {
  HLS_WALK_TIMEOUT_MS,
  firstVariantUri,
  hlsWalkTargets,
  mediaPlaylistTargets,
  preflightHlsSource,
  probeHlsReadiness,
  resolveUrl,
} from './hlsWalk.js';
import { SERVER_SEGMENT_HOLD_MS } from './streamProtocol.js';

function source(overrides: Partial<PlaybackSource> = {}): PlaybackSource {
  return {
    mediaId: 'm1',
    url: 'https://node-a.example/stream/abc/index.m3u8',
    isManifest: true,
    mode: 'transcode',
    ...overrides,
  };
}

interface StubResponse {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  /** Simulate a host whose `body` exists but has no `getReader`. */
  bodyWithoutReader?: boolean;
}

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
}

function stubFetch(routes: Record<string, StubResponse | undefined>, calls: RecordedCall[] = []) {
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, headers: { ...(init?.headers as Record<string, string> ?? {}) } });
    const route = routes[url];
    if (!route) throw new Error(`no route for ${url}`);
    const status = route.status ?? 200;
    const body = route.body ?? '';
    const response = {
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      url,
      headers: { get: (name: string) => route.headers?.[name.toLowerCase()] ?? null },
      text: async () => body,
      blob: async () => ({ size: body.length, type: '' }),
      json: async () => JSON.parse(body) as unknown,
    };
    if (route.bodyWithoutReader) {
      // React Native can hand back a body object with no getReader. A guard
      // written as `if (!response.body)` sails past this and then throws.
      (response as unknown as { body: unknown }).body = {};
    }
    return response as unknown as Response;
  };
  return { fetch, calls };
}

const MASTER = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=4000000', 'v0/index.m3u8'].join('\n');
const MEDIA = ['#EXTM3U', '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:6.0,', 'seg1.m4s'].join('\n');

describe('resolving a relative URI against a manifest', () => {
  it('resolves a sibling segment, which React Native\'s own URL cannot', () => {
    // RN's URL strips one trailing slash from the base and concatenates, so
    // this becomes `.../abc/index.m3u8seg1.m4s` — a URL that 404s and is then
    // reported as the source being unservable.
    expect(resolveUrl('https://node-a.example/stream/abc/index.m3u8', 'seg1.m4s'))
      .toBe('https://node-a.example/stream/abc/seg1.m4s');
  });

  it('walks out of a directory with ..', () => {
    // `..` applies to the manifest's own directory, so this leaves `v0/` and
    // lands beside it — matching a spec-conformant URL resolver exactly.
    expect(resolveUrl('https://node-a.example/stream/abc/v0/index.m3u8', '../shared/init.mp4'))
      .toBe('https://node-a.example/stream/abc/shared/init.mp4');
  });

  it('collapses . segments', () => {
    expect(resolveUrl('https://node-a.example/stream/abc/index.m3u8', './v0/seg1.m4s'))
      .toBe('https://node-a.example/stream/abc/v0/seg1.m4s');
  });

  it('takes an absolute path from the root', () => {
    expect(resolveUrl('https://node-a.example/stream/abc/index.m3u8', '/other/seg1.m4s'))
      .toBe('https://node-a.example/other/seg1.m4s');
  });

  it('leaves an absolute reference alone', () => {
    expect(resolveUrl('https://node-a.example/stream/abc/index.m3u8', 'https://cdn.example/s.m4s'))
      .toBe('https://cdn.example/s.m4s');
  });

  it('keeps the signed query of the reference and does not inherit the base\'s', () => {
    // A capability signature belongs to the URL it was minted for. Carrying the
    // manifest's query onto a segment would send a signature for a different
    // resource.
    expect(resolveUrl('https://node-a.example/stream/abc/index.m3u8?sig=aaa', 'seg1.m4s?sig=bbb'))
      .toBe('https://node-a.example/stream/abc/seg1.m4s?sig=bbb');
    expect(resolveUrl('https://node-a.example/stream/abc/index.m3u8?sig=aaa', 'seg1.m4s'))
      .toBe('https://node-a.example/stream/abc/seg1.m4s');
  });
});

describe('reading a manifest', () => {
  it('finds the first variant of a master playlist', () => {
    expect(firstVariantUri(MASTER)).toBe('v0/index.m3u8');
  });

  it('reports no variant for a media playlist, rather than guessing', () => {
    expect(firstVariantUri(MEDIA)).toBeUndefined();
  });

  it('takes the init segment and the first media segment', () => {
    expect(mediaPlaylistTargets(MEDIA)).toEqual(['init.mp4', 'seg1.m4s']);
  });

  it('tolerates a media playlist with no EXT-X-MAP', () => {
    expect(mediaPlaylistTargets(['#EXTM3U', '#EXTINF:6.0,', 'seg1.m4s'].join('\n'))).toEqual(['seg1.m4s']);
  });

  it('descends exactly one variant deep and dedupes the targets', async () => {
    const { fetch } = stubFetch({
      'https://node-a.example/stream/abc/index.m3u8': { body: MASTER },
      'https://node-a.example/stream/abc/v0/index.m3u8': { body: MEDIA },
    });
    expect(await hlsWalkTargets(source(), { fetch })).toEqual([
      'https://node-a.example/stream/abc/v0/init.mp4',
      'https://node-a.example/stream/abc/v0/seg1.m4s',
    ]);
  });
});

describe('the walk deadline', () => {
  it('outlasts the server hold, so a held request is not recorded as a timeout', () => {
    // Both client implementations this replaces used 5 s, below the 6 s hold.
    // A node producing its first fragment could not pass: the walk aborted
    // before the node answered, and a standby about to become servable was
    // destroyed. Two numbers chosen independently, each defensible alone.
    expect(HLS_WALK_TIMEOUT_MS).toBeGreaterThan(SERVER_SEGMENT_HOLD_MS);
  });
});

describe('preflight: will this node serve the source', () => {
  it('does not condemn a source it cannot assess', async () => {
    // The line the two client copies disagreed on. `false` makes the
    // coordinator destroy the standby, and a non-manifest source is one this
    // walk cannot assess rather than one it has judged. The copy that returned
    // false threw away standbys it could have promoted.
    const { fetch, calls } = stubFetch({});
    expect(await preflightHlsSource(source({ isManifest: false }), { fetch })).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('passes a source whose targets return bytes', async () => {
    const { fetch } = stubFetch({
      'https://node-a.example/stream/abc/index.m3u8': { body: MASTER },
      'https://node-a.example/stream/abc/v0/index.m3u8': { body: MEDIA },
      'https://node-a.example/stream/abc/v0/init.mp4': { status: 206, body: 'aaaa' },
      'https://node-a.example/stream/abc/v0/seg1.m4s': { status: 206, body: 'bbbb' },
    });
    expect(await preflightHlsSource(source(), { fetch })).toBe(true);
  });

  it('treats a hold as not-yet rather than no', async () => {
    // A 500 means the node has not produced this fragment and is working
    // correctly. Failing preflight on it destroys a healthy standby.
    const { fetch } = stubFetch({
      'https://node-a.example/stream/abc/index.m3u8': { body: MASTER },
      'https://node-a.example/stream/abc/v0/index.m3u8': { body: MEDIA },
      'https://node-a.example/stream/abc/v0/init.mp4': { status: 500 },
      'https://node-a.example/stream/abc/v0/seg1.m4s': { status: 500 },
    });
    expect(await preflightHlsSource(source(), { fetch })).toBe(true);
  });

  it('fails a broken generation', async () => {
    const { fetch } = stubFetch({
      'https://node-a.example/stream/abc/index.m3u8': { body: MASTER },
      'https://node-a.example/stream/abc/v0/index.m3u8': { body: MEDIA },
      'https://node-a.example/stream/abc/v0/init.mp4': { status: 503 },
    });
    expect(await preflightHlsSource(source(), { fetch })).toBe(false);
  });

  it('fails a 200 that carries no bytes', async () => {
    // A proxy can answer 200 with an empty body, and a node mid-restart can
    // answer a range request with nothing. The status alone does not answer
    // the question this walk exists to ask.
    const { fetch } = stubFetch({
      'https://node-a.example/stream/abc/index.m3u8': { body: MASTER },
      'https://node-a.example/stream/abc/v0/index.m3u8': { body: MEDIA },
      'https://node-a.example/stream/abc/v0/init.mp4': { status: 200, body: '' },
    });
    expect(await preflightHlsSource(source(), { fetch })).toBe(false);
  });

  it('reads bytes from a body that exists but has no getReader', async () => {
    // The React Native shape. A guard written as `if (!response.body)` passes
    // this through and then throws on getReader().
    const { fetch } = stubFetch({
      'https://node-a.example/stream/abc/index.m3u8': { body: MASTER },
      'https://node-a.example/stream/abc/v0/index.m3u8': { body: MEDIA },
      'https://node-a.example/stream/abc/v0/init.mp4': { status: 206, body: 'aaaa', bodyWithoutReader: true },
      'https://node-a.example/stream/abc/v0/seg1.m4s': { status: 206, body: 'bbbb', bodyWithoutReader: true },
    });
    expect(await preflightHlsSource(source(), { fetch })).toBe(true);
  });

  it('fails a source whose manifest cannot be read', async () => {
    const { fetch } = stubFetch({ 'https://node-a.example/stream/abc/index.m3u8': { status: 404 } });
    expect(await preflightHlsSource(source(), { fetch })).toBe(false);
  });
});

describe('the headers a walk sends', () => {
  it('suppresses caching with headers, never by altering the signed URL', async () => {
    // `cache: 'no-store'` is unusable: React Native implements it by appending
    // `_=<epoch>` to the query, which alters what a capability signature
    // covered, and Tizen 3 drops the option with no header at all.
    const { fetch, calls } = stubFetch({
      'https://node-a.example/stream/abc/index.m3u8': { body: MEDIA },
      'https://node-a.example/stream/abc/init.mp4': { status: 206, body: 'a' },
      'https://node-a.example/stream/abc/seg1.m4s': { status: 206, body: 'b' },
    });
    await preflightHlsSource(source(), { fetch });
    for (const call of calls) {
      expect(call.headers['Cache-Control']).toBe('no-cache, no-store');
      expect(call.headers.Pragma).toBe('no-cache');
      expect(call.url).not.toContain('_=');
    }
  });

  it('forwards the source headers a host must attach', async () => {
    const { fetch, calls } = stubFetch({
      'https://node-a.example/stream/abc/index.m3u8': { body: MEDIA },
      'https://node-a.example/stream/abc/init.mp4': { status: 206, body: 'a' },
      'https://node-a.example/stream/abc/seg1.m4s': { status: 206, body: 'b' },
    });
    await preflightHlsSource(source({ headers: { Authorization: 'Bearer t' } }), { fetch });
    expect(calls.every((call) => call.headers.Authorization === 'Bearer t')).toBe(true);
  });

  it('does not let a source header override Range', async () => {
    // A source header that replaced Range would silently turn a bounded probe
    // into a full segment fetch — on a television, a real transfer that nobody
    // would attribute to a health check.
    const { fetch, calls } = stubFetch({
      'https://node-a.example/stream/abc/index.m3u8': { body: MEDIA },
      'https://node-a.example/stream/abc/init.mp4': { status: 206, body: 'a' },
      'https://node-a.example/stream/abc/seg1.m4s': { status: 206, body: 'b' },
    });
    await preflightHlsSource(source({ headers: { Range: 'bytes=0-' } }), { fetch });
    expect(calls.every((call) => call.headers.Range === 'bytes=0-65535')).toBe(true);
  });
});

describe('readiness: has the first fragment arrived', () => {
  it('reports a hold as a hold, with the node\'s own Retry-After', async () => {
    // A client that lost this distinction began failing over spuriously under
    // load, because every hold read as a node fault. The retry goes back to the
    // same node: the next one is producing a different generation.
    const { fetch } = stubFetch({
      'https://node-a.example/stream/abc/index.m3u8': { body: MEDIA },
      'https://node-a.example/stream/abc/init.mp4': { status: 500, headers: { 'retry-after': '2' } },
    });
    expect(await probeHlsReadiness(source(), { fetch })).toEqual({ state: 'holding', retryAfterMs: 2_000 });
  });

  it('falls back to the server hold when no Retry-After is sent', async () => {
    const { fetch } = stubFetch({
      'https://node-a.example/stream/abc/index.m3u8': { body: MEDIA },
      'https://node-a.example/stream/abc/init.mp4': { status: 500 },
    });
    expect(await probeHlsReadiness(source(), { fetch }))
      .toEqual({ state: 'holding', retryAfterMs: SERVER_SEGMENT_HOLD_MS });
  });

  it('reports ready without reading any payload', async () => {
    const { fetch, calls } = stubFetch({
      'https://node-a.example/stream/abc/index.m3u8': { body: MEDIA },
      'https://node-a.example/stream/abc/init.mp4': { status: 206 },
      'https://node-a.example/stream/abc/seg1.m4s': { status: 206 },
    });
    expect(await probeHlsReadiness(source(), { fetch })).toEqual({ state: 'ready' });
    const targetCalls = calls.filter((call) => !call.url.endsWith('.m3u8'));
    expect(targetCalls.every((call) => call.headers.Range === 'bytes=0-0')).toBe(true);
  });

  it('separates a broken generation from a hold', async () => {
    const { fetch } = stubFetch({
      'https://node-a.example/stream/abc/index.m3u8': { body: MEDIA },
      'https://node-a.example/stream/abc/init.mp4': { status: 503 },
    });
    expect(await probeHlsReadiness(source(), { fetch })).toEqual({ state: 'unavailable', status: 503 });
  });

  it('says it cannot assess a non-manifest source rather than calling it unavailable', async () => {
    const { fetch } = stubFetch({});
    expect(await probeHlsReadiness(source({ isManifest: false }), { fetch }))
      .toEqual({ state: 'unassessable', reason: 'not-a-manifest' });
  });
});

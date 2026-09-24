import { MachaConnectionError } from './serverConnection.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MachaServerApi } from './MachaServerApi.js';
import { fixedBearerToken } from './SessionManager.js';

describe('MachaServerApi', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('queries playback status with bearer authentication and reads server_version from the playback status response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      enabled: true,
      ready: true,
      server_version: '0.8.4',
      version: 'legacy',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const api = new MachaServerApi('http://node.test/', fixedBearerToken('secret'));
    const status = await api.status();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://node.test/api/v1/playback/status');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer secret');
    expect(status.version).toBe('0.8.4');
    expect(status.playback).toEqual(expect.objectContaining({ enabled: true, ready: true }));
    expect(status.playbackAvailable).toBe(true);
  });

  it('takes the version from the body and ignores response headers entirely', async () => {
    // There was a header fallback here — `x-macha-version`, `x-server-version`,
    // then parsing `Server` — and a test asserting the last of them. The server
    // sends none of the three and never has, verified against its source and a
    // live node. The old test passed against a header nobody emits, which
    // proved the code worked rather than that the behaviour was wanted.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ enabled: true, server_version: '0.36.9' }), {
      status: 200,
      headers: { Server: 'Macha/0.8.3', 'x-macha-version': '0.8.3' },
    })));

    await expect(new MachaServerApi('').status()).resolves.toEqual(expect.objectContaining({ version: '0.36.9' }));
  });

  it('reports no version rather than inventing one when the body omits it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ enabled: true }), {
      status: 200,
      headers: { Server: 'Macha/0.8.3' },
    })));

    await expect(new MachaServerApi('').status()).resolves.toEqual(expect.objectContaining({ version: null }));
  });

  it('treats an HTTP playback error as a reachable server with unavailable playback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'playback_unavailable',
      message: 'playback is disabled',
    }), { status: 503 })));

    await expect(new MachaServerApi('').status()).resolves.toEqual(expect.objectContaining({
      playbackAvailable: false,
      httpStatus: 503,
      code: 'playback_unavailable',
      detail: 'playback is disabled',
    }));
  });

  it("reads 0.56.0's status code on success, and writes no text of core's own", async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'ok', enabled: true }), { status: 200 })));
    await expect(new MachaServerApi('').status()).resolves.toEqual(expect.objectContaining({ code: 'ok', detail: null }));

    // A bare 503 with no body words: core used to put "503 Service Unavailable"
    // here for a host to show. It now says nothing and a host words the status.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 503, statusText: 'Service Unavailable' })));
    await expect(new MachaServerApi('').status()).resolves.toEqual(expect.objectContaining({ httpStatus: 503, code: null, detail: null }));
  });

  it('reads the 0.56.0 error envelope: top-level status, error.code and error.message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'playback_unavailable', error: { code: 'playback_unavailable', message: 'playback is disabled' },
    }), { status: 503 })));
    await expect(new MachaServerApi('').status()).resolves.toEqual(expect.objectContaining({ code: 'playback_unavailable', detail: 'playback is disabled' }));
  });

  it('leaves the version unknown when the server does not report one', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ enabled: true }), { status: 200 })));
    await expect(new MachaServerApi('').status()).resolves.toEqual(expect.objectContaining({ version: null }));
  });
  it('reports a network failure as an unreachable Macha server', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(new MachaServerApi('').status()).rejects.toBeInstanceOf(MachaConnectionError);
  });

  it('treats a proxy-generated non-JSON 500 as an unreachable Macha server', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('connect ECONNREFUSED', { status: 500 })));
    await expect(new MachaServerApi('').status()).rejects.toBeInstanceOf(MachaConnectionError);
  });

});

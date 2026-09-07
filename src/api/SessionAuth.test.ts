import { afterEach, describe, expect, it, vi } from 'vitest';
import { mintAnonymousSession, mintAnonymousSessionAnyNode, SessionAuthError } from './SessionAuth.js';
import { bootstrapEndpoints, EndpointRegistry } from '../cluster/EndpointRegistry.js';

function sessionResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    roles: ['anonymous'],
    token: 'token-secret',
    token_type: 'Bearer',
    created_unix_ms: 1_000,
    expires_unix_ms: 2_000,
    ...overrides,
  };
}

describe('mintAnonymousSession', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs an empty body with no Authorization header and returns the token and expiry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(sessionResponse()), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const session = await mintAnonymousSession('http://node.test/');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://node.test/api/v1/session');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
    expect(session).toEqual({ token: 'token-secret', expiresAtMs: 2_000 });
  });

  it('rejects with a SessionAuthError carrying the status on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ message: 'unsupported_credentials' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )));

    await expect(mintAnonymousSession('http://node.test')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('rejects with a SessionAuthError when the response is missing a token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ roles: ['anonymous'] }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    )));

    await expect(mintAnonymousSession('http://node.test')).rejects.toBeInstanceOf(SessionAuthError);
  });

  it('reports a network failure as an unreachable Macha server', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(mintAnonymousSession('http://node.test')).rejects.toThrow('The Macha server cannot be reached.');
  });
});

describe('mintAnonymousSessionAnyNode', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('mints against whichever endpoint answers first and records the outcome', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('node a unreachable'))
      .mockResolvedValueOnce(new Response(JSON.stringify(sessionResponse()), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));

    const session = await mintAnonymousSessionAnyNode(registry);

    expect(session.token).toBe('token-secret');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(registry.snapshot().find((entry) => entry.endpoint.id === 'http://a')?.health.consecutiveFailures).toBeGreaterThan(0);
  });

  it('throws once every known endpoint has failed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('unreachable')));
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));

    await expect(mintAnonymousSessionAnyNode(registry)).rejects.toThrow();
  });
});

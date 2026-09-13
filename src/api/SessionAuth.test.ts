import { afterEach, describe, expect, it, vi } from 'vitest';
import { mintSession, mintSessionAnyNode, SessionAuthError, validateSessionAnyNode } from './SessionAuth.js';
import { bootstrapEndpoints, EndpointRegistry } from '../cluster/EndpointRegistry.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from './httpCompat.js';
import { MachaConnectionError } from './serverConnection.js';

/**
 * A node that accepted the connection and then said nothing — the half-open
 * socket a machine that died without an RST leaves behind. It answers the
 * abort and nothing else, which is what a real fetch() does.
 */
function blackHoled() {
  return (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
}

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

describe('mintSession', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs an empty body with no Authorization header and returns the token and expiry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(sessionResponse()), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const session = await mintSession('http://node.test/');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://node.test/api/v1/session');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
    // The mint response states the roles, so the token never arrives without
    // them and nothing has to go back and ask.
    expect(session).toEqual({ token: 'token-secret', expiresAtMs: 2_000, roles: ['anonymous'] });
  });

  it('rejects with a SessionAuthError carrying the status on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ message: 'unsupported_credentials' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )));

    await expect(mintSession('http://node.test')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('rejects with a SessionAuthError when the response is missing a token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ roles: ['anonymous'] }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    )));

    await expect(mintSession('http://node.test')).rejects.toBeInstanceOf(SessionAuthError);
  });

  it('reports a network failure as an unreachable Macha server', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(mintSession('http://node.test')).rejects.toThrow('The Macha server cannot be reached.');
  });
});

describe('validating a session the cluster no longer accepts', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('treats a 403 as the token being refused everywhere, not as a broken node', async () => {
    // A rolling upgrade leaves sessions minted by the older build carrying a
    // role vocabulary the new one refuses, so every route answers 403. Read
    // as a transport fault it would mark every node unhealthy on the way to
    // re-minting, wrecking endpoint ranking while the cluster is already in
    // flux. It is one cluster-wide answer: this token is no longer valid.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { code: 'forbidden', message: 'stale role vocabulary' } }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    )));
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a.test', 'http://b.test']));

    await expect(validateSessionAnyNode(registry, 'stale')).resolves.toBeUndefined();
    for (const { health } of registry.candidates()) expect(health.consecutiveFailures).toBe(0);
  });
});

describe('a node refusing to mint', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('carries the server\'s own sentence and machine code, not the status line', async () => {
    // Macha answers `{ error: { code, message } }`. Read off the top level,
    // `record.message` found nothing and every refusal degraded to status
    // plus statusText — and statusText is empty on React Native's fetch, so a
    // wrong password reached a viewer on a device as "Could not start a
    // session: 401" while the server's own sentence sat in the body.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { code: 'anonymous_disabled', message: 'anonymous access is disabled' } }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    )));

    await expect(mintSession('http://node.test')).rejects.toMatchObject({
      status: 403,
      code: 'anonymous_disabled',
      message: 'Could not start a session: anonymous access is disabled',
    });
  });

  it('asks the next node when no credentials were offered, because that is one node\'s configuration', async () => {
    // A credential refusal is checked against a replicated table and every
    // node reaches the same verdict. An anonymous refusal is not: 403 there
    // means "this node does not allow anonymous", which is that node's own
    // configuration. Seen mid-deployment by the Android TV client — one stale
    // node answered 403 while the rest would have minted happily, and
    // stopping at its opinion denied a session the cluster was willing to
    // grant.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: { code: 'anonymous_disabled', message: 'anonymous access is disabled' } }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify(sessionResponse()), {
        status: 201, headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://stale.test', 'http://a.test']));

    await expect(mintSessionAnyNode(registry)).resolves.toMatchObject({ token: 'token-secret' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // And the refusing node is still healthy: it answered, which is what a
    // working node does.
    for (const { health } of registry.candidates()) expect(health.consecutiveFailures).toBe(0);
  });

  it('reports the refusal once every node has refused, rather than an unreachable cluster', async () => {
    // A fresh Response per call: a body can only be read once, and reusing
    // one would have this test assert the empty-body fallback by accident.
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'anonymous_disabled', message: 'anonymous access is disabled' } }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a.test', 'http://b.test']));

    await expect(mintSessionAnyNode(registry)).rejects.toMatchObject({
      status: 403,
      code: 'anonymous_disabled',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('a node that accepts the connection and never answers', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('gives up on a mint at the request deadline rather than waiting on the OS', async () => {
    // Nothing above this can impose the deadline: the callers that wait on a
    // mint are waiting on `SessionManager.inFlight`, and a fetchWithTimeout
    // wrapped around one of them holds a controller this request never sees.
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(blackHoled()));

    const request = mintSession('http://node.test');
    const assertion = expect(request).rejects.toBeInstanceOf(MachaConnectionError);
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);
    await assertion;
  });

  it('walks to the next node instead of stranding the whole client on the first', async () => {
    // The cost of the missing deadline was never one slow request: every
    // fetch() in the application queues behind the bootstrap mint, so an
    // unbounded first candidate froze the client for an OS timeout per node.
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockImplementationOnce(blackHoled())
      .mockResolvedValueOnce(new Response(JSON.stringify(sessionResponse()), {
        status: 201, headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a.test', 'http://b.test']));

    const request = mintSessionAnyNode(registry);
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);

    await expect(request).resolves.toMatchObject({ token: 'token-secret' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // A node that never answered is a node fault, unlike a refusal.
    expect(registry.snapshot().find((entry) => entry.endpoint.id === 'http://a.test')?.health.consecutiveFailures)
      .toBeGreaterThan(0);
  });

  it('gives up on validating a cached token on the same deadline', async () => {
    // The warm-reload path. Un-deadlined it turned the cheap alternative to
    // minting into the slowest thing in a reload.
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(blackHoled()));
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a.test']));

    const request = validateSessionAnyNode(registry, 'cached');
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);

    await expect(request).resolves.toBeUndefined();
  });
});

describe('signing in with credentials', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the credentials on the same route and keeps the username the server names', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify(sessionResponse({ username: 'alice', roles: ['media_viewer'] })),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const session = await mintSession('http://node.test', { username: 'alice', password: 'hunter2000' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ credentials: { username: 'alice', password: 'hunter2000' } });
    expect(session).toEqual({ token: 'token-secret', expiresAtMs: 2_000, username: 'alice', roles: ['media_viewer'] });
  });

  it('does not mark a node unhealthy for refusing a password, and does not ask the next one', async () => {
    // A mistyped password would otherwise walk the cluster and record a
    // failure against every node, degrading endpoint ranking and playback
    // failover because somebody fumbled a login. The refusal is also
    // cluster-wide: every node checks the same replicated table.
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'invalid_credentials', message: 'Unknown username or password.' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a.test', 'http://b.test']));

    await expect(mintSessionAnyNode(registry, { username: 'alice', password: 'wrong' }))
      .rejects.toMatchObject({ status: 401 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const { health } of registry.candidates()) expect(health.consecutiveFailures).toBe(0);
  });

  it('still walks to the next node when one cannot answer at all', async () => {
    // The counterpart: a node that fails to respond is a node fault, and the
    // walk is the whole reason a cold start survives one node being down.
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response(JSON.stringify(sessionResponse()), {
        status: 201, headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a.test', 'http://b.test']));

    await expect(mintSessionAnyNode(registry, { username: 'alice', password: 'right' }))
      .resolves.toMatchObject({ token: 'token-secret' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('mintSessionAnyNode', () => {
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

    const session = await mintSessionAnyNode(registry);

    expect(session.token).toBe('token-secret');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(registry.snapshot().find((entry) => entry.endpoint.id === 'http://a')?.health.consecutiveFailures).toBeGreaterThan(0);
  });

  it('throws once every known endpoint has failed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('unreachable')));
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));

    await expect(mintSessionAnyNode(registry)).rejects.toThrow();
  });
});

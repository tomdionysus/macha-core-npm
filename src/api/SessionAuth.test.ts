import { afterEach, describe, expect, it, vi } from 'vitest';
import { mintSession, mintSessionAnyNode, revokeSessionAnyNode, SESSION_HEDGE_MS, SessionAuthError, validateSessionAnyNode } from './SessionAuth.js';
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

/**
 * A fetch that answers the liveness probe for the nodes listed as up, fails it
 * for the rest, and hands every other request to `rest`. A fresh mint probes
 * first, so tests of the mint walk answer by URL rather than by call order.
 */
function withLiveness(up: readonly string[], rest: (url: string, init?: RequestInit) => Promise<Response>) {
  return vi.fn((url: string, init?: RequestInit) => {
    if (String(url).endsWith('/api/v1/health')) {
      return up.some((node) => String(url).startsWith(node))
        ? Promise.resolve(new Response('{"status":"ok"}', { status: 200 }))
        : Promise.reject(new TypeError('unreachable'));
    }
    return rest(url, init);
  });
}

/** The requests that were not liveness probes. */
function requestsBeyondProbes(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => !url.endsWith('/api/v1/health'));
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
    await expect(mintSession('http://node.test')).rejects.toBeInstanceOf(MachaConnectionError);
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
    const fetchMock = withLiveness(['http://stale.test', 'http://a.test'], async (url) => (url.startsWith('http://stale.test')
      ? new Response(
        JSON.stringify({ error: { code: 'anonymous_disabled', message: 'anonymous access is disabled' } }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      )
      : new Response(JSON.stringify(sessionResponse()), { status: 201, headers: { 'Content-Type': 'application/json' } })));
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://stale.test', 'http://a.test']));

    await expect(mintSessionAnyNode(registry)).resolves.toMatchObject({ token: 'token-secret' });

    expect(requestsBeyondProbes(fetchMock)).toEqual(['http://stale.test/api/v1/session', 'http://a.test/api/v1/session']);
    // And the refusing node is still healthy: it answered, which is what a
    // working node does.
    for (const { health } of registry.candidates()) expect(health.consecutiveFailures).toBe(0);
  });

  it('reports the refusal once every node has refused, rather than an unreachable cluster', async () => {
    // A fresh Response per call: a body can only be read once, and reusing
    // one would have this test assert the empty-body fallback by accident.
    const fetchMock = withLiveness(['http://a.test', 'http://b.test'], async () => new Response(
      JSON.stringify({ error: { code: 'anonymous_disabled', message: 'anonymous access is disabled' } }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a.test', 'http://b.test']));

    await expect(mintSessionAnyNode(registry)).rejects.toMatchObject({
      status: 403,
      code: 'anonymous_disabled',
    });
    expect(requestsBeyondProbes(fetchMock)).toHaveLength(2);
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
    // And it no longer costs the timeout: the probe finds the answering node
    // after one hedge, and the mint goes straight there.
    vi.useFakeTimers();
    const fetchMock = vi.fn((url: string, init?: RequestInit) => (String(url).startsWith('http://a.test')
      ? blackHoled()(url, init)
      : String(url).endsWith('/api/v1/health')
        ? Promise.resolve(new Response('{"status":"ok"}', { status: 200 }))
        : Promise.resolve(new Response(JSON.stringify(sessionResponse()), { status: 201, headers: { 'Content-Type': 'application/json' } }))));
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a.test', 'http://b.test']));

    const request = mintSessionAnyNode(registry);
    await vi.advanceTimersByTimeAsync(SESSION_HEDGE_MS);

    await expect(request).resolves.toMatchObject({ token: 'token-secret' });
    expect(requestsBeyondProbes(fetchMock)).toEqual(['http://b.test/api/v1/session']);
  });

  it('gives up on validating a cached token on the same deadline', async () => {
    // The warm-reload path. Un-deadlined it turned the cheap alternative to
    // minting into the slowest thing in a reload.
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(blackHoled()));
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a.test']));

    const outcome = validateSessionAnyNode(registry, 'cached').then(() => 'resolved', (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);

    // Unanswered is not rejected: a caller must not discard a good token for it.
    expect(await outcome).toBeInstanceOf(MachaConnectionError);
  });
});

describe('validating a cached token across several nodes', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  const record = () => new Response(JSON.stringify({ roles: ['media_viewer'], expires_unix_ms: 9 }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  it('asks the next node after the hedge, not after the first times out', async () => {
    // Measured 2026-09-24: two dead nodes cost 8.2 s and 8.0 s before the
    // third answered in 0.52 s.
    vi.useFakeTimers();
    const fetchMock = vi.fn((url: string, init?: RequestInit) => (String(url).startsWith('http://b.test') ? Promise.resolve(record()) : blackHoled()(url, init)));
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a.test', 'http://b.test']));

    const outcome = validateSessionAnyNode(registry, 'cached');
    await vi.advanceTimersByTimeAsync(SESSION_HEDGE_MS);

    await expect(outcome).resolves.toMatchObject({ roles: ['media_viewer'] });
    // The node still being asked when the answer came was cancelled, not charged.
    expect(registry.snapshot().find(({ endpoint }) => endpoint.id === 'http://a.test')?.health.consecutiveFailures).toBe(0);
  });

  it('moves on at once when a node fails outright, and charges it', async () => {
    const fetchMock = vi.fn((url: string) => (String(url).startsWith('http://b.test') ? Promise.resolve(record()) : Promise.reject(new TypeError('refused'))));
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a.test', 'http://b.test']));

    await expect(validateSessionAnyNode(registry, 'cached')).resolves.toMatchObject({ roles: ['media_viewer'] });
    expect(registry.snapshot().find(({ endpoint }) => endpoint.id === 'http://a.test')?.health.consecutiveFailures).toBe(1);
  });

  it('stops at a refusal, which is the answer for the whole cluster', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a.test', 'http://b.test']));

    await expect(validateSessionAnyNode(registry, 'cached')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    const fetchMock = withLiveness(['http://a.test', 'http://b.test'], async () => new Response(
      JSON.stringify({ error: 'invalid_credentials', message: 'Unknown username or password.' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a.test', 'http://b.test']));

    await expect(mintSessionAnyNode(registry, { username: 'alice', password: 'wrong' }))
      .rejects.toMatchObject({ status: 401 });

    expect(requestsBeyondProbes(fetchMock)).toHaveLength(1);
    for (const { health } of registry.candidates()) expect(health.consecutiveFailures).toBe(0);
  });

  it('still walks to the next node when one cannot answer at all', async () => {
    // The counterpart: a node that fails to respond is a node fault, and the
    // walk is the whole reason a cold start survives one node being down.
    // The probe says both are up; the first then fails the mint itself.
    const fetchMock = withLiveness(['http://a.test', 'http://b.test'], async (url) => {
      if (url.startsWith('http://a.test')) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify(sessionResponse()), { status: 201, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a.test', 'http://b.test']));

    await expect(mintSessionAnyNode(registry, { username: 'alice', password: 'right' }))
      .resolves.toMatchObject({ token: 'token-secret' });
    expect(requestsBeyondProbes(fetchMock)).toHaveLength(2);
  });
});

describe('mintSessionAnyNode', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('mints against whichever endpoint answers first and records the outcome', async () => {
    const fetchMock = withLiveness(['http://b'], async () => new Response(JSON.stringify(sessionResponse()), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));

    const session = await mintSessionAnyNode(registry);

    expect(session.token).toBe('token-secret');
    // Only the node the probe found answering is asked to mint.
    expect(requestsBeyondProbes(fetchMock)).toEqual(['http://b/api/v1/session']);
    expect(registry.snapshot().find((entry) => entry.endpoint.id === 'http://a')?.health.consecutiveFailures).toBeGreaterThan(0);
  });

  it('probes nothing once the registry already knows which nodes answer', async () => {
    // After validation, or any request, the ranking already leads with a node
    // that answered; a probe would only add a round trip.
    const fetchMock = withLiveness(['http://a', 'http://b'], async () => new Response(JSON.stringify(sessionResponse()), {
      status: 201, headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
    registry.recordSuccess('http://b');

    await mintSessionAnyNode(registry);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(['http://b/api/v1/session']);
  });

  it('throws once every known endpoint has failed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('unreachable')));
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));

    await expect(mintSessionAnyNode(registry)).rejects.toThrow();
  });
});

function twoNodes() {
  return new EndpointRegistry(bootstrapEndpoints(['http://a.test', 'http://b.test']));
}

function jsonBody(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('ending a session server-side', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('revokes on the first node that answers and asks no others', async () => {
    // A revoke propagates from whichever node accepts it. Walking on would
    // revoke nothing new while masking the first attempt having worked.
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const registry = twoNodes();

    await expect(revokeSessionAnyNode(registry, 'token')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://a.test/api/v1/session');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'DELETE' });
  });

  it('sends the token it is revoking, since the route authorises by bearer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await revokeSessionAnyNode(twoNodes(), 'the-token');

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer the-token');
  });

  it.each([401, 403])('treats %i as already revoked rather than a failure to revoke', async (status) => {
    // Already unacceptable is already gone, as far as the caller is concerned.
    // Reporting it as a failure would leave a viewer looking at an error for a
    // sign-out that has, in every sense that matters, happened.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonBody({ error: { code: 'x', message: 'no' } }, status)));

    await expect(revokeSessionAnyNode(twoNodes(), 'token')).resolves.toBeUndefined();
  });

  it('reports a node that refused to revoke, and does not try another', async () => {
    // The node was reached and answered. Asking its neighbours to revoke a
    // session this one still holds would report success for a session that is
    // still live.
    const fetchMock = vi.fn().mockResolvedValue(jsonBody(
      { error: { code: 'internal', message: 'revocation store is down' } }, 500,
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(revokeSessionAnyNode(twoNodes(), 'token')).rejects.toMatchObject({
      message: 'Could not end the session: revocation store is down',
      status: 500,
      code: 'internal',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('moves to the next node when the first cannot be reached at all', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('connection refused'))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const registry = twoNodes();

    await expect(revokeSessionAnyNode(registry, 'token')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(registry.candidates().find((c) => c.endpoint.baseUrl === 'http://a.test')?.health.consecutiveFailures).toBe(1);
  });

  it('says so plainly when there is no node to ask', async () => {
    const empty = new EndpointRegistry(bootstrapEndpoints([]));

    await expect(revokeSessionAnyNode(empty, 'token')).rejects.toThrow('No Macha endpoint is configured.');
  });
});

describe('minting with nothing configured', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports an unconfigured client rather than an unreachable cluster', async () => {
    // These are different problems with different fixes, and a client that
    // reports "all endpoints are unreachable" for an empty list sends someone
    // to check a server that is running perfectly well.
    const empty = new EndpointRegistry(bootstrapEndpoints([]));

    await expect(mintSessionAnyNode(empty)).rejects.toBeInstanceOf(SessionAuthError);
    await expect(mintSessionAnyNode(empty)).rejects.toThrow('No Macha endpoint is configured.');
  });

  it('reads a proxy answering for a node that is not there as unreachable', async () => {
    // A bodiless 502 is the proxy talking, not the node. Treating it as a
    // refusal would report a server-stated reason that no server stated.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>bad gateway</html>', {
      status: 502,
      headers: { 'Content-Type': 'text/html' },
    })));

    await expect(mintSession('http://node.test')).rejects.toBeInstanceOf(MachaConnectionError);
  });
});

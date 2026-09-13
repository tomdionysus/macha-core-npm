import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixedBearerToken, NO_AUTH, SessionManager } from './SessionManager.js';
import { bootstrapEndpoints, EndpointRegistry } from '../cluster/EndpointRegistry.js';
import { configureMachaHost, memoryStorage } from '../runtime/host.js';
import * as SessionAuth from './SessionAuth.js';
import { SessionAuthError } from './SessionAuth.js';
import { reportClusterReachable } from './serverConnection.js';
import { subscribeConnectionState } from '../runtime/events.js';

const DAY_MS = 24 * 60 * 60 * 1000;

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

describe('fixedBearerToken', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('attaches the given token as a Bearer header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await fixedBearerToken('secret').fetch('http://node.test/x');

    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('Authorization')).toBe('Bearer secret');
  });

  it('sends no Authorization header when undefined', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await NO_AUTH.fetch('http://node.test/x');

    expect(new Headers(fetchMock.mock.calls[0][1].headers).has('Authorization')).toBe(false);
  });
});

describe('SessionManager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('is not ready until start() is called', () => {
    expect(new SessionManager().isReady).toBe(false);
  });

  it('mints and becomes ready, attaching the token to subsequent requests', async () => {
    vi.spyOn(SessionAuth, 'mintAnonymousSessionAnyNode').mockResolvedValue({
      token: 'token-a', expiresAtMs: Date.now() + DAY_MS,
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SessionManager();

    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.isReady).toBe(true));

    await manager.fetch('http://a/x');
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('Authorization')).toBe('Bearer token-a');
  });

  it('says why there is no token, so a client is not left guessing from an empty one', async () => {
    // An empty token and isReady true are the same two facts whether the
    // cluster refused or nothing answered, and those need opposite handling.
    // Three client sessions built something on the guess in one day and all
    // three removed it — one a login wall that would have replaced a playing
    // film with a sign-in screen on a network blip.
    vi.spyOn(SessionAuth, 'mintAnonymousSessionAnyNode')
      .mockRejectedValue(new SessionAuthError('Could not start a session: anonymous access is disabled', 403, 'anonymous_disabled'));
    const manager = new SessionManager();

    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.isReady).toBe(true));

    expect(manager.lastMintFailure).toEqual({
      reason: 'refused',
      status: 403,
      code: 'anonymous_disabled',
      message: 'Could not start a session: anonymous access is disabled',
    });
  });

  it('distinguishes nothing answering from a node saying no', async () => {
    vi.spyOn(SessionAuth, 'mintAnonymousSessionAnyNode').mockRejectedValue(new Error('unreachable'));
    const manager = new SessionManager();

    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.isReady).toBe(true));

    expect(manager.lastMintFailure).toMatchObject({ reason: 'unreachable' });
    expect(manager.lastMintFailure?.status).toBeUndefined();
  });

  it('clears the reason the moment a session is adopted', async () => {
    // Published through the same subscribe() as everything else, and cleared
    // before the notification, so a subscriber reacting to it never acts on a
    // reason that has already been resolved.
    const mint = vi.spyOn(SessionAuth, 'mintAnonymousSessionAnyNode')
      .mockRejectedValueOnce(new SessionAuthError('refused', 403, 'anonymous_disabled'))
      .mockResolvedValue({ token: 'token-a', expiresAtMs: Date.now() + DAY_MS });
    const manager = new SessionManager();

    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.lastMintFailure?.reason).toBe('refused'));

    await manager.signIn({ username: 'alice', password: 'hunter2000' }).catch(() => undefined);

    expect(manager.lastMintFailure).toBeUndefined();
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it('does not call the cluster unreachable when a node refused to mint', async () => {
    // A node that answered 403 in forty milliseconds has been reached and has
    // stated a policy. Publishing "All configured API endpoints are
    // unreachable" for it is a sentence no node said, and it sends a viewer
    // to check a server that is up and working exactly as configured. Three
    // clients hit this in one day; two built a login wall on the guess and
    // removed it again.
    reportClusterReachable(); // clear any latch left by an earlier test
    const events: string[] = [];
    const unsubscribe = subscribeConnectionState((event) => events.push(event.type));
    vi.spyOn(SessionAuth, 'mintAnonymousSessionAnyNode')
      .mockRejectedValue(new SessionAuthError('Could not start a session: anonymous access is disabled', 403, 'anonymous_disabled'));
    const manager = new SessionManager();

    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.isReady).toBe(true));

    expect(events).not.toContain('unreachable');
    unsubscribe();
  });

  it('still calls the cluster unreachable when no node could be asked', async () => {
    reportClusterReachable();
    const events: string[] = [];
    const unsubscribe = subscribeConnectionState((event) => events.push(event.type));
    vi.spyOn(SessionAuth, 'mintAnonymousSessionAnyNode').mockRejectedValue(new Error('unreachable'));
    const manager = new SessionManager();

    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.isReady).toBe(true));

    expect(events).toContain('unreachable');
    unsubscribe();
  });

  it('becomes ready even when minting fails, so callers do not hang forever', async () => {
    vi.spyOn(SessionAuth, 'mintAnonymousSessionAnyNode').mockRejectedValue(new Error('unreachable'));
    const manager = new SessionManager();

    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.isReady).toBe(true));
  });

  it('notifies subscribers when readiness changes', async () => {
    vi.spyOn(SessionAuth, 'mintAnonymousSessionAnyNode').mockResolvedValue({
      token: 'token-a', expiresAtMs: Date.now() + DAY_MS,
    });
    const manager = new SessionManager();
    const listener = vi.fn();
    manager.subscribe(listener);

    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
  });

  it('re-mints on a 401 from a request made through fetch()', async () => {
    const mint = vi.spyOn(SessionAuth, 'mintAnonymousSessionAnyNode')
      .mockResolvedValueOnce({ token: 'token-a', expiresAtMs: Date.now() + DAY_MS })
      .mockResolvedValueOnce({ token: 'token-b', expiresAtMs: Date.now() + DAY_MS });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SessionManager();
    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.isReady).toBe(true));

    await manager.fetch('http://a/x');

    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(2));
  });

  it('holds a request fired before the first token exists until the mint lands, then sends it authenticated', async () => {
    // A caller that races ahead of the very first mint (e.g. an effect that
    // fires on mount) must not go out tokenless — that can only 401. It waits
    // for the bootstrap already in flight and carries the resulting token.
    let resolveMint: (session: SessionAuth.AnonymousSession) => void;
    const mint = vi.spyOn(SessionAuth, 'mintAnonymousSessionAnyNode')
      .mockImplementation(() => new Promise((resolve) => { resolveMint = resolve; }));
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SessionManager();
    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));

    const early = manager.fetch('http://a/x');
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();

    resolveMint!({ token: 'token-a', expiresAtMs: Date.now() + DAY_MS });
    expect((await early).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('Authorization')).toBe('Bearer token-a');
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('retries once with the re-minted token when the token it sent is rejected', async () => {
    const mint = vi.spyOn(SessionAuth, 'mintAnonymousSessionAnyNode')
      .mockResolvedValueOnce({ token: 'token-a', expiresAtMs: Date.now() + DAY_MS })
      .mockResolvedValueOnce({ token: 'token-b', expiresAtMs: Date.now() + DAY_MS });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SessionManager();
    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.isReady).toBe(true));

    const response = await manager.fetch('http://a/x');

    expect(response.status).toBe(200);
    expect(mint).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchMock.mock.calls[1][1].headers).get('Authorization')).toBe('Bearer token-b');
  });

  it('coalesces overlapping 401s into one re-mint and never clobbers the session it just adopted', async () => {
    // Two requests go out on token-a; both are rejected. The first re-mints
    // to token-b and retries. By the time the second, slower 401 arrives the
    // session it was sent on has already been replaced — minting again would
    // throw away a perfectly good token-b. It must simply retry with token-b.
    const mint = vi.spyOn(SessionAuth, 'mintAnonymousSessionAnyNode')
      .mockResolvedValueOnce({ token: 'token-a', expiresAtMs: Date.now() + DAY_MS })
      .mockResolvedValue({ token: 'token-b', expiresAtMs: Date.now() + DAY_MS });
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => Promise.resolve(
      new Response(null, { status: new Headers(init.headers).get('Authorization') === 'Bearer token-a' ? 401 : 200 }),
    ));
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SessionManager();
    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.isReady).toBe(true));

    const [first, second] = await Promise.all([manager.fetch('http://a/x'), manager.fetch('http://a/y')]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it('returns the original 401 when re-minting fails, rather than retrying tokenless or looping', async () => {
    vi.spyOn(SessionAuth, 'mintAnonymousSessionAnyNode')
      .mockResolvedValueOnce({ token: 'token-a', expiresAtMs: Date.now() + DAY_MS })
      .mockRejectedValueOnce(new Error('unreachable'));
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SessionManager();
    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.isReady).toBe(true));

    const response = await manager.fetch('http://a/x');

    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    manager.stop();
  });

  it('never lets a long-lived expiry overflow setTimeout into an immediate re-mint loop', async () => {
    // Regression test: setTimeout's delay is a 32-bit signed int (~24.8 day
    // max) — scheduling a refresh for the full remaining time on a
    // multi-week session (this contract's own example is 30 days) silently
    // overflows to ~0ms and re-mints in a tight infinite loop.
    vi.useFakeTimers();
    const mint = vi.spyOn(SessionAuth, 'mintAnonymousSessionAnyNode').mockResolvedValue({
      token: 'token-a', expiresAtMs: Date.now() + 30 * DAY_MS,
    });
    const manager = new SessionManager();

    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.advanceTimersByTimeAsync(0);
    expect(mint).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * DAY_MS);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('re-mints once the real remaining time reaches the refresh safety margin', async () => {
    vi.useFakeTimers();
    const mint = vi.spyOn(SessionAuth, 'mintAnonymousSessionAnyNode')
      .mockResolvedValueOnce({ token: 'token-a', expiresAtMs: Date.now() + 2 * DAY_MS })
      .mockResolvedValue({ token: 'token-b', expiresAtMs: Date.now() + 30 * DAY_MS });
    const manager = new SessionManager();

    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(2 * DAY_MS);
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it('stops scheduling further mints after stop()', async () => {
    vi.useFakeTimers();
    const mint = vi.spyOn(SessionAuth, 'mintAnonymousSessionAnyNode').mockResolvedValue({
      token: 'token-a', expiresAtMs: Date.now() + DAY_MS,
    });
    const manager = new SessionManager();
    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.advanceTimersByTimeAsync(0);
    expect(mint).toHaveBeenCalledTimes(1);

    manager.stop();
    await vi.advanceTimersByTimeAsync(10 * DAY_MS);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('restarting against a new registry resets readiness until the new mint settles', async () => {
    vi.spyOn(SessionAuth, 'mintAnonymousSessionAnyNode').mockResolvedValue({
      token: 'token-a', expiresAtMs: Date.now() + DAY_MS,
    });
    const manager = new SessionManager();
    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.isReady).toBe(true));

    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://b'])));
    expect(manager.isReady).toBe(false);
    await vi.waitFor(() => expect(manager.isReady).toBe(true));
  });
});

describe('SessionManager cached-session validation (Law 2: never make the viewer wait)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('adopts a validated cached session without minting a new one', async () => {
    const mint = vi.spyOn(SessionAuth, 'mintAnonymousSessionAnyNode');
    const validate = vi.spyOn(SessionAuth, 'validateAnonymousSessionAnyNode').mockResolvedValue(true);
    const storage = new MemoryStorage();
    storage.setItem('macha-session', JSON.stringify({ token: 'cached-token', expiresAtMs: Date.now() + DAY_MS }));
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SessionManager(storage);

    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.isReady).toBe(true));

    expect(validate).toHaveBeenCalledWith(expect.anything(), 'cached-token');
    expect(mint).not.toHaveBeenCalled();
    await manager.fetch('http://a/x');
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('Authorization')).toBe('Bearer cached-token');
  });

  it('mints fresh when the cached session fails validation, and re-caches the result', async () => {
    const mint = vi.spyOn(SessionAuth, 'mintAnonymousSessionAnyNode').mockResolvedValue({
      token: 'fresh-token', expiresAtMs: Date.now() + DAY_MS,
    });
    vi.spyOn(SessionAuth, 'validateAnonymousSessionAnyNode').mockResolvedValue(false);
    const storage = new MemoryStorage();
    storage.setItem('macha-session', JSON.stringify({ token: 'stale-token', expiresAtMs: Date.now() + DAY_MS }));
    const manager = new SessionManager(storage);

    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.isReady).toBe(true));

    expect(mint).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.getItem('macha-session') ?? '')).toEqual({
      token: 'fresh-token', expiresAtMs: expect.any(Number),
    });
  });

  it('mints fresh without validating when the cached session is already expired', async () => {
    const mint = vi.spyOn(SessionAuth, 'mintAnonymousSessionAnyNode').mockResolvedValue({
      token: 'fresh-token', expiresAtMs: Date.now() + DAY_MS,
    });
    const validate = vi.spyOn(SessionAuth, 'validateAnonymousSessionAnyNode');
    const storage = new MemoryStorage();
    storage.setItem('macha-session', JSON.stringify({ token: 'old-token', expiresAtMs: Date.now() - 1_000 }));
    const manager = new SessionManager(storage);

    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.isReady).toBe(true));

    expect(validate).not.toHaveBeenCalled();
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('mints fresh when there is nothing cached, and caches the result for next time', async () => {
    const mint = vi.spyOn(SessionAuth, 'mintAnonymousSessionAnyNode').mockResolvedValue({
      token: 'fresh-token', expiresAtMs: Date.now() + DAY_MS,
    });
    const storage = new MemoryStorage();
    const manager = new SessionManager(storage);

    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.isReady).toBe(true));

    expect(mint).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.getItem('macha-session') ?? '').token).toBe('fresh-token');
  });
});

describe('session cache storage resolution', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses the host configured after the manager was constructed, not the one detected before it', async () => {
    // The exported `sessionManager` singleton is built when this module is
    // first evaluated, which under ESM is strictly before the importing entry
    // module's body runs — so before its `configureMachaHost()` call. A
    // manager that captured the host at construction would cache the session
    // into the auto-detected default and silently ignore the real one.
    const manager = new SessionManager();
    const configured = memoryStorage();
    configureMachaHost({ ephemeralStorage: configured });

    vi.spyOn(SessionAuth, 'mintAnonymousSessionAnyNode').mockResolvedValue({
      token: 'token-a', expiresAtMs: Date.now() + DAY_MS,
    });
    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.isReady).toBe(true));
    manager.stop();

    expect(JSON.parse(configured.getItem('macha-session') ?? 'null')).toMatchObject({ token: 'token-a' });
  });

  it('still honours an explicitly supplied storage over the host', async () => {
    const explicit = memoryStorage();
    const manager = new SessionManager(explicit);
    const hostStorage = memoryStorage();
    configureMachaHost({ ephemeralStorage: hostStorage });

    vi.spyOn(SessionAuth, 'mintAnonymousSessionAnyNode').mockResolvedValue({
      token: 'token-b', expiresAtMs: Date.now() + DAY_MS,
    });
    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.isReady).toBe(true));
    manager.stop();

    expect(explicit.getItem('macha-session')).not.toBeNull();
    expect(hostStorage.getItem('macha-session')).toBeNull();
  });

  describe('authorization for requests this client does not make', () => {
    it('hands out the current header for a URL given to a native player', async () => {
      expect(await fixedBearerToken('secret').authorization()).toBe('Bearer secret');
    });

    it('says undefined rather than an empty header when unauthenticated', async () => {
      // A player told `Bearer ` would send a malformed header and get a 401 it
      // cannot interpret; absent is an answer it can act on.
      expect(await fixedBearerToken(undefined).authorization()).toBeUndefined();
      expect(await fixedBearerToken('   ').authorization()).toBeUndefined();
    });
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixedBearerToken, NO_AUTH, SessionManager, SessionNotStartedError } from './SessionManager.js';
import { bootstrapEndpoints, EndpointRegistry } from '../cluster/EndpointRegistry.js';
import { configureMachaHost, memoryStorage } from '../runtime/host.js';
import * as SessionAuth from './SessionAuth.js';
import { SessionAuthError } from './SessionAuth.js';
import { MachaConnectionError, reportClusterReachable } from './serverConnection.js';
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
    vi.spyOn(SessionAuth, 'mintSessionAnyNode').mockResolvedValue({
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
    vi.spyOn(SessionAuth, 'mintSessionAnyNode')
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
    vi.spyOn(SessionAuth, 'mintSessionAnyNode').mockRejectedValue(new Error('unreachable'));
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
    const mint = vi.spyOn(SessionAuth, 'mintSessionAnyNode')
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
    vi.spyOn(SessionAuth, 'mintSessionAnyNode')
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
    vi.spyOn(SessionAuth, 'mintSessionAnyNode').mockRejectedValue(new Error('unreachable'));
    const manager = new SessionManager();

    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.isReady).toBe(true));

    expect(events).toContain('unreachable');
    unsubscribe();
  });

  it('becomes ready even when minting fails, so callers do not hang forever', async () => {
    vi.spyOn(SessionAuth, 'mintSessionAnyNode').mockRejectedValue(new Error('unreachable'));
    const manager = new SessionManager();

    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.isReady).toBe(true));
  });

  it('notifies subscribers when readiness changes', async () => {
    vi.spyOn(SessionAuth, 'mintSessionAnyNode').mockResolvedValue({
      token: 'token-a', expiresAtMs: Date.now() + DAY_MS,
    });
    const manager = new SessionManager();
    const listener = vi.fn();
    manager.subscribe(listener);

    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
  });

  it('re-mints on a 401 from a request made through fetch()', async () => {
    const mint = vi.spyOn(SessionAuth, 'mintSessionAnyNode')
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
    let resolveMint: (session: SessionAuth.Session) => void;
    const mint = vi.spyOn(SessionAuth, 'mintSessionAnyNode')
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
    const mint = vi.spyOn(SessionAuth, 'mintSessionAnyNode')
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
    const mint = vi.spyOn(SessionAuth, 'mintSessionAnyNode')
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
    vi.spyOn(SessionAuth, 'mintSessionAnyNode')
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

  it('stops handing a rejected token to callers outside this class while the re-mint is in flight', async () => {
    // `authorization()` answers from the current token and only waits when
    // there is none, so a token left in place across a reactive re-mint is
    // handed to a native player for the whole length of that mint — and it is
    // the one token a node has just refused.
    let grantSecond: (session: { token: string; expiresAtMs: number }) => void = () => undefined;
    vi.spyOn(SessionAuth, 'mintSessionAnyNode')
      .mockResolvedValueOnce({ token: 'token-a', expiresAtMs: Date.now() + DAY_MS })
      .mockImplementationOnce(() => new Promise((resolve) => { grantSecond = resolve; }));
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SessionManager();
    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.isReady).toBe(true));

    const request = manager.fetch('http://a/x');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    let header: string | undefined | 'pending' = 'pending';
    const asked = manager.authorization().then((value) => { header = value; });
    for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
    expect(header).toBe('pending');

    grantSecond({ token: 'token-b', expiresAtMs: Date.now() + DAY_MS });
    await asked;
    expect(header).toBe('Bearer token-b');
    await request;
    manager.stop();
  });

  it('contacts the new registry when restarted mid-bootstrap, and does not adopt the old one\'s session', async () => {
    // `stop()` sets `cancelled` and `start()` clears it, so the flag cannot
    // disown work started against the registry just replaced: the in-flight
    // bootstrap was returned as this start's own answer, the new registry was
    // never contacted, and whatever the old one eventually said was adopted.
    let grantFirst: (session: { token: string; expiresAtMs: number }) => void = () => undefined;
    const mint = vi.spyOn(SessionAuth, 'mintSessionAnyNode')
      .mockImplementationOnce(() => new Promise((resolve) => { grantFirst = resolve; }))
      .mockResolvedValue({ token: 'token-b', expiresAtMs: Date.now() + DAY_MS });
    const manager = new SessionManager();
    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(1));

    const corrected = new EndpointRegistry(bootstrapEndpoints(['http://b']));
    manager.start(corrected);

    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(2));
    expect(mint.mock.calls[1]?.[0]).toBe(corrected);
    await vi.waitFor(() => expect(manager.isReady).toBe(true));

    // The abandoned bootstrap lands last, which is the case that matters: it
    // must not overwrite the session the registry in use granted.
    grantFirst({ token: 'token-a', expiresAtMs: Date.now() + DAY_MS });
    for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
    expect(await manager.authorization()).toBe('Bearer token-b');
    manager.stop();
  });

  it('leaves no timer behind when a retry timer is armed over a pending refresh', async () => {
    // Both sites assigned `refreshTimer` without clearing it, and `stop()`
    // clears only the handle it can still see. The refresh armed by the first
    // adoption was overwritten by the retry armed when the re-mint failed, and
    // went on running with nothing able to cancel it.
    vi.useFakeTimers();
    const mint = vi.spyOn(SessionAuth, 'mintSessionAnyNode')
      .mockResolvedValueOnce({ token: 'token-a', expiresAtMs: Date.now() + 2 * DAY_MS })
      .mockRejectedValue(new Error('unreachable'));
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SessionManager();
    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    await manager.fetch('http://a/x');

    expect(mint).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    manager.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never lets a long-lived expiry overflow setTimeout into an immediate re-mint loop', async () => {
    // Regression test: setTimeout's delay is a 32-bit signed int (~24.8 day
    // max) — scheduling a refresh for the full remaining time on a
    // multi-week session (this contract's own example is 30 days) silently
    // overflows to ~0ms and re-mints in a tight infinite loop.
    vi.useFakeTimers();
    const mint = vi.spyOn(SessionAuth, 'mintSessionAnyNode').mockResolvedValue({
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
    const mint = vi.spyOn(SessionAuth, 'mintSessionAnyNode')
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
    const mint = vi.spyOn(SessionAuth, 'mintSessionAnyNode').mockResolvedValue({
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
    vi.spyOn(SessionAuth, 'mintSessionAnyNode').mockResolvedValue({
      token: 'token-a', expiresAtMs: Date.now() + DAY_MS,
    });
    // Its own empty storage. The shared default could hold a session another
    // test cached, which sent this one to validate against the unresolvable
    // http://a for real, and under a full-suite load that outlasted the wait.
    const manager = new SessionManager(new MemoryStorage());
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
    const mint = vi.spyOn(SessionAuth, 'mintSessionAnyNode');
    const validate = vi.spyOn(SessionAuth, 'validateSessionAnyNode')
      .mockResolvedValue({ roles: ['media_viewer'], expires_unix_ms: Date.now() + DAY_MS });
    const storage = new MemoryStorage();
    storage.setItem('macha.session.v1', JSON.stringify({ token: 'cached-token', expiresAtMs: Date.now() + DAY_MS }));
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

  it('keeps a good cached session when no node answers, rather than minting a refused one', async () => {
    // Measured 2026-09-24: with two nodes down the web client lost its
    // signed-in session. Validation that no node answered read as "rejected",
    // the anonymous mint on an account-only cluster was refused, and the
    // viewer holding a good 30-day token was sent to sign in.
    const mint = vi.spyOn(SessionAuth, 'mintSessionAnyNode');
    vi.spyOn(SessionAuth, 'validateSessionAnyNode').mockRejectedValue(new MachaConnectionError('nobody answered'));
    const storage = new MemoryStorage();
    storage.setItem('macha.session.v1', JSON.stringify({ token: 'cached-token', expiresAtMs: Date.now() + DAY_MS, roles: ['media_viewer'], username: 'alice' }));
    const manager = new SessionManager(storage);

    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.isReady).toBe(true));

    expect(mint).not.toHaveBeenCalled();
    expect(manager.roles).toEqual(['media_viewer']);
    expect(manager.lastMintFailure).toBeUndefined();
  });

  it('takes the roles from whichever request already had them', async () => {
    // Roles arrive with the token on every path: the mint response states
    // them, and so does the record returned by validating a cached token. So
    // there is no separate fetch to fail and nothing to retry — which is what
    // made this worth moving here. A client fetching them once per API
    // identity never re-asked, because failover changes the preferred
    // endpoint inside the registry without changing that identity, and one
    // transient failure left roles unknown for a whole run.
    vi.spyOn(SessionAuth, 'validateSessionAnyNode')
      .mockResolvedValue({ roles: ['media_viewer', 'view_status'], expires_unix_ms: Date.now() + DAY_MS });
    const storage = new MemoryStorage();
    storage.setItem('macha.session.v1', JSON.stringify({ token: 'cached-token', expiresAtMs: Date.now() + DAY_MS }));
    const manager = new SessionManager(storage);
    expect(manager.roles).toBeUndefined();

    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.isReady).toBe(true));

    expect(manager.roles).toEqual(['media_viewer', 'view_status']);
  });

  it('takes the roles a mint states, and forgets them when the token goes', async () => {
    const mint = vi.spyOn(SessionAuth, 'mintSessionAnyNode')
      .mockResolvedValueOnce({ token: 'token-a', expiresAtMs: Date.now() + DAY_MS, roles: [] });
    const revoke = vi.spyOn(SessionAuth, 'revokeSessionAnyNode').mockResolvedValue(undefined);
    const manager = new SessionManager();

    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.roles).toEqual([]));

    // An empty array is a session the cluster granted nothing, which is a
    // real state and not an absence. Losing the token makes it unknown again
    // rather than leaving a stale answer that says the viewer may do nothing.
    await manager.signOut();
    expect(revoke).toHaveBeenCalledWith(expect.anything(), 'token-a');
    expect(manager.roles).toBeUndefined();
    // And no replacement was minted. Signing out and obtaining a session are
    // two decisions, and this call makes only the first.
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('mints fresh when the cached session fails validation, and re-caches the result', async () => {
    const mint = vi.spyOn(SessionAuth, 'mintSessionAnyNode').mockResolvedValue({
      token: 'fresh-token', expiresAtMs: Date.now() + DAY_MS,
    });
    vi.spyOn(SessionAuth, 'validateSessionAnyNode').mockResolvedValue(undefined);
    const storage = new MemoryStorage();
    storage.setItem('macha.session.v1', JSON.stringify({ token: 'stale-token', expiresAtMs: Date.now() + DAY_MS }));
    const manager = new SessionManager(storage);

    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.isReady).toBe(true));

    expect(mint).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.getItem('macha.session.v1') ?? '')).toEqual({
      token: 'fresh-token', expiresAtMs: expect.any(Number),
    });
  });

  it('mints fresh without validating when the cached session is already expired', async () => {
    const mint = vi.spyOn(SessionAuth, 'mintSessionAnyNode').mockResolvedValue({
      token: 'fresh-token', expiresAtMs: Date.now() + DAY_MS,
    });
    const validate = vi.spyOn(SessionAuth, 'validateSessionAnyNode');
    const storage = new MemoryStorage();
    storage.setItem('macha.session.v1', JSON.stringify({ token: 'old-token', expiresAtMs: Date.now() - 1_000 }));
    const manager = new SessionManager(storage);

    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.isReady).toBe(true));

    expect(validate).not.toHaveBeenCalled();
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('mints fresh when there is nothing cached, and caches the result for next time', async () => {
    const mint = vi.spyOn(SessionAuth, 'mintSessionAnyNode').mockResolvedValue({
      token: 'fresh-token', expiresAtMs: Date.now() + DAY_MS,
    });
    const storage = new MemoryStorage();
    const manager = new SessionManager(storage);

    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.isReady).toBe(true));

    expect(mint).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.getItem('macha.session.v1') ?? '').token).toBe('fresh-token');
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
    configureMachaHost({ secureStorage: configured });

    vi.spyOn(SessionAuth, 'mintSessionAnyNode').mockResolvedValue({
      token: 'token-a', expiresAtMs: Date.now() + DAY_MS,
    });
    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.isReady).toBe(true));
    manager.stop();

    expect(JSON.parse(configured.getItem('macha.session.v1') ?? 'null')).toMatchObject({ token: 'token-a' });
  });

  it('still honours an explicitly supplied storage over the host', async () => {
    const explicit = memoryStorage();
    const manager = new SessionManager(explicit);
    const hostStorage = memoryStorage();
    configureMachaHost({ secureStorage: hostStorage });

    vi.spyOn(SessionAuth, 'mintSessionAnyNode').mockResolvedValue({
      token: 'token-b', expiresAtMs: Date.now() + DAY_MS,
    });
    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.isReady).toBe(true));
    manager.stop();

    expect(explicit.getItem('macha.session.v1')).not.toBeNull();
    expect(hostStorage.getItem('macha.session.v1')).toBeNull();
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

describe('a session that stops belonging to the account it belonged to', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const registry = () => new EndpointRegistry(bootstrapEndpoints(['http://a']));

  it('reports a signed-in session becoming somebody else', async () => {
    // The defect this exists for: a 401 is answered by re-minting, a re-mint
    // presenting no credentials gets whatever an empty set of credentials
    // authenticates, and an administrator whose roles changed underneath them
    // silently becomes that account. Sections vanish, writes fail, nothing
    // says why — an auth event wearing the costume of a UI bug.
    const manager = new SessionManager(new MemoryStorage());
    vi.spyOn(SessionAuth, 'mintSessionAnyNode')
      .mockResolvedValueOnce({ token: 't1', expiresAtMs: Date.now() + DAY_MS, username: 'tom' })
      .mockResolvedValueOnce({ token: 't2', expiresAtMs: Date.now() + DAY_MS, username: 'anonymous' });

    manager.start(registry());
    await vi.waitFor(() => expect(manager.isReady).toBe(true));
    expect(manager.lastIdentityChange).toBeUndefined();

    await manager['mint']();

    expect(manager.lastIdentityChange).toMatchObject({ from: 'tom', to: 'anonymous' });
    manager.stop();
  });

  it('says nothing when the account did not change', async () => {
    // Anonymous is not special here. Anonymous-to-anonymous is not a change,
    // and it is silent for the same reason tom-to-tom would be: the names
    // match. No branch tests the name.
    const manager = new SessionManager(new MemoryStorage());
    vi.spyOn(SessionAuth, 'mintSessionAnyNode')
      .mockResolvedValue({ token: 't', expiresAtMs: Date.now() + DAY_MS, username: 'anonymous' });

    manager.start(registry());
    await vi.waitFor(() => expect(manager.isReady).toBe(true));
    await manager['mint']();

    expect(manager.lastIdentityChange).toBeUndefined();
    manager.stop();
  });

  it('does not report the first session as a change', async () => {
    const manager = new SessionManager(new MemoryStorage());
    vi.spyOn(SessionAuth, 'mintSessionAnyNode')
      .mockResolvedValue({ token: 't', expiresAtMs: Date.now() + DAY_MS, username: 'tom' });

    manager.start(registry());
    await vi.waitFor(() => expect(manager.isReady).toBe(true));

    // An arrival, not a change. There was nobody to stop being.
    expect(manager.lastIdentityChange).toBeUndefined();
    manager.stop();
  });

  it('does not report a change when the node never says who this is', async () => {
    // A node too old to state `username` says nothing about the account, which
    // is not evidence that it changed. A false "you were signed out" is worse
    // than a missing one.
    const manager = new SessionManager(new MemoryStorage());
    vi.spyOn(SessionAuth, 'mintSessionAnyNode')
      .mockResolvedValueOnce({ token: 't1', expiresAtMs: Date.now() + DAY_MS, username: 'tom' })
      .mockResolvedValueOnce({ token: 't2', expiresAtMs: Date.now() + DAY_MS });

    manager.start(registry());
    await vi.waitFor(() => expect(manager.isReady).toBe(true));
    await manager['mint']();

    expect(manager.lastIdentityChange).toBeUndefined();
    manager.stop();
  });

  it('does not report the sign-in the viewer just performed', async () => {
    const manager = new SessionManager(new MemoryStorage());
    vi.spyOn(SessionAuth, 'mintSessionAnyNode')
      .mockResolvedValueOnce({ token: 't1', expiresAtMs: Date.now() + DAY_MS, username: 'anonymous' })
      .mockResolvedValueOnce({ token: 't2', expiresAtMs: Date.now() + DAY_MS, username: 'tom' });

    manager.start(registry());
    await vi.waitFor(() => expect(manager.isReady).toBe(true));
    await manager.signIn({ username: 'tom', password: 'pw' });

    // Deliberate, so not a change to report. Handing the application a "you
    // were signed out" to show someone who has just signed in is the failure.
    expect(manager.lastIdentityChange).toBeUndefined();
    manager.stop();
  });
});

describe('a session that survives a restart', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('restores the whole session, not just the credential', async () => {
    // This used to parse `username` and `roles` and throw them away, which
    // made a restored session indistinguishable from a freshly minted
    // anonymous one — so after a reload core could not tell it had ever been
    // signed in, and had nothing to compare an identity change against.
    const storage = new MemoryStorage();
    storage.setItem('macha.session.v1', JSON.stringify({
      token: 'cached', expiresAtMs: Date.now() + DAY_MS, username: 'tom', roles: ['manager'],
    }));
    vi.spyOn(SessionAuth, 'validateSessionAnyNode').mockResolvedValue({
      roles: ['manager'], expires_unix_ms: Date.now() + DAY_MS,
    } as never);
    const manager = new SessionManager(storage);

    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.isReady).toBe(true));

    // The restored identity is real enough to be compared against: a re-mint
    // that lands on a different account is now reportable.
    vi.spyOn(SessionAuth, 'mintSessionAnyNode')
      .mockResolvedValue({ token: 'fresh', expiresAtMs: Date.now() + DAY_MS, username: 'anonymous' });
    await manager['mint']();

    expect(manager.lastIdentityChange).toMatchObject({ from: 'tom', to: 'anonymous' });
    manager.stop();
  });

  it('caches into the host secure store ahead of persistent storage', async () => {
    // Every session goes there, not only a credentialed one. A session is a
    // session; the account it belongs to may have no password, and that does
    // not make the bearer less worth protecting.
    const secure = memoryStorage();
    const persistent = memoryStorage();
    configureMachaHost({ storage: persistent, secureStorage: secure });
    vi.spyOn(SessionAuth, 'mintSessionAnyNode')
      .mockResolvedValue({ token: 'token-s', expiresAtMs: Date.now() + DAY_MS });
    const manager = new SessionManager();

    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.isReady).toBe(true));
    manager.stop();

    expect(JSON.parse(secure.getItem('macha.session.v1') ?? 'null')).toMatchObject({ token: 'token-s' });
    expect(persistent.getItem('macha.session.v1')).toBeNull();
  });

  it('falls back to persistent storage when the host offers no secure store', async () => {
    // Stated rather than implied: core cannot make a platform safer than it
    // is, and a host that supplies nothing gets durable storage rather than
    // storage that dies with the run.
    const persistent = memoryStorage();
    configureMachaHost({ storage: persistent, secureStorage: undefined });
    vi.spyOn(SessionAuth, 'mintSessionAnyNode')
      .mockResolvedValue({ token: 'token-p', expiresAtMs: Date.now() + DAY_MS });
    const manager = new SessionManager();

    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.isReady).toBe(true));
    manager.stop();

    expect(JSON.parse(persistent.getItem('macha.session.v1') ?? 'null')).toMatchObject({ token: 'token-p' });
  });
});

describe('signing out', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('revokes server-side rather than only forgetting', async () => {
    // Dropping a token locally leaves the session valid on every node until it
    // expires, and anyone holding it keeps the access it grants.
    const revoke = vi.spyOn(SessionAuth, 'revokeSessionAnyNode').mockResolvedValue(undefined);
    vi.spyOn(SessionAuth, 'mintSessionAnyNode')
      .mockResolvedValue({ token: 'live', expiresAtMs: Date.now() + DAY_MS, username: 'tom' });
    const manager = new SessionManager(new MemoryStorage());

    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.isReady).toBe(true));
    await manager.signOut();

    expect(revoke).toHaveBeenCalledWith(expect.anything(), 'live');
    expect(await manager.authorization()).toBeUndefined();
  });

  it('clears local state even when the revoke fails, and still reports the failure', async () => {
    // Ordered so the two cannot conflict: once the viewer has asked to be
    // signed out, ending up still signed in is the outcome that must not
    // happen — but a caller showing "signed out" needs to be able to learn
    // that the session is still live somewhere.
    const storage = new MemoryStorage();
    vi.spyOn(SessionAuth, 'revokeSessionAnyNode').mockRejectedValue(new Error('no node answered'));
    vi.spyOn(SessionAuth, 'mintSessionAnyNode')
      .mockResolvedValue({ token: 'live', expiresAtMs: Date.now() + DAY_MS, username: 'tom' });
    const manager = new SessionManager(storage);

    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.isReady).toBe(true));

    await expect(manager.signOut()).rejects.toThrow('no node answered');
    expect(await manager.authorization()).toBeUndefined();
    expect(storage.getItem('macha.session.v1')).toBeNull();
    expect(manager.roles).toBeUndefined();
  });
});

describe('what a subscriber sees at the moment the session becomes ready', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('never publishes ready with the session not yet applied', async () => {
    // A three-state gate — unknown / granted / denied — must never read
    // `unknown` as a refusal. `settle()` used to run at the *top* of `adopt`,
    // so the first notification a subscriber saw carried `isReady === true`
    // with no token and no roles: momentarily indistinguishable from a session
    // the cluster granted nothing. That window is how a privileged viewer
    // lands on a login screen, and a restored signed-in session makes it
    // matter rather than merely exist.
    vi.spyOn(SessionAuth, 'mintSessionAnyNode').mockResolvedValue({
      token: 'ready-token', expiresAtMs: Date.now() + DAY_MS, username: 'tom', roles: ['manager'],
    });
    const manager = new SessionManager(new MemoryStorage());
    const readySnapshots: Array<{ roles: unknown; authorized: boolean }> = [];
    manager.subscribe(() => {
      if (!manager.isReady) return;
      readySnapshots.push({ roles: manager.roles, authorized: manager['token'] !== undefined });
    });

    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.isReady).toBe(true));

    expect(readySnapshots.length).toBeGreaterThan(0);
    for (const snapshot of readySnapshots) {
      expect(snapshot.authorized).toBe(true);
      expect(snapshot.roles).toEqual(['manager']);
    }
    manager.stop();
  });

  it('still becomes ready when a mint fails, so a gate is never left waiting', async () => {
    vi.spyOn(SessionAuth, 'mintSessionAnyNode').mockRejectedValue(new Error('unreachable'));
    const manager = new SessionManager(new MemoryStorage());

    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a'])));
    await vi.waitFor(() => expect(manager.isReady).toBe(true));

    expect(manager.roles).toBeUndefined();
    expect(manager.lastMintFailure).toBeDefined();
    manager.stop();
  });
});

describe('fetch on a manager with nothing to mint against', () => {
  afterEach(() => vi.unstubAllGlobals());

  /**
   * The contract this class documents is that a caller never has to know
   * whether a session exists yet. Before `start()` there is no registry and no
   * bootstrap in flight, so the old code sent the request tokenless, took the
   * 401, and returned it — handing the caller exactly the answer it had been
   * promised it would never see. The web client met this on a reload into a
   * player URL, 18 ms after load, and a viewer got a broken video.
   */
  it('refuses rather than sending a request that can only 401', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(new SessionManager(memoryStorage()).fetch('http://node.test/api/v1/users'))
      .rejects.toBeInstanceOf(SessionNotStartedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * Deliberately a `MachaConnectionError`. The phone client's `MediaApi.serve`
   * falls back to its downloaded library on that classification, and a fresh
   * error type would have escaped the fallback and put a bearer-token message
   * on a library screen — which is the thing that fallback exists to prevent.
   * So this needs no client change to be handled sanely.
   */
  it('is a connection error, so an existing offline fallback still catches it', async () => {
    vi.stubGlobal('fetch', vi.fn());

    await expect(new SessionManager(memoryStorage()).fetch('http://node.test/api/v1/users'))
      .rejects.toBeInstanceOf(MachaConnectionError);
  });

  it('says it was never started, which is routine rather than a caller mistake', async () => {
    // React runs child effects before parent effects, so on both React Native
    // clients a screen's first request fires before the provider starts the
    // manager, on every cold start.
    vi.stubGlobal('fetch', vi.fn());

    await expect(new SessionManager(memoryStorage()).fetch('http://node.test/api/v1/users'))
      .rejects.toMatchObject({ reason: 'not-started' });
  });

  it('distinguishes a teardown from a cold start', async () => {
    // A reconfiguration whose cleanup stopped the manager while a request was
    // in flight. A restart usually follows within milliseconds, and a client
    // may want to treat that differently from never having started at all.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    const manager = new SessionManager(memoryStorage());
    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a.test'])));
    manager.stop();

    await expect(manager.fetch('http://node.test/api/v1/users'))
      .rejects.toMatchObject({ reason: 'stopped' });
  });

  it('still sends once a registry is present', async () => {
    // The refusal must not swallow the normal path: with somewhere to mint
    // against, fetch behaves exactly as before.
    vi.spyOn(SessionAuth, 'mintSessionAnyNode').mockResolvedValue({ token: 'live', expiresAtMs: Date.now() + DAY_MS });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const manager = new SessionManager(memoryStorage());
    manager.start(new EndpointRegistry(bootstrapEndpoints(['http://a.test'])));

    await expect(manager.fetch('http://node.test/api/v1/users')).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe('signIn on a manager with nothing to mint against', () => {
  afterEach(() => vi.unstubAllGlobals());

  /**
   * Raised by the web client: its login screen sorts 401/403 ("check your
   * username and password") from everything else ("the node could not be
   * reached"). A plain Error landed in the second bucket and told a viewer a
   * healthy node was down. The typed error lands there too — it is a
   * connection state — but the screen can now tell the manager was never
   * started, which is an app fault, not a network one.
   */
  it('throws the same typed refusal as fetch, so a login screen can tell it apart', async () => {
    vi.stubGlobal('fetch', vi.fn());

    await expect(new SessionManager(memoryStorage()).signIn({ username: 'u', password: 'p' }))
      .rejects.toMatchObject({ name: 'SessionNotStartedError', reason: 'not-started' });
  });
});

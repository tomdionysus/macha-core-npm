import { afterEach, describe, expect, it, vi } from 'vitest';
import { MachaUsersApi, MachaUsersApiError } from './MachaUsersApi.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function user(username: string) {
  return {
    id: `id-${username}`,
    username,
    roles: ['media_viewer'],
    created_unix_ms: 1,
    updated_unix_ms: 1,
    credential_generation: 1,
    version: 1,
    mutable: { rename: true, delete: true, set_password: true, set_roles: true },
  };
}

describe('MachaUsersApi.list', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the collection the server actually sends, keyed `users`', async () => {
    // Not `items`, which is what every other collection in this API uses and
    // what this originally assumed. The cost of that assumption was a screen
    // that rendered its heading and nothing else.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ users: [user('alice')] })));
    await expect(new MachaUsersApi('http://node.test').list()).resolves.toEqual([user('alice')]);
  });

  it('also reads an `items` envelope, since being generous about it costs nothing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ items: [user('alice')] })));
    await expect(new MachaUsersApi('http://node.test').list()).resolves.toEqual([user('alice')]);
  });

  it('reads a bare array, because not every collection on this API is wrapped', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([user('alice'), user('bob')])));
    const users = await new MachaUsersApi('http://node.test').list();
    expect(users.map((entry) => entry.username)).toEqual(['alice', 'bob']);
  });

  it('fails loudly on a shape it does not recognise, rather than resolving to nothing', async () => {
    // Reading `.items` off a payload that has none yields `undefined`, which
    // is not an error anywhere downstream: the screen renders its heading and
    // nothing else, and looks broken rather than reporting a bad answer.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ accounts: [user('alice')], count: 1 })));
    await expect(new MachaUsersApi('http://node.test').list()).rejects.toBeInstanceOf(MachaUsersApiError);
  });

  it('separates a permission refusal from a dead session', async () => {
    // 403 must never drive a re-mint: the token is fine and the account
    // simply may not do this, so retrying would loop instead of reporting.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
      { error: { code: 'forbidden', message: "this action requires the 'manage_users' role" } }, 403,
    )));
    await expect(new MachaUsersApi('http://node.test').list()).rejects.toMatchObject({ status: 403, forbidden: true });
  });
});

describe('MachaUsersApi reads', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('escapes an id rather than pasting it into the path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(user('alice')));
    vi.stubGlobal('fetch', fetchMock);

    await new MachaUsersApi('http://node.test').get('id with/slash');

    expect(fetchMock.mock.calls[0][0]).toBe('http://node.test/api/v1/users/id%20with%2Fslash');
  });

  it('reads the signed-in account from /users/me', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(user('alice')));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new MachaUsersApi('http://node.test').me()).resolves.toEqual(user('alice'));
    expect(fetchMock.mock.calls[0][0]).toBe('http://node.test/api/v1/users/me');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'GET' });
  });

  it('reads the current session, including a server that states no account', async () => {
    // A 0.37.2 node answers this route with an id, roles and two timestamps and
    // nothing else: it has sessions but not yet accounts. Typing user_id as
    // required would be a promise some servers do not keep.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      roles: ['media_viewer'],
      expires_unix_ms: 99,
    })));

    await expect(new MachaUsersApi('http://node.test').currentSession()).resolves.toEqual({
      roles: ['media_viewer'],
      expires_unix_ms: 99,
    });
  });
});

describe('MachaUsersApi mutations', () => {
  afterEach(() => vi.unstubAllGlobals());

  function sentBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
    return JSON.parse(String(fetchMock.mock.calls[0][1].body)) as Record<string, unknown>;
  }

  it('creates an account with the three fields the server requires', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(user('new'), 201));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      new MachaUsersApi('http://node.test').create({ username: 'new', password: 'pw', roles: ['media_viewer'] }),
    ).resolves.toEqual(user('new'));
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' });
    expect(sentBody(fetchMock)).toEqual({ username: 'new', password: 'pw', roles: ['media_viewer'] });
  });

  /**
   * The rule the update body is built around. `username: undefined` serialises
   * to an absent key here, but a body assembled less carefully sends an
   * explicit null — which a server distinguishing absent from null reads as
   * "clear it". A rename nobody asked for is a bad way to find that out.
   */
  it('sends only the fields the caller actually set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(user('alice')));
    vi.stubGlobal('fetch', fetchMock);

    await new MachaUsersApi('http://node.test').update('id-alice', { roles: ['importer'] });

    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'PATCH' });
    expect(sentBody(fetchMock)).toEqual({ roles: ['importer'] });
    expect(Object.keys(sentBody(fetchMock))).not.toContain('username');
    expect(Object.keys(sentBody(fetchMock))).not.toContain('password');
  });

  it('sends an empty patch rather than inventing fields when nothing was set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(user('alice')));
    vi.stubGlobal('fetch', fetchMock);

    await new MachaUsersApi('http://node.test').update('id-alice', {});

    expect(sentBody(fetchMock)).toEqual({});
  });

  it('deletes an account and accepts the 204 that says so', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new MachaUsersApi('http://node.test').remove('id-alice')).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'DELETE' });
  });

  it('changes an own password and hands back the replacement session', async () => {
    // The old bearer stops validating the moment credential_generation bumps,
    // so the caller needs the new token from this response or it is signed out.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ token: 'fresh', expires_unix_ms: 42 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new MachaUsersApi('http://node.test').changeOwnPassword('pw')).resolves.toEqual({
      token: 'fresh',
      expires_unix_ms: 42,
    });
    expect(fetchMock.mock.calls[0][0]).toBe('http://node.test/api/v1/users/me');
    expect(sentBody(fetchMock)).toEqual({ password: 'pw' });
  });

  it('revokes the session server-side on logout', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new MachaUsersApi('http://node.test').logout()).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe('http://node.test/api/v1/session');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'DELETE' });
  });
});

describe('MachaUsersApi failures', () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports the server's own sentence, not its status line", async () => {
    // statusText is empty on React Native's fetch, so a refusal that degrades
    // to status plus statusText reaches the viewer as a bare number while the
    // server's explanation sits unread in the body.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
      { error: { code: 'username_taken', message: 'That username is already in use.' } }, 409,
    )));

    await expect(
      new MachaUsersApi('http://node.test').create({ username: 'alice', password: 'pw', roles: [] }),
    ).rejects.toMatchObject({
      message: 'That username is already in use.',
      status: 409,
      code: 'username_taken',
    });
  });

  it('treats a dead session as a dead session, not a refusal', async () => {
    // The mirror of the 403 case: a 401 means the token is gone and re-minting
    // is the right response, so `forbidden` must stay false here.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
      { error: { code: 'unauthorized', message: 'no session' } }, 401,
    )));

    await expect(new MachaUsersApi('http://node.test').me())
      .rejects.toMatchObject({ status: 401, forbidden: false });
  });
});

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

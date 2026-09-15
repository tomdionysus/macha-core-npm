import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClusterEndpointRouter } from '../cluster/endpointRouting.js';
import { createFakeCluster } from '../test/fakeCluster.js';
import { ClusterUsersApi } from './ClusterUsersApi.js';
import type { MachaUser } from './UsersApi.js';

const NODE_A = 'https://a.example';
const NODE_B = 'https://b.example';

function user(id: string): MachaUser {
  return {
    id,
    username: id,
    roles: ['media_viewer'],
    created_unix_ms: 1,
    updated_unix_ms: 1,
    credential_generation: 1,
    version: 1,
    mutable: { rename: true, delete: true, set_password: true, set_roles: true },
  };
}

function cluster() {
  const fake = createFakeCluster([NODE_A, NODE_B]);
  const api = new ClusterUsersApi(new ClusterEndpointRouter(fake.registry));
  return { ...fake, api };
}

/** The nodes that were actually dialled, in order, without duplicates. */
function nodesCalled(calls: ReadonlyArray<{ url: string }>): string[] {
  const seen: string[] = [];
  for (const { url } of calls) {
    const base = [NODE_A, NODE_B].find((candidate) => url.startsWith(candidate));
    if (base && !seen.includes(base)) seen.push(base);
  }
  return seen;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ClusterUsersApi reads', () => {
  it('fails over to the next node when one answers 5xx', async () => {
    const { api, node, calls } = cluster();
    node(NODE_A).queueStatus(503, { error: { code: 'starting', message: 'still starting' } });
    node(NODE_B).queueStatus(200, { items: [user('u1')] });

    await expect(api.list()).resolves.toEqual([user('u1')]);
    expect(nodesCalled(calls)).toEqual([NODE_A, NODE_B]);
  });

  it('does not walk the cluster for a refusal the whole cluster would repeat', async () => {
    // A 403 is a policy answer from a healthy node. Asking its neighbours is a
    // slower way to be told the same thing, and it would mark nodes that are
    // working perfectly as having failed.
    const { api, node, calls } = cluster();
    node(NODE_A).queueStatus(403, { error: { code: 'forbidden', message: 'requires manage_users' } });

    await expect(api.list()).rejects.toMatchObject({ status: 403 });
    expect(nodesCalled(calls)).toEqual([NODE_A]);
  });

  it('routes me() and currentSession() as reads that fail over', async () => {
    const { api, node, calls } = cluster();
    node(NODE_A).queueNetworkFailure();
    node(NODE_B).queueStatus(200, user('me'));

    await expect(api.me()).resolves.toEqual(user('me'));
    expect(nodesCalled(calls)).toEqual([NODE_A, NODE_B]);
  });

  it('reuses one per-node client across reads to the same node', async () => {
    const { api, node } = cluster();
    node(NODE_A).queueStatus(200, { items: [user('u1')] });
    node(NODE_A).queueStatus(200, user('u1'));

    await expect(api.list()).resolves.toEqual([user('u1')]);
    await expect(api.get('u1')).resolves.toEqual(user('u1'));
  });
});

describe('ClusterUsersApi mutations', () => {
  /**
   * The rule this class is arranged around, and the reason a mutation router
   * exists at all: a read retried elsewhere costs nothing, a create retried
   * after an ambiguous failure makes a second account.
   *
   * A 500 is retryable *as a read* — `retryableEndpointFailure` says so, and
   * `list()` above proves it — so this is the one assertion that separates the
   * two paths. If `create` ever routes through `request()` instead of
   * `mutation()`, everything else in this file still passes.
   */
  it('attempts a create on exactly one node, even when the failure is retryable', async () => {
    const { api, node, calls } = cluster();
    node(NODE_A).queueStatus(500, { error: { code: 'internal', message: 'boom' } });

    await expect(api.create({ username: 'new', password: 'pw', roles: ['media_viewer'] })).rejects.toThrow();
    expect(nodesCalled(calls)).toEqual([NODE_A]);
  });

  it('attempts an update on exactly one node', async () => {
    const { api, node, calls } = cluster();
    node(NODE_A).queueStatus(500, { error: { code: 'internal', message: 'boom' } });

    await expect(api.update('u1', { username: 'renamed' })).rejects.toThrow();
    expect(nodesCalled(calls)).toEqual([NODE_A]);
  });

  it('attempts a remove on exactly one node', async () => {
    const { api, node, calls } = cluster();
    node(NODE_A).queueStatus(500, { error: { code: 'internal', message: 'boom' } });

    await expect(api.remove('u1')).rejects.toThrow();
    expect(nodesCalled(calls)).toEqual([NODE_A]);
  });

  it('attempts a password change on exactly one node', async () => {
    const { api, node, calls } = cluster();
    node(NODE_A).queueStatus(500, { error: { code: 'internal', message: 'boom' } });

    await expect(api.changeOwnPassword('pw')).rejects.toThrow();
    expect(nodesCalled(calls)).toEqual([NODE_A]);
  });

  it('attempts a logout on exactly one node', async () => {
    // A revoke propagates from whichever node accepts it, so a retry elsewhere
    // would revoke nothing new and could mask the first attempt having worked.
    const { api, node, calls } = cluster();
    node(NODE_A).queueStatus(500, { error: { code: 'internal', message: 'boom' } });

    await expect(api.logout()).rejects.toThrow();
    expect(nodesCalled(calls)).toEqual([NODE_A]);
  });

  it('carries a successful mutation back to the caller', async () => {
    const { api, node, calls } = cluster();
    node(NODE_A).queueStatus(201, user('new'));

    await expect(api.create({ username: 'new', password: 'pw', roles: ['media_viewer'] })).resolves.toEqual(user('new'));
    expect(nodesCalled(calls)).toEqual([NODE_A]);
  });

  it('accepts a 204 from a remove', async () => {
    const { api, node } = cluster();
    node(NODE_A).queueStatus(204);

    await expect(api.remove('u1')).resolves.toBeUndefined();
  });
});

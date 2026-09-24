import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapEndpoints, EndpointRegistry } from './EndpointRegistry.js';
import { ClusterEndpointRouter } from './endpointRouting.js';
import { reportClusterReachable } from '../api/serverConnection.js';
import { clearClientDiagnostics, clientDiagnosticsSnapshot, configureClientDiagnostics } from '../diagnostics/ClientLog.js';

beforeEach(() => {
  clearClientDiagnostics();
  configureClientDiagnostics({ level: 'debug', console: false, maxEntries: 100 });
});

afterEach(() => {
  reportClusterReachable();
  vi.unstubAllGlobals();
});

describe('ClusterEndpointRouter', () => {
  it('makes the first working alternative authoritative without letting probes steal authority', async () => {
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
    const router = new ClusterEndpointRouter(registry);
    const first = vi.fn(async (endpoint: { id: string }) => {
      if (endpoint.id === 'http://a') throw new TypeError('node A unreachable');
      return endpoint.id;
    });

    await expect(router.request(first)).resolves.toBe('http://b');
    registry.recordProbeSuccess('http://a');

    const second = vi.fn(async (endpoint: { id: string }) => endpoint.id);
    await expect(router.request(second)).resolves.toBe('http://b');
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('records health from an advisory read without moving authority to whichever node answered', async () => {
    let now = 1_000;
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']), () => now);
    const router = new ClusterEndpointRouter(registry);
    // Real work first, because authority is meant to follow real work alone.
    await router.request(async (endpoint) => endpoint.id);

    const advisory = vi.fn(async (endpoint: { id: string }) => {
      if (endpoint.id === 'http://a') throw new TypeError('status call timed out');
      return endpoint.id;
    });
    await expect(router.request(advisory, undefined, { advisory: true })).resolves.toBe('http://b');

    // The failure is still evidence: it cools the node down and the walk moved
    // on, so this is not an advisory read that recorded nothing.
    expect(registry.candidates()[0]?.endpoint.id).toBe('http://b');
    // Past that cooldown only authority is left to explain the order, and a
    // background read must not have taken it from the node serving the viewer.
    now += 60_000;
    expect(registry.candidates()[0]?.endpoint.id).toBe('http://a');
  });

  it('does not let a host listener that throws turn a successful route into a failure', async () => {
    // The registry notifies on every recorded outcome, and the recording is
    // on the success path — so an unguarded listener turned a request that had
    // *worked* into a rejection, and could take the health loop with it.
    // Presentation must not be able to break routing.
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a']));
    const router = new ClusterEndpointRouter(registry);
    registry.subscribe(() => { throw new Error('a host listener blew up'); });

    await expect(router.request(async (endpoint) => endpoint.id)).resolves.toBe('http://a');
    expect(registry.candidates()[0]?.health.lastSuccessAt).toBeDefined();
  });

  it('routes a mutation once through current authority and does not replay an ambiguous failure', async () => {
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
    const router = new ClusterEndpointRouter(registry);
    await router.request(async (endpoint) => endpoint.id === 'http://a'
      ? Promise.reject(new TypeError('node A unreachable'))
      : endpoint.id);
    const mutation = vi.fn(async (_endpoint: { id: string }) => { throw new TypeError('connection lost after send'); });

    await expect(router.mutation(mutation)).rejects.toThrow();
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(mutation.mock.calls[0]?.[0].id).toBe('http://b');
  });

  it('reports every exhausted endpoint instead of implying only the final node was tried', async () => {
    const router = new ClusterEndpointRouter(new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b'])));
    await expect(router.request(async () => { throw new TypeError('unavailable'); }))
      .rejects.toMatchObject({ unreachable: true });
  });

  it('does not describe reachable nodes returning API errors as unreachable', async () => {
    const router = new ClusterEndpointRouter(new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b'])));
    await expect(router.request(async () => {
      throw Object.assign(new Error('temporarily unavailable'), { status: 503 });
    })).rejects.toThrow('All configured Macha API endpoints failed.');
  });

  it('does not fail over or damage endpoint health when a caller cancels its own request', async () => {
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
    const router = new ClusterEndpointRouter(registry);
    const operation = vi.fn(async () => {
      throw new DOMException('consumer left', 'AbortError');
    });

    await expect(router.request(operation)).rejects.toMatchObject({ name: 'AbortError' });

    expect(operation).toHaveBeenCalledTimes(1);
    expect(registry.snapshot().map(({ health }) => health.consecutiveFailures)).toEqual([0, 0]);
  });

  it('records node selection, attempt order and failure evidence to bounded diagnostics', async () => {
    const router = new ClusterEndpointRouter(new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b'])));
    await expect(router.request(async (endpoint) => endpoint.id === 'http://a'
      ? Promise.reject(new TypeError('node A unreachable'))
      : endpoint.id)).resolves.toBe('http://b');

    const events = clientDiagnosticsSnapshot()
      .filter((entry) => entry.scope === 'cluster.routing')
      .map((entry) => entry.event);
    expect(events).toEqual(['route-attempt', 'route-endpoint-failed', 'route-attempt', 'route-success']);
  });

  it('does not let an exhausted foreground read declare a cluster-wide outage', async () => {
    const dispatchEvent = vi.fn();
    class TestCustomEvent {
      constructor(public readonly type: string) {}
    }
    vi.stubGlobal('window', { dispatchEvent });
    vi.stubGlobal('CustomEvent', TestCustomEvent);
    const router = new ClusterEndpointRouter(new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b'])));

    await expect(router.request(async () => { throw new TypeError('request failed'); })).rejects.toThrow();

    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  describe('pinned work', () => {
    const endpointOf = (registry: EndpointRegistry, id: string) =>
      registry.snapshot().find((candidate) => candidate.endpoint.id === id)!.endpoint;

    it('runs on the given endpoint even when it is not the best candidate', async () => {
      // A playback session lives on the node that created it. A PATCH sent
      // anywhere else addresses a session that does not exist there — not a
      // fallback, a different and wrong request.
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
      registry.recordSuccess('http://a');
      const router = new ClusterEndpointRouter(registry);
      const attempted: string[] = [];

      await router.pinned(endpointOf(registry, 'http://b'), async (endpoint) => {
        attempted.push(endpoint.id);
        return 'ok';
      });

      expect(attempted).toEqual(['http://b']);
    });

    it('feeds endpoint health from pinned work rather than losing it', async () => {
      // The alternative — calling a node's API directly — silently costs the
      // registry every success and failure on the node doing the most work.
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
      const router = new ClusterEndpointRouter(registry);

      await router.pinned(endpointOf(registry, 'http://b'), async () => 'ok');

      expect(registry.candidates()[0].endpoint.id).toBe('http://b');
      expect(registry.selectionAxis()).toBe('sticky');
    });

    it('never retries elsewhere and records the failure against the pinned node', async () => {
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
      const router = new ClusterEndpointRouter(registry);
      const attempted: string[] = [];

      await expect(router.pinned(endpointOf(registry, 'http://a'), async (endpoint) => {
        attempted.push(endpoint.id);
        throw Object.assign(new Error('node fell over'), { status: 503 });
      })).rejects.toThrow('node fell over');

      expect(attempted).toEqual(['http://a']);
      expect(registry.snapshot()[0].health.consecutiveFailures).toBe(1);
    });

    it('leaves health alone when the failure is about the title rather than the node', async () => {
      // With a small cluster and an escalating cooldown, one unplayable file
      // could otherwise cool every node out of the candidate list in turn.
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://a']));
      const router = new ClusterEndpointRouter(registry);

      await expect(router.pinned(endpointOf(registry, 'http://a'), async () => {
        throw Object.assign(new Error('pipeline refused'), { status: 500, code: 'stream_failed' });
      })).rejects.toThrow('pipeline refused');

      expect(registry.snapshot()[0].health.consecutiveFailures).toBe(0);
    });
  });

  describe('cancelling a read', () => {
    it('stops the walk rather than only the attempt in flight', async () => {
      // Without this a caller that has gone away — a screen unmounted
      // mid-load — still pays for every remaining candidate before its result
      // is discarded.
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b', 'http://c']));
      const router = new ClusterEndpointRouter(registry);
      const controller = new AbortController();
      const attempted: string[] = [];

      await expect(router.request(async (endpoint) => {
        attempted.push(endpoint.id);
        controller.abort();
        throw Object.assign(new Error('node fell over'), { status: 503 });
      }, controller.signal)).rejects.toThrow();

      expect(attempted).toEqual(['http://a']);
    });

    it('records no failure against a node when the caller cancelled', async () => {
      // Cancellation is client intent, never endpoint evidence.
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://a']));
      const router = new ClusterEndpointRouter(registry);
      const controller = new AbortController();
      controller.abort();

      await expect(router.request(async () => 'unreached', controller.signal)).rejects.toThrow();

      expect(registry.snapshot()[0].health.consecutiveFailures).toBe(0);
    });
  });
});

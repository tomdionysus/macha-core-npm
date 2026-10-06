import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapEndpoints, EndpointRegistry } from './EndpointRegistry.js';
import { ClusterEndpointRouter, READ_YOUR_WRITES_MS } from './endpointRouting.js';
import { configureMachaHost, resetMachaHost } from '../runtime/host.js';
import { MachaRequestTimeoutError, reportClusterReachable } from '../api/serverConnection.js';
import { failureRetryAfterMs, MachaClusterRouteError, mutationOutcomeUnknown } from './endpointFailure.js';
import { MachaApiError } from '../api/MachaCatalogueApi.js';
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
    // on the success path, so an unguarded listener turned a request that had
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
      // anywhere else addresses a session that does not exist there: not a
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
      // The alternative, calling a node's API directly, silently costs the
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
      // Without this a caller that has gone away (a screen unmounted
      // mid-load) still pays for every remaining candidate before its result
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

  describe('holdOnTimeout, for a read that makes the node work', () => {
    const timeout = () => new MachaRequestTimeoutError('exceeded', 30_000);

    it('stops at a node in good standing that ran out of time, says slow, and charges nothing', async () => {
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
      const router = new ClusterEndpointRouter(registry);
      const operation = vi.fn(async () => { throw timeout(); });

      const error = await router.request(operation, undefined, { holdOnTimeout: true }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(MachaClusterRouteError);
      expect(error).toMatchObject({ slow: true, unreachable: false, endpointIds: ['http://a'] });
      expect(operation).toHaveBeenCalledTimes(1);
      expect(registry.snapshot()[0].health.consecutiveFailures).toBe(0);
    });

    it('walks on past a lapsed node that times out', async () => {
      let now = 0;
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']), () => now);
      for (; now <= 30_000; now += 10_000) {
        registry.recordProbeFailure('http://a');
        registry.recordProbeFailure('http://b');
      }
      registry.recordProbeSuccess('http://b');
      for (; now <= 70_000; now += 10_000) registry.recordProbeFailure('http://b');
      // Both lapsed: neither is in good standing, so a timeout is no evidence of work.
      expect(registry.candidates().every(({ lapsed }) => lapsed)).toBe(true);
      const router = new ClusterEndpointRouter(registry);
      const operation = vi.fn(async (endpoint: { id: string }) => {
        if (endpoint.id === 'http://a') throw timeout();
        return endpoint.id;
      });

      await expect(router.request(operation, undefined, { holdOnTimeout: true })).resolves.toBe('http://b');
    });

    it('still walks on a refused connection, and on a timeout without the option', async () => {
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
      const router = new ClusterEndpointRouter(registry);
      const refused = vi.fn(async (endpoint: { id: string }) => {
        if (endpoint.id === 'http://a') throw new TypeError('connection refused');
        return endpoint.id;
      });
      await expect(router.request(refused, undefined, { holdOnTimeout: true })).resolves.toBe('http://b');

      const slow = vi.fn(async (endpoint: { id: string }) => {
        if (endpoint.id === 'http://b') throw timeout();
        return endpoint.id;
      });
      await expect(router.request(slow)).resolves.toBe('http://a');
    });
  });

  describe('a failure that is not the node\'s', () => {
    // The Android TV client, 2026-09-24: every node answered 503
    // catalogue_unavailable while playback answered, and Home reported every
    // endpoint failed. The server gives that code no scope.
    const catalogueDown = () => new MachaApiError('catalogue metadata durability unavailable', 503, 'catalogue_unavailable');
    const failures = (registry: EndpointRegistry) => registry.snapshot().map(({ health }) => health.consecutiveFailures);

    it('walks on past catalogue_unavailable without charging any node', async () => {
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
      const router = new ClusterEndpointRouter(registry);
      const operation = vi.fn(async (endpoint: { id: string }) => {
        if (endpoint.id === 'http://a') throw catalogueDown();
        return endpoint.id;
      });
      await expect(router.request(operation)).resolves.toBe('http://b');
      await expect(router.find(async (endpoint) => { if (endpoint.id === 'http://a') throw catalogueDown(); return endpoint.id; })).resolves.toBe('http://b');
      expect(failures(registry)).toEqual([0, 0]);
    });

    it('charges neither a mutation\'s node nor an advisory read\'s for it', async () => {
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
      const router = new ClusterEndpointRouter(registry);
      await expect(router.mutation(async () => { throw catalogueDown(); })).rejects.toThrow();
      await expect(router.request(async () => { throw catalogueDown(); }, undefined, { advisory: true })).rejects.toThrow();
      expect(failures(registry)).toEqual([0, 0]);
    });

    it('does not charge an account-scoped refusal on a walk, as its comment always said', async () => {
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
      const router = new ClusterEndpointRouter(registry);
      const limit = new MachaApiError('limit', 429, 'account_session_limit');
      await expect(router.request(async (endpoint) => { if (endpoint.id === 'http://a') throw limit; return endpoint.id; })).resolves.toBe('http://b');
      expect(failures(registry)).toEqual([0, 0]);
    });

    it('still charges a node\'s own 5xx', async () => {
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
      const router = new ClusterEndpointRouter(registry);
      const broken = new MachaApiError('boom', 500, 'internal_error');
      await expect(router.request(async (endpoint) => { if (endpoint.id === 'http://a') throw broken; return endpoint.id; })).resolves.toBe('http://b');
      expect(failures(registry)).toEqual([1, 0]);
    });
  });
});

describe('a write that ran out of time', () => {
  // 2026-10-05: 13 unmatched deletes all succeeded on fi-1, answering from
  // 3.7 s to 24.1 s, while the client reported 11 as not deleted and charged
  // the node for each.
  it('charges the node nothing, and says the outcome is unknown rather than failed', async () => {
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
    const router = new ClusterEndpointRouter(registry);

    const outcome = await router.mutation(async () => {
      throw new MachaRequestTimeoutError('Request exceeded 8000 ms.', 8000);
    }).catch((error: unknown) => error);

    expect(mutationOutcomeUnknown(outcome)).toBe(true);
    expect(registry.candidates().map((candidate) => candidate.health.consecutiveFailures ?? 0)).toEqual([0, 0]);
    expect(registry.candidates()[0]?.endpoint.id).toBe('http://a');
  });

  it('still charges a write the node refused for its own reasons', async () => {
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
    const router = new ClusterEndpointRouter(registry);

    const outcome = await router.mutation(async () => {
      throw new MachaApiError('unavailable', 503);
    }).catch((error: unknown) => error);

    expect(mutationOutcomeUnknown(outcome)).toBe(false);
    expect(registry.snapshot().find((candidate) => candidate.endpoint.id === 'http://a')?.health.consecutiveFailures).toBe(1);
  });
});

describe('reading back what was just written (server 0.90.0)', () => {
  // A write is visible on the node that took it at once, and on the others a
  // round trip later. Tom, 2026-10-05: keep the reads that follow on it.
  let now = 0;
  beforeEach(() => { now = 1_000; configureMachaHost({ now: () => now }); });
  afterEach(() => resetMachaHost());

  function writtenThroughA() {
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']), () => now);
    const router = new ClusterEndpointRouter(registry);
    return { registry, router, write: () => router.mutation(async (endpoint) => endpoint.id) };
  }

  it('reads from the node that took the write, though the ranking has moved', async () => {
    const { registry, router, write } = writtenThroughA();
    await expect(write()).resolves.toBe('http://a');
    registry.prefer('http://b');

    await expect(router.request(async (endpoint) => endpoint.id)).resolves.toBe('http://a');
    await expect(router.mutation(async (endpoint) => endpoint.id)).resolves.toBe('http://a');
  });

  it('returns to the ranking once the window has passed', async () => {
    const { registry, router, write } = writtenThroughA();
    await write();
    registry.prefer('http://b');
    now += READ_YOUR_WRITES_MS;

    await expect(router.request(async (endpoint) => endpoint.id)).resolves.toBe('http://b');
  });

  it('does not hold to a writer that has failed since', async () => {
    const { registry, router, write } = writtenThroughA();
    await write();
    registry.recordFailure('http://a');

    await expect(router.request(async (endpoint) => endpoint.id)).resolves.toBe('http://b');
  });

  it('leaves an advisory read on the ranking', async () => {
    const { registry, router, write } = writtenThroughA();
    await write();
    registry.prefer('http://b');

    await expect(router.request(async (endpoint) => endpoint.id, undefined, { advisory: true })).resolves.toBe('http://b');
  });

  it('holds reads to a node whose write timed out, since it may have been done there', async () => {
    const { registry, router } = writtenThroughA();
    await router.mutation(async () => { throw new MachaRequestTimeoutError('slow', 30_000); }).catch(() => undefined);
    registry.prefer('http://b');

    await expect(router.request(async (endpoint) => endpoint.id)).resolves.toBe('http://a');
  });
});

describe('a provider refusing the node (server 0.90.19)', () => {
  it('is walked to the next node, which has its own gate, and charges nothing', async () => {
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
    const router = new ClusterEndpointRouter(registry);
    const refusal = Object.assign(new MachaApiError('provider', 503, 'provider_unavailable'), { retryAfterMs: 4000 });

    const answered = await router.request(async (endpoint) => {
      if (endpoint.id === 'http://a') throw refusal;
      return endpoint.id;
    });

    expect(answered).toBe('http://b');
    expect(registry.snapshot().map((candidate) => candidate.health.consecutiveFailures)).toEqual([0, 0]);
  });

  it('keeps the wait readable through the route error', async () => {
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a']));
    const router = new ClusterEndpointRouter(registry);
    const refusal = Object.assign(new MachaApiError('provider', 503, 'provider_unavailable'), { retryAfterMs: 4000 });

    const outcome = await router.request(async () => { throw refusal; }).catch((error: unknown) => error);

    expect(failureRetryAfterMs(outcome)).toBe(4000);
  });
});


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
      .rejects.toThrow('All configured API endpoints are unreachable.');
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
});

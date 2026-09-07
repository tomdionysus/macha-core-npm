import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapEndpoints, EndpointRegistry } from './EndpointRegistry.js';
import { discoverClusterEndpoints, EndpointHealthMonitor, persistConfirmedEndpoints, probeKnownEndpoints } from './EndpointHealthMonitor.js';
import { MachaClientConfiguration } from '../runtime/configuration.js';
import { configureMachaHost, memoryStorage } from '../runtime/host.js';
import { fixedBearerToken } from '../api/SessionManager.js';
import { clearClientDiagnostics, clientDiagnosticsSnapshot, configureClientDiagnostics } from '../diagnostics/ClientLog.js';
import type { ClusterNodeStatus, ClusterStatusApi, ClusterStatusSnapshot } from '../api/ClusterStatusApi.js';

function fakeClusterStatusApi(nodes: readonly ClusterNodeStatus[]): ClusterStatusApi {
  const snapshot = { nodes: [...nodes] } as ClusterStatusSnapshot;
  return {
    status: async () => snapshot,
    node: async () => { throw new Error('not implemented'); },
    checkConnectivity: async () => { throw new Error('not implemented'); },
  };
}

describe('API endpoint health probes', () => {
  beforeEach(() => {
    clearClientDiagnostics();
    configureClientDiagnostics({ level: 'debug', console: false, maxEntries: 100 });
  });

  it('records a reachable/known summary to bounded diagnostics each cycle', async () => {
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
    const fetchImpl = vi.fn(async (url: string | URL | Request) => new Response(null, {
      status: String(url).startsWith('http://a/') ? 200 : 503,
    })) as unknown as typeof fetch;

    await probeKnownEndpoints(registry, fixedBearerToken(undefined, fetchImpl), new AbortController().signal);

    const entry = clientDiagnosticsSnapshot().find((candidate) => candidate.scope === 'cluster.health');
    expect(entry).toMatchObject({ event: 'probe-cycle', data: { reachable: 2, known: 2 } });
  });

  it('tries every known endpoint and records usable API health', async () => {
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
    registry.recordSuccess('http://a');
    const fetchSpy = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => new Response(null, {
      status: String(url).startsWith('http://a/') ? 200 : 503,
    }));
    const fetchImpl = fetchSpy as unknown as typeof fetch;

    await expect(probeKnownEndpoints(registry, fixedBearerToken('secret', fetchImpl), new AbortController().signal)).resolves.toBe(2);

    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([
      'http://a/api/v1/catalogue/status',
      'http://b/api/v1/catalogue/status',
    ]);
    expect(new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer secret');
    expect(registry.snapshot().map(({ health }) => health.consecutiveFailures)).toEqual([0, 1]);
    expect(registry.candidates()[0]?.endpoint.id).toBe('http://a');
  });

  it('does not publish results after the monitor is cancelled', async () => {
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a']));
    const controller = new AbortController();
    let finish!: (response: Response) => void;
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(false);
      return new Promise<Response>((resolve) => { finish = resolve; });
    }) as typeof fetch;

    const probe = probeKnownEndpoints(registry, fixedBearerToken(undefined, fetchImpl), controller.signal);
    controller.abort();
    finish(new Response(null, { status: 200 }));
    await probe;

    expect(registry.snapshot()[0]?.health).toEqual({ consecutiveFailures: 0 });
  });

  it('does not let a failed background probe permanently give up the endpoint preferred by real traffic', async () => {
    let now = 1_000;
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']), () => now);
    registry.recordSuccess('http://a');
    const fetchImpl = vi.fn(async (url: string | URL | Request) => new Response(null, {
      status: String(url).startsWith('http://a/') ? 503 : 200,
    })) as unknown as typeof fetch;

    await probeKnownEndpoints(registry, fixedBearerToken(undefined, fetchImpl), new AbortController().signal);
    // Still cooling down from the probe failure: a ready alternative sorts first.
    expect(registry.candidates()[0]?.endpoint.id).toBe('http://b');

    now = 1_501;
    // Once the cooldown lapses, the endpoint real traffic preferred resumes
    // authority rather than staying displaced by a mere probe blip.
    expect(registry.candidates()[0]?.endpoint.id).toBe('http://a');
  });

  it('records observed latency from a successful probe and logs a reported pre-emptive swap', async () => {
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a']));
    const nowSpy = vi.fn<() => number>().mockReturnValueOnce(1_000).mockReturnValueOnce(1_500);
    configureMachaHost({ now: nowSpy });
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const recordLatencySpy = vi.spyOn(registry, 'recordLatency');
    vi.spyOn(registry, 'evaluatePreferredSwap').mockReturnValue({
      fromId: 'http://a', toId: 'http://b', fromLatencyMs: 500, toLatencyMs: 50, reason: 'latency',
    });

    await probeKnownEndpoints(registry, fixedBearerToken(undefined, fetchImpl), new AbortController().signal);

    expect(recordLatencySpy).toHaveBeenCalledWith('http://a', 500);
    const entry = clientDiagnosticsSnapshot().find((candidate) => candidate.event === 'preemptive-endpoint-swap');
    expect(entry).toMatchObject({ scope: 'cluster.health', data: { fromId: 'http://a', toId: 'http://b' } });
  });

  it('does not record latency for a reachable-but-non-ok response', async () => {
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a']));
    const recordLatencySpy = vi.spyOn(registry, 'recordLatency');
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 })) as unknown as typeof fetch;

    await probeKnownEndpoints(registry, fixedBearerToken(undefined, fetchImpl), new AbortController().signal);

    expect(recordLatencySpy).not.toHaveBeenCalled();
    expect(registry.latencyMs('http://a')).toBeUndefined();
  });

  it('never attaches lifecycle cancellation to status HTTP requests', async () => {
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a']));
    const lifecycle = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    let finish!: (response: Response) => void;
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => { finish = resolve; });
    }) as typeof fetch;

    const probe = probeKnownEndpoints(registry, fixedBearerToken(undefined, fetchImpl), lifecycle.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Cancelling one consumer (or a playback request) is not evidence
    // about node health — the request's own signal (the bounded-timeout one
    // added alongside it) must never be the same object as that lifecycle
    // signal, so an unrelated unmount can never cancel it.
    expect(capturedSignal).not.toBe(lifecycle.signal);
    expect(capturedSignal?.aborted).toBe(false);
    expect(registry.snapshot()[0]?.health).toEqual({ consecutiveFailures: 0 });
    finish(new Response(null, { status: 200 }));

    await expect(probe).resolves.toBe(1);
    expect(registry.snapshot()[0]?.health.consecutiveFailures).toBe(0);
  });
});

describe('cluster membership discovery', () => {
  it('adds online cluster nodes the registry did not already know about', async () => {
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://10.44.1.50:7438']));
    const clusterStatusApi = fakeClusterStatusApi([
      { id: 'node-50', state: 'online', host: '10.44.1.50', port: 7437, api_host: '10.44.1.50', api_port: 7438 } as ClusterNodeStatus,
      { id: 'node-51', state: 'online', host: '10.44.1.51', port: 7437, api_host: '10.44.1.51', api_port: 7438 } as ClusterNodeStatus,
      { id: 'node-offline', state: 'offline', host: '10.34.1.99', port: 7437, api_host: '10.34.1.99', api_port: 7438 } as ClusterNodeStatus,
    ]);

    await discoverClusterEndpoints(registry, clusterStatusApi);

    const baseUrls = registry.snapshot().map(({ endpoint }) => endpoint.baseUrl);
    expect(baseUrls).toContain('http://10.44.1.51:7438');
    expect(baseUrls).not.toContain('http://10.34.1.99:7438');
    // The originally configured endpoint must survive discovery unchanged.
    expect(baseUrls).toContain('http://10.44.1.50:7438');
  });

  it('does not guess an API endpoint for a node that has not advertised one yet', async () => {
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://10.44.1.50:7438']));
    const clusterStatusApi = fakeClusterStatusApi([
      { id: 'node-50', state: 'online', host: '10.44.1.50', port: 7437, api_host: '10.44.1.50', api_port: 7438 } as ClusterNodeStatus,
      // An older node in a mixed-version cluster: no api_host/api_port yet.
      // `host`/`port` here is its RPC bind address on a different port and
      // must never be guessed at as the API address.
      { id: 'node-51', state: 'online', host: '10.44.1.51', port: 7437 } as ClusterNodeStatus,
    ]);

    await discoverClusterEndpoints(registry, clusterStatusApi);

    const baseUrls = registry.snapshot().map(({ endpoint }) => endpoint.baseUrl);
    expect(baseUrls).toEqual(['http://10.44.1.50:7438']);
  });

  it('makes newly discovered endpoints usable as failover candidates', async () => {
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://10.44.1.50:7438']));
    registry.recordSuccess('http://10.44.1.50:7438');
    const clusterStatusApi = fakeClusterStatusApi([
      { id: 'node-50', state: 'online', host: '10.44.1.50', port: 7437, api_host: '10.44.1.50', api_port: 7438 } as ClusterNodeStatus,
      { id: 'node-51', state: 'online', host: '10.44.1.51', port: 7437, api_host: '10.44.1.51', api_port: 7438 } as ClusterNodeStatus,
    ]);

    await discoverClusterEndpoints(registry, clusterStatusApi);
    registry.recordFailure('http://10.44.1.50:7438');
    const excluded = new Set(['http://10.44.1.50:7438']);

    expect(registry.candidates(excluded).map(({ endpoint }) => endpoint.baseUrl)).toEqual(['http://10.44.1.51:7438']);
  });

  it('leaves the registry untouched when no endpoint can answer the status call', async () => {
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://10.44.1.50:7438']));
    const clusterStatusApi: ClusterStatusApi = {
      status: async () => { throw new Error('unreachable'); },
      node: async () => { throw new Error('not implemented'); },
      checkConnectivity: async () => { throw new Error('not implemented'); },
    };

    await expect(discoverClusterEndpoints(registry, clusterStatusApi)).resolves.toBeUndefined();
    expect(registry.snapshot().map(({ endpoint }) => endpoint.baseUrl)).toEqual(['http://10.44.1.50:7438']);
  });
});

describe('persisted endpoint memory across a reload', () => {
  it('persists a discovered endpoint only once it has actually been confirmed reachable', () => {
    const storage = memoryStorage();
    const configuration = new MachaClientConfiguration({ storage });
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://10.44.1.50:7438']));
    registry.applyAdvertisement([{ nodeId: 'node-51', apiBaseUrls: ['http://10.44.1.51:7438'] }]);

    persistConfirmedEndpoints(registry, configuration);
    expect(storage.getItem('macha-discovered-endpoints-v1')).toBeNull();

    registry.recordProbeSuccess('http://10.44.1.51:7438');
    persistConfirmedEndpoints(registry, configuration);
    expect(JSON.parse(storage.getItem('macha-discovered-endpoints-v1') ?? '')).toEqual({
      version: 1,
      urls: ['http://10.44.1.51:7438'],
    });
  });

  it('never persists the configured bootstrap endpoint itself, even once confirmed reachable', () => {
    const storage = memoryStorage();
    const configuration = new MachaClientConfiguration({ storage });
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://10.44.1.50:7438']));

    registry.recordSuccess('http://10.44.1.50:7438');
    persistConfirmedEndpoints(registry, configuration);

    expect(storage.getItem('macha-discovered-endpoints-v1')).toBeNull();
  });

  it('clears previously persisted endpoints once none are confirmed reachable any more', () => {
    const storage = memoryStorage();
    const configuration = new MachaClientConfiguration({ storage });
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://10.44.1.50:7438']));
    registry.applyAdvertisement([{ nodeId: 'node-51', apiBaseUrls: ['http://10.44.1.51:7438'] }]);
    registry.recordProbeSuccess('http://10.44.1.51:7438');
    persistConfirmedEndpoints(registry, configuration);
    expect(storage.getItem('macha-discovered-endpoints-v1')).not.toBeNull();

    // The next discovery cycle no longer reports node-51 online at all.
    registry.applyAdvertisement([{ nodeId: 'node-50', apiBaseUrls: ['http://10.44.1.50:7438'] }]);
    persistConfirmedEndpoints(registry, configuration);

    expect(storage.getItem('macha-discovered-endpoints-v1')).toBeNull();
  });
});

describe('EndpointHealthMonitor lifecycle', () => {
  it('runs a cycle on start, publishes reachability, and reschedules itself', async () => {
    vi.useFakeTimers();
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a']));
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const monitor = new EndpointHealthMonitor({
      registry,
      clusterStatusApi: fakeClusterStatusApi([]),
      auth: fixedBearerToken(undefined, fetchImpl),
      intervalMs: 10_000,
    });

    monitor.start();
    await vi.waitFor(() => expect(registry.snapshot()[0]?.health.lastSuccessAt).toBeDefined());
    expect(monitor.running).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);

    monitor.stop();
    vi.useRealTimers();
  });

  it('is idempotent on start and on stop, so a repeated teardown cannot leave a loop running', async () => {
    vi.useFakeTimers();
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a']));
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const monitor = new EndpointHealthMonitor({
      registry,
      clusterStatusApi: fakeClusterStatusApi([]),
      auth: fixedBearerToken(undefined, fetchImpl),
      intervalMs: 10_000,
    });

    monitor.start();
    monitor.start();
    await vi.waitFor(() => expect(registry.snapshot()[0]?.health.lastSuccessAt).toBeDefined());
    const afterFirstCycle = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(afterFirstCycle).toBe(1);

    monitor.stop();
    monitor.stop();
    expect(monitor.running).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(afterFirstCycle);
    vi.useRealTimers();
  });

  it('remembers confirmed discoveries only when given somewhere to remember them', async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const configuration = new MachaClientConfiguration({ storage });
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://10.44.1.50:7438']));
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const monitor = new EndpointHealthMonitor({
      registry,
      clusterStatusApi: fakeClusterStatusApi([
        { id: 'node-51', state: 'online', host: '10.44.1.51', port: 7437, api_host: '10.44.1.51', api_port: 7438 } as ClusterNodeStatus,
      ]),
      auth: fixedBearerToken(undefined, fetchImpl),
      configuration,
    });

    monitor.start();
    await vi.waitFor(() => expect(configuration.discoveredEndpoints()).toEqual(['http://10.44.1.51:7438']));

    monitor.stop();
    vi.useRealTimers();
  });
});

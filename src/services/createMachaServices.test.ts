import { afterEach, describe, expect, it, vi } from 'vitest';
import { readJsonBody } from '../api/httpCompat.js';
import { setTransferRecorder } from '../api/transferRecorder.js';
import { bootstrapEndpoints, EndpointRegistry } from '../cluster/EndpointRegistry.js';
import { EndpointBandwidth } from '../cluster/EndpointBandwidth.js';
import { configureMachaHost, memoryStorage } from '../runtime/host.js';
import { createMachaServices } from './createMachaServices.js';
import { fixedBearerToken } from '../api/SessionManager.js';
import type { MediaApi } from '../api/MediaApi.js';
import type { PlaybackResolver } from '../playback/PlaybackResolver.js';

function registry(): EndpointRegistry {
  return new EndpointRegistry(bootstrapEndpoints(['http://a']));
}

describe('createMachaServices', () => {
  it('builds every service over one registry, routing requests to a live endpoint', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

    const services = createMachaServices({
      endpointRegistry: registry(),
      auth: fixedBearerToken('secret', fetchImpl),
    });
    await services.catalogueApi.list();

    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(String(calls[0]?.[0])).toBe('http://a/api/v1/catalogue/items');
    expect(new Headers(calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer secret');
    expect(services.managementAvailable).toBe(true);
  });

  it('needs no authentication to be constructed', () => {
    expect(() => createMachaServices({ endpointRegistry: registry() })).not.toThrow();
  });

  it('honours substituted media and playback implementations, and marks management unavailable', () => {
    const apiOverride = {} as MediaApi;
    const playbackOverride = {} as PlaybackResolver;

    const services = createMachaServices({ endpointRegistry: registry(), apiOverride, playbackOverride });

    expect(services.mediaApi).toBe(apiOverride);
    expect(services.playbackResolver).toBe(playbackOverride);
    // Management screens act on a real Macha cluster; a substituted media API
    // has no cluster behind it.
    expect(services.managementAvailable).toBe(false);
  });
});

describe('core wires throughput; a host only feeds it bytes core cannot see', () => {
  function freshHost(seed: Record<string, string> = {}) {
    const storage = memoryStorage(seed);
    configureMachaHost({ storage, secureStorage: undefined, now: Date.now, uuid: () => 'minted-id' });
    return storage;
  }
  function jsonResponse(url: string, bytes: number): Response {
    // A body that takes measurable time: a 0 ms read is discarded as a sample,
    // since it would claim infinite throughput.
    return { url, headers: { get: () => String(bytes) }, json: async () => { await new Promise((r) => setTimeout(r, 5)); return {}; } } as unknown as Response;
  }
  afterEach(() => { setTransferRecorder(undefined); vi.unstubAllGlobals(); });

  /**
   * The whole point. Core times every JSON read, owns the store, and knows the
   * endpoint a URL belongs to. It used to ask a host to connect those three;
   * two of three never did and never knew the axis was dark.
   */
  it('attaches a store and records its own reads, with the host wiring nothing', async () => {
    freshHost({ 'macha-client-id': 'client-42' });
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a.test']));
    expect(registry.throughputRecordable).toBe(false);

    createMachaServices({ endpointRegistry: registry });
    await readJsonBody(jsonResponse('http://a.test/api/v1/users', 4_000_000));
    await readJsonBody(jsonResponse('http://a.test/api/v1/users', 4_000_000));

    expect(registry.throughputRecordable).toBe(true);
    expect(registry.candidates()[0]?.bytesPerSecond).toBeGreaterThan(0);
  });

  /**
   * Core never fetches media, so it never sees those bytes — and a node that
   * serves nothing but media would have no evidence against it. The web client
   * learned that across an afternoon on its slowest node. Its media bytes go
   * into the same store core records into: one store, one axis.
   */
  it('takes host-fed media bytes into the same store as its own reads', async () => {
    freshHost({ 'macha-client-id': 'client-42' });
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a.test', 'http://b.test']));
    createMachaServices({ endpointRegistry: registry });

    registry.recordTransferByUrl('http://b.test/api/v1/playback/stream/s/cap/0/seg.m4s', 8_000_000, 1_000);
    registry.recordTransferByUrl('http://b.test/api/v1/playback/stream/s/cap/1/seg.m4s', 8_000_000, 1_000);

    const b = registry.candidates().find((candidate) => candidate.endpoint.baseUrl === 'http://b.test');
    expect(b?.bytesPerSecond).toBeGreaterThan(0);
  });

  it('keys the store by the client id the host already has, never a fresh one', () => {
    const storage = freshHost({ 'macha-client-id': 'client-42' });

    createMachaServices({ endpointRegistry: new EndpointRegistry(bootstrapEndpoints(['http://a.test'])) });

    expect(storage.getItem('macha-client-id')).toBe('client-42');
  });

  /**
   * Services are rebuilt when routing changes. The rebuilt set must own the
   * recorder — the old registry is being retired — and the old registry must
   * not keep a second store writing the same key.
   */
  it('moves the recorder to the newest registry on rebuild', async () => {
    freshHost({ 'macha-client-id': 'client-42' });
    const first = new EndpointRegistry(bootstrapEndpoints(['http://a.test']));
    const second = new EndpointRegistry(bootstrapEndpoints(['http://a.test']));
    createMachaServices({ endpointRegistry: first });
    createMachaServices({ endpointRegistry: second });

    await readJsonBody(jsonResponse('http://a.test/api/v1/users', 4_000_000));
    await readJsonBody(jsonResponse('http://a.test/api/v1/users', 4_000_000));

    expect(second.candidates()[0]?.bytesPerSecond).toBeGreaterThan(0);
    expect(first.candidates()[0]?.bytesPerSecond).toBeUndefined();
  });

  it('does not attach a second store to a registry that already has one', () => {
    freshHost({ 'macha-client-id': 'client-42' });
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a.test']));
    createMachaServices({ endpointRegistry: registry });

    expect(registry.attachBandwidth(new EndpointBandwidth('client-42', memoryStorage()))).toBe(false);
  });
});

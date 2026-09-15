import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasTransferRecorder, readJsonBody, setTransferRecorder } from '../api/httpCompat.js';
import { bootstrapEndpoints, EndpointRegistry } from '../cluster/EndpointRegistry.js';
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

describe('core wiring throughput without taking anything over', () => {
  afterEach(() => { setTransferRecorder(undefined); vi.unstubAllGlobals(); });

  /**
   * There is one recorder slot. The web client's carries Direct Play media
   * bytes as well as API bytes — the feed it added after an afternoon
   * streaming from its slowest node, because the record until then described
   * only JSON. Core replacing it would restore that fault silently, while
   * claiming to fix throughput.
   */
  it('leaves a recorder the host already installed alone', async () => {
    const hostRecorder = vi.fn();
    setTransferRecorder(hostRecorder);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a.test']));

    createMachaServices({ endpointRegistry: registry, clientId: 'client-42' });

    expect(hasTransferRecorder()).toBe(true);
    const response = { url: 'http://a.test/x', headers: { get: () => '4000000' }, json: async () => ({}) } as unknown as Response;
    await readJsonBody(response);
    expect(hostRecorder).toHaveBeenCalledWith('http://a.test/x', 4000000, expect.any(Number));
  });

  /**
   * `clientId()` mints and persists a fresh id when the key is absent, and on
   * a prefix-hydrated cache an unhydrated key is indistinguishable from an
   * absent one. Deriving the id here would mint a new identity at
   * service-construction time and orphan every per-client store — the fault
   * the Android TV client hit, and that core now documents. Core will not
   * cause the bug it documents.
   */
  it('records nothing rather than inventing a client id', () => {
    const storage = memoryStorage();
    configureMachaHost({ storage, secureStorage: undefined, now: Date.now, uuid: () => 'minted-id' });
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a.test']));

    createMachaServices({ endpointRegistry: registry });

    expect(registry.throughputRecordable).toBe(false);
    expect(storage.getItem('macha-client-id')).toBeNull();
  });

  it('records when the host states its client id', () => {
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a.test']));

    createMachaServices({ endpointRegistry: registry, clientId: 'client-42' });

    expect(registry.throughputRecordable).toBe(true);
    expect(hasTransferRecorder()).toBe(true);
  });

  it('respects a host that wants the axis dark', () => {
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a.test']));

    createMachaServices({ endpointRegistry: registry, clientId: 'client-42', recordThroughput: false });

    expect(registry.throughputRecordable).toBe(false);
  });
});

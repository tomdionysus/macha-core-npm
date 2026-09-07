import { describe, expect, it, vi } from 'vitest';
import { createMachaServices } from './createMachaServices.js';
import { bootstrapEndpoints, EndpointRegistry } from '../cluster/EndpointRegistry.js';
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

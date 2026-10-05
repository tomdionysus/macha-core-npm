import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapEndpoints, endpointBlockedByHost, EndpointRegistry } from './EndpointRegistry.js';
import { ClusterEndpointRouter } from './endpointRouting.js';
import { MachaNoReachableEndpointError } from './endpointFailure.js';
import { probeKnownEndpoints } from './EndpointHealthMonitor.js';
import { NO_AUTH } from '../api/SessionManager.js';
import { configureMachaHost, resetMachaHost } from '../runtime/host.js';

/**
 * Tom, 2026-10-05: a secure page cannot fetch a plain-http node, so core
 * stops offering one, rather than failing over onto it and reporting the
 * browser's refusal as the node being down.
 */
describe('endpoints a secure page cannot reach', () => {
  afterEach(() => { resetMachaHost(); vi.unstubAllGlobals(); });

  it('blocks plain http from a secure context only, loopback aside', () => {
    expect(endpointBlockedByHost('http://10.35.1.50:7438', true)).toBe('insecure_from_secure_page');
    expect(endpointBlockedByHost('https://macnessa.example', true)).toBeUndefined();
    expect(endpointBlockedByHost('http://localhost:7438', true)).toBeUndefined();
    expect(endpointBlockedByHost('http://127.0.0.1:7438', true)).toBeUndefined();
    expect(endpointBlockedByHost('http://10.35.1.50:7438', false)).toBeUndefined();
    expect(endpointBlockedByHost('http://10.35.1.50:7438', undefined)).toBeUndefined();
  });

  it('leaves a blocked endpoint out of the candidates, and names it in the snapshot', () => {
    configureMachaHost({ secureContext: true });
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://10.35.1.50:7438', 'https://b.example']));

    expect(registry.candidates().map(({ endpoint }) => endpoint.id)).toEqual(['https://b.example']);
    expect(registry.snapshot().map(({ endpoint, blockedByHost }) => [endpoint.id, blockedByHost])).toEqual([
      ['http://10.35.1.50:7438', 'insecure_from_secure_page'],
      ['https://b.example', undefined],
    ]);
  });

  it('offers every endpoint to a host that is not a secure context', () => {
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://10.35.1.50:7438', 'https://b.example']));
    expect(registry.candidates()).toHaveLength(2);
  });

  it('says why, when every endpoint is blocked, and sends nothing', async () => {
    configureMachaHost({ secureContext: true });
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://10.35.1.50:7438']));
    const router = new ClusterEndpointRouter(registry);
    const operation = vi.fn(async () => 'answered');

    await expect(router.request(operation)).rejects.toBeInstanceOf(MachaNoReachableEndpointError);
    await expect(router.mutation(operation)).rejects.toMatchObject({ code: 'insecure_from_secure_page', blocked: ['http://10.35.1.50:7438'] });
    expect(operation).not.toHaveBeenCalled();
  });

  it('does not probe a blocked endpoint', async () => {
    configureMachaHost({ secureContext: true });
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://10.35.1.50:7438', 'https://b.example']));

    await probeKnownEndpoints(registry, NO_AUTH, new AbortController().signal);

    const urls = (fetchMock.mock.calls as unknown as Array<[string]>).map(([url]) => String(url));
    expect(urls.some((url) => url.startsWith('http://10.35.1.50'))).toBe(false);
    expect(urls.some((url) => url.startsWith('https://b.example'))).toBe(true);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { checkEndpointConfiguration, initialConnectionGate, normalizeConnectionEndpoints, shouldEnterConnectionGate } from './connectionConfiguration.js';

describe('connection configuration', () => {
  it('locks a real client with no configured endpoints into first-run setup', () => {
    expect(initialConnectionGate(true, [])).toBe('welcome');
    expect(initialConnectionGate(true, ['http://a'])).toBeUndefined();
    expect(initialConnectionGate(false, [])).toBeUndefined();
  });

  it('defers connection recovery UI while a player still owns playback', () => {
    expect(shouldEnterConnectionGate(true, true)).toBe(false);
    expect(shouldEnterConnectionGate(true, false)).toBe(true);
    expect(shouldEnterConnectionGate(false, false)).toBe(false);
  });

  it('normalizes and deduplicates endpoints while discarding blank same-origin entries', () => {
    expect(normalizeConnectionEndpoints([' http://a/ ', 'http://a', '', '  ', '/'])).toEqual(['http://a']);
  });

  it('accepts configuration when any endpoint responds successfully', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => String(url).startsWith('http://b/')
      ? new Response('{}', { status: 200 })
      : Promise.reject(new TypeError('offline')));
    const result = await checkEndpointConfiguration(['http://a', 'http://b'], fetchMock as unknown as typeof fetch, 50);
    expect(result.available).toEqual(['http://b']);
    expect(result.problem).toBeUndefined();
    // Deliberately unauthenticated: this asks whether an address answers at
    // all, which needs no credentials, and there is no session to draw one
    // from before the endpoint has been saved.
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('authorization')).toBeNull();
  });

  it('never probes a blank line against the client origin', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request) => new Response('{}', { status: 200 }));
    const result = await checkEndpointConfiguration(['http://node-a:7438', '', '  '], fetchMock as unknown as typeof fetch, 50);
    expect(result.endpoints).toEqual(['http://node-a:7438']);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://node-a:7438/api/v1/health');
  });

  it('accepts an endpoint that answered without confirming it is Macha', async () => {
    // The measured lockout: this asked `/api/v1/catalogue/status` and counted
    // an endpoint only on `response.ok`, and all three of Tom's nodes answer
    // 401 there unauthenticated — so nothing could ever be saved, no session
    // was ever minted, and a fresh install could not be configured at all.
    // A 401 is an answer. So is the 503 a node still starting gives, and so
    // is the 404 from a build too old to have the liveness route.
    const fetchMock = vi.fn(async (url: string | URL | Request) => new Response('{}', {
      status: String(url).startsWith('http://starting/') ? 503 : 200,
    }));

    const result = await checkEndpointConfiguration(['http://serving', 'http://starting'], fetchMock as unknown as typeof fetch, 50);

    expect(result.available).toEqual(['http://serving', 'http://starting']);
    // Separated rather than hidden, so a caller can say "reached, but it did
    // not identify itself as Macha" instead of guessing in either direction.
    expect(result.unconfirmed).toEqual(['http://starting']);
    expect(result.problem).toBeUndefined();
  });

  it('says why when nothing was entered, as a kind rather than a sentence', async () => {
    await expect(checkEndpointConfiguration([], vi.fn() as unknown as typeof fetch, 50)).resolves.toMatchObject({ problem: 'no-endpoints' });
  });

  it('returns one concise transport failure when no endpoint can be reached', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('offline'); }) as typeof fetch;
    await expect(checkEndpointConfiguration(['http://a', 'http://b'], fetchMock, 50)).resolves.toMatchObject({
      available: [],
      problem: 'unreachable',
    });
  });

  it('bounds the UI wait without cancelling a pending status request or declaring an outage', async () => {
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeUndefined();
      return new Promise<Response>(() => undefined);
    }) as typeof fetch;

    await expect(checkEndpointConfiguration(['http://a'], fetchMock, 1)).resolves.toEqual({
      endpoints: ['http://a'],
      available: [],
      unconfirmed: [],
      problem: 'pending',
    });
  });
});

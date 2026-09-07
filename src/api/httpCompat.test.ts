import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_REQUEST_TIMEOUT_MS, fetchWithTimeout } from './httpCompat.js';
import { MachaConnectionError } from './serverConnection.js';

describe('fetchWithTimeout', () => {
  afterEach(() => vi.useRealTimers());

  it('resolves normally when the request finishes before the timeout', async () => {
    const response = new Response(null, { status: 200 });
    const fetcher = vi.fn().mockResolvedValue(response);

    await expect(fetchWithTimeout(fetcher, 'http://node.test/x', {}, DEFAULT_REQUEST_TIMEOUT_MS)).resolves.toBe(response);
  });

  it('abandons a hung request once the timeout elapses, as a retryable connection failure', async () => {
    vi.useFakeTimers();
    try {
      // A real fetch() rejects with an AbortError once its own signal aborts
      // — this helper relies on that contract (unlike ClusterCatalogueApi's
      // artworkAttempt, which settles a request on its own even when the
      // underlying implementation ignores the signal entirely).
      const fetcher = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      }));

      const request = fetchWithTimeout(fetcher, 'http://node.test/slow', {}, DEFAULT_REQUEST_TIMEOUT_MS);
      const assertion = expect(request).rejects.toBeInstanceOf(MachaConnectionError);
      await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces a caller-supplied cancellation as a plain AbortError, not a timeout', async () => {
    const callerController = new AbortController();
    const fetcher = vi.fn((_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });

    // The composed signal (not the caller's own object — no `AbortSignal.any`
    // on the legacy browsers this app also targets) is what fetch sees;
    // aborting the caller's controller must still reach it, forwarded, and
    // must stay a genuine AbortError so `retryableEndpointFailure` keeps
    // treating cancellation as client intent rather than endpoint health.
    const request = fetchWithTimeout(fetcher, 'http://node.test/x', { signal: callerController.signal }, DEFAULT_REQUEST_TIMEOUT_MS);
    callerController.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });
});

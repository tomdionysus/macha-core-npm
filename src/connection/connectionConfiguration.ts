import { mergeRequestHeaders, normalizeBaseUrl } from '../api/httpCompat.js';
import { SERVER_UNREACHABLE_MESSAGE } from '../api/serverConnection.js';

export const CONNECTION_CHECK_TIMEOUT_MS = 4_000;
export type ConnectionGate = 'welcome' | 'unreachable';

export function initialConnectionGate(connectionRequired: boolean, endpoints: readonly string[]): ConnectionGate | undefined {
  return connectionRequired && endpoints.length === 0 ? 'welcome' : undefined;
}

/** Never replace a live player with control-plane recovery UI. */
export function shouldEnterConnectionGate(clusterUnreachable: boolean, activePlayback: boolean): boolean {
  return clusterUnreachable && !activePlayback;
}

export function normalizeConnectionEndpoints(urls: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const url of urls) {
    const normalized = normalizeBaseUrl(url);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export interface ConnectionCheckResult {
  endpoints: string[];
  available: string[];
  message?: string;
}

type ConnectionAttempt = { state: 'response'; response: Response } | { state: 'pending' } | { state: 'failed' };

function observeWithin(request: Promise<Response>, timeoutMs: number): Promise<ConnectionAttempt> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (attempt: ConnectionAttempt) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(attempt);
    };
    const timeout = setTimeout(() => finish({ state: 'pending' }), timeoutMs);
    // This is a UI deadline only. The status request remains independent and
    // observed instead of being aborted and mistaken for endpoint failure.
    request.then(
      (response) => finish({ state: 'response', response }),
      () => finish({ state: 'failed' }),
    );
  });
}

/**
 * A pre-save reachability ping for endpoints a viewer has typed in.
 *
 * Deliberately unauthenticated. It asks whether an address answers at all,
 * which needs no credentials, and the client has none to offer before a
 * session exists anyway.
 */
export async function checkEndpointConfiguration(
  urls: readonly string[],
  fetchImpl: typeof fetch = fetch,
  timeoutMs = CONNECTION_CHECK_TIMEOUT_MS,
): Promise<ConnectionCheckResult> {
  const endpoints = normalizeConnectionEndpoints(urls);
  if (endpoints.length === 0) return { endpoints, available: [], message: 'Enter at least one Macha API endpoint.' };

  let receivedResponse = false;
  let pendingResponse = false;
  const results = await Promise.all(endpoints.map(async (endpoint) => {
    const attempt = await observeWithin(
      fetchImpl(`${endpoint}/api/v1/catalogue/status`, {
        method: 'GET',
        headers: mergeRequestHeaders(undefined, { Accept: 'application/json' }),
        cache: 'no-store',
      }),
      timeoutMs,
    );
    if (attempt.state === 'pending') pendingResponse = true;
    if (attempt.state !== 'response') return undefined;
    receivedResponse = true;
    return attempt.response.ok ? endpoint : undefined;
  }));
  const available = results.filter((endpoint): endpoint is string => endpoint !== undefined);
  return {
    endpoints,
    available,
    message: available.length > 0
      ? undefined
      : pendingResponse
        ? 'Connection checks are still pending. Try again shortly.'
      : receivedResponse
        ? 'No configured endpoint accepted these connection details.'
        : SERVER_UNREACHABLE_MESSAGE,
  };
}

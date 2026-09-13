import { mergeRequestHeaders, normalizeBaseUrl } from '../api/httpCompat.js';
import { LIVENESS_PATH, SERVER_UNREACHABLE_MESSAGE } from '../api/serverConnection.js';

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
  /**
   * Endpoints that answered, and may be saved.
   *
   * "Answered" rather than "answered successfully". A node still starting
   * says `503`, a node too old for the liveness route says `404`, and both
   * have demonstrably been reached — which is the only question this check
   * exists to ask.
   */
  available: string[];
  /**
   * The subset of `available` that answered without confirming it is Macha.
   *
   * Separated so a client can say so rather than guess. A viewer who mistypes
   * an address at their router gets an answer from something, and this is how
   * a caller can offer "reached, but it did not identify itself as a Macha
   * server" instead of either refusing a working endpoint or silently
   * accepting a wrong one.
   */
  unconfirmed: string[];
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
 *
 * That reasoning was right and the implementation contradicted it for as long
 * as this pointed at `/api/v1/catalogue/status` and counted an endpoint only
 * on `response.ok`. Measured against Tom's cluster, all three nodes answer
 * `401` there unauthenticated, so `available` came back empty and a caller
 * that refuses to save an empty list could accept no endpoint a viewer typed
 * — no endpoint saved, so no session minted, so the client could not be
 * configured at all. **A 401 is an answer.** It survived because it is
 * invisible to anyone whose endpoints arrive from build configuration.
 *
 * Now it asks `/api/v1/health`, which needs no session and no role, and a
 * successful answer means it really is Macha rather than merely something.
 * Anything else that answers is still reported as reached, because a node
 * that is starting up (`503`) or too old for the route (`404`) is an address
 * a viewer should be allowed to save.
 */
export async function checkEndpointConfiguration(
  urls: readonly string[],
  fetchImpl: typeof fetch = fetch,
  timeoutMs = CONNECTION_CHECK_TIMEOUT_MS,
): Promise<ConnectionCheckResult> {
  const endpoints = normalizeConnectionEndpoints(urls);
  if (endpoints.length === 0) return { endpoints, available: [], unconfirmed: [], message: 'Enter at least one Macha API endpoint.' };

  let pendingResponse = false;
  const results = await Promise.all(endpoints.map(async (endpoint) => {
    const attempt = await observeWithin(
      fetchImpl(`${endpoint}${LIVENESS_PATH}`, {
        method: 'GET',
        headers: mergeRequestHeaders(undefined, { Accept: 'application/json' }),
        cache: 'no-store',
      }),
      timeoutMs,
    );
    if (attempt.state === 'pending') pendingResponse = true;
    if (attempt.state !== 'response') return undefined;
    return { endpoint, confirmed: attempt.response.ok };
  }));
  const answered = results.filter((result): result is { endpoint: string; confirmed: boolean } => result !== undefined);
  const available = answered.map(({ endpoint }) => endpoint);
  const unconfirmed = answered.filter(({ confirmed }) => !confirmed).map(({ endpoint }) => endpoint);
  return {
    endpoints,
    available,
    unconfirmed,
    message: available.length > 0
      ? undefined
      : pendingResponse
        ? 'Connection checks are still pending. Try again shortly.'
        : SERVER_UNREACHABLE_MESSAGE,
  };
}

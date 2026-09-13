import { DEFAULT_REQUEST_TIMEOUT_MS, fetchWithTimeout, mergeRequestHeaders, normalizeBaseUrl, readResponseBody } from './httpCompat.js';
import { parseErrorEnvelope } from './errorEnvelope.js';
import { isGatewayConnectionFailure, serverUnreachable } from './serverConnection.js';
import type { EndpointRegistry } from '../cluster/EndpointRegistry.js';

export interface AnonymousSession {
  token: string;
  expiresAtMs: number;
  /**
   * The account this session belongs to, where the server names it.
   *
   * Absent from a node that has sessions but not yet accounts, which is not
   * the same as an unnamed user — the caller has to be able to tell "the
   * server did not say" from "the server said anonymous".
   */
  username?: string;
}

export interface SessionCredentials {
  username: string;
  password: string;
}

export class SessionAuthError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    /**
     * The server's machine-readable reason, where it sent one.
     *
     * Load-bearing rather than diagnostic: `anonymous_disabled` is how a
     * deployment says "this cluster requires an account", and a client that
     * cannot read it has to guess from an empty token — which reads exactly
     * the same as a node being unreachable. Two clients built a login wall on
     * that guess and removed it again, because telling a viewer who is merely
     * away from home that they need an account is the worst version of being
     * wrong here.
     */
    public readonly code?: string,
  ) {
    super(message);
  }
}

/**
 * Whether a node refused to mint, rather than failing to answer.
 *
 * 401 is a wrong username or password; 403 is a refusal to mint at all, such
 * as anonymous access being switched off. Both are the node working
 * correctly, which is why neither is endpoint evidence. 429 is deliberately
 * absent: a rate limit is worth trying elsewhere, and it says nothing about
 * whether the credentials are right.
 *
 * Whether a refusal is *final* is a separate question, and it depends on what
 * was asked — see `mintAnonymousSessionAnyNode`. This only says the node
 * answered and said no.
 */
export function isSessionRefusal(error: unknown): boolean {
  const status = error instanceof SessionAuthError ? error.status : undefined;
  return status === 401 || status === 403;
}

/**
 * `POST /api/v1/session` — the one endpoint that takes no Authorization header.
 *
 * Credentials are optional because there is no such thing as an
 * unauthenticated session: omitting them authenticates the `anonymous` user
 * and supplying them authenticates whoever they name. Same route, same
 * response, one lifecycle — which is why signing in does not need a parallel
 * set of everything below.
 */
export async function mintAnonymousSession(baseUrl: string, credentials?: SessionCredentials): Promise<AnonymousSession> {
  const url = `${normalizeBaseUrl(baseUrl)}/api/v1/session`;
  // Bounded here, because nothing above can bound it. Every request in the
  // application waits on a mint — `SessionManager.fetch` blocks on `inFlight`
  // through bootstrap and through a 401 re-mint — and a `fetchWithTimeout`
  // wrapped around one of those callers composes a controller this request
  // never sees. Unbounded, a node that died without an RST leaves a half-open
  // connection that costs the OS timeout, and a cold start pays that per
  // candidate while the whole client waits.
  const response = await fetchWithTimeout(
    (target, init) => fetch(target, init),
    url,
    {
      method: 'POST',
      headers: mergeRequestHeaders(undefined, { Accept: 'application/json', 'Content-Type': 'application/json' }),
      body: JSON.stringify(credentials ? { credentials } : {}),
    },
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const { body, wasJson } = await readResponseBody(response);
  if (isGatewayConnectionFailure(response, wasJson)) throw serverUnreachable();
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
  if (!response.ok) {
    // Through the envelope parser, not off the top level. Macha answers
    // `{ error: { code, message } }`, so reading `record.message` found
    // nothing and every refusal degraded to status plus statusText — and
    // `statusText` is empty on React Native's fetch, so a wrong password
    // reached the viewer as "Could not start a session: 401" while the
    // server's own sentence, and the code the client needed, were both in the
    // body all along.
    const { message, code } = parseErrorEnvelope(body, `HTTP ${response.status}`);
    throw new SessionAuthError(`Could not start a session: ${message}`, response.status, code);
  }
  const token = typeof record?.token === 'string' ? record.token : undefined;
  const expiresAtMs = typeof record?.expires_unix_ms === 'number' ? record.expires_unix_ms : undefined;
  if (!token || expiresAtMs === undefined) throw new SessionAuthError('Server returned a malformed session response.');
  const username = typeof record?.username === 'string' ? record.username : undefined;
  return username === undefined ? { token, expiresAtMs } : { token, expiresAtMs, username };
}

/**
 * Mints against whichever known endpoint answers first, in the same
 * any-node spirit as the rest of the cluster client: a session obtained from
 * any node is valid cluster-wide, so a single down node must not block
 * getting a token.
 */
export async function mintAnonymousSessionAnyNode(registry: EndpointRegistry, credentials?: SessionCredentials): Promise<AnonymousSession> {
  let lastError: unknown;
  for (const { endpoint } of registry.candidates()) {
    try {
      const session = await mintAnonymousSession(endpoint.baseUrl, credentials);
      registry.recordSuccess(endpoint.id);
      return session;
    } catch (error) {
      if (isSessionRefusal(error)) {
        // A refusal is not a fault. A node that answers "those credentials are
        // wrong" has done its job perfectly, and marking it unhealthy for
        // saying so would let one mistyped password walk the whole cluster and
        // mark every node failed — degrading endpoint ranking and playback
        // failover because somebody fumbled a login.
        registry.recordSuccess(endpoint.id);
        // Whether that refusal settles the question depends on what was asked.
        //
        // Credentials are checked against a replicated table, so every node
        // reaches the same verdict and asking the next one is a slower way to
        // be told the same thing. But an *anonymous* mint offers no
        // credentials: a 403 there means "this node does not allow anonymous",
        // which is that node's configuration and nothing else's. Observed
        // mid-deployment by the Android TV client — one stale node answered
        // 403 while the rest would have minted happily, and stopping at its
        // opinion denied a session the cluster was willing to grant. Taking
        // one node's word for the cluster is the thing this package exists
        // not to do.
        if (credentials) throw error;
        lastError = error;
        continue;
      }
      registry.recordFailure(endpoint.id);
      lastError = error;
    }
  }
  throw lastError ?? new SessionAuthError('No Macha endpoint is configured.');
}

/**
 * Cheaply proves whether an already-held token is still accepted.
 *
 * Minting a brand new session does real server-side work (creating a session
 * record); checking that an existing token still authenticates is far cheaper
 * and, as a side effect, proves the node actually answers — so a warm reload
 * with a live cached token never pays for a full mint (Law 2: Thou Shalt Not
 * Make The Viewer Wait, `docs/principles-and-laws.md`).
 *
 * It asks the session about itself, and deliberately not a catalogue or
 * status route. Under the roles model those need a role — `media_viewer` for
 * the catalogue, `view_status` for cluster status from server 0.38.5 — so a
 * session the cluster granted nothing would have every cached token
 * classified dead on every reload and re-mint forever, having been told
 * nothing about the token at all. A session's own record is the one thing it
 * can always ask about, because the answer is about the asker.
 *
 * Confirmed with the server session: it is the one route explicitly exempt
 * from the role gate, on that same reasoning — needing a role to find out
 * which roles you have is not a thing that can work.
 *
 * It also answers a stronger question than "is this token well formed". The
 * authenticator re-checks the session's `credential_generation` against the
 * user record on every request, so a password change, a role change or a
 * deletion invalidates the token the moment that record reaches the node.
 * This therefore catches revocation, not only expiry, at no extra cost.
 *
 * The corollary matters more than it looks: a 401 here does **not** only mean
 * "expired". It can mean the account changed underneath the token. The
 * response is the same either way — mint fresh — but a caller that reports
 * the reason to a viewer must not claim the session timed out.
 */
export async function validateAnonymousSession(baseUrl: string, token: string): Promise<boolean> {
  const url = `${normalizeBaseUrl(baseUrl)}/api/v1/session`;
  const response = await fetchWithTimeout(
    (target, init) => fetch(target, init),
    url,
    { headers: mergeRequestHeaders(undefined, { Accept: 'application/json', Authorization: `Bearer ${token}` }) },
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  // A reachable node that rejects the token is a definitive, cluster-wide
  // answer (sessions are valid cluster-wide, so a rejection is not
  // node-specific) — no point asking another node the same question.
  //
  // 403 counts too, and that is not hypothetical: a rolling upgrade leaves
  // sessions minted by the older build carrying a role vocabulary the new one
  // refuses, so every route answers 403. Treated as a transport fault it
  // would mark all four nodes unhealthy on the way to re-minting, wrecking
  // endpoint ranking at exactly the moment the cluster is already in flux.
  // The token is simply no longer acceptable anywhere; say so and re-mint.
  if (response.status === 401 || response.status === 403) return false;
  if (!response.ok) throw new SessionAuthError(`${response.status} ${response.statusText}`, response.status);
  return true;
}

/**
 * Any-node counterpart to `mintAnonymousSessionAnyNode`: tries known
 * endpoints in order until one actually answers the validity question.
 * Resolves `false` only for a genuine rejection; an endpoint that merely
 * failed to answer is skipped in favor of the next candidate, and if none
 * can be reached the caller falls back to minting fresh (which will hit the
 * same unreachable nodes and fail the same way — no worse than today).
 */
export async function validateAnonymousSessionAnyNode(registry: EndpointRegistry, token: string): Promise<boolean> {
  for (const { endpoint } of registry.candidates()) {
    try {
      const valid = await validateAnonymousSession(endpoint.baseUrl, token);
      registry.recordSuccess(endpoint.id);
      return valid;
    } catch {
      registry.recordFailure(endpoint.id);
    }
  }
  return false;
}

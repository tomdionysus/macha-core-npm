import { mergeRequestHeaders, normalizeBaseUrl, readResponseBody } from './httpCompat.js';
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
  constructor(message: string, public readonly status?: number) {
    super(message);
  }
}

/**
 * Whether the server refused who you claim to be, rather than failing to
 * answer.
 *
 * 401 is a wrong username or password; 403 is a refusal to mint at all, such
 * as anonymous access being switched off. Both are the node working
 * correctly. 429 is deliberately absent: a rate limit is worth trying
 * elsewhere, and it says nothing about whether the credentials are right.
 */
function refusedCredentials(error: unknown): boolean {
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
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: mergeRequestHeaders(undefined, { Accept: 'application/json', 'Content-Type': 'application/json' }),
      body: JSON.stringify(credentials ? { credentials } : {}),
    });
  } catch {
    throw serverUnreachable();
  }
  const { body, wasJson } = await readResponseBody(response);
  if (isGatewayConnectionFailure(response, wasJson)) throw serverUnreachable();
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
  if (!response.ok) {
    const message = typeof record?.message === 'string' ? record.message : `${response.status} ${response.statusText}`;
    throw new SessionAuthError(`Could not start a session: ${message}`, response.status);
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
      // A refusal is not a fault. A node that answers "those credentials are
      // wrong" has done its job perfectly, and marking it unhealthy for
      // saying so would let one mistyped password walk the whole cluster and
      // mark every node failed — degrading endpoint ranking and playback
      // failover because somebody fumbled a login.
      //
      // It is also cluster-wide and final, the same reasoning session
      // validation already uses for a rejected token: every node checks the
      // same credentials against the same replicated table, so asking the
      // next one is a slower way to be told the same thing.
      if (refusedCredentials(error)) {
        registry.recordSuccess(endpoint.id);
        throw error;
      }
      registry.recordFailure(endpoint.id);
      lastError = error;
    }
  }
  throw lastError ?? new SessionAuthError('No Macha endpoint is configured.');
}

/**
 * Cheaply proves whether an already-held token is still accepted, reusing the
 * same lightweight status endpoint the health monitor already probes.
 * Minting a brand new session does real server-side work (creating a session
 * record); checking one an existing token still authenticates is far cheaper
 * and, as a side effect, proves the node actually answers — so a warm reload
 * with a live cached token never pays for a full mint (Law 2: Thou Shalt Not
 * Make The Viewer Wait, `docs/principles-and-laws.md`).
 */
export async function validateAnonymousSession(baseUrl: string, token: string): Promise<boolean> {
  const url = `${normalizeBaseUrl(baseUrl)}/api/v1/catalogue/status`;
  const response = await fetch(url, {
    headers: mergeRequestHeaders(undefined, { Accept: 'application/json', Authorization: `Bearer ${token}` }),
  });
  // A reachable node that rejects the token is a definitive, cluster-wide
  // answer (anonymous sessions are valid cluster-wide, so a rejection is not
  // node-specific) — no point asking another node the same question.
  if (response.status === 401) return false;
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

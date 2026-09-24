import { DEFAULT_REQUEST_TIMEOUT_MS, fetchWithTimeout, mergeRequestHeaders, normalizeBaseUrl, readResponseBody } from './httpCompat.js';
import { parseErrorEnvelope } from './errorEnvelope.js';
import type { CurrentSession, UserRole } from './UsersApi.js';
import { isGatewayConnectionFailure, LIVENESS_PATH, serverUnreachable } from './serverConnection.js';
import type { EndpointCandidate, EndpointRegistry } from '../cluster/EndpointRegistry.js';

/**
 * A session, for whatever account minted it.
 *
 * **There is no separate anonymous session type, and there was never a reason
 * for one.** This carried the name `Session` while being the type of
 * every session in the package, including one minted from a username and
 * password — and that one wrong word produced four defects: the cache dropped
 * `username` and `roles` on the way back in (why keep them, for anonymous?),
 * the token was persisted to tab-lifetime storage (an anonymous session dies
 * with the tab), and a 401 re-minted and adopted whatever came back without
 * checking whose session it now held (they are all anonymous, so who cares).
 *
 * The account an empty set of credentials authenticates is special in exactly
 * three places, all server-side: it cannot be renamed or deleted, it has no
 * password, and it can mint with no credentials where a deployment allows it.
 * **Core enforces none of those**, and a client that needs to reflect them
 * reads the server's per-record `mutable` rather than comparing a name.
 */
export interface Session {
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
  /**
   * What this session may do, as the minting node resolved it.
   *
   * Absent means the node did not say, which is not the same as an empty
   * array — that is a session the cluster deliberately granted nothing, and
   * the two need opposite handling. See `sessionPermits` and
   * `sessionLockedOut`.
   *
   * Unknown strings are passed through rather than filtered to `UserRole`.
   * Dropping a role the server granted because this build has not heard of it
   * yet would understate what the viewer may do, and understating is the
   * direction that hides working features behind a lock.
   */
  roles?: UserRole[];
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
    /** The server's own sentence, for a host that shows it. Never core's text; `message` is for a log. */
    public readonly detail?: string,
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
 * was asked — see `mintSessionAnyNode`. This only says the node
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
 * set of everything below. Credentials are the only difference between the
 * two calls, and they are an argument rather than a code path.
 */
export async function mintSession(baseUrl: string, credentials?: SessionCredentials): Promise<Session> {
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
    const { message, code, detail } = parseErrorEnvelope(body, `HTTP ${response.status}`);
    throw new SessionAuthError(`Could not start a session: ${message}`, response.status, code, detail);
  }
  const token = typeof record?.token === 'string' ? record.token : undefined;
  const expiresAtMs = typeof record?.expires_unix_ms === 'number' ? record.expires_unix_ms : undefined;
  if (!token || expiresAtMs === undefined) throw new SessionAuthError('Server returned a malformed session response.');
  const username = typeof record?.username === 'string' ? record.username : undefined;
  return {
    token,
    expiresAtMs,
    ...(username !== undefined ? { username } : {}),
    ...(sessionRoles(record) !== undefined ? { roles: sessionRoles(record)! } : {}),
  };
}

/**
 * The roles a session record states, or `undefined` where it states none.
 *
 * Absent and empty are kept apart all the way down: a node that did not
 * answer the question and a cluster that granted nothing look identical in a
 * boolean and need opposite handling.
 */
function sessionRoles(record: Record<string, unknown> | undefined): UserRole[] | undefined {
  if (!Array.isArray(record?.roles)) return undefined;
  return (record.roles as unknown[]).filter((value): value is UserRole => typeof value === 'string');
}

/**
 * Mints against whichever known endpoint answers first, in the same
 * any-node spirit as the rest of the cluster client: a session obtained from
 * any node is valid cluster-wide, so a single down node must not block
 * getting a token.
 */
/**
 * The ranked candidates, led by the first to answer a liveness probe when the
 * registry has no evidence about any of them yet: a fresh sign-in, or a cold
 * start with no cached token.
 *
 * A mint creates a session, so it cannot be hedged the way validation is:
 * each losing mint would hold a session against the account's cap. So the
 * question "who is answering" is asked of the unauthenticated health route,
 * hedged, and the mint then goes to that node alone, falling back to the rest
 * in ranked order. Without it a fresh sign-in waited a full request timeout,
 * 8 s, for every dead node ranked ahead of a live one.
 */
async function mintOrder(registry: EndpointRegistry): Promise<EndpointCandidate['endpoint'][]> {
  const candidates = registry.candidates();
  const ranked = candidates.map(({ endpoint }) => endpoint);
  if (candidates.length < 2 || candidates.some(({ health }) => health.lastSuccessAt !== undefined || health.consecutiveFailures > 0)) {
    return ranked;
  }
  const won = await firstToAnswer(registry, async (endpoint, signal) => {
    await fetchWithTimeout(
      (target, init) => fetch(target, init),
      `${endpoint.baseUrl}${LIVENESS_PATH}`,
      { method: 'GET', headers: mergeRequestHeaders(undefined, { Accept: 'application/json' }), cache: 'no-store', signal },
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    // Any response is an answer. A node answering 503 while it starts is
    // reachable, and the mint decides the rest.
    return true;
  });
  if (!won) return ranked;
  return [won.endpoint, ...ranked.filter((endpoint) => endpoint.id !== won.endpoint.id)];
}

export async function mintSessionAnyNode(registry: EndpointRegistry, credentials?: SessionCredentials): Promise<Session> {
  let lastError: unknown;
  for (const endpoint of await mintOrder(registry)) {
    try {
      const session = await mintSession(endpoint.baseUrl, credentials);
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
 * `DELETE /api/v1/session` — end this session server-side.
 *
 * **Dropping a token locally is not a logout.** The session stays valid on
 * every node until it expires, and anyone holding the token keeps the access
 * it grants. This is what actually revokes it, and the revocation propagates.
 *
 * A mutation, so it executes **once**: the walk continues only while nodes
 * fail to *answer*. A node that answers at all has taken the request — and a
 * refusal is an answer, because a token the cluster will not accept is a
 * token that no longer needs revoking. Retrying elsewhere after an answer
 * could only revoke something already gone, while masking the first attempt
 * having worked.
 */
export async function revokeSessionAnyNode(registry: EndpointRegistry, token: string): Promise<void> {
  let lastError: unknown;
  for (const { endpoint } of registry.candidates()) {
    try {
      const url = `${normalizeBaseUrl(endpoint.baseUrl)}/api/v1/session`;
      const response = await fetchWithTimeout(
        (target, init) => fetch(target, init),
        url,
        { method: 'DELETE', headers: mergeRequestHeaders(undefined, { Accept: 'application/json', Authorization: `Bearer ${token}` }) },
        DEFAULT_REQUEST_TIMEOUT_MS,
      );
      const { body, wasJson } = await readResponseBody(response);
      if (isGatewayConnectionFailure(response, wasJson)) throw serverUnreachable();
      registry.recordSuccess(endpoint.id);
      // Already unacceptable is already revoked, as far as the caller is
      // concerned. Anything else the node says is a real failure to revoke and
      // the caller must hear about it rather than be told it signed out.
      if (response.ok || response.status === 401 || response.status === 403) return;
      const { message, code, detail } = parseErrorEnvelope(body, `HTTP ${response.status}`);
      throw new SessionAuthError(`Could not end the session: ${message}`, response.status, code, detail);
    } catch (error) {
      if (error instanceof SessionAuthError) throw error;
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
export async function validateSession(baseUrl: string, token: string, signal?: AbortSignal): Promise<CurrentSession | undefined> {
  const url = `${normalizeBaseUrl(baseUrl)}/api/v1/session`;
  const response = await fetchWithTimeout(
    (target, init) => fetch(target, init),
    url,
    { headers: mergeRequestHeaders(undefined, { Accept: 'application/json', Authorization: `Bearer ${token}` }), signal },
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
  const { body, wasJson } = await readResponseBody(response);
  if (isGatewayConnectionFailure(response, wasJson)) throw serverUnreachable();
  if (response.status === 401 || response.status === 403) return undefined;
  if (!response.ok) {
    const { message, code, detail } = parseErrorEnvelope(body, `HTTP ${response.status}`);
    throw new SessionAuthError(`Session check failed: ${message}`, response.status, code, detail);
  }
  // The record is returned rather than a boolean because this request already
  // carries the answer to a second question nothing else was asking: what the
  // session may do. Re-reading roles was the one part of the session
  // lifecycle living outside this module, and a client that fetched them once
  // per API identity never re-asked — failover changes the preferred endpoint
  // inside the registry without changing that identity, so one transient
  // failure left roles unknown for a whole run.
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
  if (!record || !Array.isArray(record.roles)) {
    throw new SessionAuthError('Server returned a malformed session record.', response.status);
  }
  return record as unknown as CurrentSession;
}

/**
 * Any-node counterpart to `mintSessionAnyNode`: asks the known endpoints,
 * hedged, until one actually answers the validity question. Resolves
 * `undefined` only for a genuine rejection (401 or 403). An endpoint that
 * fails to answer is skipped for the next, and when none answers at all it
 * throws a `MachaConnectionError`: "could not find out" is not "rejected".
 */
export async function validateSessionAnyNode(
  registry: EndpointRegistry,
  token: string,
): Promise<CurrentSession | undefined> {
  // Hedged, because a cold start walked it one node at a time: measured by
  // the web client 2026-09-24 with two nodes down, 8.2 s and 8.0 s of
  // timeouts before the third answered in 0.52 s, 17.2 s before a viewer saw
  // anything. A GET, so asking a second node early costs a request and
  // nothing else. A refusal (401 or 403) is an answer, and ends it.
  const won = await firstToAnswer(registry, (endpoint, signal) => validateSession(endpoint.baseUrl, token, signal));
  // No node answered, which is not the same as the token being refused.
  // Resolving `undefined` here told the caller "rejected", and it minted
  // fresh; on a cluster that requires an account the anonymous mint is then
  // refused and a viewer holding a good 30-day token is sent to sign in.
  // Measured on the web client 2026-09-24 with two nodes down.
  if (!won) {
    // With nothing configured there is nothing to ask; the mint says so.
    if (registry.candidates().length === 0) return undefined;
    throw serverUnreachable();
  }
  return won.value;
}

/**
 * How long one node has to answer before the next is also asked. Short
 * against the 8 s request bound, long against a working node's answer (0.52
 * s cold across the WAN, measured): a guess, and it only spends a request.
 */
export const SESSION_HEDGE_MS = 1_000;

/**
 * Ask the ranked candidates in turn, starting the next when the current one
 * fails or has not answered within `SESSION_HEDGE_MS`, and take the first
 * answer. The rest are cancelled, and a cancelled attempt is not charged.
 * Only for requests that are safe to send twice: never a mint.
 */
async function firstToAnswer<T>(
  registry: EndpointRegistry,
  attempt: (endpoint: EndpointCandidate['endpoint'], signal: AbortSignal) => Promise<T>,
): Promise<{ endpoint: EndpointCandidate['endpoint']; value: T } | undefined> {
  const candidates = registry.candidates().map(({ endpoint }) => endpoint);
  if (candidates.length === 0) return undefined;
  const controller = new AbortController();
  return new Promise((resolve) => {
    let next = 0;
    let running = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: { endpoint: EndpointCandidate['endpoint']; value: T } | undefined) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
      resolve(result);
    };
    const launch = () => {
      if (settled || next >= candidates.length) return;
      const endpoint = candidates[next++];
      running += 1;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(launch, SESSION_HEDGE_MS);
      attempt(endpoint, controller.signal).then(
        (value) => {
          running -= 1;
          if (settled) return;
          registry.recordSuccess(endpoint.id);
          finish({ endpoint, value });
        },
        () => {
          running -= 1;
          if (settled) return;
          registry.recordFailure(endpoint.id);
          if (next < candidates.length) launch();
          else if (running === 0) finish(undefined);
        },
      );
    };
    launch();
  });
}

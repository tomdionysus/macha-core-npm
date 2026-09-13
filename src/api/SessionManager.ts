import { machaHost } from '../runtime/host.js';
import type { StorageLike } from '../state/storage.js';
import { isSessionRefusal, mintAnonymousSessionAnyNode, SessionAuthError, validateAnonymousSessionAnyNode, type AnonymousSession, type SessionCredentials } from './SessionAuth.js';
import { mergeRequestHeaders } from './httpCompat.js';
import { reportClusterReachable, reportClusterUnreachable } from './serverConnection.js';
import type { EndpointRegistry } from '../cluster/EndpointRegistry.js';

/** sessionStorage (not localStorage): scoped to this tab, and gone with it — matching an anonymous session's own lifetime. */
const SESSION_CACHE_KEY = 'macha-session';
const RETRY_AFTER_MINT_FAILURE_MS = 10_000;
/** No sliding renewal in v1: re-mint shortly before the server-declared expiry rather than waiting to be 401'd. */
const REFRESH_SAFETY_MARGIN_MS = 30_000;
/**
 * `setTimeout`'s delay is a 32-bit signed int internally (~24.8 days max);
 * anything longer silently overflows to fire almost immediately. A session
 * can live far longer than that (this contract's own example is 30 days),
 * so the wait to a distant expiry is chunked into re-checks no longer than
 * this, rather than scheduled as one timer for the full remaining duration.
 */
const MAX_TIMER_DELAY_MS = 24 * 60 * 60 * 1000;

/** Everything an API client needs to make an authenticated request — nothing more. */
export interface AuthenticatedFetch {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /**
   * The `Authorization` header value for a request this client will not make
   * itself — a URL handed to a native player, an `<img>`, or a platform
   * downloader, all of which fetch on their own and cannot go through `fetch`
   * above. Undefined when the client is unauthenticated.
   *
   * Async because the honest answer may not exist yet: a session being minted
   * for the first time, or re-minted after a 401, has no valid token until
   * that settles, and handing back the expired one would produce a 401 the
   * caller cannot retry — the fetch is happening inside a player.
   *
   * Returns the whole header value rather than the bare token, deliberately.
   * Callers that need it in a query parameter can strip the prefix, but they
   * should not be encouraged to: a token in a URL ends up in access logs, in
   * `Referer`, and in whatever the platform keeps about recent media.
   */
  authorization(): Promise<string | undefined>;
}

/**
 * A fixed, never-refreshed bearer token.
 *
 * `NO_AUTH` is defined in terms of it, and it is the standard test double
 * wherever a test needs an `AuthenticatedFetch` without exercising session
 * lifecycle at all. It is deliberately **not** a way to configure a token:
 * clients mint anonymous sessions through `SessionManager`, and the
 * settings-screen override this once backed has been removed from every
 * client. Nothing should reintroduce a caller that passes a real token.
 */
export function fixedBearerToken(token: string | undefined, fetchImpl?: typeof fetch): AuthenticatedFetch {
  const trimmed = token?.trim() || undefined;
  return {
    // `fetchImpl ?? fetch` is resolved on every call, not once at
    // construction — `NO_AUTH` below is a module-level constant built at
    // import time, long before a test's `vi.stubGlobal('fetch', ...)` runs;
    // capturing `fetch` as a bound default parameter here would freeze in
    // whatever `fetch` was at that moment and silently ignore every stub.
    fetch: (url, init = {}) => (fetchImpl ?? fetch)(url, {
      ...init,
      headers: mergeRequestHeaders(init.headers, { Authorization: trimmed ? `Bearer ${trimmed}` : undefined }),
    }),
    authorization: async () => (trimmed ? `Bearer ${trimmed}` : undefined),
  };
}

/** Sends no Authorization header at all — the default for a test/caller that doesn't care about auth. */
export const NO_AUTH: AuthenticatedFetch = fixedBearerToken(undefined);

/**
 * Owns the client's anonymous session end to end — minting, proactive
 * refresh before expiry, reactive re-mint on 401, and attaching the current
 * token to every request made through `fetch()`. Every API client depends
 * on this (or `fixedBearerToken`, for a manual override) instead of
 * building its own auth headers and checking for 401 itself: one place
 * owns the contract, not a copy in every client class.
 *
 * One instance (`sessionManager`, below) exists for the life of the app; a
 * host's own session binding is a thin interface onto it, not an owner —
 * tests instantiate their own via `new SessionManager()`.
 */
/**
 * Why there is no token, when there is no token.
 *
 * `authorization()` returning `undefined` and `isReady` settling `true` are
 * the same two facts whether a node refused to mint or no node could be
 * asked, and those need opposite handling: a refusal deserves a login, and
 * being away from home deserves a notice over whatever is already on screen
 * and a retry. Three client sessions built something on the guess in one day
 * and all three removed it — one had a login wall that would have replaced a
 * playing film with a sign-in screen on a network blip, because its condition
 * re-evaluated on every notification and an empty token looked like a policy.
 *
 * So this is the fact core already had and was throwing away, not a new
 * lifecycle. `isReady === false` still means "still asking"; this answers the
 * other two.
 */
export interface SessionMintFailure {
  /**
   * `refused` — a node answered and said no. `unreachable` — nothing answered.
   *
   * A refusal is a policy a cluster stated; the client may be able to do
   * something about it, and telling a viewer to sign in is only honest here.
   */
  reason: 'refused' | 'unreachable';
  /** The HTTP status, where a node gave one. */
  status?: number;
  /** The server's machine-readable reason, e.g. `anonymous_disabled`. */
  code?: string;
  /** The server's own sentence where it sent one, otherwise ours. Never assume it is fit to show a viewer. */
  message: string;
}

function describeMintFailure(error: unknown): SessionMintFailure {
  const authError = error instanceof SessionAuthError ? error : undefined;
  return {
    reason: isSessionRefusal(error) ? 'refused' : 'unreachable',
    ...(authError?.status !== undefined ? { status: authError.status } : {}),
    ...(authError?.code !== undefined ? { code: authError.code } : {}),
    message: error instanceof Error ? error.message : String(error),
  };
}

export class SessionManager implements AuthenticatedFetch {
  private token: string | undefined;
  private ready = false;
  private cancelled = true;
  private settled = false;
  private inFlight: Promise<void> | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private registry: EndpointRegistry | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storageOverride?: StorageLike) {}

  /**
   * Resolved on use, never captured at construction.
   *
   * `sessionManager` below is created when this module is first evaluated,
   * which under ESM happens strictly before the importing entry module's body
   * — so before any `configureMachaHost()` call in it. Reading the host in a
   * constructor default would pin the singleton to the auto-detected
   * environment and silently ignore whatever the host went on to configure.
   * On the web those are the same object; on a host that supplies its own
   * ephemeral storage they are not, and the anonymous session would be cached
   * somewhere nothing ever reads back.
   */
  private get storage(): StorageLike | undefined {
    return this.storageOverride ?? machaHost().ephemeralStorage;
  }

  private mintFailure?: SessionMintFailure;

  get isReady(): boolean {
    return this.ready;
  }

  /**
   * Why the last mint failed, or `undefined` if the current session is good.
   *
   * Cleared the moment a session is adopted, and every change to it is
   * published through `subscribe()`, so a consumer reading it on notification
   * is never looking at a reason that has already been resolved. Read it
   * together with `isReady`: not ready means the question is still open.
   */
  get lastMintFailure(): SessionMintFailure | undefined {
    return this.mintFailure;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** (Re)starts the mint/refresh lifecycle against `registry`. Safe to call again if the registry changes. */
  start(registry: EndpointRegistry): void {
    this.stop();
    this.cancelled = false;
    this.settled = false;
    this.ready = false;
    this.registry = registry;
    void this.bootstrap();
  }

  /**
   * Exchange credentials for a session and adopt it.
   *
   * Failure is thrown rather than swallowed, unlike the background mint: a
   * wrong password is something the person at the keyboard has to be told,
   * and retrying it on a timer would lock the account out on their behalf.
   * The previous session is simply replaced — it belonged to a different
   * user, so revoking it here would sign out whoever else was holding it.
   */
  async signIn(credentials: SessionCredentials): Promise<void> {
    if (!this.registry) throw new Error('Cannot sign in before the session lifecycle has started.');
    const session = await mintAnonymousSessionAnyNode(this.registry, credentials);
    this.cacheSession(session);
    this.adopt(session);
  }

  /**
   * Drop this session and take an anonymous one.
   *
   * Revoking the old token server-side is the caller's to do before calling
   * this, because a revoke is a request that can fail and this cannot: once
   * the viewer has asked to be signed out, ending up still signed in is the
   * one outcome that must not happen.
   */
  async signOut(): Promise<void> {
    this.token = undefined;
    try {
      this.storage?.removeItem(SESSION_CACHE_KEY);
    } catch {
      // An unwritable store cannot keep us signed in: the in-memory token is
      // already gone, and a stale cached one is rejected on the next reload.
    }
    this.notify();
    if (this.registry) await this.mintNow(this.registry);
  }

  /** Halts the lifecycle (pending timers, in-flight tracking) without clearing the current token. */
  stop(): void {
    this.cancelled = true;
    this.registry = undefined;
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  /**
   * An authenticated request, end to end. Callers never need to know
   * whether a session exists yet or is still valid:
   *
   * - Fired before the first token exists (cold start, bootstrap in flight),
   *   the request waits for that bootstrap rather than going out tokenless —
   *   a request that can only 401 is not worth sending.
   * - A 401 on the token that was actually sent means that session is dead:
   *   re-mint (coalesced with any mint already in flight) and retry once with
   *   the new token. A 401 for a token that has *already* been replaced by
   *   the time it arrives (a slow request overlapping someone else's re-mint)
   *   must not mint again — that would clobber the good new session — so it
   *   just retries with the current one.
   * - If re-minting fails there is nothing better to retry with: the
   *   original 401 is returned, and the failure-retry timer owns recovery.
   */
  /**
   * The current `Authorization` header for a request made outside this class.
   *
   * Waits for a bootstrap already in flight, exactly as `fetch` does — a cold
   * start would otherwise hand a native player `undefined` and produce a 401
   * inside a component that has no way to retry. Beyond that it cannot
   * promise much: the token is a snapshot, and a caller holding it across a
   * re-mint holds a dead one. Ask again per request rather than caching it.
   */
  async authorization(): Promise<string | undefined> {
    if (this.token === undefined && this.inFlight) await this.inFlight;
    return this.token ? `Bearer ${this.token}` : undefined;
  }

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    if (this.token === undefined && this.inFlight) await this.inFlight;
    const sent = this.token;
    const response = await this.send(url, init, sent);
    if (response.status !== 401 || sent === undefined) return response;
    await (this.token === sent ? this.mint() : this.inFlight ?? Promise.resolve());
    const current = this.token;
    if (current === undefined || current === sent) return response;
    return this.send(url, init, current);
  }

  private send(url: string, init: RequestInit, token: string | undefined): Promise<Response> {
    return fetch(url, {
      ...init,
      headers: mergeRequestHeaders(init.headers, { Authorization: token ? `Bearer ${token}` : undefined }),
    });
  }

  private settle(): void {
    if (this.settled) return;
    this.settled = true;
    this.ready = true;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private loadCachedSession(): AnonymousSession | undefined {
    const raw = this.storage?.getItem(SESSION_CACHE_KEY);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as Partial<AnonymousSession>;
      if (typeof parsed.token !== 'string' || typeof parsed.expiresAtMs !== 'number') return undefined;
      return { token: parsed.token, expiresAtMs: parsed.expiresAtMs };
    } catch {
      return undefined;
    }
  }

  private cacheSession(session: AnonymousSession): void {
    try {
      this.storage?.setItem(SESSION_CACHE_KEY, JSON.stringify(session));
    } catch {
      // Best-effort: a full/unavailable sessionStorage (private browsing,
      // quota) just means the next reload mints fresh instead of validating.
    }
  }

  private adopt(session: AnonymousSession): void {
    this.settle();
    if (this.cancelled) return;
    this.token = session.token;
    this.mintFailure = undefined;
    this.notify();
    reportClusterReachable();
    this.scheduleRefresh(session.expiresAtMs);
  }

  /**
   * `start()`'s entry point. A cached, unexpired token is worth a cheap
   * server-side validity check before falling back to a full mint — Law 2
   * (`docs/principles-and-laws.md`) forbids adding viewer-visible delay, and
   * minting always costs a real round trip plus server-side session creation
   * where validating is a single lightweight authenticated GET that doubles
   * as an endpoint-reachability check. A definitive rejection (401, from any
   * node — anonymous sessions are valid cluster-wide, so this is not
   * node-specific) skips straight to minting; an unreachable-endpoint
   * failure is treated the same, since minting will hit the identical nodes
   * and fail the same way regardless.
   */
  private bootstrap(): Promise<void> {
    if (!this.registry) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const registry = this.registry;
    const cached = this.loadCachedSession();
    this.inFlight = (async () => {
      if (cached && cached.expiresAtMs > Date.now()) {
        let valid = false;
        try {
          valid = await validateAnonymousSessionAnyNode(registry, cached.token);
        } catch {
          valid = false;
        }
        if (this.cancelled) return;
        if (valid) {
          this.adopt(cached);
          return;
        }
      }
      await this.mintNow(registry);
    })().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async mintNow(registry: EndpointRegistry): Promise<void> {
    try {
      const session = await mintAnonymousSessionAnyNode(registry);
      this.cacheSession(session);
      this.adopt(session);
    } catch (error) {
      this.settle();
      if (this.cancelled) return;
      this.token = undefined;
      this.mintFailure = describeMintFailure(error);
      this.notify();
      // Only "we could not ask" is a connection state. A node that answered
      // 403 in forty milliseconds has demonstrably been reached and has
      // stated a policy; publishing "All configured API endpoints are
      // unreachable" for it is a sentence no node said, and it sends a viewer
      // to check a server that is up and working exactly as configured.
      // `isGatewayConnectionFailure`, one file over, draws this distinction
      // for every other request in the package.
      if (this.mintFailure.reason !== 'refused') reportClusterUnreachable();
      this.refreshTimer = setTimeout(() => { void this.mint(); }, RETRY_AFTER_MINT_FAILURE_MS);
    }
  }

  /** Reactive re-mint (401 from `fetch()`, or the failure-retry timer) — skips validation since the current token is already known bad. */
  private mint(): Promise<void> {
    if (!this.registry) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const registry = this.registry;
    this.inFlight = this.mintNow(registry).finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private scheduleRefresh(expiresAtMs: number): void {
    if (this.cancelled) return;
    const remainingMs = expiresAtMs - Date.now() - REFRESH_SAFETY_MARGIN_MS;
    if (remainingMs <= 0) {
      void this.mint();
      return;
    }
    this.refreshTimer = setTimeout(() => this.scheduleRefresh(expiresAtMs), Math.min(remainingMs, MAX_TIMER_DELAY_MS));
  }
}

/** The one session for the life of the app. `useSession` configures and reads this — it does not own it. */
export const sessionManager = new SessionManager();

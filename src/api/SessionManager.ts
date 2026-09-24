import { machaHost } from '../runtime/host.js';
import type { StorageLike } from '../state/storage.js';
import { isSessionRefusal, mintSessionAnyNode, revokeSessionAnyNode, SessionAuthError, validateSessionAnyNode, type Session, type SessionCredentials } from './SessionAuth.js';
import type { CurrentSession, UserRole } from './UsersApi.js';
import { mergeRequestHeaders } from './httpCompat.js';
import { MachaConnectionError, reportClusterReachable, reportClusterUnreachable } from './serverConnection.js';
import type { EndpointRegistry } from '../cluster/EndpointRegistry.js';

/**
 * Where the session is cached. Dotted, joining the convention the state stores
 * already use; the hyphenated `macha-session` it replaces is retired.
 *
 * Renaming is free exactly once, and this is the release: moving the session
 * out of tab-lifetime storage already forces one fresh mint everywhere, so the
 * key change costs nothing on top of it. Doing it later would cost a second.
 */
const SESSION_CACHE_KEY = 'macha.session.v1';
const RETRY_AFTER_MINT_FAILURE_MS = 10_000;
/**
 * How far before the server-declared expiry to re-mint rather than wait to be
 * 401'd.
 *
 * **There is no renewal to schedule, and that is now a decision rather than a
 * gap.** Confirmed with the server on 2026-09-13: the session TTL is 30 days,
 * counted from *creation* and never extended — `validate()` does not slide it
 * — and there are no refresh tokens. So this timer does not refresh anything;
 * it re-mints, which is a different operation with a different result.
 *
 * **For a credentialed session that difference is the whole story.** A re-mint
 * presents no credentials, so at the 30-day mark a signed-in viewer's session
 * becomes a session for whatever an empty set of credentials authenticates.
 * Re-minting is still the right thing to attempt — it is the only thing this
 * can present — but **do not assume the result is a usable browsing session.**
 *
 * On a cluster where the anonymous account holds no roles — the shape of any
 * deployment that requires accounts — the re-mint degrades a signed-in viewer
 * not to browsing but **to nothing**: the library empties mid-use and the
 * application renders its refused state, unannounced, looking exactly like a
 * fault. That is worse than a logout, because a logout at least says what
 * happened.
 *
 * *Measured rather than hypothesised, on the development cluster with
 * `media_viewer` removed from the anonymous account: `POST /api/v1/session`
 * with empty credentials mints successfully on every node and returns
 * `roles: []`, and `/catalogue/items` then answers `403 requires the
 * 'media_viewer' role`. So the degraded session is not merely limited — it
 * cannot read the catalogue at all, which presents as an empty client rather
 * than as a sign-out.*
 *
 * **Core gives a host both halves of the answer and invents neither.**
 * {@link SessionManager.lastIdentityChange} says the session stopped belonging
 * to the account it belonged to; {@link sessionLockedOut} on
 * {@link SessionManager.roles} says whether what replaced it can do anything
 * at all. Read together they separate "your session aged out" from "this
 * cluster refuses you" — two states that look identical to a gate and read
 * very differently to a person. Core states neither sentence, because a 401
 * does not distinguish an expiry from a revoke from a `credential_generation`
 * bump.
 *
 * So a signed-in viewer is signed out 30 days after minting **even under daily
 * use**, knowingly short of "permanent until logout". The honest remedy is not
 * to explain it afterwards but to pre-empt it: the expiry is knowable in
 * advance from the session's own `expiresAtMs`, so a host can ask for a fresh
 * sign-in before the deadline rather than after the library has emptied.
 */
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
  /** The server's own sentence, where it sent one, for a host that shows it. Never core's text. */
  detail?: string;
  /** For a log: the server's sentence where it sent one, otherwise core's. Not viewer text. */
  message: string;
}

function describeMintFailure(error: unknown): SessionMintFailure {
  const authError = error instanceof SessionAuthError ? error : undefined;
  return {
    reason: isSessionRefusal(error) ? 'refused' : 'unreachable',
    ...(authError?.status !== undefined ? { status: authError.status } : {}),
    ...(authError?.code !== undefined ? { code: authError.code } : {}),
    ...(authError?.detail !== undefined ? { detail: authError.detail } : {}),
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * A session that now belongs to a different account than it did.
 *
 * `from`/`to` are usernames as the server stated them, and either may be
 * absent where a node did not say. The application decides what this means to
 * a viewer; see {@link SessionManager.lastIdentityChange}.
 */
export interface SessionIdentityChange {
  from?: string;
  to?: string;
  /** `Date.now()` at the moment the new session was adopted — an absolute instant, not `machaHost().now()`. */
  at: number;
}

/**
 * `fetch()` was called on a manager that has no registry to mint against.
 *
 * **Deliberately a `MachaConnectionError`.** "We could not ask" is what a
 * connection state means in this package — the distinction `mintNow` already
 * draws between a node refusing and a node being unreachable — and a caller
 * that already falls back for one should fall back for the other. The phone
 * client's `MediaApi.serve` serves its downloaded library on exactly that
 * classification, and a fresh error type would have escaped it and put a
 * bearer-token message on a library screen, which is the thing that fallback
 * exists to prevent. So this needs no client change to be handled sanely, and
 * `reason` is there for a client that wants to tell the two cases apart.
 *
 * `reason` distinguishes them because they are different faults:
 *
 * - `not-started` — `start()` has never been called. **Routine rather than a
 *   programming error on React Native**: React runs child effects before
 *   parent effects, so a screen's first request fires before the provider's
 *   effect starts the manager. Both RN clients reach it that way on every cold
 *   start.
 * - `stopped` — `start()` ran and `stop()` has since torn it down, typically a
 *   reconfiguration whose cleanup stopped the manager while a request was in
 *   flight. A restart usually follows within milliseconds.
 *
 * Neither is worth sending a request for: with no registry there is nothing to
 * mint against, so the request could only ever 401.
 *
 * **It is not evidence that any node is unreachable, and must not be reported
 * as connectivity.** It is a `MachaConnectionError` because the *request*
 * could not be made, but no node was asked and none has said anything — so a
 * host that calls something like `reportUnreachable()` on every
 * `MachaConnectionError` will flip a viewer to an offline state on a
 * perfectly healthy cluster. The phone client traced that cost on its own
 * tree: the cold-start route reaches its transport branch, the UI flips
 * offline, and its probe suppression then withholds real requests for twenty
 * seconds, so a viewer sees their downloads instead of their library on every
 * launch. **Branch on `reason` before treating this as a network fault** —
 * that is what `reason` is for.
 */
export class SessionNotStartedError extends MachaConnectionError {
  constructor(public readonly reason: 'not-started' | 'stopped') {
    super(reason === 'not-started'
      ? 'The Macha session manager has not been started, so this request has nothing to authenticate against.'
      : 'The Macha session manager was stopped, so this request has nothing to authenticate against.');
    this.name = 'SessionNotStartedError';
  }
}

export class SessionManager implements AuthenticatedFetch {
  private token: string | undefined;
  private ready = false;
  private cancelled = true;
  private settled = false;
  private inFlight: Promise<void> | undefined;
  /**
   * Which lifecycle the work in `inFlight` belongs to.
   *
   * `cancelled` cannot answer that question, because `start()` clears it: a
   * bootstrap cancelled by the `stop()` inside `start()` sees `cancelled`
   * false again by the time it lands, and adopts a session minted against a
   * registry nobody is using any more. Every `stop()` moves this instead, and
   * nothing moves it back, so abandoned work stays abandoned.
   */
  private generation = 0;
  /** The generation `inFlight` belongs to, so an abandoned run cannot clear its successor's handle. */
  private inFlightGeneration = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private registry: EndpointRegistry | undefined;
  /** Whether `start()` has ever run, so a teardown is distinguishable from a cold start. */
  private started = false;
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
    const host = machaHost();
    return this.storageOverride ?? host.secureStorage ?? host.storage;
  }

  private mintFailure?: SessionMintFailure;
  private sessionRoles?: UserRole[];
  private sessionUsername?: string;
  /** Whether a session has ever been adopted, so the first is an arrival rather than a change. */
  private adopted = false;
  private identityChange?: SessionIdentityChange;

  get isReady(): boolean {
    return this.ready;
  }

  /**
   * What the current session may do, or `undefined` if nothing has said yet.
   *
   * Roles arrive with the token on every path — the mint response states them,
   * and so does the record returned by validating a cached token — so there is
   * no separate fetch to fail and nothing to retry. That is the point: this
   * was the one part of the session lifecycle living outside this class, and a
   * client fetching it once per API identity never re-asked, because failover
   * changes the preferred endpoint *inside* the registry without changing that
   * identity. One transient failure left roles unknown for a whole run.
   *
   * `undefined` is unknown and an empty array is a session granted nothing;
   * feed it to `sessionPermits` and `sessionLockedOut`, which keep them apart.
   * A node too old to state roles leaves this `undefined` forever, which is
   * the permissive answer and the right one.
   */
  get roles(): UserRole[] | undefined {
    return this.sessionRoles;
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

  /**
   * The last time the session stopped belonging to the account it belonged to
   * before, or `undefined` if that has not happened since the last `signIn()`.
   *
   * **This is the whole of core's answer to "was the viewer signed out?", and
   * it is a comparison rather than a special case.** A 401 is answered by
   * re-minting, and a re-mint presenting no credentials gets a session for
   * whatever account an empty set of credentials authenticates. That is the
   * right thing to attempt — it is the only thing core can present, and
   * browsing anonymously beats no session at all — but it means an
   * administrator whose roles changed underneath them, or whose password was
   * changed elsewhere, silently becomes somebody else. Sections vanish, writes
   * start failing, and nothing says why: an auth event wearing the costume of
   * a UI bug.
   *
   * Core records the change and says nothing about what it means. *Why* the
   * identity moved — an expiry, a revoke, a `credential_generation` bump from
   * a role change, someone signing out on another device — is not something a
   * 401 distinguishes, and "your session timed out" is the wrong sentence for
   * most of those. The application knows its viewer; it decides the wording
   * and whether to interrupt.
   *
   * **Anonymous is not special here either.** Signed-in-to-anonymous is a
   * change and is reported; anonymous-to-anonymous is not a change and is
   * silent. Both fall out of comparing the name rather than testing it.
   *
   * A node too old to state `username` cannot support this, and core will not
   * invent it: with nothing to compare, no change is reported. Said plainly
   * rather than approximated, because a false "you were signed out" is worse
   * than a missing one.
   */
  get lastIdentityChange(): SessionIdentityChange | undefined {
    return this.identityChange;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * (Re)starts the mint/refresh lifecycle against `registry`.
   *
   * Safe to call again if the registry changes, and that is now true in the
   * window it used to be false in: the `stop()` here moves the generation, so
   * a bootstrap still in flight against the previous registry is disowned
   * rather than adopted, and this call contacts the new one instead of
   * returning the old one's promise.
   */
  start(registry: EndpointRegistry): void {
    this.stop();
    this.cancelled = false;
    this.settled = false;
    this.ready = false;
    this.registry = registry;
    this.started = true;
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
   *
   * Playback must be stopped before calling this, for the same reason it must
   * be stopped before `signOut`. Nothing connects a playback session to an
   * identity, and once the token changes a session created under the old one
   * can no longer be closed: the node holds its transcode entitlement until
   * `session_idle`, thirty minutes, and on a one-slot node the next viewer
   * gets `429 resource_limit` with nothing pointing at the client that caused
   * it. Invisible from here, which is why it is said here.
   */
  async signIn(credentials: SessionCredentials): Promise<void> {
    // The same fault fetch() refuses for, and typed the same way: a login
    // screen that sorts 401/403 from everything else must be able to tell
    // "the manager was never started" from "no node could be reached", or an
    // app bug sends a viewer to check a server that is up.
    if (!this.registry) throw new SessionNotStartedError(this.started ? 'stopped' : 'not-started');
    const session = await mintSessionAnyNode(this.registry, credentials);
    this.cacheSession(session);
    this.adopt(session, this.generation);
    // Deliberate, so not a change to report: the viewer just asked for this
    // identity. Cleared *after* `adopt`, which would otherwise record the very
    // transition the viewer performed and hand the application a "you were
    // signed out" to show someone who has just signed in.
    this.identityChange = undefined;
  }

  /**
   * End this session, server-side and locally. **Does not mint a replacement.**
   *
   * This used to drop the token and immediately mint an anonymous one, which
   * made two decisions look like one. They are separate, and the composition
   * is now the caller's: sign out, then `start(registry)` again if and when a
   * session is wanted. A screen that signs the viewer out on the way to a
   * login form does not need a session in between, and minting one it never
   * uses costs a round trip and takes a slot on a node.
   *
   * Revoking is done here rather than left to the caller, because forgetting a
   * token is not signing out: the session stays valid on every node until it
   * expires and anyone holding it keeps the access. The two halves are ordered
   * so they cannot conflict — **local state is cleared first and
   * unconditionally**, since once the viewer has asked to be signed out,
   * ending up still signed in is the one outcome that must not happen; then
   * the revoke runs and **its failure is not swallowed**. A caller that shows
   * "signed out" needs to be able to learn that the session is still live
   * somewhere.
   *
   * Playback must be stopped before calling this. Nothing connects a playback
   * session to an identity, and once the token changes a session created under
   * the old one can no longer be closed — the node then holds its transcode
   * entitlement until `session_idle`, thirty minutes, and on a one-slot node
   * the next viewer gets `429 resource_limit` with nothing pointing at the
   * client that caused it.
   *
   * @throws SessionAuthError if the cluster could not be told. Local state is
   * cleared regardless.
   */
  async signOut(): Promise<void> {
    const token = this.token;
    const registry = this.registry;
    // Local state first, unconditionally. The viewer has asked to be signed
    // out, and ending up still signed in is the one outcome that must not
    // happen — so nothing below is allowed to leave a token behind, however
    // it fails.
    this.token = undefined;
    this.sessionRoles = undefined;
    this.sessionUsername = undefined;
    this.adopted = false;
    this.identityChange = undefined;
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    try {
      this.storage?.removeItem(SESSION_CACHE_KEY);
    } catch {
      // An unwritable store cannot keep us signed in: the in-memory token is
      // already gone, and a stale cached one is rejected on the next reload.
    }
    this.notify();
    // Then the part that actually ends it. Dropping the token locally leaves
    // the session valid on every node until it expires, and anyone holding
    // that token keeps the access — so a "sign out" that only forgets is a
    // sign-out in name only.
    //
    // The error is not swallowed. A failed revoke means the session is still
    // live somewhere, and a caller that shows "signed out" on the strength of
    // this call needs to be able to say otherwise.
    if (token && registry) await revokeSessionAnyNode(registry, token);
  }

  /** Halts the lifecycle (pending timers, in-flight tracking) without clearing the current token. */
  stop(): void {
    this.cancelled = true;
    // Whatever is in flight was started against a registry this manager no
    // longer has. `cancelled` is not enough to disown it, because `start()`
    // clears that flag on the way back in.
    this.generation += 1;
    this.registry = undefined;
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  /** Whether work started in `generation` still belongs to the current lifecycle. */
  private abandoned(generation: number): boolean {
    return this.cancelled || this.generation !== generation;
  }

  /**
   * Replace the pending timer, clearing whatever was already there.
   *
   * Both assignment sites used to overwrite the handle, and `stop()` clears
   * only the one it can see: a retry timer armed over a refresh timer left
   * the earlier one running, a mint nobody could cancel, firing against a
   * registry the manager may no longer have.
   */
  private armTimer(fire: () => void, delayMs: number): void {
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(fire, delayMs);
  }

  /**
   * The current `Authorization` header for a request made outside this class.
   *
   * Waits for a bootstrap already in flight, exactly as `fetch` does — a cold
   * start would otherwise hand a native player `undefined` and produce a 401
   * inside a component that has no way to retry. It waits across a reactive
   * re-mint too, because `fetch` drops a token a node has rejected before
   * asking for a new one — so there is no window in which this hands out a
   * credential already known to be refused. Beyond that it cannot promise
   * much: the token is a snapshot, and a caller holding it across a re-mint
   * holds a dead one. Ask again per request rather than caching it.
   *
   * **Unlike `fetch`, this answers `undefined` rather than throwing when the
   * manager is not started.** It is a question about current state, and "there
   * is no token" is a true answer to it. A caller that turns that `undefined`
   * into a request is building the very thing `fetch` now refuses to send.
   */
  async authorization(): Promise<string | undefined> {
    if (this.token === undefined && this.inFlight) await this.inFlight;
    return this.token ? `Bearer ${this.token}` : undefined;
  }

  /**
   * An authenticated request, end to end. A caller never needs to know whether
   * a session exists yet or is still valid:
   *
   * - Fired before the first token exists while a bootstrap is in flight, the
   *   request waits for that bootstrap rather than going out tokenless — a
   *   request that can only 401 is not worth sending.
   * - Fired with **no registry at all** — never started, or stopped since — it
   *   throws {@link SessionNotStartedError} rather than sending. There is
   *   nothing to mint against, so the request could only 401, and returning
   *   that 401 to a caller told it would never see one is worse than refusing:
   *   the web client met exactly that on a reload into a player URL, 18 ms
   *   after load, and a viewer got a broken video out of it.
   * - A 401 on the token that was actually sent means that session is dead:
   *   re-mint (coalesced with any mint already in flight) and retry once with
   *   the new token. A 401 for a token that has *already* been replaced by
   *   the time it arrives (a slow request overlapping someone else's re-mint)
   *   must not mint again — that would clobber the good new session — so it
   *   just retries with the current one.
   * - If re-minting fails there is nothing better to retry with: the
   *   original 401 is returned, and the failure-retry timer owns recovery.
   *
   * **This doc used to be attached to `authorization()`**, one method up,
   * promising a wait that the code did not perform. A client read the promise,
   * built on it, and found the 401 in production.
   */
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    if (!this.registry) throw new SessionNotStartedError(this.started ? 'stopped' : 'not-started');
    if (this.token === undefined && this.inFlight) await this.inFlight;
    const sent = this.token;
    const response = await this.send(url, init, sent);
    if (response.status !== 401 || sent === undefined) return response;
    // A node has refused this token, so it has stopped being a credential.
    // Dropped here rather than replaced when the mint lands, because
    // `authorization()` answers from `this.token` and only waits when it is
    // undefined: leaving it in place hands a native player, for the whole
    // length of the re-mint, exactly the token that has just been rejected.
    const rejectedIsCurrent = this.token === sent;
    if (rejectedIsCurrent) this.token = undefined;
    await (rejectedIsCurrent ? this.mint() : this.inFlight ?? Promise.resolve());
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

  private loadCachedSession(): Session | undefined {
    const raw = this.storage?.getItem(SESSION_CACHE_KEY);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as Partial<Session>;
      if (typeof parsed.token !== 'string' || typeof parsed.expiresAtMs !== 'number') return undefined;
      // The whole record, not just the credential. `cacheSession` has always
      // written `username` and `roles`; this used to parse them and throw them
      // away, which made a restored session structurally indistinguishable
      // from a freshly minted anonymous one — so after a reload core could not
      // tell it had ever been signed in, and the identity check below had
      // nothing to compare against.
      return {
        token: parsed.token,
        expiresAtMs: parsed.expiresAtMs,
        ...(typeof parsed.username === 'string' ? { username: parsed.username } : {}),
        ...(Array.isArray(parsed.roles) ? { roles: parsed.roles.filter((role): role is UserRole => typeof role === 'string') } : {}),
      };
    } catch {
      return undefined;
    }
  }

  private cacheSession(session: Session): void {
    try {
      this.storage?.setItem(SESSION_CACHE_KEY, JSON.stringify(session));
    } catch {
      // Best-effort: a full/unavailable sessionStorage (private browsing,
      // quota) just means the next reload mints fresh instead of validating.
    }
  }

  private adopt(session: Session, generation: number): void {
    // Ready is published *with* the session, never ahead of it.
    //
    // `settle()` used to run here, at the top, so the first notification a
    // subscriber received carried `isReady === true` with no token and no
    // roles — momentarily indistinguishable from a session the cluster
    // granted nothing. A three-state gate reading unknown / granted / denied
    // sees that window as a refusal, which is how a privileged viewer lands on
    // a login screen. The window always existed; a restored signed-in session
    // is what makes it matter rather than merely exist.
    if (this.abandoned(generation)) {
      this.settle();
      return;
    }
    this.token = session.token;
    this.mintFailure = undefined;
    // Compared only when the node actually named an account. A node too old to
    // state `username` says nothing about who this is, which is not evidence
    // that the account changed — the same reasoning as the roles line below,
    // and the direction that avoids inventing a sign-out nobody performed.
    if (session.username !== undefined) {
      if (this.adopted && this.sessionUsername !== session.username) {
        this.identityChange = { from: this.sessionUsername, to: session.username, at: Date.now() };
      }
      this.sessionUsername = session.username;
    }
    this.adopted = true;
    // Left alone when the node did not state them: a token that arrived with
    // no roles attached says nothing about the roles, and overwriting a known
    // answer with `undefined` would turn a session granted nothing back into
    // a session permitted everything.
    if (session.roles !== undefined) this.sessionRoles = session.roles;
    this.settled = true;
    this.ready = true;
    this.notify();
    reportClusterReachable();
    this.scheduleRefresh(session.expiresAtMs, generation);
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
    // Coalesced only within one lifecycle. A bootstrap from a previous
    // registry is not this one's answer, however far along it is.
    if (this.inFlight && this.inFlightGeneration === this.generation) return this.inFlight;
    const registry = this.registry;
    const generation = this.generation;
    const cached = this.loadCachedSession();
    const run = (async () => {
      if (cached && cached.expiresAtMs > Date.now()) {
        let record: CurrentSession | undefined;
        try {
          record = await validateSessionAnyNode(registry, cached.token);
        } catch {
          record = undefined;
        }
        if (this.abandoned(generation)) return;
        if (record) {
          // The validation request is also the only request that states what
          // this session may do, so the warm path adopts the roles it already
          // paid for rather than asking again.
          this.adopt({ ...cached, roles: record.roles }, generation);
          return;
        }
      }
      await this.mintNow(registry, generation);
    })().finally(() => { if (this.inFlightGeneration === generation) this.inFlight = undefined; });
    this.inFlight = run;
    this.inFlightGeneration = generation;
    return run;
  }

  private async mintNow(registry: EndpointRegistry, generation: number): Promise<void> {
    try {
      const session = await mintSessionAnyNode(registry);
      this.cacheSession(session);
      this.adopt(session, generation);
    } catch (error) {
      this.settle();
      if (this.abandoned(generation)) return;
      this.token = undefined;
      // No token, nothing known about what it may do.
      this.sessionRoles = undefined;
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
      this.armTimer(() => { void this.mint(); }, RETRY_AFTER_MINT_FAILURE_MS);
    }
  }

  /** Reactive re-mint (401 from `fetch()`, or the failure-retry timer) — skips validation since the current token is already known bad. */
  private mint(): Promise<void> {
    if (!this.registry) return Promise.resolve();
    if (this.inFlight && this.inFlightGeneration === this.generation) return this.inFlight;
    const registry = this.registry;
    const generation = this.generation;
    const run = this.mintNow(registry, generation).finally(() => { if (this.inFlightGeneration === generation) this.inFlight = undefined; });
    this.inFlight = run;
    this.inFlightGeneration = generation;
    return run;
  }

  private scheduleRefresh(expiresAtMs: number, generation: number): void {
    if (this.abandoned(generation)) return;
    const remainingMs = expiresAtMs - Date.now() - REFRESH_SAFETY_MARGIN_MS;
    if (remainingMs <= 0) {
      void this.mint();
      return;
    }
    this.armTimer(() => this.scheduleRefresh(expiresAtMs, generation), Math.min(remainingMs, MAX_TIMER_DELAY_MS));
  }
}

/** The one session for the life of the app. `useSession` configures and reads this — it does not own it. */
export const sessionManager = new SessionManager();

import { MachaConnectionError } from '../api/serverConnection.js';

export type EndpointFailureKind = 'transport' | 'unavailable' | 'capacity' | 'session-missing';

export class MachaEndpointError extends Error {
  constructor(
    message: string,
    public readonly endpointId: string,
    public readonly baseUrl: string,
    public readonly kind: EndpointFailureKind,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'MachaEndpointError';
  }
}

/**
 * The HTTP status for a failure, wherever it ended up in the chain.
 *
 * **The companion to `playbackFailureCode`, and it exists because leaving it
 * private cost a client a real bug.** `endpointFailure()` wraps the original
 * in a `MachaEndpointError` that carries **neither `status` nor `code` of its
 * own**, so a caller reading `error.status` off the object it caught finds
 * nothing and classifies every wrapped refusal as fatal. The phone client hit
 * exactly that on 2026-09-21, in a classifier it had written an hour earlier
 * to fix the neighbouring bug — it had corrected *"the error I catch is the
 * error I raise"* and immediately assumed *"the fields are on the error I
 * catch"*. Its degrade path had then been dead twice in one day.
 *
 * **Core walks this chain in three places; a client that has to re-walk it is
 * a mirror that only one side will update.** Exported for the same reason the
 * code accessor is, and stated as the rule rather than the exception: **what
 * survives a layer boundary is fields, never identity and never position** —
 * duck-type on `status` and `code`, and read them through these accessors.
 */
export function playbackFailureStatus(error: unknown): number | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const status = (current as { status?: unknown }).status;
    if (typeof status === 'number' && Number.isFinite(status)) return status;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Why the source failed, as the server states it.
 *
 * `source_unsupported` is a fact about the file: every node holds the same
 * bytes and every node will refuse it the same way, so walking the cluster
 * only spends the viewer's time before giving them the same answer.
 * `source_unreadable` and `source_read_timed_out` are facts about one node's
 * view of it — a bad extent, a storage mount gone slow — and the next node is
 * exactly the right thing to try.
 */
const TERMINAL_SOURCE_REASONS: ReadonlySet<string> = new Set(['source_unsupported']);
const NODE_LOCAL_SOURCE_REASONS: ReadonlySet<string> = new Set([
  'source_unreadable',
  'source_read_timed_out',
]);

function failureReason(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const reason = (error as { reason?: unknown }).reason;
  if (typeof reason === 'string') return reason;
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === 'object') {
    const nested = (cause as { reason?: unknown }).reason;
    if (typeof nested === 'string') return nested;
  }
  return undefined;
}

export function retryableEndpointFailure(error: unknown): boolean {
  const reason = failureReason(error);
  // A stated reason outranks the status. A node reporting a 5xx for a file it
  // cannot decode is telling the truth about the file, and asking its
  // neighbours produces three identical refusals instead of one.
  if (reason !== undefined && TERMINAL_SOURCE_REASONS.has(reason)) return false;
  if (reason !== undefined && NODE_LOCAL_SOURCE_REASONS.has(reason)) return true;

  if (error instanceof MachaConnectionError || error instanceof MachaEndpointError) return true;
  // Browser Fetch reports connection refusal, DNS failure and CORS transport
  // failure as TypeError. API/schema errors use the typed HTTP errors below.
  if (error instanceof TypeError) return true;
  // Cancellation describes client intent, never endpoint health. Callers that
  // impose a genuine endpoint deadline must surface a typed timeout instead.
  if (error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError') return false;
  if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'profile_pending') return true;
  // An account-scoped refusal used to return `false` here, on the belief that
  // every node would repeat it. **It does not, and the belief was wrong at the
  // source.** See `ACCOUNT_SCOPED_FAILURE_CODES`: the cap is counted per node,
  // so a refusal from one node says nothing about the next. It walks like any
  // other `429`, and what it must not do — charge the node — is handled by
  // `failureBlamesEndpoint` rather than by refusing to walk.
  const status = errorStatus(error);
  // A server-side failure can be node-local (for example this node cannot read
  // a media extent). Safe reads and idempotent playback admission must exhaust
  // the remaining cluster candidates rather than treating the first 500 as a
  // cluster-wide terminal result. Mutation routers still execute only once.
  return status === 429 || (status !== undefined && status >= 500 && status <= 599);
}

/**
 * Server error codes that describe one title's outcome on a node, not the
 * node's health.
 *
 * A transcode pipeline that fails to start, or a source stream that dies, is
 * a fact about that title on that node. Cooling the endpoint down for it
 * takes a healthy node out of rotation for every *other* title — and with a
 * small cluster and an escalating cooldown, a single unplayable file can
 * empty the candidate list. Trying the next node for the same title is still
 * right; recording the node as unhealthy is not.
 */
/**
 * Server error codes that describe the **account**, not the node and not the
 * title.
 *
 * A third scope, and core had only two. Server `0.48.0` adds a per-account
 * session cap, because once one bearer token can hold several playback
 * sessions nothing else bounds one account — the cap is the admission control
 * that replaces one-session-per-bearer. It answers `429 account_session_limit`
 * with the limit and the current count in the body.
 *
 * **The cap is counted per node, and core spent a release believing it was
 * counted per cluster.** `playback.cpp`'s `sessions_held_by_locked` iterates
 * that node's own in-process session map: there is no replication, no gossip
 * of account counts, and no cluster-wide total anywhere in the server. So
 * `account_session_limit` from one node means *that node* holds the account's
 * limit, and the next node counts from its own zero.
 *
 * **What this set is for, and what it is not for.** It is not a routing
 * decision. A refusal listed here is still worth trying elsewhere — the walk
 * is how a viewer gets served by a node that has room — and it is listed here
 * so that the walk happens *without charging anyone*: an account at its limit
 * on one node is not evidence that the node is unwell. Routing asks
 * `retryableEndpointFailure`; blame asks `failureBlamesEndpoint`; a host
 * asking what to tell a viewer asks `isAccountSessionLimit`. Three questions,
 * three answers, and conflating the first two is what produced the defect
 * above.
 *
 * **How the wrong premise got in, because it will try to come back.** The
 * server's own source said it: a comment beside the refusal reasoned that
 * "an account cap is identical on every node in the cluster", about a hundred
 * lines from the loop that disproves it. Core adopted the sentence rather than
 * the code, three clients adopted core, and the result was a viewer refused
 * outright on a cluster where two nodes had capacity. **Read the loop, not the
 * comment beside it.**
 *
 * `resource_limit` is deliberately *not* listed — it is shared by the
 * node-wide session limit and both transcode limits, where the node really is
 * full and the charge is earned.
 */
const ACCOUNT_SCOPED_FAILURE_CODES: ReadonlySet<string> = new Set([
  'account_session_limit',
]);

/**
 * **Core holds the refusal, never the limit. Do not add a number here.**
 *
 * What is above is a *code the server owns and stated*. The cap's value is a
 * node's configuration, it is the operator's to set, and core has no standing
 * to hold a copy of it — not as a constant, not as a default, not as a
 * fallback for a node that has not said. Core attempts, and handles the
 * refusal it gets.
 *
 * **This is the fault class this repository keeps re-recording, and it has a
 * measured cost each time.** A client sized itself against `look_ahead_ms`'s
 * default of 8 segments when the node was configured for 4, believed it had
 * 32 s of authorised production against a real 16, and sat refused at the
 * frontier for the difference — a 12.7 s viewer freeze on 2026-09-17. Two
 * standby windows in `PlaybackCoordinator` are still literals sized against a
 * configurable `pipeline_idle_ms`, and they are open items for the same
 * reason. **A default is not a contract**, and the whole of `0.14.0` was spent
 * deleting core's private copies of server numbers.
 *
 * The server has agreed to publish the limit and the current count somewhere
 * core can read *before* it plans, rather than only on the refusal — so core
 * can decline to prepare a standby it knows will be refused instead of
 * discovering the cap at the moment failover needs it. **When that lands, read
 * it per response and treat absence as "the node cannot say"**, the same
 * convention `lookAheadMs` and `PlaybackSource.budgets` already use. Until
 * then core plans as though there were no cap, which is correct: an attempt
 * that is refused costs one round trip, and a guessed limit costs a standby
 * that was never built.
 */

function isAccountScopedFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && ACCOUNT_SCOPED_FAILURE_CODES.has(code);
}

const PER_TITLE_FAILURE_CODES: ReadonlySet<string> = new Set([
  'playback_pipeline_start_failed',
  'stream_failed',
]);

/**
 * Does this failure say anything about the endpoint's health?
 *
 * **The charge gate, and the only one.** Every site that records a failure
 * against the registry asks this, and a site that cannot walk says so with
 * `pinned`. The reasons not to charge are siblings and were previously spelled
 * differently, or not at all: a per-title failure is
 * about the file, an account-scoped one is about the account, and neither is
 * about the node. `isPerTitleFailure` alone was the gate, which left the
 * account case relying on `retryableEndpointFailure` returning `false` — so
 * the moment the walk was corrected, the charge would have followed it onto
 * every healthy node in the cluster. Naming the question separately is what
 * keeps routing and blame from being one decision again.
 */
export function failureBlamesEndpoint(
  error: unknown,
  options?: { readonly pinned?: boolean },
): boolean {
  if (isPerTitleFailure(error)) return false;
  if (isAccountScopedFailure(error)) return false;
  // A capacity refusal on a pinned path. The node is **full, not unwell**, and
  // the caller cannot act on the charge: `update` and `stop` are pinned to the
  // node that holds the generation, so there is no walk for the charge to
  // inform. All it does is apply an escalating cooldown to a node that is
  // working perfectly and will have room again shortly.
  //
  // On a walking path the same refusal is charged, and that is not an
  // inconsistency: there the charge biases the *next* attempt away from a node
  // that just said it was full, which saves a round trip. The difference is
  // whether anything can use the answer.
  //
  // The server states this distinction directly from 0.48.0's successor:
  // `resource_limit` on create carries scope=node with
  // alternative_may_succeed, while on update it carries scope=request —
  // the session lives here and is still serving, so the remedy is a different
  // instruction against this node, a remux instead of a transcode or a lower
  // height, not a different node. Core keys on the status rather than those
  // axes for now, deliberately: they are committed on the server but not
  // pushed and not deployed, and every node in the field today sends
  // `resource_limit` with no axes at all.
  if (options?.pinned === true && errorStatus(error) === 429) return false;
  return true;
}

export function isPerTitleFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const reason = failureReason(error);
  // A source this node could not read, or could not read in time, says
  // nothing about its ability to serve anything else.
  if (reason !== undefined
    && (NODE_LOCAL_SOURCE_REASONS.has(reason) || TERMINAL_SOURCE_REASONS.has(reason))) return true;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && PER_TITLE_FAILURE_CODES.has(code);
}

/**
 * The server's machine code for a failure, wherever it ended up in the chain.
 *
 * **A host should never parse a message and should never walk `cause` itself,
 * and until this existed it had no third option.** By the time a create
 * failure reaches `PlaybackCoordinatorSnapshot.fatalError` it is a bare
 * `Error` whose code sits two or three links down — `MachaPlaybackError`
 * wrapped by `endpointFailure`, then chained by `terminalRecoveryError`. The
 * Android TV client asked what it could render for a per-account cap refusal
 * and the honest answer was "the message, or a chain walk you write yourself".
 * Neither is acceptable for the most actionable failure in the system: a
 * viewer on a television told *"Playback failed: account_session_limit"* has
 * no address bar to go and close the other session in, and a host that
 * string-matches is one server rewording away from silence.
 *
 * Cycle-safe by the same rule as `terminalRecoveryError`: a viewer waiting on
 * a hung failure report is strictly worse than one told slightly less.
 *
 * Returns the **first** code found, outermost first, because the outermost
 * layer is the one that classified the failure. `undefined` means no layer
 * stated one, which is not the same as the failure having no cause.
 *
 * **The name is narrower than the behaviour, deliberately.** This walks any
 * error chain and is correct for auth, catalogue and transfer failures too --
 * every family in this package wraps the same way. Use it there rather than
 * writing a second walk: the web client found a `signInComplaint` reading
 * `.status` one level off `cause`, which degrades to a generic message the
 * moment anything wraps a `401` in something carrying no status of its own.
 * **A hand-rolled walk is the mirror these accessors exist to retire**, and a
 * domain-flavoured name should not be what talks somebody into writing one.
 */
export function playbackFailureCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Is this the account's own session cap refusing, rather than anything about
 * the node or the title?
 *
 * Named because it is the one failure a host can give a viewer a genuinely
 * useful sentence for — *"another screen on this account is playing"* — and
 * because the alternative is four clients each matching on a code string that
 * is core's to track, not theirs.
 */
/**
 * The sentence a viewer can be shown, wherever it ended up in the chain.
 *
 * **The third accessor, and it exists for the same reason as the other two.**
 * `playbackFailureCode` and `playbackFailureStatus` were added because hosts
 * were parsing messages and walking `cause` themselves. This is the rest of
 * that job: what a host actually renders. Without it a host shows `.message`,
 * which by the time a playback failure has crossed `endpointFailure` reads
 * *"Macha endpoint http://10.35.1.50:7438 failed: Macha playback request
 * failed: timed out waiting for first fragmented-MP4 segment"* — two of core's
 * own envelopes and a node address, in front of a viewer. Three clients
 * displayed exactly that today and one had written a loop to strip prefixes
 * until none remained.
 *
 * **Carried rather than reconstructed.** Stripping core's prefixes means a
 * client matching on core's wording, which goes silent the first time one is
 * reworded — the same fault `playbackFailureCode` retired for codes. The
 * server's sentence is kept on the error at the moment it is parsed.
 *
 * Returns the **innermost** stated detail, which is the opposite of
 * `playbackFailureCode`: the outermost layer is the one that classified the
 * failure, but the innermost is the one that knows what happened. `undefined`
 * means no layer stated a viewer-facing sentence, and a host should then say
 * something of its own rather than fall back to `.message`.
 *
 * Cycle-safe by the same rule as its neighbours.
 */
export function playbackFailureDetail(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current = error;
  let innermost: string | undefined;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const detail = (current as { detail?: unknown }).detail;
    if (typeof detail === 'string' && detail.length > 0) innermost = detail;
    current = (current as { cause?: unknown }).cause;
  }
  return innermost;
}

export function isAccountSessionLimit(error: unknown): boolean {
  const code = playbackFailureCode(error);
  return code !== undefined && ACCOUNT_SCOPED_FAILURE_CODES.has(code);
}

export function unreachableEndpointFailure(error: unknown): boolean {
  if (error instanceof MachaConnectionError) return true;
  if (error instanceof MachaEndpointError) return error.kind === 'transport';
  return error instanceof TypeError;
}

export function endpointFailure(
  endpointId: string,
  baseUrl: string,
  error: unknown,
): MachaEndpointError {
  const status = errorStatus(error);
  const kind: EndpointFailureKind = status === 429
    ? 'capacity'
    : status === 404
      ? 'session-missing'
      : status !== undefined && status >= 500 && status <= 599
        ? 'unavailable'
        : 'transport';
  const detail = error instanceof Error ? error.message : String(error);
  return new MachaEndpointError(`Macha endpoint ${endpointId} failed: ${detail}`, endpointId, baseUrl, kind, error);
}

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
  // **Account-scoped before status, because the status says the opposite.**
  // A cap on the account answers `429`, and `429` is the one 4xx this function
  // treats as worth another node. For a node-scoped limit that is right; for
  // an account-scoped one every node refuses identically, so the walk is
  // guaranteed-futile work on the viewer's critical path — and because the
  // charge is gated on this answer, walking would also record a failure
  // against every healthy node it visited on the way.
  if (isAccountScopedFailure(error)) return false;
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
 * **Tolerated here before the server ships it**, for the same reason as
 * `SOURCE_SUPERSEDED_STATUS`: the failure mode of arriving unprepared is that
 * core walks the whole cluster collecting identical refusals and charges every
 * healthy node it touches. `resource_limit`, which this replaces for the
 * account case, is deliberately *not* listed — it is shared by the node-wide
 * session limit and both transcode limits, where walking and charging are
 * correct because the node really is full.
 */
const ACCOUNT_SCOPED_FAILURE_CODES: ReadonlySet<string> = new Set([
  'account_session_limit',
]);

function isAccountScopedFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && ACCOUNT_SCOPED_FAILURE_CODES.has(code);
}

const PER_TITLE_FAILURE_CODES: ReadonlySet<string> = new Set([
  'playback_pipeline_start_failed',
  'stream_failed',
]);

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

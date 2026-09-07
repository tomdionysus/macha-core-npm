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

export function retryableEndpointFailure(error: unknown): boolean {
  if (error instanceof MachaConnectionError || error instanceof MachaEndpointError) return true;
  // Browser Fetch reports connection refusal, DNS failure and CORS transport
  // failure as TypeError. API/schema errors use the typed HTTP errors below.
  if (error instanceof TypeError) return true;
  // Cancellation describes client intent, never endpoint health. Callers that
  // impose a genuine endpoint deadline must surface a typed timeout instead.
  if (error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError') return false;
  if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'profile_pending') return true;
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
const PER_TITLE_FAILURE_CODES: ReadonlySet<string> = new Set([
  'playback_pipeline_start_failed',
  'stream_failed',
]);

export function isPerTitleFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
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

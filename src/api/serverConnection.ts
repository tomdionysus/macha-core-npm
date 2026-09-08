import { publishConnectionState } from '../runtime/events.js';

/** Names kept for hosts that bridge these onward as DOM/native events. */
export const SERVER_UNREACHABLE_EVENT = 'macha:server-unreachable';
export const SERVER_REACHABLE_EVENT = 'macha:server-reachable';

export const SERVER_UNREACHABLE_MESSAGE =
  'All configured API endpoints are unreachable.';
export const ENDPOINT_UNREACHABLE_MESSAGE =
  'The Macha server cannot be reached. Check that the server is running and that the API address is correct.';

let clusterUnreachableReported = false;

export class MachaConnectionError extends Error {
  constructor(message = ENDPOINT_UNREACHABLE_MESSAGE) {
    super(message);
    this.name = 'MachaConnectionError';
  }
}

/**
 * Whether this response means the request never reached Macha at all.
 *
 * The distinction is between "the node answered and said no" and "something in
 * front of it answered instead", because only the second is a connection
 * problem and only the second should read as an unreachable server.
 *
 * `502` and `504` are unconditional: Macha proxies nothing, so it has no reason
 * to emit either, and a body that happens to parse as JSON does not make one of
 * them an application answer.
 *
 * `500` and `503` are gated on the body, because Macha uses both legitimately —
 * `500 segment_not_ready` for a fragment it has not produced yet, `503
 * stream_failed` for a broken generation — each with an error envelope. A JSON
 * body means the request demonstrably reached the application. Without a body
 * the same statuses are what a proxy emits when it has no healthy backend, and
 * `503` in particular is HAProxy's canonical answer for exactly that. Treating
 * it as an application error would show a viewer an API error for a node that
 * is simply gone.
 */
export function isGatewayConnectionFailure(response: Response, bodyWasJson: boolean): boolean {
  if (response.status === 502 || response.status === 504) return true;
  return (response.status === 500 || response.status === 503) && !bodyWasJson;
}

export function serverUnreachable(): MachaConnectionError {
  return new MachaConnectionError();
}

/** Publish one application-level transition per cluster outage, not one event per failed request. */
export function reportClusterUnreachable(): void {
  if (clusterUnreachableReported) return;
  clusterUnreachableReported = true;
  publishConnectionState({ type: 'unreachable', message: SERVER_UNREACHABLE_MESSAGE });
}

export function reportClusterReachable(): void {
  const recovered = clusterUnreachableReported;
  clusterUnreachableReported = false;
  if (recovered) publishConnectionState({ type: 'reachable' });
}

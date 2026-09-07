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

export function isGatewayConnectionFailure(response: Response, bodyWasJson: boolean): boolean {
  if (response.status === 502 || response.status === 504) return true;
  return response.status === 500 && !bodyWasJson;
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

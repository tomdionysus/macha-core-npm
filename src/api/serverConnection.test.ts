import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isGatewayConnectionFailure,
  reportClusterReachable,
  reportClusterUnreachable,
  serverUnreachable,
  SERVER_UNREACHABLE_MESSAGE,
} from './serverConnection.js';
import { subscribeConnectionState } from '../runtime/events.js';

describe('cluster reachability notification', () => {
  afterEach(() => {
    reportClusterReachable();
  });

  it('publishes once per outage rather than once per endpoint failure', () => {
    reportClusterReachable();
    const listener = vi.fn();
    const unsubscribe = subscribeConnectionState(listener);

    serverUnreachable();
    reportClusterUnreachable();
    reportClusterUnreachable();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toEqual({ type: 'unreachable', message: SERVER_UNREACHABLE_MESSAGE });

    reportClusterReachable();
    expect(listener.mock.calls[1]?.[0]).toEqual({ type: 'reachable' });
    reportClusterUnreachable();
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    reportClusterReachable();
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('reports recovery only after an outage was published', () => {
    reportClusterReachable();
    const listener = vi.fn();
    const unsubscribe = subscribeConnectionState(listener);

    reportClusterReachable();

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe('telling a dead node from a node saying no', () => {
  const response = (status: number) => new Response(null, { status });

  it('treats a bare 502 or 504 as unreachable whatever the body parsed as', () => {
    // Macha proxies nothing, so it has no reason to emit either. A body that
    // happens to be JSON does not make one an application answer.
    expect(isGatewayConnectionFailure(response(502), false)).toBe(true);
    expect(isGatewayConnectionFailure(response(504), false)).toBe(true);
    expect(isGatewayConnectionFailure(response(502), true)).toBe(true);
  });

  it('treats a bodyless 503 as unreachable — HAProxy with no healthy backend', () => {
    // The API is going behind HAProxy for TLS offload, and 503 is its
    // canonical answer for a backend that is gone. Reading that as an
    // application error shows a viewer an API failure for a node that is dead.
    expect(isGatewayConnectionFailure(response(503), false)).toBe(true);
  });

  it('leaves 503 stream_failed alone, because the node answered it', () => {
    // A JSON envelope means the request demonstrably reached the application.
    expect(isGatewayConnectionFailure(response(503), true)).toBe(false);
  });

  it('leaves 500 segment_not_ready alone for the same reason', () => {
    expect(isGatewayConnectionFailure(response(500), true)).toBe(false);
    expect(isGatewayConnectionFailure(response(500), false)).toBe(true);
  });

  it('says nothing about statuses that are plainly the application answering', () => {
    expect(isGatewayConnectionFailure(response(404), false)).toBe(false);
    expect(isGatewayConnectionFailure(response(429), false)).toBe(false);
  });
});

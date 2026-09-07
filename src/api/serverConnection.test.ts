import { afterEach, describe, expect, it, vi } from 'vitest';
import {
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

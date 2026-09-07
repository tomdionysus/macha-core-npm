import { describe, expect, it, vi } from 'vitest';
import { publishConnectionState, subscribeConnectionState } from './events.js';

describe('connection state events', () => {
  it('delivers to every subscriber and stops on unsubscribe', () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = subscribeConnectionState(first);
    const unsubscribeSecond = subscribeConnectionState(second);

    publishConnectionState({ type: 'unreachable', message: 'down' });
    expect(first).toHaveBeenCalledWith({ type: 'unreachable', message: 'down' });
    expect(second).toHaveBeenCalledTimes(1);

    unsubscribeFirst();
    publishConnectionState({ type: 'reachable' });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    unsubscribeSecond();
  });

  it('survives a listener that throws, and one that unsubscribes itself mid-delivery', () => {
    // A presentation-layer listener must not be able to break the health loop
    // that publishes these.
    const later = vi.fn();
    const unsubscribeThrowing = subscribeConnectionState(() => { throw new Error('render failed'); });
    const unsubscribeSelfRemoving = subscribeConnectionState(() => { unsubscribeSelfRemoving(); });
    const unsubscribeLater = subscribeConnectionState(later);

    expect(() => publishConnectionState({ type: 'reachable' })).not.toThrow();
    expect(later).toHaveBeenCalledTimes(1);

    unsubscribeThrowing();
    unsubscribeLater();
  });
});

/**
 * Cluster reachability transitions, published once per outage rather than
 * once per failed request.
 *
 * The web client used to dispatch these as `CustomEvent`s on `window`, which
 * is not a thing every target has. The core emits them here instead and a
 * platform is free to bridge them onward however it presents connectivity.
 */
export type ConnectionStateKind = 'unreachable' | 'reachable';

export interface ConnectionStateEvent {
  /** The whole of the event. A host words it; core writes no viewer text. */
  type: ConnectionStateKind;
}

export type ConnectionStateListener = (event: ConnectionStateEvent) => void;

const listeners = new Set<ConnectionStateListener>();

export function subscribeConnectionState(listener: ConnectionStateListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function publishConnectionState(event: ConnectionStateEvent): void {
  // Copied before iterating: a listener may unsubscribe itself on delivery.
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // A presentation-layer listener must not be able to break the health loop.
    }
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A cancellation error, built without assuming a DOM.
 *
 * `DOMException` is a browser global, not an ECMAScript one. Hermes supplies
 * nothing DOM, and React Native — which does ship an implementation — never
 * installs it on `globalThis`, so a bare `new DOMException(...)` there throws
 * `ReferenceError: Property 'DOMException' doesn't exist`.
 *
 * The `signal.reason ?? new DOMException(...)` idiom does not save it, and the
 * reason it does not is why this went unnoticed. `reason` is a later addition
 * to `AbortSignal`; React Native's `AbortController` polyfill predates it and
 * never sets one. So on the web the fallback almost never runs and on React
 * Native it *always* runs — the one platform that cannot evaluate the
 * expression is the one that always reaches it. A web client and a full test
 * suite will both stay green.
 *
 * The consequence is worse than a wrong error type: cancelling an in-flight
 * request raises a `ReferenceError` instead of an `AbortError`, so every
 * `error.name === 'AbortError'` check fails and a screen unmount or a
 * pull-to-refresh reads as a genuine failure.
 *
 * A plain `Error` with `name = 'AbortError'` satisfies every consumer, since
 * `name` is what they all test. `DOMException` is still preferred where it
 * exists so web behaviour — including `instanceof DOMException` in host code —
 * is unchanged.
 */
export function abortError(message = 'Aborted'): Error {
  if (typeof DOMException === 'function') return new DOMException(message, 'AbortError');
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

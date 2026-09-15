import { afterEach, describe, expect, it, vi } from 'vitest';
import { abortError, errorMessage } from './errors.js';

describe('describing a caught value', () => {
  it('uses the message when it is an Error', () => {
    expect(errorMessage(new Error('node unreachable'))).toBe('node unreachable');
  });

  it('stringifies anything else, since a catch can receive any value', () => {
    // `throw 'oops'` is legal JavaScript and a rejected promise can carry
    // anything at all. A caller rendering this must never get "[object Object]"
    // where a string was thrown, nor undefined where nothing was.
    expect(errorMessage('oops')).toBe('oops');
    expect(errorMessage(404)).toBe('404');
    expect(errorMessage(undefined)).toBe('undefined');
  });
});

describe('building a cancellation error', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('prefers DOMException where the platform has one', () => {
    const error = abortError();

    expect(error.name).toBe('AbortError');
    expect(error).toBeInstanceOf(DOMException);
  });

  /**
   * The branch this function exists for, and the one a Node suite never
   * reaches on its own.
   *
   * `DOMException` is a browser global, not an ECMAScript one. React Native
   * ships an implementation but never installs it on `globalThis`, so a bare
   * `new DOMException(...)` throws `ReferenceError: Property 'DOMException'
   * doesn't exist` — and the `signal.reason ?? new DOMException(...)` idiom
   * does not save it, because React Native's AbortController predates `reason`
   * and never sets one. So the one platform that cannot evaluate the
   * expression is the one that always reaches it, while a web client and a
   * full test suite both stay green.
   *
   * Stubbing the global away is the only way to run what React Native runs.
   */
  it('falls back to a plain Error where the platform has none', () => {
    vi.stubGlobal('DOMException', undefined);

    const error = abortError();

    // `name` is what every consumer tests — `error.name === 'AbortError'` — so
    // a plain Error satisfies them all. The failure this guards against is not
    // a wrong error type: it is a ReferenceError reaching a screen as a
    // genuine failure when someone merely navigated away.
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AbortError');
    expect(error.message).toBe('Aborted');
  });

  it('carries a caller-supplied message through either path', () => {
    vi.stubGlobal('DOMException', undefined);

    expect(abortError('Playback was superseded').message).toBe('Playback was superseded');
  });
});

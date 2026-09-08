import { describe, expect, it } from 'vitest';
import { errorMessage } from './errors.js';

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

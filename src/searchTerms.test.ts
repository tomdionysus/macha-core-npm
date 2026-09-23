import { describe, expect, it } from 'vitest';
import { isSearchable, MIN_SEARCH_TERM_LENGTH, searchTerms } from './searchTerms.js';
import { indexedTitle } from './titleIndex.js';

describe('searchTerms', () => {
  it('drops the words titles are ordered without, wherever they appear', () => {
    expect(searchTerms('the matrix')).toBe('matrix');
    expect(searchTerms('a man called')).toBe('man called');
    expect(searchTerms('Return of THE King')).toBe('Return of King');
    expect(searchTerms('An American in Paris')).toBe('American in Paris');
  });

  it('leaves nothing for a query of only those words', () => {
    expect(searchTerms('the')).toBe('');
    expect(searchTerms('  A  the an ')).toBe('');
  });

  it('matches whole words only, and collapses the whitespace', () => {
    expect(searchTerms('  theatre   anatomy  ')).toBe('theatre anatomy');
    expect(searchTerms('a-team')).toBe('a-team');
  });

  it('ignores exactly the words title ordering ignores', () => {
    // One list behind both, so they cannot disagree.
    for (const word of ['the', 'an', 'a']) {
      expect(indexedTitle(`${word} Zed`)).toBe('Zed');
      expect(searchTerms(`${word} Zed`)).toBe('Zed');
    }
  });
});

describe('isSearchable', () => {
  it('counts only what remains after the ignored words', () => {
    expect(MIN_SEARCH_TERM_LENGTH).toBe(2);
    expect(isSearchable('the')).toBe(false);
    expect(isSearchable('the x')).toBe(false);
    expect(isSearchable('the xy')).toBe(true);
    expect(isSearchable('  ')).toBe(false);
  });
});

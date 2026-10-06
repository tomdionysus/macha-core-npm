import { IGNORED_TITLE_WORDS } from './titleIndex.js';

/**
 * The fewest characters of real search terms worth sending. Two, from the web
 * client's own threshold, so one letter does not return half the library. A
 * choice, not a measurement.
 */
export const MIN_SEARCH_TERM_LENGTH = 2;

const IGNORED = new Set(IGNORED_TITLE_WORDS);

/**
 * The words of a query that a search keys on: the query without a leading
 * "the", "an" or "a", the words titles are ordered without, matched whole and
 * without regard to case. Whitespace is collapsed and trimmed, and `''` means
 * nothing is left to search for.
 *
 * Tom's ruling, 2026-10-04, narrowing the one of 2026-09-24: those words are
 * dropped only at the start of the query, never after it. So "the matrix"
 * searches for "matrix", "a man called" for "man called", and "the" for
 * nothing, while "Plan A" and "Return of the King" are searched as typed.
 * One word is dropped, as title ordering drops one.
 *
 * Words are split on whitespace only, so "a-team" and "the," stay as typed.
 */
export function searchTerms(query: string): string {
  const words = query.split(/\s+/).filter((word) => word.length > 0);
  if (words.length > 0 && IGNORED.has(words[0].toLowerCase())) words.shift();
  return words.join(' ');
}

/** Whether a query leaves enough to search for. A client asks this before searching at all. */
export function isSearchable(query: string): boolean {
  return searchTerms(query).length >= MIN_SEARCH_TERM_LENGTH;
}

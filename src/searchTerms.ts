import { IGNORED_TITLE_WORDS } from './titleIndex.js';

/**
 * The fewest characters of real search terms worth sending. Two, from the web
 * client's own threshold, so one letter does not return half the library. A
 * choice, not a measurement.
 */
export const MIN_SEARCH_TERM_LENGTH = 2;

const IGNORED = new Set(IGNORED_TITLE_WORDS);

/**
 * The words of a query that a search keys on: every word except those titles
 * are ordered without ("the", "an", "a"), wherever they appear, matched whole
 * and without regard to case. Whitespace is collapsed and trimmed, and `''`
 * means nothing is left to search for.
 *
 * Tom's ruling, 2026-09-24: do not trigger a search on those words, do not
 * pass them to the search, and key only on the words that remain. So "the
 * matrix" searches for "matrix", "a man called" for "man called", and "the"
 * for nothing. One consequence to know: a title that needs one of those words
 * to be told apart, such as "Plan A", is searched for without it.
 *
 * Words are split on whitespace only, so "a-team" and "the," stay as typed.
 */
export function searchTerms(query: string): string {
  return query
    .split(/\s+/)
    .filter((word) => word.length > 0 && !IGNORED.has(word.toLowerCase()))
    .join(' ');
}

/** Whether a query leaves enough to search for. A client asks this before searching at all. */
export function isSearchable(query: string): boolean {
  return searchTerms(query).length >= MIN_SEARCH_TERM_LENGTH;
}

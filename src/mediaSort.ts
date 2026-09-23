import { newestCatalogueFirst } from './recentMedia.js';
import { compareIndexedTitles, sortMediaByIndexedTitle } from './titleIndex.js';
import type { MediaSummary } from './types.js';

/**
 * The orderings a viewer can choose for a list of media, in one place.
 *
 * Every client with a search or library screen needs the same table, and the
 * web client had begun writing its own. Written per client, the keys, labels,
 * defaults and tie-breaks drift apart, and a viewer moving between the
 * television and the phone finds "Recently added" meaning two things. Asked
 * for by the web client on Tom's instruction, 2026-09-24.
 */
export type MediaSortKey = 'relevance' | 'title' | 'year' | 'recent';

export interface MediaSort {
  key: MediaSortKey;
  /** The viewer-facing name, in English like every other string core produces. */
  label: string;
  /** A new array in this order. Never the one passed in. */
  order(items: readonly MediaSummary[]): MediaSummary[];
}

/**
 * Newest release year first. Equal years, and all items without a year, fall
 * back to indexed title and then id, so the order is the same on every client.
 * Items without a year come last: a missing year is unknown, and putting it
 * first would read as newer than everything.
 */
export function newestYearFirst(items: readonly MediaSummary[]): MediaSummary[] {
  return [...items].sort((left, right) => {
    const leftYear = knownYear(left);
    const rightYear = knownYear(right);
    if (leftYear !== rightYear) {
      if (leftYear === undefined) return 1;
      if (rightYear === undefined) return -1;
      return rightYear - leftYear;
    }
    return compareIndexedTitles(left.title, right.title) || compareIds(left.id, right.id);
  });
}

const RELEVANCE: MediaSort = {
  key: 'relevance',
  label: 'Relevance',
  // The server's own order. Only a search has one worth keeping.
  order: (items) => [...items],
};
const TITLE: MediaSort = { key: 'title', label: 'Title', order: (items) => sortMediaByIndexedTitle([...items]) };
const YEAR: MediaSort = { key: 'year', label: 'Year', order: newestYearFirst };
const RECENT: MediaSort = { key: 'recent', label: 'Recently added', order: newestCatalogueFirst };

/** For search results, in the order a control should list them. */
export const SEARCH_SORTS: readonly MediaSort[] = [RELEVANCE, TITLE, YEAR, RECENT];
export const DEFAULT_SEARCH_SORT: MediaSortKey = 'relevance';

/**
 * For a library list. No relevance here: a library has no query, so the
 * server's order is only an accident of how it was listed.
 */
export const LIBRARY_SORTS: readonly MediaSort[] = [TITLE, YEAR, RECENT];
export const DEFAULT_LIBRARY_SORT: MediaSortKey = 'title';

/**
 * `items` in the order `key` names, or unchanged apart from being copied if
 * the key is not one of `sorts`, which is how a saved choice from another
 * context or an older build fails safe.
 */
export function orderMedia(
  items: readonly MediaSummary[],
  key: MediaSortKey,
  sorts: readonly MediaSort[] = SEARCH_SORTS,
): MediaSummary[] {
  const sort = sorts.find((candidate) => candidate.key === key);
  return sort ? sort.order(items) : [...items];
}

/** Whether a stored or received value is a sort `sorts` offers, for reading a saved choice back. */
export function isMediaSortKey(value: unknown, sorts: readonly MediaSort[] = SEARCH_SORTS): value is MediaSortKey {
  return typeof value === 'string' && sorts.some((sort) => sort.key === value);
}

function knownYear(item: MediaSummary): number | undefined {
  return typeof item.year === 'number' && Number.isFinite(item.year) && item.year > 0 ? item.year : undefined;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

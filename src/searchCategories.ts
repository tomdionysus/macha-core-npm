import type { MediaKind } from './types.js';

/**
 * The kinds of title a search can be narrowed to. Asked for by the web client
 * on Tom's instruction, 2026-09-24, as toggles any combination of which may be
 * on, including none, and owned here so every client offers the same three.
 */
export type SearchCategoryKey = 'movies' | 'shows' | 'music';

export interface SearchCategory {
  /** What a client keys its own wording on. Core names no category for a viewer. */
  key: SearchCategoryKey;
  kinds: readonly MediaKind[];
}

export const SEARCH_CATEGORIES: readonly SearchCategory[] = [
  { key: 'movies', kinds: ['movie'] },
  { key: 'shows', kinds: ['show', 'season', 'episode'] },
  { key: 'music', kinds: ['artist', 'album', 'track'] },
];

/** All three on: a search the viewer has not narrowed finds everything. */
export const DEFAULT_SEARCH_CATEGORIES: readonly SearchCategoryKey[] = ['movies', 'shows', 'music'];

/** Which category a kind belongs to. Every kind belongs to exactly one. */
export function searchCategoryOf(kind: MediaKind): SearchCategoryKey | undefined {
  return SEARCH_CATEGORIES.find((category) => category.kinds.includes(kind))?.key;
}

/** Whether a stored or received value is a category, for reading a saved choice back. */
export function isSearchCategoryKey(value: unknown): value is SearchCategoryKey {
  return typeof value === 'string' && SEARCH_CATEGORIES.some((category) => category.key === value);
}

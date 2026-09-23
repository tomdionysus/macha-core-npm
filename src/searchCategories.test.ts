import { describe, expect, it } from 'vitest';
import { DEFAULT_SEARCH_CATEGORIES, isSearchCategoryKey, SEARCH_CATEGORIES, searchCategoryOf } from './searchCategories.js';
import type { MediaKind } from './types.js';

describe('search categories', () => {
  it('puts every kind in exactly one category', () => {
    const kinds: MediaKind[] = ['movie', 'show', 'season', 'episode', 'artist', 'album', 'track'];
    for (const kind of kinds) {
      expect(SEARCH_CATEGORIES.filter((category) => category.kinds.includes(kind))).toHaveLength(1);
    }
    expect(searchCategoryOf('episode')).toBe('shows');
    expect(searchCategoryOf('track')).toBe('music');
  });

  it('labels them as the pills read, and starts with all three on', () => {
    expect(SEARCH_CATEGORIES.map((category) => category.label)).toEqual(['Movies', 'TV Shows', 'Music']);
    expect(DEFAULT_SEARCH_CATEGORIES).toEqual(['movies', 'shows', 'music']);
  });

  it('reads a saved choice back', () => {
    expect(isSearchCategoryKey('music')).toBe(true);
    expect(isSearchCategoryKey('podcasts')).toBe(false);
  });
});

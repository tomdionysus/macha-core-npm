import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIBRARY_SORT, DEFAULT_SEARCH_SORT, isMediaSortKey, LIBRARY_SORTS, newestYearFirst, orderMedia, SEARCH_SORTS,
} from './mediaSort.js';
import type { MediaSummary } from './types.js';

function item(id: string, title: string, year?: number, catalogueUpdatedNs?: number): MediaSummary {
  return { id, kind: 'movie', title, year, catalogueUpdatedNs, mediaIds: [id] };
}

const ids = (items: MediaSummary[]) => items.map((entry) => entry.id);

describe('newestYearFirst', () => {
  it('puts the newest year first', () => {
    expect(ids(newestYearFirst([item('a', 'A', 1999), item('b', 'B', 2021), item('c', 'C', 2004)]))).toEqual(['b', 'c', 'a']);
  });

  it('breaks a tie on indexed title, so a leading article does not decide it', () => {
    // "The Alpha" indexes under A, so it comes before "Beta". Raw, it would sort under T.
    expect(ids(newestYearFirst([item('b', 'Beta', 2020), item('a', 'The Alpha', 2020)]))).toEqual(['a', 'b']);
  });

  it('breaks a tie on title by id, so two clients agree on two films of the same name', () => {
    expect(ids(newestYearFirst([item('m2', 'Solaris', 1972), item('m1', 'Solaris', 1972)]))).toEqual(['m1', 'm2']);
  });

  it('puts items without a year last, in title order', () => {
    const sorted = newestYearFirst([item('n2', 'Beta'), item('y', 'Zed', 1950), item('n1', 'Alpha'), item('z', 'Zero', 0)]);
    expect(ids(sorted)).toEqual(['y', 'n1', 'n2', 'z']);
  });

  it('leaves the input alone', () => {
    const input = [item('a', 'A', 1999), item('b', 'B', 2021)];
    newestYearFirst(input);
    expect(ids(input)).toEqual(['a', 'b']);
  });
});

describe('the sort tables', () => {
  const items = [item('old', 'The Old One', 1970, 3), item('new', 'Brand New', 2024, 1), item('mid', 'Middle', 2000, 2)];

  it('offers relevance to search and not to a library, with each default among its own', () => {
    expect(SEARCH_SORTS.map((sort) => sort.key)).toEqual(['relevance', 'title', 'year', 'recent']);
    expect(LIBRARY_SORTS.map((sort) => sort.key)).toEqual(['title', 'year', 'recent']);
    expect(SEARCH_SORTS.some((sort) => sort.key === DEFAULT_SEARCH_SORT)).toBe(true);
    expect(LIBRARY_SORTS.some((sort) => sort.key === DEFAULT_LIBRARY_SORT)).toBe(true);
  });

  it('composes each option as a control shows it, so no client composes its own', () => {
    expect(SEARCH_SORTS.map((sort) => sort.choiceLabel)).toEqual([
      'Sort By Relevance', 'Sort By Title', 'Sort By Year', 'Sort By Recently added',
    ]);
  });

  it('orders by each key', () => {
    expect(ids(orderMedia(items, 'relevance'))).toEqual(['old', 'new', 'mid']);
    expect(ids(orderMedia(items, 'title'))).toEqual(['new', 'mid', 'old']);
    expect(ids(orderMedia(items, 'year'))).toEqual(['new', 'mid', 'old']);
    expect(ids(orderMedia(items, 'recent'))).toEqual(['old', 'mid', 'new']);
  });

  it('returns a copy even for relevance, so a caller sorting it in place cannot reorder the source', () => {
    expect(orderMedia(items, 'relevance')).not.toBe(items);
  });

  it('leaves a list in its given order for a key the context does not offer', () => {
    expect(ids(orderMedia(items, 'relevance', LIBRARY_SORTS))).toEqual(['old', 'new', 'mid']);
  });

  it('reads a saved choice back only if the context offers it', () => {
    expect(isMediaSortKey('year')).toBe(true);
    expect(isMediaSortKey('relevance', LIBRARY_SORTS)).toBe(false);
    expect(isMediaSortKey('popularity')).toBe(false);
    expect(isMediaSortKey(undefined)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { alphabetIndexKey, compareIndexedTitles, indexedTitle, sortMediaByIndexedTitle } from './titleIndex.js';
import type { MediaSummary } from './types.js';

function item(id: string, title: string): MediaSummary {
  return { id, title, kind: 'movie', mediaIds: [] };
}

describe('title indexing', () => {
  it('strips leading English articles for indexing without altering the supplied title', () => {
    expect(indexedTitle('The Matrix')).toBe('Matrix');
    expect(indexedTitle('A Clockwork Orange')).toBe('Clockwork Orange');
    expect(indexedTitle('An American Werewolf in London')).toBe('American Werewolf in London');
    expect(indexedTitle('Theatre of Blood')).toBe('Theatre of Blood');
  });

  it('uses the normalised title for alphabet buckets', () => {
    expect(alphabetIndexKey('The X-Files')).toBe('X');
    expect(alphabetIndexKey('A Beautiful Mind')).toBe('B');
    expect(alphabetIndexKey('An Education')).toBe('E');
    expect(alphabetIndexKey('The 100')).toBe('#');
  });

  it('folds accented Latin initials into the alphabet', () => {
    expect(alphabetIndexKey('Été 85')).toBe('E');
    expect(alphabetIndexKey('Ångström')).toBe('A');
  });

  it('sorts by the same normalised title used by the alphabet index', () => {
    const sorted = sortMediaByIndexedTitle([
      item('1', 'The Matrix'),
      item('2', 'Alien'),
      item('3', 'A Clockwork Orange'),
      item('4', 'Blade Runner'),
      item('5', '2001: A Space Odyssey'),
    ]);

    expect(sorted.map((entry) => entry.title)).toEqual([
      '2001: A Space Odyssey',
      'Alien',
      'Blade Runner',
      'A Clockwork Orange',
      'The Matrix',
    ]);
    expect(compareIndexedTitles('The Matrix', 'Moon')).toBeLessThan(0);
  });
});

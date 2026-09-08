import { describe, expect, it } from 'vitest';
import { alphabetIndexKey, availableAlphabetKeys, compareIndexedTitles, indexedTitle, sortMediaByIndexedTitle } from './titleIndex.js';
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

describe('grouping and ordering titles for an alphabet index', () => {
  const entryFor = (title: string) => item(title, title);

  it('files a title under its first letter, ignoring a leading article', () => {
    expect(alphabetIndexKey('The Matrix')).toBe('M');
    expect(alphabetIndexKey('a Clockwork Orange')).toBe('C');
  });

  it('folds an accent so a viewer finds the title where they expect it', () => {
    expect(alphabetIndexKey('Amélie')).toBe('A');
    expect(alphabetIndexKey('Ínsula')).toBe('I');
  });

  it('files anything not starting with a letter under #', () => {
    expect(alphabetIndexKey('1917')).toBe('#');
    expect(alphabetIndexKey('[REC]')).toBe('#');
  });

  it('keeps a title that is nothing but an article rather than emptying it', () => {
    // "The" is a real title. Stripping it would leave nothing to file.
    expect(indexedTitle('The')).toBe('The');
  });

  it('orders across buckets before ordering within one', () => {
    const sorted = sortMediaByIndexedTitle([entryFor('The Matrix'), entryFor('1917'), entryFor('Alien')]);
    expect(sorted.map((entry) => entry.title)).toEqual(['1917', 'Alien', 'The Matrix']);
  });

  it('breaks a tie on the indexed title using the full title', () => {
    // Two titles that index identically must still order deterministically,
    // or a list reshuffles between renders.
    expect(compareIndexedTitles('The Office', 'Office')).not.toBe(0);
  });

  it('reports only the buckets a library actually has', () => {
    const keys = availableAlphabetKeys([entryFor('Alien'), entryFor('1917'), entryFor('Aliens')]);
    expect([...keys].sort()).toEqual(['#', 'A']);
  });
});

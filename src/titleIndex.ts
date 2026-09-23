import type { MediaSummary } from './types.js';

export const ALPHABET_INDEX = [
  '#',
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
  'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
] as const;
export type AlphabetIndexKey = (typeof ALPHABET_INDEX)[number];

/**
 * The words a title is ordered without, when leading. Search drops them
 * wherever they appear in a query, by Tom's ruling of 2026-09-24, so ordering
 * and search cannot disagree about which words are ignored.
 */
export const IGNORED_TITLE_WORDS: readonly string[] = ['the', 'an', 'a'];

const LEADING_ARTICLE = new RegExp(`^(?:${IGNORED_TITLE_WORDS.join('|')})\\s+`, 'i');
const COMBINING_MARKS = /\p{M}/gu;
const TITLE_COLLATOR = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
const ALPHABET_ORDER = new Map<AlphabetIndexKey, number>(ALPHABET_INDEX.map((key, index) => [key, index]));

export function indexedTitle(title: string): string {
  const trimmed = title.trim();
  const withoutArticle = trimmed.replace(LEADING_ARTICLE, '').trimStart();
  return withoutArticle.length > 0 ? withoutArticle : trimmed;
}

function foldedInitial(title: string): string {
  return indexedTitle(title)
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .slice(0, 1)
    .toUpperCase();
}

export function alphabetIndexKey(title: string): AlphabetIndexKey {
  const initial = foldedInitial(title);
  return /^[A-Z]$/.test(initial) ? initial as AlphabetIndexKey : '#';
}

export function compareIndexedTitles(a: string, b: string): number {
  const bucket = (ALPHABET_ORDER.get(alphabetIndexKey(a)) ?? 0) - (ALPHABET_ORDER.get(alphabetIndexKey(b)) ?? 0);
  if (bucket !== 0) return bucket;

  const indexed = TITLE_COLLATOR.compare(indexedTitle(a), indexedTitle(b));
  return indexed !== 0 ? indexed : TITLE_COLLATOR.compare(a, b);
}

export function sortMediaByIndexedTitle(items: MediaSummary[]): MediaSummary[] {
  return [...items].sort((a, b) => compareIndexedTitles(a.title, b.title));
}

export function availableAlphabetKeys(items: MediaSummary[]): Set<AlphabetIndexKey> {
  return new Set(items.map((item) => alphabetIndexKey(item.title)));
}

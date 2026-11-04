import type { CatalogueKind } from './CatalogueApi.js';
import type { MediaSummary } from '../types.js';
import { compareIndexedTitles } from '../titleIndex.js';

/** The catalogue kinds books brought (server 0.92.0). */
export const BOOK_KINDS: readonly CatalogueKind[] = ['book', 'author', 'series'];

/** Whether a kind is one of the book kinds. */
export function isBookKind(kind: string): boolean {
  return (BOOK_KINDS as readonly string[]).includes(kind);
}

/**
 * Whether a title of this kind may be handed to playback. A book is read
 * through its content, never played: its file has no playback profile
 * (`422 profile_not_applicable`) and no session is opened for it. The
 * node resolver refuses one with `NOT_PLAYABLE_KIND_CODE` before any request,
 * and a 422 ends the cluster's walk, so no node is asked.
 */
export function isPlayableKind(kind: string): boolean {
  return !isBookKind(kind);
}

/** The code a resolver refuses a book (or author, or series) with; status 422. */
export const NOT_PLAYABLE_KIND_CODE = 'not_playable_kind';

/** The code the server answers a book's profile with (server 0.92.0). */
export const PROFILE_NOT_APPLICABLE_CODE = 'profile_not_applicable';

/**
 * Books in their order within one series: by `index` ascending, a fraction
 * between its neighbours, those with no index after every numbered one, and
 * title order among equals. The server leaves this order to the client.
 * A book not in the series sorts with the unnumbered ones. Returns a new
 * array.
 */
export function orderBooksInSeries<T extends Pick<MediaSummary, 'id' | 'title' | 'bookContext'>>(books: readonly T[], seriesId: string): T[] {
  const indexOf = (book: T) => book.bookContext?.series.find((entry) => entry.id === seriesId)?.index ?? null;
  return [...books].sort((left, right) => {
    const a = indexOf(left);
    const b = indexOf(right);
    if (a !== b) {
      if (a === null) return 1;
      if (b === null) return -1;
      return a - b;
    }
    return compareIndexedTitles(left.title, right.title) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  });
}

/**
 * An author's books, oldest first: by `published` where both have one (an
 * ISO date compares as text), else by year, undated after dated, then title.
 * Returns a new array.
 */
export function orderBooksByPublication<T extends Pick<MediaSummary, 'id' | 'title' | 'year' | 'bookContext'>>(books: readonly T[]): T[] {
  const date = (book: T) => book.bookContext?.published ?? (book.year !== undefined ? String(book.year).padStart(4, '0') : undefined);
  return [...books].sort((left, right) => {
    const a = date(left);
    const b = date(right);
    if (a !== b) {
      if (a === undefined) return 1;
      if (b === undefined) return -1;
      const order = a.localeCompare(b);
      if (order !== 0) return order;
    }
    return compareIndexedTitles(left.title, right.title) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  });
}

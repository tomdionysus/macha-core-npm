import type { CatalogueApi, CatalogueConversion, CatalogueKind, ConversionFailureCode, ConversionFormat, ConversionRef } from './CatalogueApi.js';
import { abortError } from '../errors.js';
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

/** The formats a book's file converts to (server 0.92.1), in the server's order. */
export const CONVERSION_FORMATS: readonly ConversionFormat[] = ['epub', 'azw3', 'mobi', 'pdf', 'fb2'];

/** Whether a string names a conversion format. */
export function isConversionFormat(value: string): value is ConversionFormat {
  return (CONVERSION_FORMATS as readonly string[]).includes(value);
}

/** Why a conversion failed, as server 0.92.1 says: `CatalogueConversion.errorCode`, and a failed content read's code. */
export const CONVERSION_FAILURE_CODES: readonly ConversionFailureCode[] = [
  'conversion_failed', 'conversion_timed_out', 'source_unreadable', 'source_too_large',
];

/** `400`: not one of `CONVERSION_FORMATS`. */
export const BAD_FORMAT_CODE = 'bad_format';
/** `400`: the book's file is already that format; read it through `content`. */
export const SAME_FORMAT_CODE = 'same_format';
/** `422`: the media is not a book's file. */
export const NOT_A_BOOK_CODE = 'not_a_book';
/** `503`, scope `node`: this node has no conversion; the cluster API walks on, and answers it only when no node has one. */
export const CONVERSION_UNAVAILABLE_CODE = 'conversion_unavailable';
/** `409`: the converted file was asked for while the conversion runs. */
export const NOT_READY_CODE = 'not_ready';

/** The poll interval when the server names none, and the bounds a stated one is held to. */
const CONVERSION_POLL_DEFAULT_MS = 2_000;
const CONVERSION_POLL_MIN_MS = 500;
const CONVERSION_POLL_MAX_MS = 30_000;

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Poll a conversion on its node until it is ready or failed, waiting what the
 * server asks between polls (`Retry-After`, held to 0.5 to 30 s). Resolves
 * with the final state: a failed conversion resolves, it does not throw.
 * `onState` sees each state, the first included, for a host showing
 * progress. Throws what `CatalogueApi.conversion` throws, such as
 * `404 not_found` when the node evicted it, and the abort reason on abort.
 *
 * ```ts
 * const started = await catalogue.convert(mediaId, 'epub');
 * const done = await awaitConversion(catalogue, started, { signal });
 * if (done.status === 'ready') urls = catalogue.conversionContentUrls(done, { download: true });
 * ```
 */
export async function awaitConversion(
  catalogue: Pick<CatalogueApi, 'conversion'>,
  start: CatalogueConversion | ConversionRef,
  options: { signal?: AbortSignal; onState?: (conversion: CatalogueConversion) => void } = {},
): Promise<CatalogueConversion> {
  const { signal, onState } = options;
  let current = 'status' in start ? start : await catalogue.conversion(start, signal);
  onState?.(current);
  while (current.status === 'converting') {
    const delay = Math.min(CONVERSION_POLL_MAX_MS, Math.max(CONVERSION_POLL_MIN_MS, current.retryAfterMs ?? CONVERSION_POLL_DEFAULT_MS));
    await wait(delay, signal);
    // Keep the node: a node API's answer carries none, and the next poll must go there.
    const next = await catalogue.conversion(current, signal);
    current = next.endpointId === undefined && current.endpointId !== undefined ? { ...next, endpointId: current.endpointId } : next;
    onState?.(current);
  }
  return current;
}

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

import { artworkHostOf } from './artworkHost.js';

/**
 * How long a poster near the viewport may go unloaded before a second
 * source is asked as well, and the most requests one poster runs at once.
 *
 * Tom, 2026-10-05: core owns the artwork hedge, so every client races the
 * same way. A host that drops packets fails an image only after about 15 s,
 * and the health cycle demotes it some seconds after it dies; the first
 * request is never cancelled, so a slow but working link still wins. Taken
 * from the web client's measured choice (`LazyArtwork.tsx`, 2026-10-04).
 * The racing itself is the client's: core never sees an image's bytes.
 */
export const ARTWORK_HEDGE_DELAY_MS = 2000;
export const ARTWORK_HEDGE_MAX_IN_FLIGHT = 2;

/**
 * Which of `sources` (as `MediaApi.artworkUrls` orders them, by `url`) to
 * request next, by index, or `undefined` when there is none.
 *
 * - After a failure (`hedge` false): the first source not yet tried, on any
 *   host, the same host's other entries included.
 * - To hedge (`hedge` true): the first untried source **on a host with no
 *   request in flight**. `artworkUrls` can list one host twice in a row, the
 *   signed capability and that node's own entry, and a second request to a
 *   silent node does nothing. `undefined` when `inFlight` is already at
 *   `ARTWORK_HEDGE_MAX_IN_FLIGHT`.
 *
 * `tried` is every index started, whether in flight or finished.
 */
export function nextArtworkSource(
  sources: readonly string[],
  tried: readonly number[],
  inFlight: readonly number[],
  hedge: boolean,
): number | undefined {
  if (hedge && inFlight.length >= ARTWORK_HEDGE_MAX_IN_FLIGHT) return undefined;
  const hostOf = (url: string): string => artworkHostOf(url) ?? url;
  const busy = new Set(inFlight.map((index) => sources[index]).filter((url): url is string => url !== undefined).map(hostOf));
  const index = sources.findIndex((url, candidate) => !tried.includes(candidate) && !(hedge && busy.has(hostOf(url))));
  return index < 0 ? undefined : index;
}

import { MachaConnectionError, serverUnreachable } from './serverConnection.js';
import { currentTransferRecorder } from './transferRecorder.js';

export type HeaderValues = Record<string, string | undefined>;

/**
 * Applies to every request in the cluster status/catalogue/routing layer, and
 * to session minting and validation — which are not part of that layer, but
 * are the one path the whole application waits on, so an unbounded one there
 * stalls every request behind it. Playback/streaming transfers are exempt and
 * manage their own deadlines.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError');
}

/**
 * Bounds a request with a timeout, composed with whatever cancellation the
 * caller already threads through `init.signal` — without `AbortSignal.any`,
 * which is absent on browsers old enough to have a real `AbortController` but
 * predate that static (this is a TV app; see `AbortControllerPolyfill.ts`).
 *
 * A genuine caller cancellation still surfaces as a plain AbortError, so
 * `retryableEndpointFailure` keeps treating it as client intent rather than
 * endpoint health. Only a timeout is reported as `MachaConnectionError`: from
 * here, a request that never answers looks exactly like an endpoint that
 * never answers, and must retry/fail over the same way one already does.
 */
export async function fetchWithTimeout(
  fetcher: (url: string, init?: RequestInit) => Promise<Response>,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const consumerSignal = init.signal ?? undefined;
  let timedOut = false;
  const onConsumerAbort = () => controller.abort(consumerSignal?.reason);
  consumerSignal?.addEventListener('abort', onConsumerAbort, { once: true });
  if (consumerSignal?.aborted) onConsumerAbort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new MachaConnectionError(`Request to ${url} exceeded ${timeoutMs} ms.`);
    if (isAbortError(error)) throw error;
    throw serverUnreachable();
  } finally {
    clearTimeout(timer);
    consumerSignal?.removeEventListener('abort', onConsumerAbort);
  }
}

export interface ParsedResponseBody {
  body: unknown;
  wasJson: boolean;
}

/**
 * Build a plain header object without relying on the Headers(init) constructor.
 * Older Tizen Chromium implements Fetch but only exposes the earliest Headers
 * constructor shape.
 */
export function mergeRequestHeaders(initial: HeadersInit | undefined, values: HeaderValues): Record<string, string> {
  const result: Record<string, string> = {};

  if (initial) {
    if (Array.isArray(initial)) {
      for (const pair of initial) result[pair[0]] = pair[1];
    } else {
      const iterable = initial as Headers;
      if (typeof iterable.forEach === 'function') {
        iterable.forEach((value, key) => { result[key] = value; });
      } else {
        const object = initial as Record<string, string>;
        for (const key of Object.keys(object)) result[key] = object[key];
      }
    }
  }

  for (const key of Object.keys(values)) {
    const value = values[key];
    if (value !== undefined) result[key] = value;
  }

  return result;
}

export function queryString(entries: ReadonlyArray<readonly [string, string | undefined]>): string {
  const parts: string[] = [];
  for (const [key, value] of entries) {
    if (value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  return parts.join('&');
}

export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') return '';
  return trimmed.replace(/\/+$/, '');
}

export async function readResponseBody(response: Response): Promise<ParsedResponseBody> {
  try {
    return { body: await readJsonBody<unknown>(response), wasJson: true };
  } catch {
    return { body: undefined, wasJson: false };
  }
}

/**
 * The array a collection envelope is supposed to carry.
 *
 * A success body was taken for the envelope everywhere: `response.items.map`
 * on a 200 that has no `items` throws `TypeError` at the call site, and
 * `retryableEndpointFailure` reads a bare `TypeError` as a *transport*
 * failure — so a schema mismatch cooled the node down as if it had been
 * unreachable, and the message a caller saw was about `.map` rather than
 * about the server. Checked here so every family says the same thing.
 *
 * The typed failure carries `502`, which stays retryable on purpose: in a
 * mixed-version endpoint set the next node may well answer a shape this build
 * can read, and that is the situation being generous about envelopes exists
 * for. `invalid_media_profile` has taken the same position since it was
 * written.
 */
export function envelopeArray<T>(
  body: unknown,
  key: string,
  fail: (message: string) => Error,
): T[] {
  if (body && typeof body === 'object') {
    const value = (body as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value as T[];
  }
  throw fail(`Macha returned a success body with no \`${key}\` array in it.`);
}

/**
 * Parse a JSON response body, timing the read.
 *
 * The single place every API family reads a success body, so that throughput
 * evidence comes from traffic the client was making anyway rather than from
 * synthetic probes. Timing starts here, not at the `fetch()` call: a resolved
 * fetch has received response *headers* and not one byte of the payload, so
 * measuring around it yields round-trip time wearing a throughput costume.
 */
export async function readJsonBody<T>(response: Response): Promise<T> {
  const transferRecorder = currentTransferRecorder();
  if (!transferRecorder) return await response.json() as T;
  const startedAt = Date.now();
  const body = await response.json() as T;
  // Content-Length is the only byte count available without re-reading the
  // stream; a chunked response simply contributes no sample.
  const declared = Number(response.headers?.get?.('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > 0) {
    transferRecorder(response.url, declared, Date.now() - startedAt);
  }
  return body;
}

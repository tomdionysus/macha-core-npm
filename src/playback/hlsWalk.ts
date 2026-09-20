import type { PlaybackSource } from '../types.js';
import { SEGMENT_NOT_READY_STATUS, SERVER_SEGMENT_HOLD_MS } from './streamProtocol.js';

/**
 * Walking an HLS manifest to find out whether a node will actually serve it.
 *
 * Two walks share everything except their question. **Preflight** asks "will
 * this source play if I switch to it" and reads real bytes from the first
 * media targets. **Readiness** asks "has the first fragment arrived yet" and
 * reads none. Both descend the same manifest, resolve the same relative URIs
 * and honour the same hold semantics, which is why they are one module: they
 * were previously one implementation per client per question, and the copies
 * had already diverged on the answer that matters most (see
 * `nonAssessableResult` below).
 *
 * **Everything here is protocol, not presentation.** What a `500` means, how
 * deep to descend, which URI a tag carries — none of it varies by platform.
 * Only `fetch` does, so only `fetch` is injected.
 */

/**
 * Deadline for a single request in either walk.
 *
 * **It must exceed `SERVER_SEGMENT_HOLD_MS`, and that is the whole reason this
 * constant is not simply "five seconds".** A node holds a request for a
 * fragment it has not produced yet and answers `500` only when that hold
 * expires, sending no bytes in the meantime. A deadline shorter than the hold
 * therefore aborts *before the node answers*, and the client records a node
 * behaving exactly as specified as a network fault.
 *
 * Both client implementations this replaces used 5 s, which is below the 6 s
 * hold. A transcode standby probed while it was still producing its first
 * fragment could not pass: the walk timed out, reported failure, and the
 * coordinator destroyed a standby that was about to become servable. That is
 * the same defect `streamProtocol.ts` warns about in its own doc comment —
 * two numbers chosen independently, each defensible alone — and it survived
 * in both clients because neither constant recorded the relationship.
 */
export const HLS_WALK_TIMEOUT_MS = SERVER_SEGMENT_HOLD_MS + 2_000;

/** How far above a node's hold a walk deadline sits. The relationship, named. */
export const HLS_WALK_HOLD_MARGIN_MS = 2_000;

/**
 * The hold this source's node actually enforces.
 *
 * **Prefers what the node said over what this package guessed.** Every figure
 * above is expressed as "the hold, plus room", and until a node reported its
 * own `segment_timeout_ms` the hold could only be a compiled-in assumption.
 * Where the node has stated one, that is the number the relationship was
 * always meant to be built on; `SERVER_SEGMENT_HOLD_MS` remains the answer for
 * a node too old to say, and only for that.
 */
function sourceHoldMs(source: PlaybackSource): number {
  return source.budgets?.segmentHoldMs ?? SERVER_SEGMENT_HOLD_MS;
}

/** How much of a media target preflight reads before deciding bytes are flowing. */
export const HLS_PREFLIGHT_RANGE = 'bytes=0-65535';

/**
 * Readiness reads no payload at all — it only needs the status line.
 *
 * `bytes=0-0` rather than a `HEAD`: a node answers a range request through the
 * same path that serves the fragment, so it holds and answers `500` the same
 * way. A `HEAD` may be routed differently and would be asking a different
 * question of a different code path.
 */
export const HLS_READINESS_RANGE = 'bytes=0-0';

/**
 * Cache suppression as **request headers**, never as `RequestInit.cache`.
 *
 * `cache: 'no-store'` is unusable here and actively harmful on one host.
 * React Native implements it by rewriting the URL — appending `_=<epoch
 * millis>` to the query — and Macha media is reached by **signed capability
 * URLs**, so that rewrite alters what was signed and the node rejects a
 * request that would otherwise have succeeded. Tizen 3 drops the option
 * entirely, with no header and no URL change, so the response stays cacheable.
 *
 * The same reasoning rules out a deliberate cache-busting query parameter,
 * which is the obvious-looking fix for the Tizen half and breaks the signature
 * for everyone. Headers are the only mechanism that suppresses caching without
 * touching the signed URL.
 */
const NO_CACHE_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'no-cache, no-store',
  Pragma: 'no-cache',
};

export type HlsWalkFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface HlsWalkOptions {
  /** The host's `fetch`. The only platform-varying part of either walk. */
  fetch: HlsWalkFetch;
  /** Caller cancellation, composed with this module's own deadline. */
  signal?: AbortSignal;
  /**
   * Overrides the derived deadline. Must stay above the serving node's hold.
   *
   * Left unset, the deadline comes from what the node itself reports through
   * `PlaybackSource.budgets`, falling back to {@link HLS_WALK_TIMEOUT_MS} only
   * for a node that does not report one. Passing a fixed value here opts out of
   * that and re-accepts the risk the constant was written about: a deadline
   * below the hold aborts before the node answers.
   */
  timeoutMs?: number;
}

// ---- URI resolution --------------------------------------------------------

interface UriParts {
  scheme?: string;
  authority?: string;
  path: string;
  query?: string;
}

/** RFC 3986 Appendix B. */
const URI_PATTERN = /^(?:([^:/?#]+):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/;

function parseUri(uri: string): UriParts {
  const match = URI_PATTERN.exec(uri);
  if (!match) return { path: uri };
  return {
    scheme: match[1] || undefined,
    authority: match[2] === undefined ? undefined : match[2],
    path: match[3] || '',
    query: match[4] === undefined ? undefined : match[4],
  };
}

/** RFC 3986 §5.2.4. */
function removeDotSegments(path: string): string {
  const output: string[] = [];
  let input = path;
  while (input.length > 0) {
    if (input.startsWith('../')) { input = input.slice(3); continue; }
    if (input.startsWith('./')) { input = input.slice(2); continue; }
    if (input.startsWith('/./')) { input = `/${input.slice(3)}`; continue; }
    if (input === '/.') { input = '/'; continue; }
    if (input.startsWith('/../')) { input = `/${input.slice(4)}`; output.pop(); continue; }
    if (input === '/..') { input = '/'; output.pop(); continue; }
    if (input === '.' || input === '..') { input = ''; continue; }
    const next = input.indexOf('/', input.startsWith('/') ? 1 : 0);
    if (next === -1) { output.push(input); input = ''; } else { output.push(input.slice(0, next)); input = input.slice(next); }
  }
  return output.join('');
}

/** RFC 3986 §5.2.3. */
function mergePaths(base: UriParts, referencePath: string): string {
  if (base.authority !== undefined && base.path === '') return `/${referencePath}`;
  const lastSlash = base.path.lastIndexOf('/');
  return lastSlash === -1 ? referencePath : `${base.path.slice(0, lastSlash + 1)}${referencePath}`;
}

function recompose(parts: UriParts): string {
  let result = '';
  if (parts.scheme !== undefined) result += `${parts.scheme}:`;
  if (parts.authority !== undefined) result += `//${parts.authority}`;
  result += parts.path;
  if (parts.query !== undefined) result += `?${parts.query}`;
  return result;
}

/**
 * Resolve a possibly-relative URI against a base, per RFC 3986 §5.3.
 *
 * **Core ships this rather than calling the host's `URL`, and that is
 * deliberate.** React Native's `URL` does not resolve relative references at
 * all: it strips one trailing slash from the base and concatenates, so
 * `.../abc/index.m3u8` + `seg1.m4s` becomes `.../abc/index.m3u8seg1.m4s` —
 * a URL that 404s, reported as the source being unservable.
 *
 * It is also deliberately **not** an injected seam. Making resolution a
 * host-supplied function would mean every host injecting the same correct
 * implementation, which is duplication wearing an abstraction's clothes. The
 * rule is protocol; there is one right answer; core states it once.
 *
 * Fragments are dropped: no HLS URI carries one, and keeping it would send a
 * fragment to the wire where a signature may cover the whole reference.
 */
export function resolveUrl(baseUrl: string, reference: string): string {
  const ref = parseUri(reference);
  if (ref.scheme !== undefined) {
    return recompose({ ...ref, path: removeDotSegments(ref.path) });
  }
  const base = parseUri(baseUrl);
  if (ref.authority !== undefined) {
    return recompose({ scheme: base.scheme, authority: ref.authority, path: removeDotSegments(ref.path), query: ref.query });
  }
  if (ref.path === '') {
    return recompose({
      scheme: base.scheme,
      authority: base.authority,
      path: base.path,
      query: ref.query !== undefined ? ref.query : base.query,
    });
  }
  const path = ref.path.startsWith('/') ? removeDotSegments(ref.path) : removeDotSegments(mergePaths(base, ref.path));
  return recompose({ scheme: base.scheme, authority: base.authority, path, query: ref.query });
}

// ---- manifest parsing ------------------------------------------------------

function manifestLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

/** The URI on the first line following a tag that carries its URI separately. */
function uriAfter(lines: readonly string[], index: number): string | undefined {
  for (let i = index + 1; i < lines.length; i += 1) {
    if (!lines[i].startsWith('#')) return lines[i];
  }
  return undefined;
}

function attributeUri(line: string): string | undefined {
  const match = /URI="([^"]*)"/.exec(line);
  return match?.[1] || undefined;
}

/**
 * The first variant URI in a master playlist, or `undefined` if this is already
 * a media playlist.
 *
 * One variant, not all of them: the walk establishes that the node is serving
 * this source, and a node that serves one rendition is serving the session.
 * Probing every variant multiplies the cost of a check that runs on a hot path
 * without changing the answer.
 */
export function firstVariantUri(manifestText: string): string | undefined {
  const lines = manifestLines(manifestText);
  const index = lines.findIndex((line) => line.startsWith('#EXT-X-STREAM-INF'));
  return index === -1 ? undefined : uriAfter(lines, index);
}

/**
 * The media targets of a media playlist: the initialization segment named by
 * `#EXT-X-MAP`, when present, and the first media segment.
 *
 * The init segment is included because a missing or unservable one fails
 * playback just as completely as a missing fragment, and it is the target most
 * likely to be served from a different path than the fragments.
 */
export function mediaPlaylistTargets(manifestText: string): string[] {
  const lines = manifestLines(manifestText);
  const targets: string[] = [];
  const map = lines.find((line) => line.startsWith('#EXT-X-MAP'));
  const mapUri = map ? attributeUri(map) : undefined;
  if (mapUri) targets.push(mapUri);
  const firstSegment = lines.find((line) => !line.startsWith('#'));
  if (firstSegment) targets.push(firstSegment);
  return targets;
}

// ---- the shared walk -------------------------------------------------------

/**
 * Why a walk produced no answer rather than a negative one.
 *
 * `unassessable` is **not** a failure and callers must not treat it as one.
 * See {@link preflightHlsSource} for what that distinction cost.
 */
export type HlsWalkOutcome =
  | { state: 'ready' }
  | { state: 'holding'; retryAfterMs: number }
  | { state: 'unavailable'; status?: number; detail?: string }
  | { state: 'unassessable'; reason: 'not-a-manifest' | 'empty-manifest' };

/**
 * A playlist is fetched whole, with no `Range`.
 *
 * Ranging a playlist was wrong twice over. A readiness probe is documented as
 * reading no payload, yet was pulling up to 64 KB per playlist per attempt —
 * on a television, against the node already struggling to produce a fragment.
 * And a long media playlist *exceeds* 64 KB (a two-hour film at six-second
 * segments is around 1,200 entries), so a node honouring the range answers
 * `206` with a **silently truncated playlist**. Parsing from the top hid it,
 * because the first fragment still resolved — the next person to read further
 * down would not have seen it coming.
 */
function requestHeaders(source: PlaybackSource, range: string | undefined): Record<string, string> {
  // Source headers beat cache suppression — a host that must send an
  // Authorization header has no alternative, and a cached answer is a lesser
  // problem than an unauthorized one. `Range` is applied last and is therefore
  // not overridable: a source header that replaced it would silently turn a
  // bounded probe into a full segment fetch, which on a television is a real
  // transfer that nobody would attribute to a health check.
  const headers: Record<string, string> = { ...NO_CACHE_HEADERS, ...(source.headers ?? {}) };
  if (range !== undefined) headers.Range = range;
  else delete headers.Range;
  return headers;
}

async function walkFetch(
  url: string,
  source: PlaybackSource,
  range: string | undefined,
  options: HlsWalkOptions,
): Promise<Response> {
  const controller = new AbortController();
  const consumerSignal = options.signal;
  const onConsumerAbort = () => controller.abort();
  consumerSignal?.addEventListener('abort', onConsumerAbort, { once: true });
  if (consumerSignal?.aborted) onConsumerAbort();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? sourceHoldMs(source) + HLS_WALK_HOLD_MARGIN_MS,
  );
  try {
    return await options.fetch(url, {
      method: 'GET',
      headers: requestHeaders(source, range),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    consumerSignal?.removeEventListener('abort', onConsumerAbort);
  }
}

/**
 * A response body that can be read incrementally, where the host has one.
 *
 * Declared locally rather than added to `platform-neutral.d.ts`: streaming
 * bodies are genuinely absent on some hosts core supports, and putting the
 * property on the shared `Response` would invite code that assumes it.
 */
interface StreamingBody {
  getReader?: () => { read(): Promise<{ done: boolean; value?: { length?: number } }>; cancel(): unknown };
}

/**
 * Body accessors that exist on real hosts but not on the narrow `Response`
 * this package declares. Probed structurally because which of them works is a
 * property of the host, not of the standard.
 */
interface BufferedBody {
  arrayBuffer?: () => Promise<{ byteLength: number }>;
  blob?: () => Promise<{ size: number }>;
}

/** What a body read established — including that it established nothing. */
type ByteEvidence = 'bytes' | 'empty' | 'unreadable';

/**
 * Whether any payload bytes actually arrived.
 *
 * A status alone does not answer this: a proxy can return `200` with an empty
 * body, and a node mid-restart can answer a range request with nothing. The
 * walk exists to see bytes.
 *
 * **The buffered path is the normal one on React Native, not a fallback.** Its
 * `fetch` is an XHR polyfill with no streaming body, and it can hand back a
 * `body` object that exists but has no `getReader` — which a `if (!body)`
 * guard sails straight past before throwing. Guard on the method, not on the
 * object.
 */
async function receivedBytes(response: Response): Promise<ByteEvidence> {
  const body = (response as unknown as { body?: StreamingBody }).body;
  const reader = typeof body?.getReader === 'function' ? body.getReader() : undefined;
  if (reader) {
    try {
      const first = await reader.read();
      return !first.done && (first.value?.length ?? 0) > 0 ? 'bytes' : 'empty';
    } catch {
      return 'unreadable';
    } finally {
      try { reader.cancel(); } catch { /* the transfer is already finished */ }
    }
  }
  // `arrayBuffer` first, `blob` second. React Native's `blob()` depends on the
  // app having the Blob module, and rejects where it does not — while
  // `arrayBuffer` is the accessor the client implementations here used before
  // this module existed. A host that has one usually has the other, so trying
  // both costs a branch and removes a whole-platform failure mode.
  const buffered = response as unknown as BufferedBody;
  if (typeof buffered.arrayBuffer === 'function') {
    try {
      return (await buffered.arrayBuffer()).byteLength > 0 ? 'bytes' : 'empty';
    } catch { /* fall through to blob */ }
  }
  if (typeof buffered.blob === 'function') {
    try {
      return (await buffered.blob()).size > 0 ? 'bytes' : 'empty';
    } catch { /* fall through to unreadable */ }
  }
  return 'unreadable';
}

/**
 * The longest hold this module will report.
 *
 * `Retry-After` is a number a node states about itself, and nothing validates
 * it. An unbounded one turns a single bad header into an effectively
 * permanent hold: a caller that waits as instructed abandons a node that is
 * otherwise healthy, having been told to come back in three hours. Clamped
 * rather than rejected, because a large value still means "longer than usual"
 * and that part is worth keeping.
 */
export const HLS_MAX_RETRY_AFTER_MS = 60_000;

/** `Retry-After` in seconds, or an HTTP-date. Absent or unparseable falls back to the hold. */
function retryAfterMs(response: Response, holdMs: number): number {
  const header = response.headers?.get?.('retry-after');
  if (!header) return holdMs;
  const clamp = (ms: number) => Math.min(HLS_MAX_RETRY_AFTER_MS, Math.max(0, Math.round(ms)));
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return clamp(seconds * 1_000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return clamp(date - Date.now());
  return holdMs;
}

/** The message of a thrown value, where it has one worth reporting. */
function causeDetail(error: unknown): string | undefined {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === 'string' && error ? error : undefined;
}

/**
 * Resolve the media targets of a source, descending at most one variant deep.
 *
 * The primitive both walks share. Exported because a host with a third
 * question should ask it over these targets rather than parse a manifest
 * again — a fourth copy of this descent was days from being written when this
 * module was created.
 */
export async function hlsWalkTargets(
  source: PlaybackSource,
  options: HlsWalkOptions,
): Promise<string[]> {
  const manifest = await walkFetch(source.url, source, undefined, options);
  if (!manifest.ok) return [];
  const text = await manifest.text();
  const variant = firstVariantUri(text);
  if (!variant) {
    return mediaPlaylistTargets(text).map((uri) => resolveUrl(source.url, uri));
  }
  const variantUrl = resolveUrl(source.url, variant);
  const media = await walkFetch(variantUrl, source, undefined, options);
  if (!media.ok) return [];
  const mediaText = await media.text();
  const targets = mediaPlaylistTargets(mediaText).map((uri) => resolveUrl(variantUrl, uri));
  return [...new Set(targets)];
}

/**
 * Will this node serve this source? Reads real bytes from the first media
 * targets.
 *
 * **A non-manifest source answers `true`, and that is the single most
 * important line in this module.** `false` means "this node will not serve
 * it", and `PlaybackCoordinator` destroys the standby on a `false`. A source
 * that is not a manifest is one this walk **cannot assess**, not one it has
 * judged — `isManifest` is stated by the resolver and `PlaybackSource`
 * documents that it must never be inferred from the extension or the mode, so
 * a byte-source is a perfectly ordinary thing to be handed here.
 *
 * The two client implementations this replaces disagreed on exactly this, and
 * the one that returned `false` was wrong: it threw away standbys it could
 * have promoted. Reporting an inability to measure as a failure is the same
 * error that once made every Samsung standby fail its own validation. When in
 * doubt, this walk declines to condemn.
 *
 * A hold (`500`) answers `true` for the same reason: the node has not produced
 * the fragment yet and is working correctly, so "not yet" is not "no".
 */
export async function preflightHlsSource(
  source: PlaybackSource,
  options: HlsWalkOptions,
): Promise<boolean> {
  if (!source.isManifest) return true;
  let targets: string[];
  try {
    targets = await hlsWalkTargets(source, options);
  } catch {
    return false;
  }
  // An empty target list means the manifest was unreadable or had no media in
  // it, which is a negative answer about this node rather than an absence of
  // one — a served manifest with nothing to play will not play.
  if (targets.length === 0) return false;
  for (const target of targets) {
    try {
      const response = await walkFetch(target, source, HLS_PREFLIGHT_RANGE, options);
      // The hold, through the one constant that defines it. Spelling the
      // number here is how a walk goes on recognising a status the protocol
      // has moved off, and it fails in the expensive direction: an unmatched
      // hold falls to `!response.ok` and condemns a node that is working.
      if (response.status === SEGMENT_NOT_READY_STATUS) continue;
      if (!response.ok) return false;
      // `unreadable` is this module's own rule turned on itself: the node
      // answered, the status says it is serving, and all that failed was this
      // package's ability to read the body on this host. Condemning on it
      // would destroy every standby on a platform whose body accessors this
      // walk cannot use — silently, with no status and no log line, looking
      // exactly like "seamless failover does not work on this device".
      if (await receivedBytes(response) === 'empty') return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Has the first fragment arrived yet? Reads no payload.
 *
 * The question a player asks before committing to a source it has just been
 * handed, and the one whose answer must distinguish a hold from a refusal.
 * `holding` carries the node's own `Retry-After` where it sent one, so a
 * caller retries **the same node**: the next node is producing a different
 * generation and does not have this fragment either.
 *
 * Losing this distinction is not theoretical. A client that moved to a player
 * without hold-aware retry began failing over spuriously under load, because
 * every hold read as a node fault.
 */
export async function probeHlsReadiness(
  source: PlaybackSource,
  options: HlsWalkOptions,
): Promise<HlsWalkOutcome> {
  if (!source.isManifest) return { state: 'unassessable', reason: 'not-a-manifest' };
  let targets: string[];
  try {
    targets = await hlsWalkTargets(source, options);
  } catch (error) {
    // The thrown message is the only line that names a cause. On a television
    // there is no console, so a failure trail on screen is the whole mechanism
    // for telling a stalled node from a timed-out one from a refused one, and
    // swallowing this leaves it printing "the node did not answer".
    return { state: 'unavailable', detail: causeDetail(error) };
  }
  if (targets.length === 0) return { state: 'unassessable', reason: 'empty-manifest' };
  for (const target of targets) {
    let response: Response;
    try {
      response = await walkFetch(target, source, HLS_READINESS_RANGE, options);
    } catch (error) {
      return { state: 'unavailable', detail: causeDetail(error) };
    }
    if (response.status === SEGMENT_NOT_READY_STATUS) return { state: 'holding', retryAfterMs: retryAfterMs(response, sourceHoldMs(source)) };
    if (!response.ok) return { state: 'unavailable', status: response.status };
  }
  return { state: 'ready' };
}

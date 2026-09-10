/**
 * The platform surface `@macha/core` is allowed to assume.
 *
 * Not a convenience — a boundary. `tsconfig.nodom.json` compiles core against
 * *only* this and `ES2022`, so anything the package reaches for that is not
 * declared here becomes a compile error with a file and a line. That is the
 * check `npm run lint:platform` runs.
 *
 * The shipped build still uses the `DOM` lib, because emitting is not the
 * problem: `HTMLElement` compiled and passed 570 tests while sitting in an
 * exported signature, and `DOMException` compiled and passed them while
 * throwing `ReferenceError` on React Native. A grep for four noun-shaped names
 * found neither. This file is the mechanical version of that boundary.
 *
 * **Members are declared as core uses them, not as the web platform defines
 * them.** Reaching for something not listed is meant to fail: it means core has
 * quietly widened what it requires of a host, and that should be a decision
 * rather than an accident.
 *
 * What is deliberately *not* here: `document`, `window`, `navigator`,
 * `localStorage`, `HTMLElement` and every other DOM type. Presentation handles
 * travel as `PlaybackHost`, which is `unknown`; storage, the clock, id
 * generation and the origin arrive through `machaHost()`.
 */

// ---- universal ECMAScript hosts -------------------------------------------
declare function setTimeout(handler: () => void, timeout?: number): number;
declare function clearTimeout(handle: number | undefined): void;
declare const console: {
  debug(...data: unknown[]): void;
  info(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
};

// ---- cancellation ----------------------------------------------------------
interface AbortSignal {
  readonly aborted: boolean;
  /**
   * Optional on purpose: `reason` postdates `AbortSignal` and React Native's
   * polyfill does not implement it, so `signal.reason` is always `undefined`
   * there. Code that falls back when it is missing is the norm, not a defence.
   */
  readonly reason?: unknown;
  /**
   * `once` is honoured everywhere core uses it, but **not by every host** —
   * only ever on an `AbortSignal`, which is the part that saves it.
   *
   * React Native's `AbortController` comes from `abort-controller` over
   * `event-target-shim`, which stores the flag and removes the listener after
   * dispatch. Tizen 3's *native* `addEventListener` ignores the options object
   * entirely — a `{once:true}` listener on `window` fires twice — but core
   * never attaches to a DOM node, and on that platform the signal is the
   * client's own shim, which honours it. Correct by the shim, not by the host.
   */
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}
interface AbortController {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}
/**
 * **Not universally present.** Tizen 3 / Chromium 47 has no `AbortController`
 * at all, and core-js does not supply one — macha-client installs its own shim
 * before anything else runs. So this line is satisfied on that platform by a
 * consumer, not by the host.
 *
 * That is the honest shape of this whole file: it states what core requires,
 * and a host that lacks something must bring it. It does not assert that every
 * host already has everything listed.
 */
declare const AbortController: { new(): AbortController };

/**
 * Declared as possibly absent, which is the whole point of listing it.
 *
 * `DOMException` is a browser global rather than an ECMAScript one. Hermes has
 * none and React Native never installs its implementation on `globalThis`, so
 * an unguarded `new DOMException(...)` throws there. Typing it as possibly
 * undefined makes the `typeof` guard mandatory rather than remembered.
 */
declare const DOMException: (new(message?: string, name?: string) => Error) | undefined;

/** Same treatment, for the same reason: guarded in `machaHost()`, never assumed. */
interface Crypto {
  randomUUID?(): string;
  getRandomValues?<T extends ArrayBufferView>(array: T): T;
}
declare const crypto: Crypto | undefined;

// ---- fetch, as core uses it ------------------------------------------------
type HeadersInit = Headers | Record<string, string> | [string, string][];
type BodyInit = string | Blob;
interface Blob { readonly size: number; readonly type: string }
declare const Headers: { new(init?: HeadersInit): Headers };
interface Headers {
  get(name: string): string | null;
  set(name: string, value: string): void;
  forEach(callback: (value: string, key: string) => void): void;
}
interface RequestInit {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit;
  signal?: AbortSignal;
  /**
   * **Not a header everywhere, and not ignored where it is unsupported.**
   *
   * React Native's `fetch` is `whatwg-fetch` over XHR, and for a GET or HEAD
   * it implements `no-store` by *rewriting the URL* — appending `_=<epoch
   * millis>` to the query, or replacing an existing one. So core's health
   * probe goes out as a different URL on every cycle rather than as a request
   * with a cache directive.
   *
   * Tizen 3 is a third behaviour again, and the worst one: the property does
   * not exist — `'cache' in new Request(url, {cache:'no-store'})` is `false` —
   * so the directive vanishes with no header and no URL change, and the
   * response is cacheable by the WebView.
   *
   * Three hosts, three behaviours, one of which silently does nothing. **Do
   * not rely on this option alone where a stale answer would be wrong.**
   * `EndpointHealthMonitor` busts its own probe URL for exactly that reason: a
   * cached `catalogue/status` makes a dead node answer `200` and keeps traffic
   * pointed at it.
   */
  cache?: 'no-store' | 'default';
  /**
   * Browser-only, and knowingly so. It lets a teardown `DELETE` outlive the
   * page navigating away, which is the only way a web client can close a
   * playback session on exit. React Native ignores it — there is no
   * equivalent, and no navigation to survive — so a host without it loses
   * best-effort teardown and nothing else. Declared rather than removed
   * because the web behaviour is worth having; named rather than assumed
   * because it is not universal.
   */
  keepalive?: boolean;
}
declare const Response: { new(body?: BodyInit | null, init?: { status?: number; statusText?: string; headers?: HeadersInit }): Response };
interface Response {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  readonly headers: Headers;
  json(): Promise<unknown>;
  text(): Promise<string>;
  blob(): Promise<Blob>;
}
declare function fetch(input: string, init?: RequestInit): Promise<Response>;

/**
 * Present everywhere, but *not the same everywhere*.
 *
 * React Native's `URL` is a string-concatenation polyfill rather than an RFC
 * resolver: it appends where a browser would resolve, so a relative path
 * containing `../` comes out wrong. Core only ever resolves absolute paths
 * against an origin, which both implementations agree on. Anything relying on
 * real relative resolution needs to do it itself.
 */
declare const URL: {
  new(url: string, base?: string): { readonly href: string; readonly origin: string };
};

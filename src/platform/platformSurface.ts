/**
 * Check, on the device, that this host actually provides what `@macha/core`
 * requires of it.
 *
 * Core declares its permitted platform surface in `macha-ts/types/
 * platform-neutral.d.ts` and compiles against only that. But that is a
 * *compile-time* boundary on what core may reach for — it says nothing about
 * whether a given host supplies it at runtime. The two come apart in exactly
 * the way that is hardest to notice: `DOMException` compiled and passed the
 * entire test suite while throwing `ReferenceError` on React Native.
 *
 * The Samsung client is the standing proof that this must be checked rather
 * than assumed — Chromium 47 has no `AbortController` at all, and the web
 * client meets core's surface with a consumer-supplied polyfill. Hermes plus
 * React Native's polyfills is a third host again, so it gets the same
 * treatment: probe the members, report what is missing, and let a person see
 * the answer on the Settings screen.
 *
 * Nothing here throws. A missing *optional* member is information; a missing
 * *required* one is a defect worth showing, but crashing at startup over it
 * would replace a diagnosable app with an unusable one.
 */

export type SurfaceStatus = 'present' | 'absent' | 'degraded';

export interface SurfaceFinding {
  name: string;
  status: SurfaceStatus;
  /** Whether core needs it, or merely uses it when offered. */
  required: boolean;
  detail?: string;
}

/**
 * The members `types/platform-neutral.d.ts` declares as possibly absent, and
 * therefore the only ones whose absence is not a defect.
 *
 * Stated once, here, rather than as a boolean beside each probe. A per-probe
 * flag is a second copy of the contract and drifts from it silently — the same
 * failure as the segment-hold constant that lived in three places. Everything
 * not named here is declared unconditionally and is required.
 *
 * Each entry corresponds to a declaration you can check by eye:
 * `DOMException` and `crypto` are typed `| undefined`, and `reason` is
 * declared `readonly reason?: unknown` on `AbortSignal`.
 */
const OPTIONAL_SURFACE: ReadonlySet<string> = new Set([
  'AbortSignal.reason',
  'DOMException',
  'crypto.randomUUID',
]);

function probe(
  name: string,
  test: () => boolean | string,
): SurfaceFinding {
  const required = !OPTIONAL_SURFACE.has(name);
  try {
    const result = test();
    if (result === true) return { name, status: 'present', required };
    if (result === false) return { name, status: 'absent', required };
    return { name, status: 'degraded', required, detail: result };
  } catch (error) {
    return {
      name,
      status: 'absent',
      required,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function checkPlatformSurface(): SurfaceFinding[] {
  const global = globalThis as Record<string, unknown>;

  return [
    probe('setTimeout / clearTimeout', () =>
      typeof global.setTimeout === 'function' && typeof global.clearTimeout === 'function'),

    probe('console', () =>
      typeof console?.warn === 'function' && typeof console?.error === 'function'),

    probe('AbortController', () => {
      if (typeof global.AbortController !== 'function') return false;
      const controller = new AbortController();
      if (controller.signal.aborted) return 'signal starts aborted';
      controller.abort();
      return controller.signal.aborted ? true : 'abort() did not set aborted';
    }),

    probe('AbortSignal listener `once`', () => {
      // Core relies on this to avoid leaking a listener per awaited request.
      // The natural guess is that a polyfill ignores it; core's own note says
      // it was verified rather than assumed, so verify it here too.
      //
      // Verifying it properly needs a second dispatch, because `abort()` fires
      // only once by itself and so cannot distinguish `once` from its absence.
      // That needs `Event` and `dispatchEvent`, neither of which is in core's
      // declared surface and neither of which Hermes is guaranteed to have.
      // **Their absence must not be reported as this member failing** — a
      // required member wrongly marked absent is the worst output this probe
      // can produce, so an unverifiable check says so instead.
      const controller = new AbortController();
      let calls = 0;
      controller.signal.addEventListener('abort', () => { calls += 1; }, { once: true });
      controller.abort();

      const signal = controller.signal as { dispatchEvent?: (event: unknown) => boolean };
      const eventCtor = (globalThis as { Event?: new (type: string) => unknown }).Event;
      if (typeof signal.dispatchEvent !== 'function' || typeof eventCtor !== 'function') {
        return calls === 1
          ? 'accepted, not verifiable here (no Event/dispatchEvent to re-fire with)'
          : `listener fired ${calls} times on abort`;
      }

      signal.dispatchEvent(new eventCtor('abort'));
      return calls === 1 ? true : `listener fired ${calls} times`;
    }),

    probe('AbortSignal.reason', () => {
      // Documented as absent on React Native. Core already falls back, so this
      // is reported for information rather than as a fault.
      const controller = new AbortController();
      controller.abort();
      return 'reason' in controller.signal && controller.signal.reason !== undefined
        ? true
        : 'absent — core falls back, as designed';
    }),

    probe('DOMException', () =>
      typeof global.DOMException === 'function'
        ? true
        : 'absent — expected on Hermes; core guards with typeof'),

    probe('crypto.randomUUID', () =>
      typeof (global.crypto as { randomUUID?: unknown })?.randomUUID === 'function'
        ? true
        : 'absent — machaHost() falls back'),

    probe('fetch', () => typeof global.fetch === 'function'),

    probe('Headers', () => {
      if (typeof global.Headers !== 'function') return false;
      const headers = new Headers({ a: 'b' });
      if (headers.get('a') !== 'b') return 'get() did not round-trip';
      if (typeof headers.forEach !== 'function') return 'no forEach()';
      return true;
    }),

    probe('Response', () => {
      if (typeof global.Response !== 'function') return false;
      const response = new Response('{}', { status: 200 });
      return typeof response.json === 'function' && typeof response.text === 'function'
        ? true
        : 'missing json()/text()';
    }),

    // The three below are not in `platform-neutral.d.ts` — they are ES2022
    // built-ins core compiles against unconditionally — but Hermes has
    // historically shipped `Intl` partially, and **a partial `Intl` degrades
    // to a wrong answer rather than an exception.** `titleIndex` builds
    // `sortMediaByIndexedTitle` and `availableAlphabetKeys` on all three, so
    // the visible symptom is a library sorted wrongly and an alphabet-jump
    // strip with the wrong letters — on a TV, the navigation affordance
    // itself. Nothing throws, so nothing else would ever report it.
    //
    // Each asserts a specific answer rather than mere presence, because
    // presence is exactly what a partial implementation has.

    probe('Intl.Collator options', () => {
      const intl = (globalThis as { Intl?: { Collator?: new (l?: string, o?: object) => { compare(a: string, b: string): number } } }).Intl;
      if (typeof intl?.Collator !== 'function') return false;
      const collator = new intl.Collator('en', { sensitivity: 'base', numeric: true });
      // `sensitivity: 'base'` must fold case and accent together; `numeric`
      // must order 2 before 10. A stub that ignores its options answers both
      // the other way round, which is the wrong-sort-order failure.
      if (collator.compare('a', 'A') !== 0) return 'sensitivity: base does not fold case';
      if (collator.compare('e', 'é') !== 0) return 'sensitivity: base does not fold accents';
      if (collator.compare('item 2', 'item 10') >= 0) return 'numeric: true does not order numerically';
      return true;
    }),

    probe('String.prototype.normalize', () => {
      if (typeof String.prototype.normalize !== 'function') return false;
      // NFKD must actually decompose, so the combining mark below is there to
      // be stripped. A pass-through implementation returns the input.
      const decomposed = 'é'.normalize('NFKD');
      return decomposed.length === 2 ? true : 'NFKD did not decompose a precomposed character';
    }),

    probe('Unicode property escapes (\\p{M})', () => {
      // Built at runtime so a host whose regex engine rejects the syntax
      // throws here and is reported, rather than failing to parse this module.
      let marks: RegExp;
      try {
        marks = new RegExp('\\p{M}', 'gu');
      } catch {
        return false;
      }
      return 'é'.normalize('NFKD').replace(marks, '') === 'e'
        ? true
        : 'did not match combining marks';
    }),

    // **Deliberately does not test relative resolution.** It asserts only an
    // absolute path against an origin, which is the one thing core does.
    // React Native's `URL` is a concatenating polyfill rather than an RFC
    // resolver and would fail a `../` case — correctly, since core never asks
    // for one. Without this note a passing probe reads as "URL works" when it
    // means "URL works for the one thing core needs".
    probe('URL', () => {
      if (typeof global.URL !== 'function') return false;
      const url = new URL('/api/v1/server/info', 'http://10.44.1.50:7438');
      return url.href === 'http://10.44.1.50:7438/api/v1/server/info'
        ? true
        : `absolute-path resolution gave ${url.href}`;
    }),
  ];
}

/** Required members this host does not supply. Empty is the expected answer. */
export function missingRequiredSurface(): SurfaceFinding[] {
  return checkPlatformSurface().filter((finding) => finding.required && finding.status !== 'present');
}

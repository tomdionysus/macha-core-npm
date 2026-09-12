import { describe, expect, it } from 'vitest';
import { checkPlatformSurface, missingRequiredSurface } from './platformSurface.js';

/**
 * These run on Node, which supplies core's whole declared surface — so the
 * interesting assertions are about the probe's own behaviour rather than about
 * Node. The one bug a probe must not have is throwing, and the second is a
 * false negative on a required member; both are covered.
 */
describe('platform surface probe', () => {
  it('never throws, whatever the host', () => {
    expect(() => checkPlatformSurface()).not.toThrow();
  });

  it('reports every required member present on a complete host', () => {
    // Node has all of it, so anything missing here is the probe being wrong,
    // not the host being deficient.
    expect(missingRequiredSurface()).toEqual([]);
  });

  it('names the member rather than returning a bare boolean', () => {
    for (const finding of checkPlatformSurface()) {
      expect(finding.name).toBeTruthy();
      expect(['present', 'absent', 'degraded']).toContain(finding.status);
      expect(typeof finding.required).toBe('boolean');
    }
  });

  it('carries a reason whenever a member is not simply present', () => {
    // A finding of "absent" with no detail tells a reader nothing they can act
    // on, which defeats the purpose of returning structure at all.
    for (const finding of checkPlatformSurface()) {
      if (finding.status !== 'present') expect(finding.detail).toBeTruthy();
    }
  });

  it('reports a member as absent, not crashing, when constructing it throws', () => {
    // The Chromium 47 / Hermes shape: the global exists but is unusable.
    const original = globalThis.Headers;
    // @ts-expect-error -- deliberately hostile host.
    globalThis.Headers = function Broken() { throw new Error('unusable'); };
    try {
      const headers = checkPlatformSurface().find((f) => f.name === 'Headers');
      expect(headers?.status).toBe('absent');
      expect(headers?.detail).toContain('unusable');
    } finally {
      globalThis.Headers = original;
    }
  });

  it('does not mark `once` absent merely because Event is unavailable', () => {
    // The false negative that matters: Hermes may lack `Event`, and reporting a
    // *required* member as missing because an unrelated global is absent would
    // send someone hunting a defect that is not there.
    const original = globalThis.Event;
    // @ts-expect-error -- simulating a host without an Event constructor.
    delete globalThis.Event;
    try {
      const once = checkPlatformSurface().find((f) => f.name.includes('once'));
      expect(once?.status).not.toBe('absent');
      expect(once?.detail).toMatch(/not verifiable/i);
    } finally {
      globalThis.Event = original;
    }
  });
});

describe('required is derived from the declaration, not restated', () => {
  it('marks exactly the three members the declaration types as possibly absent', () => {
    // A per-probe boolean would be a second copy of the contract and would
    // drift from `platform-neutral.d.ts` silently — the same failure as a
    // server constant living in three repositories. If this list and the
    // declaration disagree, one of them is wrong and this test says which.
    const optional = checkPlatformSurface().filter((finding) => !finding.required).map((f) => f.name);
    expect(optional.sort()).toEqual(['AbortSignal.reason', 'DOMException', 'crypto.randomUUID']);
  });

  it('treats every other probed member as required', () => {
    const required = checkPlatformSurface().filter((finding) => finding.required);
    expect(required.length).toBeGreaterThan(5);
    expect(required.every((finding) => !finding.name.includes('reason'))).toBe(true);
  });
});

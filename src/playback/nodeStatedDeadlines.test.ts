import { describe, expect, it, vi } from 'vitest';
import type { PlaybackSource } from '../types.js';
import { probeHlsReadiness } from './hlsWalk.js';
import {
  MEDIA_STALL_MARGIN_MS,
  MEDIA_STALL_TIMEOUT_MS,
  MediaStallWatchdog,
  mediaStallTimeoutMs,
  type MediaWatchdogEnvironment,
} from './MediaWatchdog.js';
import { SERVER_SEGMENT_HOLD_MS } from './streamProtocol.js';

function source(segmentHoldMs?: number): PlaybackSource {
  return {
    mediaId: 'macha:media',
    url: 'https://node.test/playlist.m3u8',
    isManifest: true,
    mode: 'transcode',
    ...(segmentHoldMs === undefined
      ? {}
      : { budgets: { deadlineMs: 19_000, segmentHoldMs } }),
  };
}

const PLAYLIST = '#EXTM3U\n#EXTINF:4,\nseg1.m4s\n';

/** A node holding a fragment: `500`, no body, and no `Retry-After` header. */
function holdingFetch() {
  return vi.fn(async (url: string) => (url.endsWith('.m3u8')
    ? new Response(PLAYLIST, { status: 200 })
    : new Response(null, { status: 500 })));
}

describe('a walk waits as long as the serving node says it holds', () => {
  it('reports the retry interval the node stated, not the compiled-in guess', async () => {
    // A node configured with a 10 s hold answers `500` after 10 s. Telling the
    // caller to come back in 6 s sends it back before the node has moved on.
    const result = await probeHlsReadiness(source(10_000), { fetch: holdingFetch() });
    expect(result).toEqual({ state: 'holding', retryAfterMs: 10_000 });
  });

  it('falls back to the published hold for a node that does not report one', async () => {
    const result = await probeHlsReadiness(source(), { fetch: holdingFetch() });
    expect(result).toEqual({ state: 'holding', retryAfterMs: SERVER_SEGMENT_HOLD_MS });
  });

  it('still prefers an explicit Retry-After over both', async () => {
    // The node answering the question directly beats any derivation of it.
    const fetch = vi.fn(async (url: string) => (url.endsWith('.m3u8')
      ? new Response(PLAYLIST, { status: 200 })
      : new Response(null, { status: 500, headers: { 'Retry-After': '2' } })));
    const result = await probeHlsReadiness(source(10_000), { fetch });
    expect(result).toEqual({ state: 'holding', retryAfterMs: 2_000 });
  });
});

describe('the stall budget follows the serving node', () => {
  it('sits one margin above whatever hold the node stated', () => {
    expect(mediaStallTimeoutMs(source(10_000))).toBe(10_000 + MEDIA_STALL_MARGIN_MS);
  });

  it('falls back to the published default where the node cannot say', () => {
    expect(mediaStallTimeoutMs(source())).toBe(MEDIA_STALL_TIMEOUT_MS);
    expect(mediaStallTimeoutMs(undefined)).toBe(MEDIA_STALL_TIMEOUT_MS);
  });

  it('never expires inside a legitimate hold', () => {
    // The whole rule the constant was written for: a node holding a fragment
    // for its full timeout is working, and a budget at or under that calls it
    // dead for behaving exactly as specified.
    for (const holdMs of [4_000, 6_000, 10_000, 30_000]) {
      expect(mediaStallTimeoutMs(source(holdMs))).toBeGreaterThan(holdMs);
    }
  });

  it('arms against the node\'s hold once a source has been adopted', () => {
    const scheduled: number[] = [];
    const environment: MediaWatchdogEnvironment = {
      now: () => 0,
      visible: () => true,
      onVisibilityChange: () => () => undefined,
      schedule: (_run, delayMs) => { scheduled.push(delayMs); return () => undefined; },
    };
    const watchdog = new MediaStallWatchdog(environment);
    watchdog.watch(() => undefined);
    watchdog.useSourceBudgets(source(10_000));

    // The countdown only starts once something has actually moved; a source
    // still loading is the start watchdog's business.
    watchdog.note(0, 1_000);
    watchdog.note(500, 4_000);

    expect(scheduled).toEqual([10_000 + MEDIA_STALL_MARGIN_MS]);
  });

  it('does not restart a running countdown for a figure that has not changed', () => {
    // Time already spent waiting is evidence about this node. Re-adopting the
    // same source must not hand it back.
    const scheduled: number[] = [];
    const environment: MediaWatchdogEnvironment = {
      now: () => 0,
      visible: () => true,
      onVisibilityChange: () => () => undefined,
      schedule: (_run, delayMs) => { scheduled.push(delayMs); return () => undefined; },
    };
    const watchdog = new MediaStallWatchdog(environment);
    watchdog.watch(() => undefined);
    watchdog.note(0, 1_000);
    watchdog.note(500, 4_000);
    const armed = scheduled.length;

    watchdog.useSourceBudgets(source());
    expect(scheduled).toHaveLength(armed);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { bootstrapEndpoints, EndpointRegistry, GENERATION_START_EVIDENCE_TTL_MS, GENERATION_START_SAMPLES } from '../cluster/EndpointRegistry.js';
import { generationStartKind, measureGenerationStart } from './generationStart.js';
import { SEGMENT_NOT_READY_STATUS } from './streamProtocol.js';
import type { PlaybackSession } from './PlaybackResolver.js';

const manifest = {
  mediaId: 'm', url: 'http://b/api/v1/playback/sessions/s/stream/t/1/index.m3u8',
  mimeType: 'application/vnd.apple.mpegurl', isManifest: true, mode: 'transcode' as const, durationMs: 600_000,
};
const PLAYLIST = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg0.m4s\n#EXT-X-ENDLIST\n';

/** A node that holds the first fragment `holds` times, then serves it. */
function node(holds: number) {
  let remaining = holds;
  return vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith('.m3u8')) return new Response(PLAYLIST, { status: 200 });
    if (remaining > 0) {
      remaining -= 1;
      return new Response(null, { status: SEGMENT_NOT_READY_STATUS, headers: { 'Retry-After': '1' } });
    }
    return new Response(new Uint8Array([0]), { status: 206 });
  });
}

describe('generation start evidence', () => {
  it('estimates from the longest recent start of that kind on that node, and nothing else', () => {
    let now = 1_000_000;
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']), () => now);
    registry.recordGenerationStart('http://b', 'video-transcode', 8_500);
    registry.recordGenerationStart('http://b', 'video-transcode', 12_300);
    registry.recordGenerationStart('http://b', 'video-transcode', 9_000);
    registry.recordGenerationStart('http://b', 'remux', 400);

    // The longest, because estimating short is the freeze and estimating long
    // is only a lead the outgoing runway pays for.
    expect(registry.generationStartEstimate('http://b', 'video-transcode')).toBe(12_300);
    // Kinds do not mix, and nodes do not lend each other figures.
    expect(registry.generationStartEstimate('http://b', 'remux')).toBe(400);
    expect(registry.generationStartEstimate('http://b', 'video-copy')).toBeUndefined();
    expect(registry.generationStartEstimate('http://a', 'video-transcode')).toBeUndefined();

    now += GENERATION_START_EVIDENCE_TTL_MS + 1;
    expect(registry.generationStartEstimate('http://b', 'video-transcode')).toBeUndefined();
  });

  it('keeps a bounded window, and refuses a value that would become a nonsense lead', () => {
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://b']), () => 1);
    registry.recordGenerationStart('http://b', 'remux', 60_000);
    for (let i = 0; i < GENERATION_START_SAMPLES; i += 1) registry.recordGenerationStart('http://b', 'remux', 1_000);
    expect(registry.generationStartEstimate('http://b', 'remux')).toBe(1_000);
    registry.recordGenerationStart('http://b', 'remux', Number.NaN);
    registry.recordGenerationStart('http://b', 'remux', -5);
    expect(registry.generationStartEstimate('http://b', 'remux')).toBe(1_000);
  });

  it('keys a start by what it involves', () => {
    const base = { mode: 'transcode', transform: { video: 'transcode', audio: 'transcode' } } as unknown as PlaybackSession;
    expect(generationStartKind(base)).toBe('video-transcode');
    expect(generationStartKind({ ...base, transform: { video: 'copy', audio: 'transcode' } } as PlaybackSession)).toBe('video-copy');
    expect(generationStartKind({ ...base, mode: 'remux' } as PlaybackSession)).toBe('remux');
    expect(generationStartKind({ ...base, mode: 'direct' } as PlaybackSession)).toBeUndefined();
  });
});

describe('measureGenerationStart', () => {
  it('times from the request to the first ready fragment, honouring the hold between probes', async () => {
    let now = 0;
    const fetch = node(2);
    const sleeps: number[] = [];
    const ms = await measureGenerationStart(manifest, {
      fetch, startedAt: 0, budgetMs: 20_000, now: () => now,
      sleep: async (wait) => { sleeps.push(wait); now += wait; },
    });
    expect(ms).toBe(2_000);
    expect(sleeps).toEqual([1_000, 1_000]);
    // No payload moved: every fragment probe ranged a single byte.
    const ranges = fetch.mock.calls
      .filter(([url]) => String(url).endsWith('.m4s'))
      .map(([, init]) => (init as RequestInit | undefined)?.headers as Record<string, string>);
    expect(ranges.every((headers) => headers.Range === 'bytes=0-0')).toBe(true);
  });

  it('records nothing for a node that refused, or one that outran its own budget', async () => {
    let now = 0;
    const refused = vi.fn(async (url: string) => url.endsWith('.m3u8')
      ? new Response(PLAYLIST, { status: 200 })
      : new Response(null, { status: 404 }));
    expect(await measureGenerationStart(manifest, { fetch: refused, startedAt: 0, budgetMs: 20_000, now: () => now })).toBeUndefined();

    const slow = node(100);
    expect(await measureGenerationStart(manifest, {
      fetch: slow, startedAt: 0, budgetMs: 5_000, now: () => now,
      sleep: async (wait) => { now += wait; },
    })).toBeUndefined();
  });
});

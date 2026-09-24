import { describe, expect, it } from 'vitest';
import { bootstrapEndpoints, EndpointRegistry, GENERATION_START_EVIDENCE_TTL_MS, GENERATION_START_SAMPLES } from '../cluster/EndpointRegistry.js';
import { generationStartKind } from './generationStart.js';
import type { PlaybackSession } from './PlaybackResolver.js';

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

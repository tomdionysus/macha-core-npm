import { describe, expect, it } from 'vitest';
import type { CatalogueMediaProfile } from '../api/CatalogueApi.js';
import type { PlaybackSession } from './PlaybackResolver.js';
import { technicalProfileFromCatalogue, technicalProfileFromSession } from './MediaTechnicalProfile.js';

describe('media technical profile normalization', () => {
  it('normalizes an immutable catalogue profile for opportunistic preparation', () => {
    const profile: CatalogueMediaProfile = {
      schema_version: 1,
      media_id: 'macha:immutable',
      format: 'mov,mp4',
      duration_ms: 90_000,
      bitrate: 4_000_000,
      streams: [{
        index: 0, type: 'video', codec: 'h264', profile: 'High', language: 'und',
        width: 1920, height: 1080, channels: 0, sample_rate: 0, bit_depth: 8,
        default: true, forced: false, bitrate: 3_500_000, attached_picture: false,
      }],
    };

    expect(technicalProfileFromCatalogue(profile)).toEqual({
      mediaId: 'macha:immutable',
      format: 'mov,mp4',
      durationMs: 90_000,
      bitrate: 4_000_000,
      streams: [expect.objectContaining({
        index: 0, codec: 'h264', width: 1920, height: 1080, bitDepth: 8,
      })],
    });
  });

  it('adds negotiated output and source size from a session response', () => {
    const session = {
      mediaId: 'macha:immutable',
      mode: 'remux',
      mimeType: 'application/vnd.apple.mpegurl',
      durationMs: 90_000,
      sourceInfo: {
        format: 'matroska,webm', size: 20_000_000, bitrate: 4_000_000,
        streams: [{ index: 1, type: 'audio', codec: 'aac', profile: 'LC', language: 'eng', default: true, forced: false, channels: 2 }],
      },
      output: { format: 'mp4' },
    } as PlaybackSession;

    expect(technicalProfileFromSession(session)).toMatchObject({
      mediaId: 'macha:immutable',
      sizeBytes: 20_000_000,
      streams: [{ index: 1, sampleRate: undefined, channels: 2 }],
      negotiated: { mode: 'remux', mimeType: 'application/vnd.apple.mpegurl', format: 'mp4' },
    });
  });
});

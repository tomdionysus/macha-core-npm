import { describe, expect, it } from 'vitest';
import { parseErrorEnvelope } from './errorEnvelope.js';

describe('parseErrorEnvelope', () => {
  it('accepts the legacy string error shape', () => {
    expect(parseErrorEnvelope({ error: 'not found' }, 'fallback')).toEqual({ message: 'not found', detail: 'not found' });
  });

  it('extracts message and code from a structured error object', () => {
    expect(parseErrorEnvelope({ error: { code: 'media_unavailable', message: 'No playable media source' } }, 'fallback')).toEqual({
      message: 'No playable media source',
      detail: 'No playable media source',
      code: 'media_unavailable',
    });
  });

  it('extracts the current Macha top-level error code when a message accompanies it', () => {
    expect(parseErrorEnvelope({ error: 'profile_not_available', message: 'Media profile is not available yet' }, 'fallback')).toEqual({
      message: 'Media profile is not available yet',
      detail: 'Media profile is not available yet',
      code: 'profile_not_available',
    });
  });

  it('prefers a top-level message while retaining a nested error code', () => {
    expect(parseErrorEnvelope({ message: 'Playback negotiation failed', error: { code: 'unsupported_codec' } }, 'fallback')).toEqual({
      message: 'Playback negotiation failed',
      detail: 'Playback negotiation failed',
      code: 'unsupported_codec',
    });
  });

  it('renders unfamiliar structured errors as JSON instead of object coercion', () => {
    expect(parseErrorEnvelope({ error: { foo: 'bar' } }, 'fallback')).toEqual({ message: '{"foo":"bar"}' });
  });

  it("keeps core's fallbacks out of detail, which is only ever the server's words", () => {
    // Core writes no viewer text (Tom, 2026-09-24).
    expect(parseErrorEnvelope({ error: { foo: 'bar' } }, 'fallback').detail).toBeUndefined();
    expect(parseErrorEnvelope(undefined, '503 Service Unavailable').detail).toBeUndefined();
  });

  it('falls back to the HTTP status description for an empty response', () => {
    expect(parseErrorEnvelope(undefined, '503 Service Unavailable')).toEqual({ message: '503 Service Unavailable' });
  });
});

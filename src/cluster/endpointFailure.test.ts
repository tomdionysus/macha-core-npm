import { describe, expect, it } from 'vitest';
import { isPerTitleFailure, retryableEndpointFailure } from './endpointFailure.js';

describe('per-title failure classification', () => {
  it('does not treat one title’s pipeline failure as node health evidence', () => {
    for (const code of ['playback_pipeline_start_failed', 'stream_failed']) {
      const error = Object.assign(new Error('pipeline'), { status: 503, code });
      // Still worth trying the next node for this title...
      expect(retryableEndpointFailure(error)).toBe(true);
      // ...but the node itself is fine.
      expect(isPerTitleFailure(error)).toBe(true);
    }
  });

  it('treats a bare 503 as node health, since nothing said otherwise', () => {
    const error = Object.assign(new Error('boom'), { status: 503 });
    expect(isPerTitleFailure(error)).toBe(false);
    expect(retryableEndpointFailure(error)).toBe(true);
  });

  it('treats a 429 admission limit as node capacity, not a per-title fault', () => {
    const error = Object.assign(new Error('limit'), { status: 429, code: 'resource_limit' });
    expect(isPerTitleFailure(error)).toBe(false);
    expect(retryableEndpointFailure(error)).toBe(true);
  });

  it('ignores non-objects and unrelated codes', () => {
    expect(isPerTitleFailure(undefined)).toBe(false);
    expect(isPerTitleFailure('stream_failed')).toBe(false);
    expect(isPerTitleFailure(Object.assign(new Error('x'), { code: 'profile_pending' }))).toBe(false);
  });
});

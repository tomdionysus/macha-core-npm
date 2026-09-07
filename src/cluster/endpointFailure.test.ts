import { describe, expect, it } from 'vitest';
import { endpointFailure, isPerTitleFailure, retryableEndpointFailure } from './endpointFailure.js';

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

  it('stops asking the cluster for a file no node can decode', () => {
    // `source_unsupported` is a fact about the bytes, and every node holds
    // the same bytes. Walking the cluster spends the viewer's time to arrive
    // at the same refusal three times.
    const error = Object.assign(new Error('unsupported'), { status: 500, reason: 'source_unsupported' });
    expect(retryableEndpointFailure(error)).toBe(false);
    expect(isPerTitleFailure(error)).toBe(true);
  });

  it('tries the next node when this one could not read the source', () => {
    for (const reason of ['source_unreadable', 'source_read_timed_out']) {
      const error = Object.assign(new Error('read'), { status: 500, reason });
      expect(retryableEndpointFailure(error)).toBe(true);
      // A bad extent or a slow mount says nothing about the node's ability to
      // serve anything else, so it must not be cooled down for it.
      expect(isPerTitleFailure(error)).toBe(true);
    }
  });

  it('reads the reason through the endpoint wrapper', () => {
    // Routing wraps the original error as `cause`; the reason must survive it
    // or the classification silently reverts to the status.
    const wrapped = endpointFailure('node-a', 'http://node-a.test',
      Object.assign(new Error('unsupported'), { status: 500, reason: 'source_unsupported' }));
    expect(retryableEndpointFailure(wrapped)).toBe(false);
  });

  it('ignores non-objects and unrelated codes', () => {
    expect(isPerTitleFailure(undefined)).toBe(false);
    expect(isPerTitleFailure('stream_failed')).toBe(false);
    expect(isPerTitleFailure(Object.assign(new Error('x'), { code: 'profile_pending' }))).toBe(false);
  });
});

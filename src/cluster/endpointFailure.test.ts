import { describe, expect, it } from 'vitest';
import { endpointFailure, isAccountSessionLimit, isPerTitleFailure, playbackFailureCode, retryableEndpointFailure } from './endpointFailure.js';

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

describe('a refusal about the account, not the node', () => {
  // **A third scope, and core had two.** Server 0.48.0 adds a per-account
  // session cap, because once one bearer can hold several playback sessions
  // nothing else bounds one account. It answers `429 account_session_limit`.
  //
  // `429` is the one 4xx core treats as worth another node, which is right for
  // a node-scoped limit and exactly wrong for an account-scoped one: every
  // node refuses identically, so the walk is guaranteed-futile work on the
  // viewer's critical path - and because the charge is gated on the same
  // answer, core would record a failure against every healthy node it visited.
  //
  // Tolerated before the server ships it, for the same reason as the 410.

  const capRefusal = () => Object.assign(new Error('Macha playback request failed: account at its session limit'), {
    status: 429,
    code: 'account_session_limit',
  });

  it('does not walk the cluster for a refusal every node will repeat', () => {
    expect(retryableEndpointFailure(capRefusal())).toBe(false);
  });

  it('does not charge a healthy node for the account being at its limit', () => {
    // The charge site is `retryableEndpointFailure(e) && !isPerTitleFailure(e)`,
    // so declining to walk is also what declines to charge. Asserted through
    // the predicate that actually gates it rather than assumed from the shape.
    const error = capRefusal();
    expect(retryableEndpointFailure(error) && !isPerTitleFailure(error)).toBe(false);
  });

  it('still walks and charges for a node genuinely at capacity', () => {
    // `resource_limit` is shared by the node-wide session limit and both
    // transcode limits, where the node really is full: walking to the next
    // node is correct and so is recording it. Keeping these apart is the whole
    // point of the new code existing.
    const nodeFull = Object.assign(new Error('resource limit'), { status: 429, code: 'resource_limit' });
    expect(retryableEndpointFailure(nodeFull)).toBe(true);
    expect(isPerTitleFailure(nodeFull)).toBe(false);
  });

  it('leaves a bare 429 alone, because an unlabelled one says nothing about scope', () => {
    expect(retryableEndpointFailure(Object.assign(new Error('slow down'), { status: 429 }))).toBe(true);
  });
});

describe('reading the machine code a host is meant to act on', () => {
  // By the time a create failure reaches PlaybackCoordinatorSnapshot.fatalError
  // the code is two or three links down the cause chain. A host asked what it
  // could render for a cap refusal and the only answers were "the message" or
  // "walk the chain yourself". Both are wrong for the most actionable failure
  // in the system.

  const wrapped = () => {
    const wire = Object.assign(new Error('account at its session limit'), {
      status: 429, code: 'account_session_limit',
    });
    return endpointFailure('node-a', 'http://a', wire);
  };

  it('finds the code through the layers a real failure acquires', () => {
    expect(playbackFailureCode(wrapped())).toBe('account_session_limit');
    expect(isAccountSessionLimit(wrapped())).toBe(true);
  });

  it('survives a chain something upstream made cyclic', () => {
    // A viewer waiting on a hung failure report is strictly worse than one
    // told slightly less - the same rule terminalRecoveryError follows.
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b') as Error & { cause?: unknown };
    a.cause = b; b.cause = a;
    expect(playbackFailureCode(a)).toBeUndefined();
  });

  it('says nothing rather than something when no layer stated a code', () => {
    expect(playbackFailureCode(new Error('no code here'))).toBeUndefined();
    expect(playbackFailureCode(undefined)).toBeUndefined();
    expect(isAccountSessionLimit(new Error('Playback failed'))).toBe(false);
  });

  it('does not mistake a node at capacity for the account being capped', () => {
    const nodeFull = endpointFailure('node-a', 'http://a',
      Object.assign(new Error('resource limit'), { status: 429, code: 'resource_limit' }));
    expect(isAccountSessionLimit(nodeFull)).toBe(false);
    expect(playbackFailureCode(nodeFull)).toBe('resource_limit');
  });
});

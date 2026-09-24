import { describe, expect, it } from 'vitest';
import { MachaPlaybackError } from '../playback/MachaPlaybackResolver.js';
import { endpointFailure, failureBlamesEndpoint, playbackFailureDetail, isAccountSessionLimit, isPerTitleFailure, MachaClusterRouteError, playbackFailureCode, playbackFailureStatus, retryableEndpointFailure, unreachableEndpointFailure } from './endpointFailure.js';

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
  // **The cap is counted per node.** `sessions_held_by_locked` iterates that
  // node's own session map; there is no replication and no cluster-wide total.
  // So a refusal from one node says nothing about the next, and the walk is
  // how a viewer on a cluster with room gets served.
  //
  // Core believed the opposite for a release, because the server's own comment
  // beside the refusal said an account cap "is identical on every node in the
  // cluster" - about a hundred lines from the loop that disproves it. These
  // tests asserted the wrong behaviour confidently, which is why they are
  // written against the two questions separately now.

  const capRefusal = () => Object.assign(new Error('Macha playback request failed: account at its session limit'), {
    status: 429,
    code: 'account_session_limit',
  });

  it('walks the cluster, because the next node counts from its own zero', () => {
    expect(retryableEndpointFailure(capRefusal())).toBe(true);
  });

  it('charges nobody on the way, because a full account is not a sick node', () => {
    // The two questions are asserted apart on purpose: walking and charging
    // were one decision, and correcting the walk would otherwise have dragged
    // the charge onto every healthy node in the cluster.
    const error = capRefusal();
    expect(failureBlamesEndpoint(error)).toBe(false);
    expect(retryableEndpointFailure(error) && failureBlamesEndpoint(error)).toBe(false);
  });

  it('still tells a host what to say to the viewer', () => {
    // Routing changed; the host-facing classification did not. The sentence a
    // viewer can act on is the reason this code is named at all.
    expect(isAccountSessionLimit(capRefusal())).toBe(true);
  });

  it('still walks and charges for a node genuinely at capacity', () => {
    // `resource_limit` is shared by the node-wide session limit and both
    // transcode limits, where the node really is full: walking to the next
    // node is correct and so is recording it. Keeping these apart is the whole
    // point of the new code existing.
    const nodeFull = Object.assign(new Error('resource limit'), { status: 429, code: 'resource_limit' });
    expect(retryableEndpointFailure(nodeFull)).toBe(true);
    expect(failureBlamesEndpoint(nodeFull)).toBe(true);
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

describe('reading the status a host is meant to branch on', () => {
  // `endpointFailure()` wraps the original in a MachaEndpointError carrying
  // neither status nor code of its own, so a caller reading `error.status` off
  // what it caught finds nothing and calls every wrapped refusal fatal. A
  // client hit exactly that, in a classifier written an hour earlier to fix
  // the neighbouring assumption.

  it('finds the status through the wrapper that does not carry one', () => {
    const wrapped = endpointFailure('node-a', 'http://a',
      Object.assign(new Error('bad request'), { status: 400, code: 'bad_playback_request' }));
    // The shape of the bug: the outermost object has neither field.
    expect((wrapped as unknown as { status?: number }).status).toBeUndefined();
    expect(playbackFailureStatus(wrapped)).toBe(400);
    expect(playbackFailureCode(wrapped)).toBe('bad_playback_request');
  });

  it('survives a cyclic chain rather than hanging the failure path', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b') as Error & { cause?: unknown };
    a.cause = b; b.cause = a;
    expect(playbackFailureStatus(a)).toBeUndefined();
  });

  it('says nothing when no layer stated a status', () => {
    expect(playbackFailureStatus(new Error('no status'))).toBeUndefined();
    expect(playbackFailureStatus(undefined)).toBeUndefined();
  });
});

describe('a charge nobody can act on', () => {
  // `update` and `stop` are pinned to the node holding the generation, so
  // there is no walk for a charge to inform. A capacity refusal there is the
  // node saying it is full, not unwell -- and charging it applies an
  // escalating cooldown to a node that is working perfectly.

  const full = () => Object.assign(new Error('video transcode limit reached'), {
    status: 429, code: 'resource_limit',
  });

  it('does not charge a full node on a path that cannot walk away from it', () => {
    expect(failureBlamesEndpoint(full(), { pinned: true })).toBe(false);
  });

  it('still charges the same refusal where a walk can use the answer', () => {
    // Not an inconsistency: on a walking path the charge biases the next
    // attempt away from a node that just said it was full, saving a round
    // trip. The difference is whether anything can use the answer.
    expect(failureBlamesEndpoint(full())).toBe(true);
  });

  it('still charges a pinned node that is actually unwell', () => {
    // The exclusion is capacity, not pinning. A 5xx from the node holding the
    // generation is real health evidence and must survive.
    const broken = Object.assign(new Error('boom'), { status: 503 });
    expect(failureBlamesEndpoint(broken, { pinned: true })).toBe(true);
  });
});

describe('the sentence a viewer can be shown', () => {
  // A playback failure crossing `endpointFailure` produces a `.message` that
  // reads "Macha endpoint http://10.35.1.50:7438 failed: Macha playback
  // request failed: timed out waiting for first fragmented-MP4 segment" --
  // two of core's own envelopes and a node address. Three clients showed
  // exactly that to a viewer today; one had written a loop stripping prefixes
  // until none remained, which is a client matching on core's wording.

  const served = () => new MachaPlaybackError(
    'Macha playback request failed: timed out waiting for first fragmented-MP4 segment',
    503, 'playback_pipeline_start_failed', undefined, undefined,
    'timed out waiting for first fragmented-MP4 segment',
  );

  it('returns the server sentence from under both envelopes', () => {
    const wrapped = endpointFailure('http://10.35.1.50:7438', 'http://10.35.1.50:7438', served());
    expect(wrapped.message).toContain('Macha endpoint');
    expect(wrapped.message).toContain('Macha playback request failed');
    expect(playbackFailureDetail(wrapped)).toBe('timed out waiting for first fragmented-MP4 segment');
  });

  it('carries no node address, which is what a viewer must not be shown', () => {
    const wrapped = endpointFailure('http://10.35.1.50:7438', 'http://10.35.1.50:7438', served());
    expect(playbackFailureDetail(wrapped)).not.toContain('10.35.1.50');
    expect(playbackFailureDetail(wrapped)).not.toContain('Macha');
  });

  it('says nothing rather than handing back a log line', () => {
    // `undefined` means no layer stated a viewer-facing sentence. A host must
    // then write its own, not fall back to `.message`.
    expect(playbackFailureDetail(new Error('boom'))).toBeUndefined();
    expect(playbackFailureDetail(undefined)).toBeUndefined();
  });

  it('survives a cycle in the cause chain', () => {
    const outer = new Error('outer') as Error & { cause?: unknown };
    outer.cause = outer;
    expect(playbackFailureDetail(outer)).toBeUndefined();
  });
});

describe('unreachableEndpointFailure on the error a routed call throws', () => {
  it('reads an exhausted walk by its own unreachable field', () => {
    // An exhausted walk throws MachaClusterRouteError, never a connection
    // error, so a host asking this of a routed failure was always told no
    // (the phone client, 2026-09-24: both offline fallbacks dead in the app).
    expect(unreachableEndpointFailure(new MachaClusterRouteError(['a', 'b'], true))).toBe(true);
    expect(unreachableEndpointFailure(new MachaClusterRouteError(['a', 'b'], false))).toBe(false);
  });
});

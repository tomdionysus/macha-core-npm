import { describe, expect, it } from 'vitest';
import { MEDIA_STALL_TIMEOUT_MS } from './MediaWatchdog.js';
import {
  BROKEN_GENERATION_STATUS,
  playbackFailureKindForStatus,
  SEGMENT_NOT_READY_STATUS,
  SERVER_SEGMENT_HOLD_MS,
  SERVER_SESSION_IDLE_MS,
  SOURCE_NOT_FOUND_STATUS,
} from './streamProtocol.js';

describe('what a status on a fragment request means', () => {
  it('calls a 500 a hold rather than a failure', () => {
    // The node has not produced this fragment yet and is working correctly.
    // Retrying elsewhere cannot help: the next node is producing a different
    // generation and does not have it either.
    expect(playbackFailureKindForStatus(500)).toBe('not-ready');
  });

  it('calls a 503 a broken generation', () => {
    expect(playbackFailureKindForStatus(503)).toBe('stream');
  });

  it('calls a 404 a miss by this node, and not evidence about the node', () => {
    // It used to answer `stream`, which is endpoint evidence — so a node that
    // had merely reaped a paused viewer's session was scored as unhealthy and
    // dropped from the candidate list for answering honestly.
    //
    // `not-found` claims only what happened. Which of the two things it means
    // — a reaped session, or a fragment past the end of the plan — is not
    // decidable from the status, and core asks the session route instead.
    expect(playbackFailureKindForStatus(404)).toBe('not-found');
  });

  it('keeps a hold, a broken generation and a miss on three separate answers', () => {
    // The pairwise statement, because the failure mode each time has been two
    // of them sharing a kind: the hold was `stream` once and cost a healthy
    // node its place, and the miss was `stream` until 2026-09-17 and cost
    // another one the same way.
    const kinds = [
      playbackFailureKindForStatus(SEGMENT_NOT_READY_STATUS),
      playbackFailureKindForStatus(BROKEN_GENERATION_STATUS),
      playbackFailureKindForStatus(SOURCE_NOT_FOUND_STATUS),
    ];
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it('publishes the statuses the rules are written in terms of', () => {
    // An adapter that cannot import these writes its own, and then there are
    // two declarations of one server fact with nothing keeping them level.
    expect(SEGMENT_NOT_READY_STATUS).toBe(500);
    expect(BROKEN_GENERATION_STATUS).toBe(503);
    expect(SOURCE_NOT_FOUND_STATUS).toBe(404);
  });

  it('does not guess at a status it has no rule for', () => {
    // `unknown` is treated as possible endpoint evidence, which is the safe
    // default — better than asserting a meaning this package does not know.
    expect(playbackFailureKindForStatus(418)).toBe('unknown');
    expect(playbackFailureKindForStatus(200)).toBe('unknown');
  });
});

describe('the session idle budget', () => {
  it('leaves the hold well inside it, so waiting out a hold can never reap the session', () => {
    // Both are server defaults a client cannot read at runtime, so this asserts
    // the relation rather than either number — the same discipline the stall
    // budget follows below. A client sitting through a hold is still talking to
    // the node and is not what the reaper is for.
    expect(SERVER_SESSION_IDLE_MS).toBeGreaterThan(SERVER_SEGMENT_HOLD_MS * 100);
  });
});

describe('the stall budget against the server hold', () => {
  it('outlasts the hold, so a node answering as designed is never called stalled', () => {
    // This is the requirement. The figure is a consequence of it, and both
    // have moved before: a five-second budget once sat *under* the hold.
    expect(MEDIA_STALL_TIMEOUT_MS).toBeGreaterThan(SERVER_SEGMENT_HOLD_MS);
  });
});

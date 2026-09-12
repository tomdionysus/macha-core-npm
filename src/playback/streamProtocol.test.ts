import { describe, expect, it } from 'vitest';
import { MEDIA_STALL_TIMEOUT_MS } from './MediaWatchdog.js';
import { playbackFailureKindForStatus, SERVER_SEGMENT_HOLD_MS } from './streamProtocol.js';

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

  it('calls a 404 a real miss, not something to wait for', () => {
    // The mistake a hold-aware caller makes in the other direction: having
    // learned a 5xx can mean "wait", it is easy to sit on one that never comes.
    expect(playbackFailureKindForStatus(404)).toBe('stream');
  });

  it('does not guess at a status it has no rule for', () => {
    // `unknown` is treated as possible endpoint evidence, which is the safe
    // default — better than asserting a meaning this package does not know.
    expect(playbackFailureKindForStatus(418)).toBe('unknown');
    expect(playbackFailureKindForStatus(200)).toBe('unknown');
  });
});

describe('the stall budget against the server hold', () => {
  it('outlasts the hold, so a node answering as designed is never called stalled', () => {
    // This is the requirement. The figure is a consequence of it, and both
    // have moved before: a five-second budget once sat *under* the hold.
    expect(MEDIA_STALL_TIMEOUT_MS).toBeGreaterThan(SERVER_SEGMENT_HOLD_MS);
  });
});

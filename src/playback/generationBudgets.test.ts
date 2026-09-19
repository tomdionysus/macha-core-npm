import { describe, expect, it } from 'vitest';
import { bootstrapEndpoints, EndpointRegistry } from '../cluster/EndpointRegistry.js';
import {
  ENDPOINT_TRANSPORT_ALLOWANCE_MS,
  generationAttemptBudgetMs,
  segmentHoldMs,
} from './PlaybackResolver.js';
import { REPLACEMENT_LEAD_TIME_MS, replacementLeadTimeMs } from './PlaybackCoordinator.js';
import { SERVER_SEGMENT_HOLD_MS, SERVER_STARTUP_TIMEOUT_MS } from './streamProtocol.js';

describe('a node states its own deadlines and core adds only the distance', () => {
  it('uses the stated startup budget rather than the published default', () => {
    expect(generationAttemptBudgetMs({ startupTimeoutMs: 22_000 }))
      .toBe(22_000 + ENDPOINT_TRANSPORT_ALLOWANCE_MS);
  });

  it('honours a node that asks for less, because its own rule is law for it', () => {
    // Not clamped up to the published default. A node entitled to give up
    // after 8 s has said so, and waiting past the point it stops trying buys
    // a viewer nothing but a longer failure.
    expect(generationAttemptBudgetMs({ startupTimeoutMs: 8_000 }))
      .toBe(8_000 + ENDPOINT_TRANSPORT_ALLOWANCE_MS);
  });

  it('falls back to the published default when the node cannot say', () => {
    expect(generationAttemptBudgetMs(undefined))
      .toBe(SERVER_STARTUP_TIMEOUT_MS + ENDPOINT_TRANSPORT_ALLOWANCE_MS);
    expect(generationAttemptBudgetMs({ segmentTimeoutMs: 6_000 }))
      .toBe(SERVER_STARTUP_TIMEOUT_MS + ENDPOINT_TRANSPORT_ALLOWANCE_MS);
  });

  it('never budgets under what a node is entitled to spend', () => {
    // The regression this whole change exists for: a 12,000 literal against a
    // node entitled to 15,000 abandoned a working node three seconds early,
    // every time. The invariant that stops it coming back is that the budget
    // always exceeds the startup entitlement it is bounding, stated or
    // defaulted — never that it beats some previous number.
    expect(generationAttemptBudgetMs(undefined)).toBeGreaterThan(SERVER_STARTUP_TIMEOUT_MS);
    expect(generationAttemptBudgetMs({ startupTimeoutMs: 30_000 })).toBeGreaterThan(30_000);
  });

  it('reports the stated hold without a transport allowance', () => {
    // This one describes the node's behaviour to a host rather than bounding
    // core, so padding it would misreport what the node does.
    expect(segmentHoldMs({ segmentTimeoutMs: 9_000 })).toBe(9_000);
    expect(segmentHoldMs(undefined)).toBe(SERVER_SEGMENT_HOLD_MS);
  });
});

describe('the registry keeps stated deadlines apart from measured load', () => {
  const registry = () => new EndpointRegistry(bootstrapEndpoints(['https://node-a.test']));

  it('answers undefined for a node it has never heard a status call about', () => {
    expect(registry().playbackBudgets('https://node-a.test')).toBeUndefined();
  });

  it('round-trips what a node reported', () => {
    const endpoints = registry();
    endpoints.recordPlaybackBudgets('https://node-a.test', {
      startupTimeoutMs: 15_000,
      segmentTimeoutMs: 6_000,
      observedAt: 1,
    });
    expect(endpoints.playbackBudgets('https://node-a.test'))
      .toMatchObject({ startupTimeoutMs: 15_000, segmentTimeoutMs: 6_000 });
  });

  it('lets a figure disappear when the node stops reporting it', () => {
    // These follow the node's `reconfigure()`. Merging would let a value
    // outlive the configuration that produced it, so a later record that omits
    // a field must clear it rather than preserve the old one.
    const endpoints = registry();
    endpoints.recordPlaybackBudgets('https://node-a.test', {
      startupTimeoutMs: 15_000,
      segmentTimeoutMs: 6_000,
      observedAt: 1,
    });
    endpoints.recordPlaybackBudgets('https://node-a.test', { observedAt: 2 });

    const stated = endpoints.playbackBudgets('https://node-a.test');
    expect(stated?.startupTimeoutMs).toBeUndefined();
    expect(stated?.segmentTimeoutMs).toBeUndefined();
    // And the derivation then falls back rather than reusing the stale figure.
    expect(generationAttemptBudgetMs(stated))
      .toBe(SERVER_STARTUP_TIMEOUT_MS + ENDPOINT_TRANSPORT_ALLOWANCE_MS);
  });

  it('does not conflate stated deadlines with self-reported load', () => {
    const endpoints = registry();
    endpoints.recordCapacity('https://node-a.test', { load1: 2.6, cores: 4, observedAt: 1 });
    expect(endpoints.playbackBudgets('https://node-a.test')).toBeUndefined();
    expect(endpoints.capacity('https://node-a.test')).toMatchObject({ load1: 2.6 });
  });
});

describe('a replacement is never started with less runway than one attempt', () => {
  const attemptMs = generationAttemptBudgetMs({ startupTimeoutMs: 15_000 });

  it('leads by the ceiling on a node with a generous frontier', () => {
    // 32,000 look-ahead less the margin is 28,000, above the ceiling.
    expect(replacementLeadTimeMs(32_000, attemptMs)).toBe(REPLACEMENT_LEAD_TIME_MS);
  });

  it('floors at the attempt budget where the frontier would clamp under it', () => {
    // The latent case: a node configured with four four-second segments has a
    // 16,000 look-ahead, which clamps to 12,000 — less than one attempt. The
    // old clamp returned 12,000 and the replacement could not finish in time.
    expect(replacementLeadTimeMs(16_000, attemptMs)).toBe(attemptMs);
  });

  it('never returns less than one attempt, for any frontier', () => {
    for (const lookAheadMs of [0, 1_000, 8_000, 16_000, 32_000, 120_000]) {
      expect(replacementLeadTimeMs(lookAheadMs, attemptMs)).toBeGreaterThanOrEqual(attemptMs);
    }
  });

  it('holds the floor for direct play and for a node too old to say', () => {
    // `null` is direct play, which has no pipeline and no frontier; undefined
    // is a node predating the field. Neither is a reason to lead by less than
    // an attempt takes.
    expect(replacementLeadTimeMs(null, attemptMs)).toBeGreaterThanOrEqual(attemptMs);
    expect(replacementLeadTimeMs(undefined, attemptMs)).toBeGreaterThanOrEqual(attemptMs);
  });

  it('follows a slow node upwards rather than capping it at the ceiling', () => {
    // A node entitled to 40 s needs a lead longer than the ceiling, or the
    // ceiling reintroduces the same deficit it was just made to prevent.
    const slowNodeMs = generationAttemptBudgetMs({ startupTimeoutMs: 40_000 });
    expect(replacementLeadTimeMs(32_000, slowNodeMs)).toBe(slowNodeMs);
  });
});

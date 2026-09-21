import { describe, expect, it, vi } from 'vitest';
import { EndpointBandwidth } from './EndpointBandwidth.js';
import { memoryStorage } from '../runtime/host.js';
import { clearClientDiagnostics, clientDiagnosticsSnapshot, configureClientDiagnostics } from '../diagnostics/ClientLog.js';
import { bootstrapEndpoints, EndpointRegistry } from './EndpointRegistry.js';

describe('EndpointRegistry', () => {
  it('normalizes and deduplicates bootstrap endpoints without losing order', () => {
    expect(bootstrapEndpoints(['http://node-a/', '', '/', ' http://node-b ', 'http://node-a'])).toEqual([
      { id: 'http://node-a', baseUrl: 'http://node-a', source: 'bootstrap' },
      { id: 'http://node-b', baseUrl: 'http://node-b', source: 'bootstrap' },
    ]);
  });

  it('rejects blank same-origin URLs from endpoint advertisements', () => {
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://seed', '']));
    registry.applyAdvertisement([{ nodeId: 'node-a', apiBaseUrls: ['', '/', 'http://node-a'] }]);
    expect(registry.snapshot().map(({ endpoint }) => endpoint.baseUrl)).toEqual(['http://seed', 'http://node-a']);
  });

  it('keeps the last successful endpoint sticky while it remains healthy', () => {
    let now = 1_000;
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']), () => now);
    registry.recordSuccess('http://b');

    expect(registry.candidates().map((candidate) => candidate.endpoint.id)).toEqual(['http://b', 'http://a']);
    now += 100;
    expect(registry.candidates().map((candidate) => candidate.endpoint.id)).toEqual(['http://b', 'http://a']);
  });

  it('moves a failed endpoint behind ready alternatives and makes it eligible after cooldown', () => {
    let now = 1_000;
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']), () => now);
    registry.recordSuccess('http://a');
    registry.recordFailure('http://a');

    expect(registry.candidates().map((candidate) => candidate.endpoint.id)).toEqual(['http://b', 'http://a']);
    now = 1_501;
    expect(registry.candidates(new Set(['http://b'])).map((candidate) => candidate.endpoint.id)).toEqual(['http://a']);
    registry.recordSuccess('http://a');
    expect(registry.candidates().map((candidate) => candidate.endpoint.id)).toEqual(['http://a', 'http://b']);
  });

  it('returns cooling endpoints in earliest-retry order when every endpoint has failed', () => {
    let now = 1_000;
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']), () => now);
    registry.recordFailure('http://a');
    now = 1_100;
    registry.recordFailure('http://b');

    expect(registry.candidates().map((candidate) => candidate.endpoint.id)).toEqual(['http://a', 'http://b']);
  });

  it('supports excluding an endpoint during one failover attempt', () => {
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
    expect(registry.candidates(new Set(['http://a'])).map((candidate) => candidate.endpoint.id)).toEqual(['http://b']);
  });

  it('retains seeds, groups multiple URLs by node, and refreshes discovered endpoints', () => {
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://seed']));

    registry.applyAdvertisement([
      { nodeId: 'node-a', apiBaseUrls: ['http://seed', 'http://node-a-lan'] },
      { nodeId: 'node-b', apiBaseUrls: ['https://node-b.example'] },
    ]);

    expect(registry.snapshot().map(({ endpoint }) => endpoint)).toEqual([
      { id: 'http://seed', baseUrl: 'http://seed', source: 'bootstrap', nodeId: 'node-a' },
      { id: 'http://node-a-lan', baseUrl: 'http://node-a-lan', source: 'discovered', nodeId: 'node-a' },
      { id: 'https://node-b.example', baseUrl: 'https://node-b.example', source: 'discovered', nodeId: 'node-b' },
    ]);

    registry.applyAdvertisement([
      { nodeId: 'node-a', apiBaseUrls: ['http://seed', 'http://node-a-wan'] },
    ]);

    expect(registry.snapshot().map(({ endpoint }) => endpoint)).toEqual([
      { id: 'http://seed', baseUrl: 'http://seed', source: 'bootstrap', nodeId: 'node-a' },
      { id: 'http://node-a-wan', baseUrl: 'http://node-a-wan', source: 'discovered', nodeId: 'node-a' },
    ]);
  });

  it('notifies client-side status observers when endpoint evidence changes', () => {
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a']));
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);

    registry.recordFailure('http://a');
    registry.recordSuccess('http://a');
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    registry.recordFailure('http://a');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('records probe health without replacing the endpoint preferred by real traffic', () => {
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
    registry.recordSuccess('http://a');
    registry.recordProbeSuccess('http://b');

    expect(registry.candidates().map(({ endpoint }) => endpoint.id)).toEqual(['http://a', 'http://b']);
    expect(registry.snapshot().find(({ endpoint }) => endpoint.id === 'http://b')?.health.lastSuccessAt).toBeDefined();
  });

  it('lets a probe-failed preferred endpoint resume authority once its cooldown lapses, unlike a real failure', () => {
    let now = 1_000;
    const preferredAfterRealFailure = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']), () => now);
    preferredAfterRealFailure.recordSuccess('http://a');
    preferredAfterRealFailure.recordFailure('http://a');
    now = 1_501;
    // A genuine failure permanently gives up authority: once ready again, the
    // never-failed alternative outranks it on failure count, not insertion.
    expect(preferredAfterRealFailure.candidates()[0]?.endpoint.id).toBe('http://b');

    now = 1_000;
    const preferredAfterProbeFailure = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']), () => now);
    preferredAfterProbeFailure.recordSuccess('http://a');
    preferredAfterProbeFailure.recordProbeFailure('http://a');
    // Still cooling down: a ready alternative is tried first either way.
    expect(preferredAfterProbeFailure.candidates()[0]?.endpoint.id).toBe('http://b');
    now = 1_501;
    // But a mere probe blip must not have surrendered authority: once its
    // cooldown lapses, the endpoint real traffic preferred resumes first.
    expect(preferredAfterProbeFailure.candidates()[0]?.endpoint.id).toBe('http://a');
  });

  describe('latency-based pre-emptive authority swap', () => {
    it('does nothing without a sustained-advantage streak across consecutive cycles', () => {
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
      registry.recordSuccess('http://a');
      registry.recordLatency('http://a', 500);
      registry.recordLatency('http://b', 50);

      expect(registry.evaluatePreferredSwap()).toBeUndefined();
      expect(registry.evaluatePreferredSwap()).toBeUndefined();
      expect(registry.candidates()[0]?.endpoint.id).toBe('http://a');
    });

    it('moves authority once the same alternate stays materially faster for three consecutive cycles', () => {
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
      registry.recordSuccess('http://a');
      registry.recordLatency('http://a', 500);
      registry.recordLatency('http://b', 50);

      expect(registry.evaluatePreferredSwap()).toBeUndefined();
      expect(registry.evaluatePreferredSwap()).toBeUndefined();
      expect(registry.evaluatePreferredSwap()).toEqual({
        fromId: 'http://a', toId: 'http://b', fromLatencyMs: 500, toLatencyMs: 50, reason: 'latency',
      });
      expect(registry.candidates()[0]?.endpoint.id).toBe('http://b');
    });

    it('never swaps for an improvement below the absolute or relative threshold', () => {
      const belowAbsolute = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
      belowAbsolute.recordSuccess('http://a');
      belowAbsolute.recordLatency('http://a', 100);
      belowAbsolute.recordLatency('http://b', 1); // >60% faster but well under the 200ms absolute floor
      for (let cycle = 0; cycle < 5; cycle += 1) expect(belowAbsolute.evaluatePreferredSwap()).toBeUndefined();

      const belowRelative = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
      belowRelative.recordSuccess('http://a');
      belowRelative.recordLatency('http://a', 1_000);
      belowRelative.recordLatency('http://b', 850); // 150ms + 15% faster: neither bar cleared
      for (let cycle = 0; cycle < 5; cycle += 1) expect(belowRelative.evaluatePreferredSwap()).toBeUndefined();
    });

    it('resets the advantage streak when the faster candidate changes cycle to cycle', () => {
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b', 'http://c']));
      registry.recordSuccess('http://a');
      registry.recordLatency('http://a', 500);
      registry.recordLatency('http://b', 50);
      expect(registry.evaluatePreferredSwap()).toBeUndefined();

      registry.recordLatency('http://c', 50);
      // A different endpoint takes the "fastest" slot this cycle; the streak must restart.
      registry.recordLatency('http://b', 500);
      expect(registry.evaluatePreferredSwap()).toBeUndefined();
      expect(registry.evaluatePreferredSwap()).toBeUndefined();
      expect(registry.evaluatePreferredSwap()).toBeDefined();
    });

    it('ignores a fast alternate that is still cooling down from a recent failure', () => {
      let now = 1_000;
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']), () => now);
      registry.recordSuccess('http://a');
      registry.recordFailure('http://b');
      registry.recordLatency('http://a', 500);
      registry.recordLatency('http://b', 50);

      for (let cycle = 0; cycle < 5; cycle += 1) expect(registry.evaluatePreferredSwap(now)).toBeUndefined();
      now = 1_501; // http://b's cooldown lapses
      expect(registry.evaluatePreferredSwap(now)).toBeUndefined();
      expect(registry.evaluatePreferredSwap(now)).toBeUndefined();
      expect(registry.evaluatePreferredSwap(now)).toEqual({
        fromId: 'http://a', toId: 'http://b', fromLatencyMs: 500, toLatencyMs: 50, reason: 'latency',
      });
    });

    it('will not swap again until the cooldown after a swap lapses', () => {
      let now = 1_000;
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b', 'http://c']), () => now);
      registry.recordSuccess('http://a');
      registry.recordLatency('http://a', 1_000);
      registry.recordLatency('http://b', 500);
      for (let cycle = 0; cycle < 2; cycle += 1) registry.evaluatePreferredSwap(now);
      expect(registry.evaluatePreferredSwap(now)).toEqual(expect.objectContaining({ toId: 'http://b' }));

      // http://c now looks even faster than the newly preferred http://b, but
      // the post-swap cooldown must hold regardless of streak length.
      registry.recordLatency('http://c', 200);
      for (let cycle = 0; cycle < 5; cycle += 1) expect(registry.evaluatePreferredSwap(now)).toBeUndefined();

      now += 60_000; // the post-swap cooldown
      for (let cycle = 0; cycle < 2; cycle += 1) expect(registry.evaluatePreferredSwap(now)).toBeUndefined();
      expect(registry.evaluatePreferredSwap(now)).toEqual(expect.objectContaining({ fromId: 'http://b', toId: 'http://c' }));
    });

    it('never swaps before the preferred endpoint has its own latency sample', () => {
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
      registry.recordSuccess('http://a');
      registry.recordLatency('http://b', 50);

      for (let cycle = 0; cycle < 5; cycle += 1) expect(registry.evaluatePreferredSwap()).toBeUndefined();
    });

    it('averages latency over a bounded rolling window', () => {
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://a']));
      for (const sample of [100, 100, 100, 100, 100, 500]) registry.recordLatency('http://a', sample);
      // The oldest 100ms sample has rolled off a five-sample window.
      expect(registry.latencyMs('http://a')).toBe((100 + 100 + 100 + 100 + 500) / 5);
    });
  });

  describe('measured throughput', () => {
    /**
     * The cluster this client is developed against is deliberately not
     * uniform: one node is wired, one is behind a flaky wireless hop, and one
     * is across a WAN. Round-trip time alone ranks those wrongly often enough
     * to matter, so throughput has to be able to overrule it.
     */
    function withBandwidth(urls: readonly string[], samples: Record<string, [bytes: number, ms: number]>) {
      const bandwidth = new EndpointBandwidth('client-1', undefined, () => 0);
      for (const [id, [bytes, ms]] of Object.entries(samples)) {
        // Two transfers each: one sample is not yet evidence.
        bandwidth.record(id, bytes, ms);
        bandwidth.record(id, bytes, ms);
      }
      const registry = new EndpointRegistry(bootstrapEndpoints(urls), () => 0);
      registry.attachBandwidth(bandwidth);
      return registry;
    }

    it('orders a materially faster link ahead of the order it was configured in', () => {
      const registry = withBandwidth(['http://slow', 'http://fast'], {
        'http://slow': [1_000_000, 4_000],
        'http://fast': [1_000_000, 500],
      });

      expect(registry.candidates().map(({ endpoint }) => endpoint.id)).toEqual(['http://fast', 'http://slow']);
    });

    it('leaves configured order alone when the difference is small or the evidence is thin', () => {
      const comparable = withBandwidth(['http://a', 'http://b'], {
        'http://a': [1_000_000, 1_000],
        'http://b': [1_000_000, 900],
      });
      expect(comparable.candidates().map(({ endpoint }) => endpoint.id)).toEqual(['http://a', 'http://b']);

      const bandwidth = new EndpointBandwidth('client-1', undefined, () => 0);
      bandwidth.record('http://b', 1_000_000, 100);
      const oneSample = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']), () => 0);
      oneSample.attachBandwidth(bandwidth);
      expect(oneSample.candidates().map(({ endpoint }) => endpoint.id)).toEqual(['http://a', 'http://b']);
    });

    it('never promotes throughput above health: a failing fast link still sorts last', () => {
      const registry = withBandwidth(['http://slow', 'http://fast'], {
        'http://slow': [1_000_000, 4_000],
        'http://fast': [1_000_000, 500],
      });
      registry.recordFailure('http://fast');

      expect(registry.candidates()[0].endpoint.id).toBe('http://slow');
    });

    it('refuses a latency swap onto a link that measurably cannot carry as much', () => {
      // The wireless node answers probes promptly and streams badly. This is
      // the case latency-only selection gets exactly wrong.
      const registry = withBandwidth(['http://wired', 'http://wireless'], {
        'http://wired': [1_000_000, 1_000],
        'http://wireless': [1_000_000, 8_000],
      });
      registry.recordSuccess('http://wired');
      registry.recordLatency('http://wired', 500);
      registry.recordLatency('http://wireless', 20);

      for (let cycle = 0; cycle < 5; cycle += 1) expect(registry.evaluatePreferredSwap()).toBeUndefined();
    });

    it('swaps for a materially fatter pipe even when the round trip is no better', () => {
      const registry = withBandwidth(['http://near', 'http://fat'], {
        'http://near': [1_000_000, 8_000],
        'http://fat': [1_000_000, 1_000],
      });
      registry.recordSuccess('http://near');
      registry.recordLatency('http://near', 40);
      registry.recordLatency('http://fat', 60);

      expect(registry.evaluatePreferredSwap()).toBeUndefined();
      expect(registry.evaluatePreferredSwap()).toBeUndefined();
      expect(registry.evaluatePreferredSwap()).toEqual(expect.objectContaining({
        fromId: 'http://near', toId: 'http://fat', reason: 'throughput',
      }));
    });

    it('will not chase a fatter pipe whose round trip has collapsed in exchange', () => {
      const registry = withBandwidth(['http://near', 'http://distant'], {
        'http://near': [1_000_000, 8_000],
        'http://distant': [1_000_000, 1_000],
      });
      registry.recordSuccess('http://near');
      registry.recordLatency('http://near', 40);
      registry.recordLatency('http://distant', 900);

      for (let cycle = 0; cycle < 5; cycle += 1) expect(registry.evaluatePreferredSwap()).toBeUndefined();
    });

    it('drops throughput estimates for endpoints that leave the configuration', () => {
      const registry = withBandwidth(['http://a', 'http://b'], {
        'http://a': [1_000_000, 1_000],
        'http://b': [1_000_000, 1_000],
      });
      expect(registry.bytesPerSecond('http://b')).toBeDefined();

      registry.replace(bootstrapEndpoints(['http://a']));

      expect(registry.bytesPerSecond('http://b')).toBeUndefined();
    });
  });

  describe('ranking on measured evidence rather than configured order', () => {
    // The afternoon this exists to prevent: with no throughput samples for
    // anyone, `candidates()` fell straight through to the order the endpoints
    // were typed into `.env`, and every playback session went to the flaky
    // wireless node because it happened to be listed first.
    const ids = (registry: EndpointRegistry) => registry.candidates().map((candidate) => candidate.endpoint.id);

    it('prefers the nearer endpoint when nothing has throughput evidence yet', () => {
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://wireless', 'http://wired']));
      registry.recordLatency('http://wireless', 400);
      registry.recordLatency('http://wired', 20);

      expect(ids(registry)).toEqual(['http://wired', 'http://wireless']);
      expect(registry.selectionAxis()).toBe('latency');
    });

    it('does not reshuffle two endpoints a few milliseconds apart', () => {
      // Both a ratio and an absolute floor: 3 ms against 5 ms is a 40%
      // "difference" that no viewer can perceive and that would trade places
      // every probe cycle.
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
      registry.recordLatency('http://a', 5);
      registry.recordLatency('http://b', 3);

      expect(ids(registry)).toEqual(['http://a', 'http://b']);
      expect(registry.selectionAxis()).toBe('configured-order');
    });

    it('ranks on reported load when latency cannot separate two endpoints', () => {
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://busy', 'http://idle']));
      registry.recordLatency('http://busy', 20);
      registry.recordLatency('http://idle', 21);
      registry.recordCapacity('http://busy', { load1: 8, cores: 4, observedAt: 1 });
      registry.recordCapacity('http://idle', { load1: 1, cores: 4, observedAt: 1 });

      expect(ids(registry)).toEqual(['http://idle', 'http://busy']);
      expect(registry.selectionAxis()).toBe('capacity');
    });

    it('compares load per core rather than raw load', () => {
      // 2.67 is a struggling two-core box and an idle eight-core one. Ranking
      // the raw numbers would put the big machine last for being big.
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://small', 'http://large']));
      registry.recordCapacity('http://small', { load1: 2.67, cores: 2, observedAt: 1 });
      registry.recordCapacity('http://large', { load1: 4, cores: 16, observedAt: 1 });

      expect(ids(registry)).toEqual(['http://large', 'http://small']);
      expect(registry.selectionAxis()).toBe('capacity');
    });

    it('abstains from the capacity axis entirely when no core count was reported', () => {
      // A comparison between machines of unknown and probably different size
      // is not a comparison. Falling back to configured order is honest;
      // ranking the raw numbers would be confidently wrong on every cycle.
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
      registry.recordCapacity('http://a', { load1: 9, observedAt: 1 });
      registry.recordCapacity('http://b', { load1: 1, observedAt: 1 });

      expect(ids(registry)).toEqual(['http://a', 'http://b']);
      expect(registry.selectionAxis()).toBe('configured-order');
    });

    it('does not let a small load difference move anything', () => {
      // Capacity responds to our own routing — send work, load rises, node
      // demoted, work leaves, load falls, node promoted. The minimum relative
      // difference is the damping on that loop.
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
      registry.recordCapacity('http://a', { load1: 2.0, cores: 4, observedAt: 1 });
      registry.recordCapacity('http://b', { load1: 1.7, cores: 4, observedAt: 1 });

      expect(ids(registry)).toEqual(['http://a', 'http://b']);
      expect(registry.selectionAxis()).toBe('configured-order');
    });

    it('keeps the sticky endpoint above every measured axis', () => {
      // Authority must not move because a number wobbled; `evaluatePreferredSwap`
      // owns that decision, with its own streak and cooldown.
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
      registry.recordSuccess('http://a');
      registry.recordLatency('http://a', 400);
      registry.recordLatency('http://b', 20);
      registry.recordCapacity('http://a', { load1: 8, cores: 4, observedAt: 1 });
      registry.recordCapacity('http://b', { load1: 1, cores: 4, observedAt: 1 });

      expect(ids(registry)).toEqual(['http://a', 'http://b']);
      expect(registry.selectionAxis()).toBe('sticky');
    });

    it('publishes the evidence behind the ordering, absent where it has none', () => {
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
      registry.recordLatency('http://a', 30);
      registry.recordCapacity('http://a', { load1: 1, cores: 4, cpuPercent: 25, observedAt: 7 });

      const [a, b] = registry.snapshot();
      expect(a.latencyMs).toBe(30);
      expect(a.capacity).toEqual({ load1: 1, cores: 4, cpuPercent: 25, observedAt: 7 });
      // A node that has never answered has no evidence, and absent must stay
      // distinguishable from zero.
      expect(b.latencyMs).toBeUndefined();
      expect(b.capacity).toBeUndefined();
      expect(b.bytesPerSecond).toBeUndefined();
    });
  });

  describe('three endpoints, where a pairwise threshold stops being an order', () => {
    // Every other ranking test above uses two endpoints, which is exactly why
    // this was invisible: a threshold compared pairwise is only an order when
    // there is one pair. At three it is not transitive, and `sort` handed a
    // cycle produces whatever its implementation happens to produce.
    const ids = (registry: EndpointRegistry) => registry.candidates().map((candidate) => candidate.endpoint.id);

    const configured = (order: readonly string[], latencies: Record<string, number>) => {
      const registry = new EndpointRegistry(bootstrapEndpoints([...order]));
      for (const [id, latencyMs] of Object.entries(latencies)) registry.recordLatency(id, latencyMs);
      return registry;
    };

    it('never puts the furthest node at the head because of the order the three were typed in', () => {
      // 20/65/110 ms against a 50 ms floor: wired ties wireless and wireless
      // ties wan, while wired beats wan. Pairwise, that is a cycle — and the
      // measured evidence below is the case that was reproduced: typing the
      // same three nodes in a different order moved the WAN node to the head,
      // where `selectionAxis()` then reported that nothing had decided it.
      const latencies = { 'http://wired': 20, 'http://wireless': 65, 'http://wan': 110 };
      const first = configured(['http://wan', 'http://wireless', 'http://wired'], latencies);
      const second = configured(['http://wan', 'http://wired', 'http://wireless'], latencies);

      expect(ids(first)).toEqual(['http://wireless', 'http://wired', 'http://wan']);
      expect(ids(second)).toEqual(['http://wired', 'http://wireless', 'http://wan']);
      // Which of the two near nodes leads does depend on configured order,
      // because 45 ms apart is below the floor that says they differ at all —
      // and that is what the axis reports. The WAN node loses in both.
      expect(first.selectionAxis()).toBe('configured-order');
      expect(second.selectionAxis()).toBe('configured-order');
    });

    it('picks the same head, on the same axis, whichever order the same three are configured in', () => {
      const latencies = { 'http://wired': 20, 'http://wireless': 300, 'http://wan': 310 };
      const first = configured(['http://wan', 'http://wireless', 'http://wired'], latencies);
      const second = configured(['http://wired', 'http://wan', 'http://wireless'], latencies);

      for (const registry of [first, second]) {
        expect(ids(registry)[0]).toBe('http://wired');
        expect(registry.selectionAxis()).toBe('latency');
      }
    });

    it('orders what it eliminated rather than treating it as one undifferentiated tail', () => {
      // The list is walked to the end on failover, so second-worst against
      // worst is a real question. Configured in reverse to prove the ordering
      // is the evidence rather than the typing.
      const registry = configured(['http://slow', 'http://mid', 'http://fast'], {
        'http://fast': 20, 'http://mid': 300, 'http://slow': 1_000,
      });

      expect(ids(registry)).toEqual(['http://fast', 'http://mid', 'http://slow']);
      expect(registry.selectionAxis()).toBe('latency');
    });

    it('never lets an endpoint that is out of contention eliminate one that is not', () => {
      // The best is taken within the surviving pool, never globally. A node
      // in a failure cooldown with the fastest link must not rank the two
      // healthy ones behind it on evidence it is in no position to offer.
      const now = 1_000;
      const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b', 'http://dead']), () => now);
      registry.recordLatency('http://a', 200);
      registry.recordLatency('http://b', 210);
      registry.recordLatency('http://dead', 10);
      registry.recordFailure('http://dead');

      expect(ids(registry)).toEqual(['http://a', 'http://b', 'http://dead']);
      expect(registry.selectionAxis()).toBe('configured-order');
    });
  });
});

describe('throughput: attaching, recording and abstaining', () => {
  /**
   * Two `EndpointBandwidth` instances for one client serialise the same record
   * map to `macha-client-bandwidth:<clientId>` and clobber each other. Core
   * attaches one so a host need not wire anything; a host that already
   * supplies its own must keep it. Both clients that wire theirs by hand did
   * so against published `0.11.1`, so this is live, not hypothetical.
   */
  it('keeps the first store when attached again, as a services rebuild will', () => {
    const hostStore = new EndpointBandwidth('client-42', memoryStorage());
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a.test']));
    expect(registry.attachBandwidth(hostStore)).toBe(true);

    expect(registry.attachBandwidth(new EndpointBandwidth('client-42', memoryStorage()))).toBe(false);

    registry.recordTransferByUrl('http://a.test/api/v1/users', 4_000_000, 1_000);
    expect(hostStore.samples(bootstrapEndpoints(['http://a.test'])[0]!.id)).toBe(1);
  });

  it('reports whether a store is attached, so the composition root can tell', () => {
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a.test']));

    expect(registry.throughputRecordable).toBe(false);
    expect(registry.attachBandwidth(new EndpointBandwidth('client-42', memoryStorage()))).toBe(true);
    expect(registry.throughputRecordable).toBe(true);
  });

  it('resolves the endpoint from the URL, so no host has to write that match', () => {
    const store = new EndpointBandwidth('client-42', memoryStorage());
    const endpoints = bootstrapEndpoints(['http://a.test', 'http://b.test']);
    const registry = new EndpointRegistry(endpoints);
    registry.attachBandwidth(store);

    registry.recordTransferByUrl('http://b.test/api/v1/catalogue/items', 4_000_000, 1_000);

    expect(store.samples(endpoints[1]!.id)).toBe(1);
    expect(store.samples(endpoints[0]!.id)).toBe(0);
  });

  it('ignores a transfer from a URL that is not one of its endpoints', () => {
    const store = new EndpointBandwidth('client-42', memoryStorage());
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a.test']));
    registry.attachBandwidth(store);

    registry.recordTransferByUrl('http://elsewhere.test/thing', 4_000_000, 1_000);

    expect(store.samples(bootstrapEndpoints(['http://a.test'])[0]!.id)).toBe(0);
  });

  /**
   * `configured-order` used to cover two different situations: every axis was
   * consulted and none separated the endpoints, or the primary axis had no
   * data to consult at all. Throughput is the one that goes missing silently.
   */
  it('says so when configuration order decided and throughput could not be consulted', () => {
    clearClientDiagnostics();
    configureClientDiagnostics({ level: 'debug', console: false, maxEntries: 100 });
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a.test', 'http://b.test']));

    registry.candidates();

    const warned = clientDiagnosticsSnapshot().filter((entry) => entry.event === 'throughput-unavailable');
    expect(warned).toHaveLength(1);
    expect(warned[0]?.data).toMatchObject({ reason: 'no-bandwidth-store' });
  });

  it('reports the abstention once, not on every probe cycle', () => {
    clearClientDiagnostics();
    configureClientDiagnostics({ level: 'debug', console: false, maxEntries: 100 });
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a.test', 'http://b.test']));

    for (let cycle = 0; cycle < 20; cycle += 1) registry.candidates();

    expect(clientDiagnosticsSnapshot().filter((entry) => entry.event === 'throughput-unavailable')).toHaveLength(1);
  });
});

describe('preference without evidence', () => {
  // A viewer choosing a node is a routing instruction, not a round trip. The
  // only public door used to be `recordSuccess`, which writes both -- so the
  // choice arrived on the Status screen as a `lastSuccessAt` that never
  // happened and a failure count reset that nothing earned.

  it('moves the sticky endpoint without touching the health record', () => {
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
    registry.recordFailure('http://b');
    expect(registry.snapshot().find((e) => e.endpoint.id === 'http://b')?.health.consecutiveFailures).toBe(1);

    registry.prefer('http://b');

    const b = registry.snapshot().find((e) => e.endpoint.id === 'http://b');
    expect(b?.health.consecutiveFailures).toBe(1);
    expect(b?.health.lastSuccessAt).toBeUndefined();
  });

  it('actually moves the chosen endpoint to the front of the candidate list', () => {
    // Asserted through `candidates()`, which is the ranked list routing reads.
    // `snapshot()` is not ranked -- it reports health in configured order, and
    // asserting preference through it passes whatever the preference is.
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
    expect(registry.candidates().map((e) => e.endpoint.id)).toEqual(['http://a', 'http://b']);

    registry.prefer('http://b');

    expect(registry.candidates().map((e) => e.endpoint.id)).toEqual(['http://b', 'http://a']);
  });

  it('does not let a choice outrank readiness', () => {
    // The chosen node is cooling down, so it must still rank below one that
    // can serve. A preference is a tie-break among usable nodes, never an
    // instruction to use an unusable one -- otherwise picking a node in a UI
    // would defeat the failover that exists to route around it.
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
    registry.recordFailure('http://b');
    registry.prefer('http://b');
    expect(registry.candidates()[0].endpoint.id).toBe('http://a');
  });

  it('ignores an endpoint it has never heard of, keeping the choice it has', () => {
    // Weaker forms of this pass for the wrong reason. The assertion is that
    // the existing preference survives: a routing instruction for an endpoint
    // that never existed can never match and never expire, so storing it would
    // silently discard a real choice.
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a', 'http://b']));
    registry.prefer('http://b');
    expect(registry.candidates()[0].endpoint.id).toBe('http://b');

    registry.prefer('http://nowhere');
    expect(registry.candidates()[0].endpoint.id).toBe('http://b');
  });
});

describe('one node reached by two spellings of one address', () => {
  // `normalizeBaseUrl` only trims trailing slashes, so `https://node` and
  // `https://node:443` are two keys for one address. An endpoint configured as
  // one and advertised as the other kept no `nodeId` at all, and anything
  // grouping by node counted one machine twice.

  it('attaches a node id across an implicit default port', () => {
    const registry = new EndpointRegistry(bootstrapEndpoints(['https://macnessa.macha.network']));
    registry.applyAdvertisement([{ nodeId: 'gbni-1', apiBaseUrls: ['https://macnessa.macha.network:443'] }]);
    expect(registry.candidates()[0].endpoint.nodeId).toBe('gbni-1');
  });

  it('attaches it the other way round, and on a differing host case', () => {
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://Node-A:80']));
    registry.applyAdvertisement([{ nodeId: 'fi-1', apiBaseUrls: ['http://node-a'] }]);
    expect(registry.candidates()[0].endpoint.nodeId).toBe('fi-1');
  });

  it('mints nothing for the spelling it matched by', () => {
    // The dangerous half. A matched advertisement must not also arrive as a
    // discovered endpoint under its other spelling -- that is how a client
    // ends up holding a plaintext address for a node behind TLS.
    const registry = new EndpointRegistry(bootstrapEndpoints(['https://macnessa.macha.network']));
    registry.applyAdvertisement([{ nodeId: 'gbni-1', apiBaseUrls: ['https://macnessa.macha.network:443'] }]);
    expect(registry.candidates()).toHaveLength(1);
  });

  it('still discovers a genuinely different address', () => {
    // Authority matching must not swallow a real second node.
    const registry = new EndpointRegistry(bootstrapEndpoints(['https://macnessa.macha.network']));
    registry.applyAdvertisement([{ nodeId: 'es-1', apiBaseUrls: ['https://ramaroja.macha.network'] }]);
    expect(registry.candidates()).toHaveLength(2);
  });

  it('does not claim two different hosts are one node', () => {
    // The case core cannot solve: a LAN address and a DNS name for the same
    // machine share no authority, and nothing in a status payload says which
    // node answered it. Guessing here would merge two real nodes.
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://10.44.1.50:7438']));
    registry.applyAdvertisement([{ nodeId: 'gbni-1', apiBaseUrls: ['https://macnessa.macha.network'] }]);
    const lan = registry.candidates().find((entry) => entry.endpoint.baseUrl === 'http://10.44.1.50:7438');
    expect(lan?.endpoint.nodeId).toBeUndefined();
  });
});

describe('learning an identity must not restate membership', () => {
  // `applyAdvertisement` states the whole of membership and drops whatever it
  // is not told about, which is right for a fresh cluster view and catastrophic
  // for a partial one. Announcing a single identified address through it
  // deleted every discovered endpoint beside it -- a three-node cluster
  // collapsing to one, and anything keyed to the endpoints that vanished going
  // with them.

  const threeNodes = () => {
    const registry = new EndpointRegistry(bootstrapEndpoints(['http://a']));
    registry.applyAdvertisement([
      { nodeId: 'n-a', apiBaseUrls: ['http://a'] },
      { nodeId: 'n-b', apiBaseUrls: ['http://b'] },
      { nodeId: 'n-c', apiBaseUrls: ['http://c'] },
    ]);
    return registry;
  };

  it('keeps every other endpoint when one names itself', () => {
    const registry = threeNodes();
    expect(registry.candidates()).toHaveLength(3);

    registry.claimNodeId('http://b', 'gbni-1');

    expect(registry.candidates().map((e) => e.endpoint.id).sort()).toEqual(['http://a', 'http://b', 'http://c']);
    expect(registry.candidates().find((e) => e.endpoint.id === 'http://b')?.endpoint.nodeId).toBe('gbni-1');
  });

  it('is the difference: the membership call would have dropped them', () => {
    // Pinned so the two are never confused again.
    const registry = threeNodes();
    registry.applyAdvertisement([{ nodeId: 'n-a', apiBaseUrls: ['http://a'] }]);
    expect(registry.candidates()).toHaveLength(1);
  });

  it('claims by authority, and does nothing for an address it does not hold', () => {
    const registry = new EndpointRegistry(bootstrapEndpoints(['https://macnessa.macha.network']));
    registry.claimNodeId('https://macnessa.macha.network:443', 'gbni-1');
    expect(registry.candidates()[0].endpoint.nodeId).toBe('gbni-1');

    registry.claimNodeId('http://nowhere', 'ghost');
    expect(registry.candidates()).toHaveLength(1);
    expect(registry.candidates()[0].endpoint.nodeId).toBe('gbni-1');
  });
});

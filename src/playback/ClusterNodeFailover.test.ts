import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaybackSourceError } from '../platform/Platform.js';
import type { MediaSummary, PlaybackCapabilities } from '../types.js';
import { createFakeCluster } from '../test/fakeCluster.js';
import { createFakePlayer } from '../testing/index.js';
import { PlaybackCoordinator } from './PlaybackCoordinator.js';

/**
 * Full-stack node-failover coverage: the real `PlaybackCoordinator`, the real
 * `ClusterPlaybackResolver`/`EndpointRegistry`, and a stubbed `fetch` talking
 * to two independently scripted fake nodes. Unlike `PlaybackCoordinator.test.ts`
 * (which fakes the resolver itself) or `ClusterPlaybackResolver.test.ts`
 * (which never drives a coordinator/player), this proves the pieces actually
 * wire together: node A can fail at request creation, at a live stream, or
 * mid-standby-preparation, and the client recovers on node B without a route
 * change or global browser event. Segment/range-load failover for Direct Play
 * has its own equally deterministic two-node fixture in
 * tests/directPlayReadAheadServiceWorker.test.ts.
 */

const media: MediaSummary = { id: 'macha:movie:1', kind: 'movie', title: 'Movie', mediaIds: ['macha:media'], durationMs: 600_000 };
const capabilities: PlaybackCapabilities = {
  platform: 'web', videoCodecs: ['h264'], audioCodecs: ['aac'], containers: ['mp4'], hlsFmp4: true, dash: false, hdr: [],
};

describe('Cluster node failover integration', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('creates the initial generation on the surviving node after request-creation failure', async () => {
    const cluster = createFakeCluster(['http://node-a', 'http://node-b']);
    cluster.node('http://node-a').queueNetworkFailure('node A unreachable');
    cluster.node('http://node-b').queueSession('session-b');
    const player = createFakePlayer();
    const coordinator = new PlaybackCoordinator({
      media, player, resolver: cluster.resolver, capabilities: async () => capabilities, initialPositionMs: 0,
    });

    await coordinator.start();

    expect(player.playCalls.at(-1)?.source.url).toBe('http://node-b/api/v1/playback/stream/session-b');
    expect(coordinator.getSnapshot().session?.endpoint?.id).toBe('http://node-b');
    expect(cluster.calls.map((call) => call.url.split('?')[0])).toEqual([
      'http://node-a/api/v1/playback/sessions',
      'http://node-b/api/v1/playback/sessions',
    ]);
  });

  it('creates the initial HLS generation on the surviving node after request-creation failure', async () => {
    // The candidate loop in ClusterPlaybackResolver.create() decides nothing
    // about mode — this proves that explicitly rather than only implying it
    // from the Direct Play case above.
    const cluster = createFakeCluster(['http://node-a', 'http://node-b']);
    cluster.node('http://node-a').queueNetworkFailure('node A unreachable');
    cluster.node('http://node-b').queueSession('session-b', { mode: 'remux' });
    const player = createFakePlayer();
    const coordinator = new PlaybackCoordinator({
      media, player, resolver: cluster.resolver, capabilities: async () => capabilities, initialPositionMs: 0,
    });

    await coordinator.start();

    expect(player.playCalls.at(-1)?.source.url).toBe('http://node-b/api/v1/playback/stream/session-b/index.m3u8');
    expect(coordinator.getSnapshot().session?.endpoint?.id).toBe('http://node-b');
    expect(cluster.calls.map((call) => call.url.split('?')[0])).toEqual([
      'http://node-a/api/v1/playback/sessions',
      'http://node-b/api/v1/playback/sessions',
    ]);
  });

  it('recreates a failed live generation on the surviving node and closes the failed lease as it abandons it', async () => {
    const cluster = createFakeCluster(['http://node-a', 'http://node-b']);
    cluster.node('http://node-a').queueSession('session-a');
    cluster.node('http://node-b').queueSession('session-b');
    cluster.node('http://node-a').queueStatus(204); // late best-effort DELETE of the failed lease
    const player = createFakePlayer();
    const coordinator = new PlaybackCoordinator({
      media, player, resolver: cluster.resolver, capabilities: async () => capabilities, initialPositionMs: 0,
    });
    await coordinator.start();
    expect(player.playCalls.at(-1)?.source.url).toContain('node-a');

    player.emit({ positionMs: 0, durationMs: 600_000, paused: false, ended: false });
    player.fail(new Error('node A stream failed'));

    await vi.waitFor(() => expect(player.playCalls.at(-1)?.source.url).toBe('http://node-b/api/v1/playback/stream/session-b'));
    expect(coordinator.getSnapshot().fatalError).toBeUndefined();

    // Closed as it is abandoned, inside failover(), with no buffered evidence
    // on the replacement asked for first. That is the whole policy: the
    // resolver is the only layer every client passes through, and a node
    // holds a transcode slot against `max_video_transcodes` from admission
    // until the record is erased — `session_idle`, thirty minutes.
    await vi.waitFor(() => expect(cluster.calls).toContainEqual({ url: 'http://node-a/api/v1/playback/sessions/session-a', method: 'DELETE' }));
    await coordinator.close();
  });

  it('does not go terminal when the dying source emits a second failure mid-failover', async () => {
    // A node going down is not one event. The fatal error starts recovery,
    // and the element then plays out whatever it had buffered and reports
    // `ended` well short of duration — a premature end, correctly read as a
    // second failure from the same source, arriving while the replacement
    // POST is still in flight. Taken terminal it closes the coordinator, and
    // the replacement that was seconds from ready is discarded by the
    // disposed path: the viewer gets the fatal screen with a working node
    // already waiting.
    const cluster = createFakeCluster(['http://node-a', 'http://node-b']);
    cluster.node('http://node-a').queueSession('session-a');
    cluster.node('http://node-b').queueSession('session-b');
    cluster.node('http://node-a').queueStatus(204); // late best-effort DELETE of the failed lease
    const player = createFakePlayer();
    const coordinator = new PlaybackCoordinator({
      media, player, resolver: cluster.resolver, capabilities: async () => capabilities, initialPositionMs: 0,
    });
    await coordinator.start();

    player.emit({ positionMs: 4_000, durationMs: 600_000, paused: false, ended: false });
    player.fail(new PlaybackSourceError('node A stream failed', 'stream'));
    // Same tick, before the admission on node B can answer: the buffered tail
    // runs out and the element says it finished.
    player.emit({ positionMs: 4_500, durationMs: 600_000, paused: false, ended: true });

    await vi.waitFor(() => expect(player.playCalls.at(-1)?.source.url).toBe('http://node-b/api/v1/playback/stream/session-b'));
    expect(coordinator.getSnapshot().fatalError).toBeUndefined();
    await coordinator.close();
  });

  it('prepares an HLS standby on the surviving node and promotes it without a second admission', async () => {
    const cluster = createFakeCluster(['http://node-a', 'http://node-b']);
    cluster.node('http://node-a').queueSession('session-a', { mode: 'remux' });
    cluster.node('http://node-b').queueSession('session-b', { mode: 'remux' });
    const player = createFakePlayer();
    const coordinator = new PlaybackCoordinator({
      media, player, resolver: cluster.resolver, capabilities: async () => capabilities, initialPositionMs: 0,
    });
    await coordinator.start();
    expect(player.playCalls.at(-1)?.source.url).toBe('http://node-a/api/v1/playback/stream/session-a/index.m3u8');

    player.degrade(new PlaybackSourceError('primary HLS network degraded', 'stream'));
    await vi.waitFor(() => expect(player.preflightCalls.at(-1)?.url).toBe('http://node-b/api/v1/playback/stream/session-b/index.m3u8'));

    player.fail(new PlaybackSourceError('primary HLS network exhausted', 'stream'));

    await vi.waitFor(() => expect(player.playCalls.at(-1)?.source.url).toBe('http://node-b/api/v1/playback/stream/session-b/index.m3u8'));
    expect(coordinator.getSnapshot().fatalError).toBeUndefined();
    // The standby was already admitted during preparation; promotion must not
    // negotiate a third session.
    expect(cluster.calls.filter((call) => call.method === 'POST')).toHaveLength(2);
  });
});

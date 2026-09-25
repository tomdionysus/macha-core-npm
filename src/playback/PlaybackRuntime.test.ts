import { describe, expect, it, vi } from 'vitest';
import type { Platform, Player } from '../platform/Platform.js';
import type { MediaSummary, MediaTechnicalProfile, PlaybackCapabilities, PlaybackSource } from '../types.js';
import type { PlaybackPreferencesUpdate, PlaybackResolver, PlaybackSession, PlaybackStopOptions, PlaybackUpdate } from './PlaybackResolver.js';
import { PlaybackRuntime } from './PlaybackRuntime.js';
import { NOT_PLAYABLE_CODE } from './PlaybackRuntime.js';
import { FakePlayer } from '../testing/FakePlayer.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function movie(id: string): MediaSummary {
  return { id, kind: 'movie', title: id, mediaIds: [`file:${id}`], durationMs: 600_000 };
}

function capabilities(): PlaybackCapabilities {
  return {
    platform: 'web',
    videoCodecs: ['h264'],
    audioCodecs: ['aac'],
    containers: ['mp4'],
    hlsFmp4: true,
    dash: false,
    hdr: [],
  };
}

function session(media: MediaSummary, sessionId = `session:${media.id}`): PlaybackSession {
  const source: PlaybackSource = {
    mediaId: media.mediaIds[0] ?? media.id,
    url: `/stream/${sessionId}`,
    mimeType: 'video/mp4', isManifest: false,
    mode: 'direct',
    durationMs: media.durationMs ?? 0,
    sizeBytes: 10_000_000,
  };
  return {
    sessionId,
    itemId: media.id,
    mediaId: source.mediaId,
    mode: 'direct',
    mimeType: 'video/mp4',
    source,
    durationMs: media.durationMs ?? 0,
    seekMs: 0,
    preferences: {
      mode: 'direct', maxHeight: null, maxBitrate: null,
      audioStream: null, subtitleStream: null, audioLanguage: '', subtitleLanguage: '',
    },
    sourceInfo: { path: `/${media.id}.mp4`, format: 'mp4', size: 10_000_000, bitrate: 1_000_000, streams: [] },
    output: { format: 'mp4' },
    selected: { videoStream: 0, audioStream: 1, subtitleStream: -1 },
    transform: { video: 'copy', audio: 'copy' },
    options: {
      modes: ['direct'], qualityHeights: [], mediaIds: [source.mediaId],
      audioStreams: [], subtitleStreams: [], canSeek: true, canChangeQuality: false, canSwitchMedia: false,
    },
  };
}


class FakePlatform implements Platform {
  readonly name = 'web' as const;
  constructor(readonly player: FakePlayer) {}
  capabilities = vi.fn(async () => capabilities());
  createPlayer(): Player { return this.player; }
}

function resolver(): PlaybackResolver & {
  resolve: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  const value = {
    available: true,
    resolve: vi.fn(async (media: MediaSummary) => session(media)),
    update: vi.fn(async (_sessionId: string, _update: PlaybackUpdate) => { throw new Error('unexpected update'); }),
    stop: vi.fn(async (_sessionId: string, _options?: PlaybackStopOptions) => undefined),
  };
  return value as typeof value & PlaybackResolver;
}

function host(): HTMLElement {
  return {} as HTMLElement;
}

describe('PlaybackRuntime ownership state machine', () => {
  it('prepares from catalogue facts and reuses one capability probe for session fallback', async () => {
    const player = new FakePlayer();
    const platform = new FakePlatform(player);
    const api = resolver();
    const runtime = new PlaybackRuntime(platform, api);
    const profile: MediaTechnicalProfile = {
      mediaId: 'macha:A',
      format: 'mov,mp4',
      durationMs: 600_000,
      bitrate: 1_000_000,
      streams: [],
    };

    runtime.prepare(profile);
    await vi.waitFor(() => expect(platform.capabilities).toHaveBeenCalledTimes(1));
    expect(player.prepareCalls).toEqual([profile]);

    runtime.attach(host());
    await runtime.play({ media: movie('A'), startPositionMs: 0, returnTo: '/movies/A' });

    expect(platform.capabilities).toHaveBeenCalledTimes(1);
    expect(player.prepareCalls).toHaveLength(2);
    expect(player.prepareCalls[1]).toMatchObject({
      mediaId: 'file:A',
      sizeBytes: 10_000_000,
      negotiated: { mode: 'direct', mimeType: 'video/mp4', format: 'mp4' },
    });
    await runtime.stop();
  });

  it('prepares from the session response when no catalogue profile arrived', async () => {
    const player = new FakePlayer();
    const runtime = new PlaybackRuntime(new FakePlatform(player), resolver());
    runtime.attach(host());

    await runtime.play({ media: movie('A'), startPositionMs: 0, returnTo: '/movies/A' });

    expect(player.prepareCalls).toHaveLength(1);
    expect(player.prepareCalls[0]).toMatchObject({ mediaId: 'file:A', negotiated: { mode: 'direct' } });
    await runtime.stop();
  });

  it('does not acquire a replacement session until the previous lease is closed', async () => {
    const player = new FakePlayer();
    const api = resolver();
    const firstStop = deferred<void>();
    api.stop.mockImplementation(async (sessionId: string) => {
      if (sessionId === 'session:A') await firstStop.promise;
    });
    const runtime = new PlaybackRuntime(new FakePlatform(player), api);
    runtime.attach(host());

    await runtime.play({ media: movie('A'), startPositionMs: 0, returnTo: '/movies/A' });
    expect(api.resolve).toHaveBeenCalledTimes(1);

    const replacing = runtime.play({ media: movie('B'), startPositionMs: 0, returnTo: '/movies/B' });
    await vi.waitFor(() => expect(api.stop).toHaveBeenCalledWith('session:A', {}));
    expect(api.resolve).toHaveBeenCalledTimes(1);

    firstStop.resolve();
    await replacing;

    expect(api.resolve).toHaveBeenCalledTimes(2);
    expect(api.resolve.mock.calls[1]?.[0]).toMatchObject({ id: 'B' });
    expect(runtime.getSnapshot()).toMatchObject({ phase: 'playing', request: { media: { id: 'B' } } });
    await runtime.stop();
  });

  it('closes a session that resolves after Stop and never activates its source', async () => {
    const player = new FakePlayer();
    const api = resolver();
    const pending = deferred<PlaybackSession>();
    api.resolve.mockImplementationOnce(async () => pending.promise);
    const runtime = new PlaybackRuntime(new FakePlatform(player), api);
    runtime.attach(host());

    const starting = runtime.play({ media: movie('A'), startPositionMs: 0, returnTo: '/movies/A' });
    await vi.waitFor(() => expect(api.resolve).toHaveBeenCalledTimes(1));
    const stopping = runtime.stop();

    pending.resolve(session(movie('A')));
    await Promise.all([starting, stopping]);

    expect(api.stop).toHaveBeenCalledWith('session:A', {});
    expect(player.playCalls).toHaveLength(0);
    expect(runtime.getSnapshot()).toEqual({ phase: 'idle', generation: 2, request: undefined, fatalError: undefined });
  });

  it('automatically releases the server lease when the active player reports a terminal source failure', async () => {
    const player = new FakePlayer();
    const api = resolver();
    const runtime = new PlaybackRuntime(new FakePlatform(player), api);
    runtime.attach(host());

    await runtime.play({ media: movie('A'), startPositionMs: 0, returnTo: '/movies/A' });
    player.fail(new Error('Web HLS media recovery exhausted'));

    await vi.waitFor(() => expect(runtime.getSnapshot().phase).toBe('failed'));
    await vi.waitFor(() => expect(api.stop).toHaveBeenCalledWith('session:A', {}));
    expect(runtime.getSnapshot().fatalError?.message).toBe('Web HLS media recovery exhausted');
    expect(player.stopCalls).toBeGreaterThanOrEqual(1);
  });

  it('treats an option change after terminal failure as a fresh generation with explicit preferences', async () => {
    const player = new FakePlayer();
    const api = resolver();
    const firstStop = deferred<void>();
    api.stop.mockImplementation(async (sessionId: string) => {
      if (sessionId === 'session:A:1') await firstStop.promise;
    });
    let resolveCount = 0;
    api.resolve.mockImplementation(async (media: MediaSummary, _capabilities: PlaybackCapabilities, _seekMs?: number, preferences?: PlaybackPreferencesUpdate) => {
      resolveCount += 1;
      const resolved = session(media, `session:${media.id}:${resolveCount}`);
      if (preferences?.mode === 'transcode') {
        return {
          ...resolved,
          mode: 'transcode',
          source: { ...resolved.source, mode: 'transcode', mimeType: 'application/vnd.apple.mpegurl' },
          preferences: { ...resolved.preferences, mode: 'transcode' },
          options: { ...resolved.options, modes: ['direct', 'transcode'] },
        };
      }
      return resolved;
    });
    const runtime = new PlaybackRuntime(new FakePlatform(player), api);
    runtime.attach(host());

    await runtime.play({ media: movie('A'), startPositionMs: 0, returnTo: '/movies/A' });
    player.fail(new Error('bufferAppendError'));
    await vi.waitFor(() => expect(runtime.getSnapshot().phase).toBe('failed'));
    await vi.waitFor(() => expect(api.stop).toHaveBeenCalledWith('session:A:1', {}));

    runtime.update({ preferences: { mode: 'transcode' } });
    await Promise.resolve();
    expect(api.resolve).toHaveBeenCalledTimes(1);

    firstStop.resolve();
    await vi.waitFor(() => expect(api.resolve).toHaveBeenCalledTimes(2));
    expect(api.resolve.mock.calls[1]?.[3]).toEqual(expect.objectContaining({ mode: 'transcode' }));
    await vi.waitFor(() => expect(runtime.getSnapshot().phase).toBe('playing'));
    expect(runtime.getPlaybackSnapshot()?.session?.preferences.mode).toBe('transcode');
    await runtime.stop();
  });

  it('retries a decision the chooser made as a fresh choice, not as a viewer instruction', async () => {
    // The retry used to be seeded from the session the server echoed back.
    // That echo has no `container`, so the retry asked for no carriage and
    // the node fell back to its own default — the starvation 0.6.3 paid for.
    // And its concrete `mode`, arriving as initialPreferences.mode, reads as
    // a mode the viewer picked: the host is told `chosenByViewer` about a
    // decision no viewer made, the chooser is skipped, and the one-shot 400
    // downgrade is switched off with it.
    const player = new FakePlayer();
    const api = resolver();
    const runtime = new PlaybackRuntime(new FakePlatform(player), api);
    runtime.attach(host());

    await runtime.play({ media: movie('A'), startPositionMs: 0, returnTo: '/movies/A' });
    expect(runtime.getPlaybackSnapshot()?.instruction).toMatchObject({ chosenByViewer: false });

    player.fail(new Error('node failed'));
    await vi.waitFor(() => expect(runtime.getSnapshot().phase).toBe('failed'));
    await runtime.retry();

    await vi.waitFor(() => expect(api.resolve).toHaveBeenCalledTimes(2));
    // Chosen again rather than restated: the chooser ran on the retry, so the
    // carriage is present and the decision is still the chooser's own.
    expect(api.resolve.mock.calls[1]?.[3]).toMatchObject({ mode: 'transcode', container: 'fmp4' });
    expect(runtime.getPlaybackSnapshot()?.instruction).toMatchObject({ chosenByViewer: false });
    await runtime.stop();
  });

  it('restates a mode the viewer did pick, with the carriage that went with it', async () => {
    const player = new FakePlayer();
    const api = resolver();
    const runtime = new PlaybackRuntime(new FakePlatform(player), api);
    runtime.attach(host());

    await runtime.play(
      { media: movie('A'), startPositionMs: 0, returnTo: '/movies/A' },
      { mode: 'transcode', container: 'mpegts' },
    );
    player.fail(new Error('node failed'));
    await vi.waitFor(() => expect(runtime.getSnapshot().phase).toBe('failed'));
    await runtime.retry();

    await vi.waitFor(() => expect(api.resolve).toHaveBeenCalledTimes(2));
    expect(api.resolve.mock.calls[1]?.[3]).toMatchObject({ mode: 'transcode', container: 'mpegts' });
    await runtime.stop();
  });

  it('treats Play after terminal failure as an explicit retry of the failed intent', async () => {
    const player = new FakePlayer();
    const api = resolver();
    let resolveCount = 0;
    api.resolve.mockImplementation(async (media: MediaSummary) => {
      resolveCount += 1;
      return session(media, `session:${media.id}:${resolveCount}`);
    });
    const runtime = new PlaybackRuntime(new FakePlatform(player), api);
    runtime.attach(host());

    await runtime.play({ media: movie('A'), startPositionMs: 12_000, returnTo: '/movies/A' });
    player.fail(new Error('decoder failed'));
    await vi.waitFor(() => expect(runtime.getSnapshot().phase).toBe('failed'));
    await vi.waitFor(() => expect(api.stop).toHaveBeenCalledWith('session:A:1', {}));

    expect(runtime.seek(30_000)).toBe(true);
    runtime.setPaused(false);

    await vi.waitFor(() => expect(api.resolve).toHaveBeenCalledTimes(2));
    expect(api.resolve.mock.calls[1]?.[2]).toBe(30_000);
    await vi.waitFor(() => expect(runtime.getSnapshot().phase).toBe('playing'));
    await runtime.stop();
  });

  it('automatically releases the server lease when source activation fails', async () => {
    const player = new FakePlayer();
    player.playResult = Promise.reject(new Error('decoder failed'));
    const api = resolver();
    const runtime = new PlaybackRuntime(new FakePlatform(player), api);
    runtime.attach(host());

    await runtime.play({ media: movie('A'), startPositionMs: 0, returnTo: '/movies/A' });
    await vi.waitFor(() => expect(runtime.getSnapshot().phase).toBe('failed'));
    await vi.waitFor(() => expect(api.stop).toHaveBeenCalledWith('session:A', {}));

    expect(runtime.getSnapshot().request?.media.id).toBe('A');
    await runtime.stop();
    expect(runtime.getSnapshot().phase).toBe('idle');
  });

  it('can stop a generation that is waiting for a presentation host', async () => {
    const player = new FakePlayer();
    const api = resolver();
    const runtime = new PlaybackRuntime(new FakePlatform(player), api);

    const starting = runtime.play({ media: movie('A'), startPositionMs: 0, returnTo: '/movies/A' });
    await Promise.resolve();
    const stopping = runtime.stop();
    await Promise.all([starting, stopping]);

    expect(api.resolve).not.toHaveBeenCalled();
    expect(runtime.getSnapshot().phase).toBe('idle');
  });

  it('rebinds presentation hosts without changing playback ownership', async () => {
    const player = new FakePlayer();
    const api = resolver();
    const runtime = new PlaybackRuntime(new FakePlatform(player), api);
    const firstHost = host();
    const secondHost = host();
    runtime.attach(firstHost);
    await runtime.play({ media: movie('A'), startPositionMs: 0, returnTo: '/movies/A' });

    runtime.detach(firstHost);
    runtime.attach(secondHost);

    expect(player.detachHostCalls).toBe(1);
    expect(player.attachCalls).toBe(2);
    expect(player.detachCalls).toBe(0);
    expect(api.resolve).toHaveBeenCalledTimes(1);
    expect(api.stop).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it('treats presentation metadata changes as resource-neutral', async () => {
    const player = new FakePlayer();
    const api = resolver();
    const runtime = new PlaybackRuntime(new FakePlatform(player), api);
    runtime.attach(host());
    await runtime.play({ media: movie('A'), startPositionMs: 0, returnTo: '/movies/A' });

    runtime.setReturnTo('/home');

    expect(runtime.getSnapshot().request?.returnTo).toBe('/home');
    expect(api.resolve).toHaveBeenCalledTimes(1);
    expect(api.stop).not.toHaveBeenCalled();
    expect(player.playCalls).toHaveLength(1);
    await runtime.stop();
  });

  it('delegates pause/resume to the one owned player without changing leases', async () => {
    const player = new FakePlayer();
    const api = resolver();
    const runtime = new PlaybackRuntime(new FakePlatform(player), api);
    runtime.attach(host());
    await runtime.play({ media: movie('A'), startPositionMs: 0, returnTo: '/movies/A' });

    runtime.setPaused(true);
    runtime.setPaused(false);

    expect(player.pauseCalls).toBe(1);
    expect(player.resumeCalls).toBe(1);
    expect(api.resolve).toHaveBeenCalledTimes(1);
    expect(api.stop).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it('uses keepalive teardown for page exit', async () => {
    const player = new FakePlayer();
    const api = resolver();
    const runtime = new PlaybackRuntime(new FakePlatform(player), api);
    runtime.attach(host());
    await runtime.play({ media: movie('A'), startPositionMs: 0, returnTo: '/movies/A' });

    runtime.terminateForPageExit();

    await vi.waitFor(() => expect(api.stop).toHaveBeenCalledWith('session:A', expect.objectContaining({ keepalive: true })));
  });

  it('rejects non-playable catalogue requests without acquiring a server session', async () => {
    const player = new FakePlayer();
    const api = resolver();
    const runtime = new PlaybackRuntime(new FakePlatform(player), api);
    runtime.attach(host());
    const album: MediaSummary = { id: 'album:A', kind: 'album', title: 'Album A', mediaIds: [] };

    await runtime.play({ media: album, startPositionMs: 0, returnTo: '/music/albums/A' });

    expect(runtime.getSnapshot().phase).toBe('failed');
    expect(runtime.getSnapshot().fatalError).toMatchObject({ code: NOT_PLAYABLE_CODE });
    expect(api.resolve).not.toHaveBeenCalled();
    expect(api.stop).not.toHaveBeenCalled();
  });
});

describe('PlaybackRuntime lifecycle edges', () => {
  /**
   * A capability probe that failed must not be remembered as the answer.
   *
   * The probe is cached because it is expensive and its result does not change
   * — but a rejection is not a result. Caching it would mean one transient
   * failure at startup leaves playback permanently broken for the life of the
   * process, with nothing to point at.
   */
  it('re-probes capabilities after a failed probe rather than caching the failure', async () => {
    const player = new FakePlayer();
    const platform = new FakePlatform(player);
    platform.capabilities.mockRejectedValueOnce(new Error('probe failed'));
    const runtime = new PlaybackRuntime(platform, resolver());
    runtime.attach(host());

    await runtime.play({ media: movie('A'), startPositionMs: 0, returnTo: '/movies/A' }).catch(() => undefined);
    await runtime.play({ media: movie('A'), startPositionMs: 0, returnTo: '/movies/A' });

    expect(platform.capabilities.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(runtime.getSnapshot()).toMatchObject({ phase: 'playing' });
    await runtime.stop();
  });

  it('holds a play until a surface exists, rather than playing into nothing', async () => {
    const player = new FakePlayer();
    const api = resolver();
    const runtime = new PlaybackRuntime(new FakePlatform(player), api);

    const playing = runtime.play({ media: movie('A'), startPositionMs: 0, returnTo: '/movies/A' });
    await Promise.resolve();
    expect(player.playCalls).toEqual([]);

    runtime.attach(host());
    await playing;

    expect(player.playCalls).toHaveLength(1);
    await runtime.stop();
  });

  it('releases a play waiting on a surface when the caller stops instead', async () => {
    // Otherwise a viewer who navigates away before the surface mounts leaves a
    // transition parked forever, and every later transition queues behind it.
    const player = new FakePlayer();
    const runtime = new PlaybackRuntime(new FakePlatform(player), resolver());

    const playing = runtime.play({ media: movie('A'), startPositionMs: 0, returnTo: '/movies/A' });
    await runtime.stop();
    await playing;

    expect(runtime.getSnapshot()).toMatchObject({ phase: 'idle' });
  });

  it('keeps the transition queue usable after one transition throws', async () => {
    // The tail is chained, so a rejection that is not absorbed poisons every
    // transition queued behind it — the runtime would go quiet rather than
    // fail, which is the harder thing to diagnose.
    const player = new FakePlayer();
    const api = resolver();
    api.resolve.mockRejectedValueOnce(new Error('resolver exploded'));
    const runtime = new PlaybackRuntime(new FakePlatform(player), api);
    runtime.attach(host());

    await runtime.play({ media: movie('A'), startPositionMs: 0, returnTo: '/movies/A' }).catch(() => undefined);
    await runtime.play({ media: movie('B'), startPositionMs: 0, returnTo: '/movies/B' });

    expect(runtime.getSnapshot()).toMatchObject({ phase: 'playing', request: { media: { id: 'B' } } });
    await runtime.stop();
  });

  it('detaches the player and drops its listeners when disposed', async () => {
    const player = new FakePlayer();
    const runtime = new PlaybackRuntime(new FakePlatform(player), resolver());
    runtime.attach(host());
    await runtime.play({ media: movie('A'), startPositionMs: 0, returnTo: '/movies/A' });

    await runtime.dispose();

    expect(player.detachCalls).toBe(1);
  });

  it('closes the open session when disposed mid-playback', async () => {
    // A dispose that drops the session without closing it leaves the node
    // holding a transcode slot until session_idle — thirty minutes, and on a
    // one-slot node the next viewer gets 429 with nothing to point at.
    const player = new FakePlayer();
    const api = resolver();
    const runtime = new PlaybackRuntime(new FakePlatform(player), api);
    runtime.attach(host());
    await runtime.play({ media: movie('A'), startPositionMs: 0, returnTo: '/movies/A' });

    await runtime.dispose();

    expect(api.stop).toHaveBeenCalledWith('session:A', {});
  });

  it('is safe to dispose twice', async () => {
    const player = new FakePlayer();
    const runtime = new PlaybackRuntime(new FakePlatform(player), resolver());
    runtime.attach(host());
    await runtime.play({ media: movie('A'), startPositionMs: 0, returnTo: '/movies/A' });

    await runtime.dispose();
    await runtime.dispose();

    expect(player.detachCalls).toBe(1);
  });

  it('ignores a stop after disposal, since there is nothing left to own', async () => {
    const player = new FakePlayer();
    const runtime = new PlaybackRuntime(new FakePlatform(player), resolver());
    runtime.attach(host());
    await runtime.play({ media: movie('A'), startPositionMs: 0, returnTo: '/movies/A' });
    await runtime.dispose();
    const stopsAfterDispose = player.stopCalls;

    await runtime.stop();

    expect(player.stopCalls).toBe(stopsAfterDispose);
  });

  it('does nothing on terminateForPageExit when nothing is playing', async () => {
    const player = new FakePlayer();
    const api = resolver();
    const runtime = new PlaybackRuntime(new FakePlatform(player), api);

    runtime.terminateForPageExit();

    expect(api.stop).not.toHaveBeenCalled();
    expect(runtime.getSnapshot()).toMatchObject({ phase: 'idle' });
  });

  it('closes the session with keepalive on page exit', async () => {
    const player = new FakePlayer();
    const api = resolver();
    const runtime = new PlaybackRuntime(new FakePlatform(player), api);
    runtime.attach(host());
    await runtime.play({ media: movie('A'), startPositionMs: 0, returnTo: '/movies/A' });

    runtime.terminateForPageExit();

    await vi.waitFor(() => expect(api.stop).toHaveBeenCalledWith('session:A', expect.objectContaining({ keepalive: true })));
  });
});

describe('the surface a viewer still has after a generation has failed', () => {
  // Everything here runs with no coordinator: the failed one was closed and
  // dropped by `cleanupFailedGeneration`. These are the controls left on the
  // failure screen, and until now not one of them was covered — so the
  // scrubbing-then-retry path a viewer actually takes out of a failure was
  // held together by reading.

  async function failed(api: ReturnType<typeof resolver>, player: FakePlayer): Promise<PlaybackRuntime> {
    const runtime = new PlaybackRuntime(new FakePlatform(player), api);
    runtime.attach(host());
    await runtime.play({ media: movie('A'), startPositionMs: 0, returnTo: '/movies/A' });
    player.fail(new Error('Web HLS media recovery exhausted'));
    await vi.waitFor(() => expect(runtime.getSnapshot().phase).toBe('failed'));
    return runtime;
  }

  it('lets a viewer scrub on the failure screen, and retries from where they scrubbed to', async () => {
    const player = new FakePlayer();
    const api = resolver();
    const runtime = await failed(api, player);

    expect(runtime.seek(120_000)).toBe(true);

    // The scrubber has to track, or the control moves and the picture of it
    // does not — the failure looks like a second failure.
    expect(runtime.getPlaybackSnapshot()?.intent.positionMs).toBe(120_000);
    expect(runtime.getPlaybackSnapshot()?.event.positionMs).toBe(120_000);
    // A generation that ended is not still ended at a position it never reached.
    expect(runtime.getPlaybackSnapshot()?.event.ended).toBe(false);

    await runtime.retry();
    await vi.waitFor(() => expect(api.resolve).toHaveBeenCalledTimes(2));
    expect(api.resolve.mock.calls[1]?.[2]).toBe(120_000);
    await runtime.stop();
  });

  it('compounds seekBy onto the failed request rather than onto a player that is gone', async () => {
    const player = new FakePlayer();
    const api = resolver();
    const runtime = await failed(api, player);
    const seeksBeforeScrubbing = player.seekCalls.length;

    expect(runtime.seekBy(30_000)).toBe(true);
    expect(runtime.seekBy(30_000)).toBe(true);

    expect(runtime.getPlaybackSnapshot()?.intent.positionMs).toBe(60_000);
    // Nothing reached the player. There is no session behind it and seeking a
    // torn-down element is how a failure screen acquires a second error.
    expect(player.seekCalls.length).toBe(seeksBeforeScrubbing);
    await runtime.stop();
  });

  it('bounds a nonsense scrub rather than carrying it into the retry', async () => {
    const player = new FakePlayer();
    const api = resolver();
    const runtime = await failed(api, player);

    expect(runtime.seek(Number.NaN)).toBe(true);
    expect(runtime.getPlaybackSnapshot()?.intent.positionMs).toBe(0);
    expect(runtime.seek(-5_000)).toBe(true);
    expect(runtime.getPlaybackSnapshot()?.intent.positionMs).toBe(0);

    await runtime.retry();
    await vi.waitFor(() => expect(api.resolve).toHaveBeenCalledTimes(2));
    expect(api.resolve.mock.calls[1]?.[2]).toBe(0);
    await runtime.stop();
  });

  it('refuses a scrub when there is no generation to scrub, failed or otherwise', async () => {
    // Idle is not failed. Returning true here would tell a host the position
    // moved when nothing holds one, and the next play would start from a
    // number nobody set.
    const runtime = new PlaybackRuntime(new FakePlatform(new FakePlayer()), resolver());
    expect(runtime.seek(120_000)).toBe(false);
    expect(runtime.seekBy(30_000)).toBe(false);
    expect(runtime.getPlaybackSnapshot()).toBeUndefined();
  });
});

describe('what a host sees through the runtime', () => {
  it('gives a new subscriber the current state at once, and stops when it unsubscribes', async () => {
    // A subscription that only delivers on the next change leaves a host
    // blank until something happens — and on an idle runtime nothing does.
    const player = new FakePlayer();
    const api = resolver();
    const runtime = new PlaybackRuntime(new FakePlatform(player), api);
    runtime.attach(host());

    const lifecycle: string[] = [];
    const playback: Array<string | undefined> = [];
    const stopLifecycle = runtime.subscribeLifecycle((snapshot) => lifecycle.push(snapshot.phase));
    const stopPlayback = runtime.subscribePlayback((snapshot) => playback.push(snapshot?.session?.sessionId));

    expect(lifecycle).toEqual(['idle']);
    expect(playback).toEqual([undefined]);

    await runtime.play({ media: movie('A'), startPositionMs: 0, returnTo: '/movies/A' });
    await vi.waitFor(() => expect(runtime.getSnapshot().phase).toBe('playing'));
    expect(lifecycle.length).toBeGreaterThan(1);
    expect(playback).toContain('session:A');

    const lifecycleSeen = lifecycle.length;
    const playbackSeen = playback.length;
    stopLifecycle();
    stopPlayback();
    await runtime.stop();

    expect(lifecycle.length).toBe(lifecycleSeen);
    expect(playback.length).toBe(playbackSeen);
  });

  it('hands out a playback snapshot a host may keep and mutate', async () => {
    // Hosts hold these across renders. A shared `intent` object would have a
    // host's own edit arrive back through core as though core had made it.
    const player = new FakePlayer();
    const runtime = new PlaybackRuntime(new FakePlatform(player), resolver());
    runtime.attach(host());
    await runtime.play({ media: movie('A'), startPositionMs: 0, returnTo: '/movies/A' });
    await vi.waitFor(() => expect(runtime.getPlaybackSnapshot()).toBeDefined());

    const held = runtime.getPlaybackSnapshot()!;
    held.intent.positionMs = 999_999;
    held.event.positionMs = 999_999;

    expect(runtime.getPlaybackSnapshot()?.intent.positionMs).not.toBe(999_999);
    expect(runtime.getPlaybackSnapshot()?.event.positionMs).not.toBe(999_999);
    await runtime.stop();
  });

  it('resolves through a resolver installed after construction', async () => {
    // The host wires a cluster resolver once the endpoints are known, which is
    // after the runtime exists. A play that still went to the original would
    // acquire against the wrong thing and nothing would say so.
    const player = new FakePlayer();
    const atConstruction = resolver();
    const installed = resolver();
    const runtime = new PlaybackRuntime(new FakePlatform(player), atConstruction);
    runtime.setResolver(installed);
    runtime.attach(host());

    await runtime.play({ media: movie('A'), startPositionMs: 0, returnTo: '/movies/A' });
    await vi.waitFor(() => expect(installed.resolve).toHaveBeenCalledTimes(1));
    expect(atConstruction.resolve).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it('forwards a node move to the live coordinator, the only thing that can perform one', async () => {
    const player = new FakePlayer();
    const api = resolver();
    const prepareOn = vi.fn(async (_endpointId: string) => undefined);
    api.prepareOn = prepareOn;
    const runtime = new PlaybackRuntime(new FakePlatform(player), api);
    runtime.attach(host());
    await runtime.play({ media: movie('A'), startPositionMs: 0, returnTo: '/movies/A' });

    // The resolver declines, so no move happens. What is under test is that
    // the request reached the coordinator at all -- a host holds a runtime and
    // never a coordinator, so without this forwarder nothing could ask.
    expect(await runtime.moveTo('node-b')).toBe(false);
    expect(prepareOn).toHaveBeenCalledTimes(1);
    expect(prepareOn.mock.calls[0]?.[0]).toBe('node-b');
    await runtime.stop();
  });

  it('answers false to a move with no generation to move, idle or failed, and asks the resolver nothing', async () => {
    const player = new FakePlayer();
    const api = resolver();
    const prepareOn = vi.fn(async (_endpointId: string) => undefined);
    api.prepareOn = prepareOn;
    const idle = new PlaybackRuntime(new FakePlatform(player), api);
    expect(await idle.moveTo('node-b')).toBe(false);

    // A failed generation is released; moving it is a retry on another node,
    // which a host spells as prefer() then retry(). Not a move.
    const runtime = new PlaybackRuntime(new FakePlatform(player), api);
    runtime.attach(host());
    await runtime.play({ media: movie('A'), startPositionMs: 0, returnTo: '/movies/A' });
    player.fail(new Error('Web HLS media recovery exhausted'));
    await vi.waitFor(() => expect(runtime.getSnapshot().phase).toBe('failed'));
    expect(await runtime.moveTo('node-b')).toBe(false);
    expect(prepareOn).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it('applies a volume to the player, and does not require a player to have one', () => {
    // The docblock on setVolume records two separate occasions when applying a
    // level was confused with persisting one. This pins the half core owns:
    // it forwards the number it is given and holds nothing.
    // Assigned through a cast because the shared `FakePlayer` declares
    // `setVolume()` with no parameters and discards the level, so nothing can
    // observe it as it stands — noted in ACTIVE's low register rather than
    // widened here, since the double ships on the `./testing` export.
    const applied: number[] = [];
    const player = new FakePlayer();
    (player as { setVolume: (volume: number) => void }).setVolume = (volume) => { applied.push(volume); };
    const runtime = new PlaybackRuntime(new FakePlatform(player), resolver());

    runtime.setVolume(0);
    runtime.setVolume(0.35);
    expect(applied).toEqual([0, 0.35]);

    // A player need not do app volume at all; the hook is optional and a
    // platform without one must not throw on a level it cannot apply.
    const silentPlayer = new FakePlayer();
    (silentPlayer as { setVolume?: unknown }).setVolume = undefined;
    const withoutVolume = new PlaybackRuntime(new FakePlatform(silentPlayer), resolver());
    expect(() => withoutVolume.setVolume(0.5)).not.toThrow();
  });

  it('does not notify a host about a returnTo that changes nothing', async () => {
    const player = new FakePlayer();
    const runtime = new PlaybackRuntime(new FakePlatform(player), resolver());
    runtime.attach(host());

    // No request yet: there is nothing for a returnTo to belong to.
    const seen: string[] = [];
    const stop = runtime.subscribeLifecycle((snapshot) => seen.push(snapshot.phase));
    runtime.setReturnTo('/movies/A');
    expect(seen).toEqual(['idle']);

    await runtime.play({ media: movie('A'), startPositionMs: 0, returnTo: '/movies/A' });
    await vi.waitFor(() => expect(runtime.getSnapshot().phase).toBe('playing'));
    const settled = seen.length;

    runtime.setReturnTo('/movies/A');
    expect(seen.length).toBe(settled);

    runtime.setReturnTo('/movies/A?from=search');
    expect(seen.length).toBe(settled + 1);
    expect(runtime.getSnapshot().request?.returnTo).toBe('/movies/A?from=search');

    stop();
    await runtime.stop();
  });
});

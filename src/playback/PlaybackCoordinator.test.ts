import { describe, expect, it, vi } from 'vitest';
import { PlaybackSourceError, type Player, type PlaybackDegradationListener, type PlaybackFailureListener, type PlaybackListener } from '../platform/Platform.js';
import type { MediaSummary, PlaybackCapabilities, PlaybackEvent, PlaybackSource, PlaybackTimeRange } from '../types.js';
import type { PlaybackPreferences, PlaybackResolver, PlaybackSession, PlaybackUpdate } from './PlaybackResolver.js';
import { equivalentDirectSources, generationLocalPosition, isPrematurePlaybackEnd, PlaybackCoordinator, mergePlaybackUpdate, restatePreferencesClearedByMode } from './PlaybackCoordinator.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class FakePlayer implements Player {
  listener?: PlaybackListener;
  failureListener?: PlaybackFailureListener;
  degradationListener?: PlaybackDegradationListener;
  playCalls: Array<{ source: PlaybackSource; positionMs: number; startPaused: boolean }> = [];
  seekCalls: number[] = [];
  pauseCalls = 0;
  resumeCalls = 0;
  detachCalls = 0;
  stopCalls = 0;
  subtitleCalls: Array<string | undefined> = [];
  directAlternatives: Array<{ active: PlaybackSource; alternate: PlaybackSource }> = [];
  preflightCalls: PlaybackSource[] = [];
  playResult: Promise<boolean> = Promise.resolve(true);
  localSeekRanges: PlaybackTimeRange[] = [];

  attach(): void {}
  detach(): void { this.detachCalls += 1; }
  play(source: PlaybackSource, positionMs = 0, startPaused = false): Promise<boolean> {
    this.playCalls.push({ source, positionMs, startPaused });
    return this.playResult;
  }
  pause(): void { this.pauseCalls += 1; }
  resume(): void { this.resumeCalls += 1; }
  seek(positionMs: number): void { this.seekCalls.push(positionMs); }
  localSeekCoverage(): readonly PlaybackTimeRange[] {
    const source = this.playCalls.at(-1)?.source;
    return source?.mode === 'direct'
      ? [{ startMs: 0, endMs: Number.POSITIVE_INFINITY }]
      : this.localSeekRanges;
  }
  setVolume(): void {}
  setSubtitle(subtitleUrl?: string): void { this.subtitleCalls.push(subtitleUrl); }
  addDirectSourceAlternative(active: PlaybackSource, alternate: PlaybackSource): boolean {
    this.directAlternatives.push({ active, alternate });
    return true;
  }
  preflightSource(source: PlaybackSource): Promise<boolean> {
    this.preflightCalls.push(source);
    return Promise.resolve(true);
  }
  stop(): void { this.stopCalls += 1; }
  subscribe(listener: PlaybackListener): () => void {
    this.listener = listener;
    return () => { if (this.listener === listener) this.listener = undefined; };
  }
  subscribeFailure(listener: PlaybackFailureListener): () => void {
    this.failureListener = listener;
    return () => { if (this.failureListener === listener) this.failureListener = undefined; };
  }
  subscribeDegradation(listener: PlaybackDegradationListener): () => void {
    this.degradationListener = listener;
    return () => { if (this.degradationListener === listener) this.degradationListener = undefined; };
  }
  emit(event: PlaybackEvent): void { this.listener?.(event); }
  fail(error: Error): void { this.failureListener?.(error); }
  degrade(error: Error): void { this.degradationListener?.(error); }
}

function media(): MediaSummary {
  return { id: 'tmdb:movie:1', kind: 'movie', title: 'Movie', mediaIds: ['m1'], durationMs: 600_000 };
}

function capabilities(): PlaybackCapabilities {
  return {
    platform: 'web', videoCodecs: ['h264'], audioCodecs: ['aac'], containers: ['mp4'], hlsFmp4: true, dash: false, hdr: [],
  };
}

function session(overrides: Partial<PlaybackSession> = {}): PlaybackSession {
  const mode = overrides.mode ?? 'direct';
  const seekMs = overrides.seekMs ?? 0;
  const mimeType = overrides.mimeType ?? (mode === 'direct' ? 'video/mp4' : 'application/vnd.apple.mpegurl');
  const source: PlaybackSource = overrides.source ?? {
    mediaId: 'm1', url: mode === 'direct' ? '/direct' : `/generation-${seekMs}.m3u8`, mimeType, isManifest: mode !== 'direct', mode, durationMs: 600_000, sizeBytes: 100_000_000,
  };
  return {
    sessionId: 's1', mediaId: 'm1', mode, mimeType, durationMs: 600_000, seekMs,
    preferences: { mode: 'direct', maxHeight: null, maxBitrate: null, audioStream: 1, subtitleStream: null, audioLanguage: '', subtitleLanguage: '' },
    sourceInfo: { path: '/movie', format: 'matroska', size: 100_000_000, bitrate: 10_000_000, streams: [] },
    output: {},
    selected: { videoStream: 0, audioStream: 1, subtitleStream: -1 },
    transform: { video: mode === 'direct' ? 'copy' : 'transcode', audio: 'copy' },
    options: { modes: ['direct', 'remux', 'transcode'], qualityHeights: [1080, 720], mediaIds: ['m1'], audioStreams: [], subtitleStreams: [], canSeek: true, canChangeQuality: true, canSwitchMedia: false },
    ...overrides,
    source,
  };
}

function resolver(initial: PlaybackSession, updateImpl?: (update: PlaybackUpdate, signal?: AbortSignal) => Promise<PlaybackSession>): PlaybackResolver & { resolve: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } {
  return {
    available: true,
    resolve: vi.fn(async () => initial),
    update: vi.fn(async (_sessionId: string, update: PlaybackUpdate, signal?: AbortSignal) => updateImpl ? updateImpl(update, signal) : initial),
    stop: vi.fn(async () => undefined),
  } as any;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('PlaybackCoordinator transport invariants', () => {
  it('refuses a seek on a stream that cannot seek without moving intent', async () => {
    // The guard used to sit below the intent mutation, so a refused seek
    // pinned intent at a position the player would never reach: observed
    // positions were ignored, `seekBy` built on the phantom, and a failover
    // asked the next node to start there.
    const player = new FakePlayer();
    const api = resolver(session({ mode: 'transcode', options: { ...session().options, canSeek: false } }));
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
    await coordinator.start();
    // Activation holds an intent at the start position until the player
    // reports reaching it; settle that first so the next event tracks.
    player.emit({ positionMs: 0, durationMs: 600_000, paused: false, ended: false });
    player.emit({ positionMs: 7_000, durationMs: 600_000, paused: false, ended: false });
    expect(coordinator.getSnapshot().intent.positionMs).toBe(7_000);

    expect(coordinator.seek(300_000)).toBe(false);

    expect(coordinator.getSnapshot().notice).toBe('This stream cannot seek.');
    expect(coordinator.getSnapshot().intent.positionMs).toBe(7_000);
    expect(coordinator.getSnapshot().event.positionMs).toBe(7_000);
    expect(player.seekCalls).toEqual([]);
    expect(api.update).not.toHaveBeenCalled();

    player.emit({ positionMs: 9_000, durationMs: 600_000, paused: false, ended: false });
    expect(coordinator.getSnapshot().intent.positionMs).toBe(9_000);
    expect(coordinator.seekBy(1_000)).toBe(false);
    await coordinator.close();
  });

  it('debounces uncached seek transitions until 300ms after the last input', async () => {
    vi.useFakeTimers();
    try {
      const player = new FakePlayer();
      const initial = session({ mode: 'transcode', seekMs: 0 });
      const api = resolver(initial, async (update) => session({
        mode: 'transcode',
        seekMs: update.seekMs ?? 0,
        source: { ...initial.source, url: `/generation-${update.seekMs ?? 0}.m3u8` },
      }));
      const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
      await coordinator.start();

      coordinator.seek(10_000);
      await vi.advanceTimersByTimeAsync(100);
      coordinator.seek(20_000);
      await vi.advanceTimersByTimeAsync(100);
      coordinator.seek(30_000);
      await vi.advanceTimersByTimeAsync(299);

      expect(api.update).not.toHaveBeenCalled();
      expect(coordinator.getSnapshot().intent.positionMs).toBe(30_000);
      await vi.advanceTimersByTimeAsync(1);
      await flush();
      expect(api.update).toHaveBeenCalledTimes(1);
      expect(api.update).toHaveBeenCalledWith('s1', expect.objectContaining({ seekMs: 30_000 }), expect.any(AbortSignal));
      await coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels an obsolete in-flight seek and dispatches only the latest intent after debounce', async () => {
    vi.useFakeTimers();
    try {
      const player = new FakePlayer();
      const initial = session({ mode: 'transcode', seekMs: 0 });
      const observedSignals: AbortSignal[] = [];
      let call = 0;
      const api = resolver(initial, async (update, signal) => {
        call += 1;
        if (signal) observedSignals.push(signal);
        if (call === 1) {
          // Model a legacy TV fetch implementation which ignores AbortSignal:
          // the coordinator must still abandon this wait locally.
          return new Promise<PlaybackSession>(() => undefined);
        }
        return session({
          mode: 'transcode',
          seekMs: update.seekMs ?? 0,
          source: { ...initial.source, url: `/generation-${update.seekMs ?? 0}.m3u8` },
        });
      });
      const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
      await coordinator.start();

      coordinator.seek(100_000);
      await vi.advanceTimersByTimeAsync(300);
      expect(api.update).toHaveBeenCalledTimes(1);
      expect(observedSignals[0]?.aborted).toBe(false);

      coordinator.seek(200_000);
      expect(observedSignals[0]?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(299);
      expect(api.update).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await flush();

      expect(api.update).toHaveBeenCalledTimes(2);
      expect(api.update.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ seekMs: 200_000 }));
      expect(coordinator.getSnapshot().notice).toBeUndefined();
      await coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels an unsent generation request when the final seek returns to cached coverage', async () => {
    vi.useFakeTimers();
    try {
      const player = new FakePlayer();
      player.localSeekRanges = [{ startMs: 0, endMs: 60_000 }];
      const initial = session({ mode: 'transcode', seekMs: 0 });
      const api = resolver(initial);
      const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
      await coordinator.start();

      coordinator.seek(120_000);
      await vi.advanceTimersByTimeAsync(100);
      coordinator.seek(30_000);
      await vi.advanceTimersByTimeAsync(300);

      expect(api.update).not.toHaveBeenCalled();
      expect(player.seekCalls).toEqual([30_000]);
      await coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('seeks Direct Play locally without synchronising transport state to the server', async () => {
    const player = new FakePlayer();
    const api = resolver(session());
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
    await coordinator.start();

    expect(coordinator.seek(10_000)).toBe(true);
    expect(player.seekCalls).toEqual([10_000]);
    expect(api.update).not.toHaveBeenCalled();
  });

  it('seeks a buffered point inside an existing transformed generation locally', async () => {
    const player = new FakePlayer();
    player.localSeekRanges = [{ startMs: 5_000, endMs: 75_000 }];
    const initial = session({ mode: 'transcode', seekMs: 30_000 });
    const api = resolver(initial);
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 40_000 });
    await coordinator.start();

    coordinator.seek(50_000);
    expect(player.seekCalls).toEqual([20_000]);
    expect(api.update).not.toHaveBeenCalled();
  });

  it('resolves a new generation when a transformed seek target is outside local coverage', async () => {
    const player = new FakePlayer();
    player.localSeekRanges = [{ startMs: 0, endMs: 60_000 }];
    const initial = session({ mode: 'transcode', seekMs: 0 });
    const api = resolver(initial, async (update) => session({
      mode: 'transcode',
      seekMs: update.seekMs ?? 0,
      source: { ...initial.source, url: `/generation-${update.seekMs ?? 0}.m3u8` },
    }));
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
    await coordinator.start();

    coordinator.seek(240_000);

    expect(player.seekCalls).toEqual([]);
    await vi.waitFor(() => {
      expect(api.update).toHaveBeenCalledWith('s1', expect.objectContaining({ seekMs: 240_000 }), expect.any(AbortSignal));
    });
  });

  it('keeps the old source running while a backwards HLS generation is prepared', async () => {
    const player = new FakePlayer();
    const initial = session({ mode: 'transcode', seekMs: 30_000 });
    const update = deferred<PlaybackSession>();
    const api = resolver(initial, async () => update.promise);
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 40_000 });
    await coordinator.start();
    const initialPlays = player.playCalls.length;

    coordinator.seek(10_000);
    await vi.waitFor(() => expect(api.update).toHaveBeenCalledTimes(1));
    expect(player.pauseCalls).toBe(0);
    expect(player.playCalls).toHaveLength(initialPlays);

    update.resolve(session({ mode: 'transcode', seekMs: 8_000, source: { ...initial.source, url: '/generation-8000.m3u8' } }));
    await vi.waitFor(() => {
      expect(player.playCalls.at(-1)?.positionMs).toBe(2_000);
    });
  });

  it('accepts server keyframe alignment for the generation it explicitly requested without retrying forever', async () => {
    const player = new FakePlayer();
    const aligned = session({ mode: 'transcode', seekMs: 33_000 });
    const api = resolver(aligned);
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 30_000 });

    await coordinator.start();
    expect(api.resolve).toHaveBeenCalledTimes(1);
    expect(api.update).not.toHaveBeenCalled();
    expect(player.playCalls).toEqual([{ source: aligned.source, positionMs: 0, startPaused: false }]);
  });

  it('does not wait for media play readiness before startup orchestration completes', async () => {
    const player = new FakePlayer();
    const pendingPlay = deferred<boolean>();
    player.playResult = pendingPlay.promise;
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: resolver(session()), capabilities: async () => capabilities(), initialPositionMs: 0 });

    await coordinator.start();
    expect(coordinator.getSnapshot().starting).toBe(false);
    expect(player.playCalls).toHaveLength(1);
    pendingPlay.resolve(true);
  });

  it('accepts play/pause intent immediately while server generation work is in flight', async () => {
    const player = new FakePlayer();
    const initial = session({ mode: 'transcode', seekMs: 30_000 });
    const update = deferred<PlaybackSession>();
    const api = resolver(initial, async () => update.promise);
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 40_000 });
    await coordinator.start();

    coordinator.seek(10_000);
    await vi.waitFor(() => expect(api.update).toHaveBeenCalledTimes(1));
    coordinator.setPaused(true);
    coordinator.setPaused(false);
    expect(player.pauseCalls).toBe(1);
    expect(player.resumeCalls).toBe(1);
    expect(coordinator.getSnapshot().intent.paused).toBe(false);

    update.resolve(session({ mode: 'transcode', seekMs: 8_000 }));
    await flush();
  });

  it('never lets transient media pause/play events overwrite user transport intent', async () => {
    const player = new FakePlayer();
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: resolver(session()), capabilities: async () => capabilities(), initialPositionMs: 0 });
    await coordinator.start();

    coordinator.setPaused(true);
    player.emit({ positionMs: 0, durationMs: 600_000, paused: false, ended: false });
    expect(coordinator.getSnapshot().intent.paused).toBe(true);

    coordinator.setPaused(false);
    player.emit({ positionMs: 0, durationMs: 600_000, paused: true, ended: false });
    expect(coordinator.getSnapshot().intent.paused).toBe(false);
  });

  it('holds a startup/resume target across transient zero-position source-load events', async () => {
    const player = new FakePlayer();
    const direct = session();
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: resolver(direct), capabilities: async () => capabilities(), initialPositionMs: 120_000 });
    await coordinator.start();

    player.emit({ positionMs: 0, durationMs: 600_000, paused: true, ended: false });
    expect(coordinator.getSnapshot().intent.positionMs).toBe(120_000);
    player.emit({ positionMs: 120_000, durationMs: 600_000, paused: false, ended: false });
    expect(coordinator.getSnapshot().intent.positionMs).toBe(120_000);
    player.emit({ positionMs: 121_000, durationMs: 600_000, paused: false, ended: false });
    expect(coordinator.getSnapshot().intent.positionMs).toBe(121_000);
  });

  it('maps transformed buffered ranges to absolute presentation time', async () => {
    const player = new FakePlayer();
    const transformed = session({ mode: 'transcode', seekMs: 30_000 });
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: resolver(transformed), capabilities: async () => capabilities(), initialPositionMs: 40_000 });
    await coordinator.start();

    player.emit({
      positionMs: 10_000,
      durationMs: 570_000,
      paused: false,
      ended: false,
      bufferedRangesMs: [{ startMs: 5_000, endMs: 75_000 }],
      forwardBufferMs: 65_000,
    });
    expect(coordinator.getSnapshot().event.bufferedRangesMs).toEqual([{ startMs: 35_000, endMs: 105_000 }]);
    expect(coordinator.getSnapshot().event.forwardBufferMs).toBe(65_000);
  });

  it('clears old-generation buffer residency when a transformed source generation is replaced', async () => {
    const player = new FakePlayer();
    player.localSeekRanges = [{ startMs: 0, endMs: 60_000 }];
    const initial = session({ mode: 'transcode', seekMs: 0 });
    const api = resolver(initial, async (update) => session({
      mode: 'transcode',
      seekMs: update.seekMs ?? 0,
      source: { ...initial.source, url: `/generation-${update.seekMs ?? 0}.m3u8` },
    }));
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
    await coordinator.start();

    player.emit({
      positionMs: 20_000,
      durationMs: 600_000,
      paused: false,
      ended: false,
      bufferedRangesMs: [{ startMs: 0, endMs: 60_000 }],
      forwardBufferMs: 40_000,
    });
    expect(coordinator.getSnapshot().event.bufferedRangesMs).toEqual([{ startMs: 0, endMs: 60_000 }]);

    coordinator.seek(240_000);
    await vi.waitFor(() => {
      expect(player.playCalls.at(-1)?.source.url).toBe('/generation-240000.m3u8');
    });

    expect(coordinator.getSnapshot().event.bufferedRangesMs).toEqual([]);
    expect(coordinator.getSnapshot().event.forwardBufferMs).toBe(0);
  });
});


describe('PlaybackCoordinator startup intent', () => {
  it('activates a source paused when pause intent arrives while initial generation is resolving', async () => {
    const player = new FakePlayer();
    const pending = deferred<PlaybackSession>();
    const api = resolver(session());
    api.resolve.mockImplementation(async () => pending.promise);
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });

    const starting = coordinator.start();
    await flush();
    coordinator.setPaused(true);
    pending.resolve(session());
    await starting;

    expect(player.playCalls.at(-1)?.startPaused).toBe(true);
    expect(coordinator.getSnapshot().intent.paused).toBe(true);
  });

  it('preserves the latest seek issued while the initial generation is resolving', async () => {
    const player = new FakePlayer();
    const pending = deferred<PlaybackSession>();
    const api = resolver(session());
    api.resolve.mockImplementation(async () => pending.promise);
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });

    const starting = coordinator.start();
    await flush();
    coordinator.seek(20_000);
    pending.resolve(session());
    await starting;

    expect(api.update).not.toHaveBeenCalled();
    expect(player.playCalls.at(-1)?.positionMs).toBe(20_000);
    expect(coordinator.getSnapshot().intent.positionMs).toBe(20_000);
  });
});

describe('PlaybackCoordinator coalescence', () => {
  it('activates one returned representation after ordinary playback progress and commits its pending pill state', async () => {
    const player = new FakePlayer();
    const initial = session({ mode: 'direct' });
    const pending = deferred<PlaybackSession>();
    const api = resolver(initial, async () => pending.promise);
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
    await coordinator.start();
    player.emit({ positionMs: 0, durationMs: 600_000, paused: false, ended: false });
    player.emit({ positionMs: 100_000, durationMs: 600_000, paused: false, ended: false });

    coordinator.update({ preferences: { mode: 'transcode' } });
    expect(coordinator.getSnapshot().pendingPreferences?.mode).toBe('transcode');
    player.emit({ positionMs: 103_000, durationMs: 600_000, paused: false, ended: false });
    pending.resolve(session({
      mode: 'transcode',
      seekMs: 100_000,
      preferences: { ...initial.preferences, mode: 'transcode' },
    }));

    await vi.waitFor(() => expect(player.playCalls.at(-1)?.positionMs).toBe(3_000));
    await vi.waitFor(() => expect(coordinator.getSnapshot().preparingSource).toBe(false));
    expect(api.update).toHaveBeenCalledTimes(1);
    expect(coordinator.getSnapshot().session?.preferences.mode).toBe('transcode');
    expect(coordinator.getSnapshot().pendingPreferences).toBeUndefined();
  });

  it('coalesces pending representation updates around the latest intent', async () => {
    const player = new FakePlayer();
    player.localSeekRanges = [{ startMs: 0, endMs: 60_000 }];
    const initial = session({ mode: 'transcode', seekMs: 0 });
    const first = deferred<PlaybackSession>();
    const updates: PlaybackUpdate[] = [];
    let count = 0;
    const api = resolver(initial, async (update) => {
      updates.push(update);
      count += 1;
      if (count === 1) return first.promise;
      return session({ mode: 'transcode', seekMs: update.seekMs ?? 0, // The server only ever echoes a concrete mode; 'choose' is resolved client-side.
        preferences: { ...initial.preferences, ...update.preferences } as PlaybackPreferences });
    });
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
    await coordinator.start();

    coordinator.update({ preferences: { maxHeight: 720 } });
    coordinator.update({ preferences: { audioStream: 2, audioLanguage: '' } });
    coordinator.seek(50_000); // local in current generation; latest transport intent must survive source prep.

    first.resolve(session({ mode: 'transcode', seekMs: 0, preferences: { ...initial.preferences, maxHeight: 720 } }));
    await vi.waitFor(() => {
      expect(updates.length).toBe(2);
    });

    expect(coordinator.getSnapshot().event.positionMs).toBe(50_000);
    expect(updates.at(-1)?.seekMs).toBe(50_000);
    expect(updates.at(-1)?.preferences).toMatchObject({ audioStream: 2, audioLanguage: '' });
    expect(player.playCalls.at(-1)?.positionMs).toBe(0);
    expect(coordinator.getSnapshot().intent.positionMs).toBe(50_000);
  });

  it('merges playback updates without losing orthogonal preferences', () => {
    expect(mergePlaybackUpdate(
      { preferences: { mode: 'remux', maxHeight: 1080 } },
      { preferences: { audioStream: 2, audioLanguage: '' }, mediaId: 'm2' },
    )).toEqual({ preferences: { mode: 'remux', maxHeight: 1080, audioStream: 2, audioLanguage: '' }, mediaId: 'm2' });
  });
});

describe('generationLocalPosition', () => {
  it('maps transformed Web VOD time through the generation origin', () => {
    const transformed = session({ mode: 'remux', seekMs: 30_000 });
    expect(generationLocalPosition(transformed, 40_000)).toBe(10_000);
    expect(generationLocalPosition(transformed, 29_999)).toBeUndefined();
  });
});

describe('Evidence-triggered Direct Play recovery preparation', () => {
  it('accepts only byte-compatible immutable Direct Play sources', () => {
    const primary = session({ sessionId: 'a', mediaId: 'macha:one' });
    const matching = session({ sessionId: 'b', mediaId: 'macha:one', source: { ...primary.source, url: 'http://b/direct' } });
    expect(equivalentDirectSources(primary, matching)).toBe(true);
    expect(equivalentDirectSources(primary, { ...matching, mediaId: 'macha:other' })).toBe(false);
    expect(equivalentDirectSources({ ...primary, mediaId: 'path:/movie' }, { ...matching, mediaId: 'path:/movie' })).toBe(false);
    expect(equivalentDirectSources(primary, { ...matching, source: { ...matching.source, sizeBytes: 99 } })).toBe(false);
  });

  it('creates no standby until degradation evidence, then registers and silently promotes it', async () => {
    const player = new FakePlayer();
    const primary = session({ sessionId: 'primary', mediaId: 'macha:one', endpoint: { id: 'node-a', baseUrl: 'http://a' } });
    const alternate = session({
      sessionId: 'alternate',
      mediaId: 'macha:one',
      endpoint: { id: 'node-b', baseUrl: 'http://b' },
      source: { ...primary.source, mediaId: 'macha:one', url: 'http://b/direct' },
    });
    primary.source.mediaId = 'macha:one';
    const pending = deferred<PlaybackSession | undefined>();
    const api = resolver(primary) as ReturnType<typeof resolver>
      & { prepareAlternate: ReturnType<typeof vi.fn>; recordEndpointFailure: ReturnType<typeof vi.fn> };
    api.prepareAlternate = vi.fn(async () => pending.promise);
    api.recordEndpointFailure = vi.fn();
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });

    await coordinator.start();
    expect(player.playCalls).toHaveLength(1);
    expect(api.prepareAlternate).not.toHaveBeenCalled();

    player.degrade(new PlaybackSourceError('read-ahead TCP failed', 'stream'));
    await vi.waitFor(() => expect(api.prepareAlternate).toHaveBeenCalledTimes(1));

    pending.resolve(alternate);
    await vi.waitFor(() => expect(player.directAlternatives).toHaveLength(1));
    // The alternate is registered as a same-cache-key fallback so an in-flight
    // range request can fail over silently — no video reload, no visible
    // stall — rather than only building a session for a later hard swap.
    expect(player.directAlternatives[0]).toEqual({ active: primary.source, alternate: alternate.source });
    expect(player.playCalls).toHaveLength(1);

    // Nothing tells the coordinator when the read-ahead worker actually uses
    // the registered fallback, so bookkeeping must move immediately rather
    // than waiting on reactive failure evidence: the superseded primary
    // session is closed right away, well before the coordinator itself closes.
    await vi.waitFor(() => expect(api.stop).toHaveBeenCalledWith('primary'));
    // No session negotiation ever failed for the primary endpoint — nothing
    // else would ever tell endpoint health tracking it is down — so a silent
    // promotion must report that failure itself, or a later failover (for an
    // unrelated cause) could still pick this same dead endpoint back up.
    expect(api.recordEndpointFailure).toHaveBeenCalledWith('node-a');

    await coordinator.close();
    expect(api.stop).toHaveBeenCalledWith('alternate', {});
  });

  it('hands a Direct Play alternate over without reloading the element', async () => {
    // The 17 ms silent swap is a byte-level handover: the read-ahead worker
    // changes source underneath an element that never reloads. Promotion goes
    // the other way, through `activateSession` and `player.play()`.
    //
    // Nothing else here asserts the silent path is taken *instead of* that
    // one — only that it happens — so a change routing a Direct Play alternate
    // through promotion-and-reload would pass every other test in this file
    // and lose the seamless swap with nothing to show for it.
    //
    // The pair of assertions is the point: bookkeeping moved, so the swap is
    // real rather than an inert path, and the element was never told to load
    // anything. A promotion satisfies the first and fails the second.
    const player = new FakePlayer();
    const primary = session({ sessionId: 'primary', mediaId: 'macha:one', endpoint: { id: 'node-a', baseUrl: 'http://a' } });
    primary.source.mediaId = 'macha:one';
    const alternate = session({
      sessionId: 'alternate',
      mediaId: 'macha:one',
      endpoint: { id: 'node-b', baseUrl: 'http://b' },
      source: { ...primary.source, mediaId: 'macha:one', url: 'http://b/direct' },
    });
    const api = resolver(primary) as ReturnType<typeof resolver> & { prepareAlternate: ReturnType<typeof vi.fn> };
    api.prepareAlternate = vi.fn(async () => alternate);
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
    await coordinator.start();
    expect(player.playCalls).toHaveLength(1);

    player.degrade(new PlaybackSourceError('read-ahead TCP failed', 'stream'));
    await vi.waitFor(() => expect(player.directAlternatives).toHaveLength(1));
    await flush();

    expect(coordinator.getSnapshot().session?.sessionId).toBe('alternate');
    expect(player.playCalls).toHaveLength(1);
    expect(player.playCalls[0]?.source).toEqual(primary.source);
  });

  it('keeps registering fallbacks against the source truly loaded in the player across chained silent promotions', async () => {
    // The player never reloads across a silent promotion, so a *second*
    // degradation must still register its new fallback against the original
    // source the read-ahead worker actually configured a key for — not
    // whichever session promotion has most recently made current — or the
    // worker cannot find the key it needs to attach the new fallback to.
    const player = new FakePlayer();
    const primary = session({ sessionId: 'primary', mediaId: 'macha:one' });
    const alternateA = session({
      sessionId: 'alternate-a',
      mediaId: 'macha:one',
      endpoint: { id: 'node-b', baseUrl: 'http://b' },
      source: { ...primary.source, mediaId: 'macha:one', url: 'http://b/direct' },
    });
    const alternateB = session({
      sessionId: 'alternate-b',
      mediaId: 'macha:one',
      endpoint: { id: 'node-c', baseUrl: 'http://c' },
      source: { ...primary.source, mediaId: 'macha:one', url: 'http://c/direct' },
    });
    primary.source.mediaId = 'macha:one';
    const api = resolver(primary) as ReturnType<typeof resolver> & { prepareAlternate: ReturnType<typeof vi.fn> };
    api.prepareAlternate = vi.fn()
      .mockResolvedValueOnce(alternateA)
      .mockResolvedValueOnce(alternateB);
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
    await coordinator.start();

    player.degrade(new PlaybackSourceError('read-ahead TCP failed', 'stream'));
    await vi.waitFor(() => expect(player.directAlternatives).toHaveLength(1));
    expect(player.directAlternatives[0]).toEqual({ active: primary.source, alternate: alternateA.source });
    await vi.waitFor(() => expect(api.stop).toHaveBeenCalledWith('primary'));

    player.degrade(new PlaybackSourceError('read-ahead TCP failed', 'stream'));
    await vi.waitFor(() => expect(player.directAlternatives).toHaveLength(2));
    expect(player.directAlternatives[1]).toEqual({ active: primary.source, alternate: alternateB.source });
    await vi.waitFor(() => expect(api.stop).toHaveBeenCalledWith('alternate-a'));

    await coordinator.close();
    expect(api.stop).toHaveBeenCalledWith('alternate-b', {});
  });

  it('does not treat a stream error during an in-flight seek-driven generation replacement as fresh degradation evidence', async () => {
    // A large seek already outside local coverage replaces this generation via
    // resolver.update() (a PATCH), which is expected to make the server tear
    // down the old pipeline. If the old player's stream then errors as a
    // direct result of that expected teardown, degrade() must not treat it as
    // independent evidence and spawn a second, fully redundant session
    // alongside the seek's own already-in-flight replacement.
    const player = new FakePlayer();
    const initial = session({ mode: 'transcode', seekMs: 30_000 });
    const update = deferred<PlaybackSession>();
    const api = resolver(initial, async () => update.promise) as ReturnType<typeof resolver> & { prepareAlternate: ReturnType<typeof vi.fn> };
    api.prepareAlternate = vi.fn(async () => undefined);
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 40_000 });
    await coordinator.start();

    coordinator.seek(10_000);
    await vi.waitFor(() => expect(api.update).toHaveBeenCalledTimes(1));

    player.degrade(new PlaybackSourceError('old generation torn down', 'stream'));
    await flush();
    expect(api.prepareAlternate).not.toHaveBeenCalled();

    update.resolve(session({ mode: 'transcode', seekMs: 8_000, source: { ...initial.source, url: '/generation-8000.m3u8' } }));
    await coordinator.close();
  });

  it('restores the observed position when a seek-driven generation replacement fails', async () => {
    // seek() pins its target optimistically and suppresses real position
    // reporting until the player reaches it. If the generation request never
    // lands, that target must not stay pinned: the scrubber renders
    // intent.positionMs, so it would otherwise sit at a position playback
    // never reached, permanently, while the stream plays on somewhere else.
    const player = new FakePlayer();
    const initial = session({ mode: 'transcode', seekMs: 30_000 });
    const update = deferred<PlaybackSession>();
    const api = resolver(initial, async () => update.promise);
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 40_000 });
    await coordinator.start();
    // Settle the startup activation target (generation origin 30s + local 10s
    // == the 40s start), so position reporting is following the player again.
    player.emit({ positionMs: 10_000, durationMs: 600_000, paused: false, ended: false });
    player.emit({ positionMs: 11_000, durationMs: 600_000, paused: false, ended: false });
    expect(coordinator.getSnapshot().intent.positionMs).toBe(41_000);

    coordinator.seek(10_000);
    await vi.waitFor(() => expect(api.update).toHaveBeenCalledTimes(1));
    expect(coordinator.getSnapshot().intent.positionMs).toBe(10_000);

    update.reject(new Error('node rejected the seek'));

    await vi.waitFor(() => expect(coordinator.getSnapshot().intent.positionMs).toBe(41_000));
    // And position reporting follows the player again rather than staying pinned.
    player.emit({ positionMs: 12_000, durationMs: 600_000, paused: false, ended: false });
    expect(coordinator.getSnapshot().intent.positionMs).toBe(42_000);
    await coordinator.close();
  });

  it('does not register a direct-source alternative for a transformed (non-direct) standby', async () => {
    const player = new FakePlayer();
    const primary = session({ sessionId: 'primary', mediaId: 'macha:one', mode: 'remux' });
    const alternate = session({
      sessionId: 'alternate',
      mediaId: 'macha:one',
      mode: 'remux',
      endpoint: { id: 'node-b', baseUrl: 'http://b' },
    });
    const api = resolver(primary) as ReturnType<typeof resolver> & { prepareAlternate: ReturnType<typeof vi.fn> };
    api.prepareAlternate = vi.fn(async () => alternate);
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
    await coordinator.start();

    player.degrade(new PlaybackSourceError('read-ahead TCP failed', 'stream'));
    await vi.waitFor(() => expect(api.prepareAlternate).toHaveBeenCalledTimes(1));
    await flush();

    expect(player.directAlternatives).toHaveLength(0);
    await coordinator.close();
  });

  it('expires an evidence-triggered transformed standby after thirty seconds when the primary continues', async () => {
    // A Direct Play standby is promoted immediately once its fallback source
    // is registered (see the silent-promotion test above) rather than sitting
    // on this expiry clock. Transformed (HLS/remux) sources have no
    // equivalent read-ahead fallback and still rely on the thirty-second
    // recovery window, only promoted reactively if the primary actually fails.
    vi.useFakeTimers();
    try {
      const player = new FakePlayer();
      const primary = session({ sessionId: 'primary', mediaId: 'macha:one', mode: 'remux' });
      const alternate = session({
        sessionId: 'alternate',
        mediaId: 'macha:one',
        mode: 'remux',
        source: { ...primary.source, url: 'http://b/direct' },
      });
      const api = resolver(primary) as ReturnType<typeof resolver> & { prepareAlternate: ReturnType<typeof vi.fn> };
      api.prepareAlternate = vi.fn(async () => alternate);
      const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
      await coordinator.start();

      player.degrade(new PlaybackSourceError('read-ahead TCP failed', 'stream'));
      await flush();
      await flush();
      expect(api.stop).not.toHaveBeenCalledWith('alternate');
      expect(player.directAlternatives).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(api.stop).toHaveBeenCalledWith('alternate');
      await coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });
});


describe('PlaybackCoordinator player failures', () => {
  it('treats an ended event far short of authoritative duration as failover evidence', async () => {
    const player = new FakePlayer();
    const initial = session({ endpoint: { id: 'node-a', baseUrl: 'http://a' } });
    const replacement = session({
      sessionId: 's2', endpoint: { id: 'node-b', baseUrl: 'http://b' },
      source: { ...initial.source, url: 'http://b/replacement.mp4' },
    });
    const api = resolver(initial) as ReturnType<typeof resolver> & { failover: ReturnType<typeof vi.fn> };
    api.failover = vi.fn(async () => replacement);
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
    await coordinator.start();

    player.emit({ positionMs: 0, durationMs: 600_000, paused: false, ended: false });
    player.emit({ positionMs: 240_000, durationMs: 600_000, paused: false, ended: false });
    player.emit({ positionMs: 240_000, durationMs: 240_000, paused: true, ended: true });

    expect(coordinator.getSnapshot().event.ended).toBe(false);
    expect(coordinator.getSnapshot().event.buffering).toBe(true);
    await vi.waitFor(() => expect(api.failover).toHaveBeenCalledWith(
      initial,
      expect.any(Object),
      expect.any(Object),
      240_000,
      expect.any(Object),
      undefined,
    ));
    await vi.waitFor(() => expect(player.playCalls.at(-1)?.source.url).toBe('http://b/replacement.mp4'));
    expect(coordinator.getSnapshot().fatalError).toBeUndefined();
  });

  it('retains a genuine ended event within the completion tolerance', async () => {
    const player = new FakePlayer();
    const api = resolver(session()) as ReturnType<typeof resolver> & { failover: ReturnType<typeof vi.fn> };
    api.failover = vi.fn();
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
    await coordinator.start();

    player.emit({ positionMs: 598_000, durationMs: 598_000, paused: true, ended: true });

    expect(isPrematurePlaybackEnd(598_000, 600_000)).toBe(false);
    expect(coordinator.getSnapshot().event.ended).toBe(true);
    expect(api.failover).not.toHaveBeenCalled();
  });

  it('does not condemn a healthy endpoint when the player proves a decoder failure', async () => {
    const player = new FakePlayer();
    const api = resolver(session({ endpoint: { id: 'node-a', baseUrl: 'http://a' } })) as ReturnType<typeof resolver> & { failover: ReturnType<typeof vi.fn> };
    api.failover = vi.fn();
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
    await coordinator.start();

    player.fail(new PlaybackSourceError('browser rejected the video stream', 'media'));

    expect(api.failover).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().fatalError?.message).toBe('browser rejected the video stream');
  });

  it('does not prepare a standby when the node is holding a fragment it has not produced yet', async () => {
    // A node near the production frontier answers `503 segment_not_ready` with
    // a Retry-After. That is the node working, and it is a 5xx on a fragment
    // exactly like a stream loss is, so only the adapter can tell them apart.
    const player = new FakePlayer();
    const primary = session({ sessionId: 'primary', mediaId: 'macha:one', mode: 'remux' });
    const alternate = session({ sessionId: 'alternate', mediaId: 'macha:one', mode: 'remux', endpoint: { id: 'node-b', baseUrl: 'http://b' } });
    const api = resolver(primary) as ReturnType<typeof resolver> & { prepareAlternate: ReturnType<typeof vi.fn> };
    api.prepareAlternate = vi.fn(async () => alternate);
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
    await coordinator.start();

    player.degrade(new PlaybackSourceError('segment not produced yet', 'not-ready'));
    await flush();

    expect(api.prepareAlternate).not.toHaveBeenCalled();
  });

  it('does not fail over to another node when a fragment is merely being held', async () => {
    // The next node holds a different generation, so failing over cannot
    // produce the fragment sooner — it discards a working session to ask a
    // stranger for something only this node is making.
    const player = new FakePlayer();
    const initial = session({ endpoint: { id: 'node-a', baseUrl: 'http://a' } });
    const replacement = session({
      sessionId: 's2', endpoint: { id: 'node-b', baseUrl: 'http://b' },
      source: { ...initial.source, url: 'http://b/replacement.mp4' },
    });
    const api = resolver(initial) as ReturnType<typeof resolver> & { failover: ReturnType<typeof vi.fn> };
    api.failover = vi.fn(async () => replacement);
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
    await coordinator.start();

    player.fail(new PlaybackSourceError('segment not produced yet', 'not-ready'));
    await flush();

    expect(api.failover).not.toHaveBeenCalled();
  });

  describe('what a standby costs the node holding it', () => {
    const standbyFor = async (mode: 'remux' | 'transcode') => {
      const player = new FakePlayer();
      const primary = session({ sessionId: 'primary', mediaId: 'macha:one', mode });
      const alternate = session({ sessionId: 'alternate', mediaId: 'macha:one', mode, endpoint: { id: 'node-b', baseUrl: 'http://b' } });
      const api = resolver(primary) as ReturnType<typeof resolver>
        & { prepareAlternate: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
      api.prepareAlternate = vi.fn(async () => alternate);
      const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
      await coordinator.start();
      player.degrade(new PlaybackSourceError('read-ahead TCP failed', 'stream'));
      await vi.waitFor(() => expect(api.prepareAlternate).toHaveBeenCalledTimes(1));
      await flush();
      return api;
    };

    it('releases a transcode standby quickly, because it holds the node\'s only slot', async () => {
      // A node counts a session against `max_video_transcodes` from admission
      // until destruction — reclaiming its pipeline does not release the
      // entitlement — and these nodes have one slot. So an unused transcode
      // standby is thirty seconds in which nobody else on that node can start
      // one. Verified against the server: 8 s, not 30 s.
      vi.useFakeTimers();
      try {
        const api = await standbyFor('transcode');
        expect(api.stop).not.toHaveBeenCalledWith('alternate');
        await vi.advanceTimersByTimeAsync(9_000);
        expect(api.stop).toHaveBeenCalledWith('alternate');
      } finally {
        vi.useRealTimers();
      }
    });

    it('holds a remux standby for the full window, which costs the node nothing scarce', async () => {
      // Remux is entitled to no transcode slot: the node keeps a session
      // record and nothing a another viewer is competing for.
      vi.useFakeTimers();
      try {
        const api = await standbyFor('remux');
        await vi.advanceTimersByTimeAsync(9_000);
        expect(api.stop).not.toHaveBeenCalledWith('alternate');
        await vi.advanceTimersByTimeAsync(22_000);
        expect(api.stop).toHaveBeenCalledWith('alternate');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('a standby that is ready while the node keeps failing', () => {
    const remuxSession = (overrides = {}) => session({ mode: 'remux', mediaId: 'macha:one', ...overrides });

    it('promotes it rather than waiting for a fatal that is a minute away', async () => {
      // Measured against a stopped node: standby ready in 267 ms, discarded
      // unused at 30 s, rebuilt from scratch at 63 s. The player's own retry
      // budget outlasts the standby's window, so waiting for fatal guarantees
      // the rescue goes stale.
      const player = new FakePlayer();
      const primary = remuxSession({ sessionId: 'primary' });
      const alternate = remuxSession({ sessionId: 'alternate', endpoint: { id: 'node-b', baseUrl: 'http://b' } });
      const api = resolver(primary) as ReturnType<typeof resolver> & { prepareAlternate: ReturnType<typeof vi.fn> };
      api.prepareAlternate = vi.fn(async () => alternate);
      const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
      await coordinator.start();

      player.degrade(new PlaybackSourceError('read-ahead TCP failed', 'stream'));
      await vi.waitFor(() => expect(api.prepareAlternate).toHaveBeenCalledTimes(1));
      await flush();
      expect(player.playCalls).toHaveLength(1);

      player.degrade(new PlaybackSourceError('read-ahead TCP failed again', 'stream'));
      await vi.waitFor(() => expect(player.playCalls).toHaveLength(2));

      expect(player.playCalls.at(-1)?.source).toEqual(alternate.source);
      expect(coordinator.getSnapshot().session?.sessionId).toBe('alternate');
    });

    it('closes the primary it walked away from', async () => {
      // The cleanup call passed a fresh record to a method that acts only on
      // the record it already owns, so it was a no-op: the promoted-from
      // session was never deleted, and a one-slot node kept its transcode
      // counted for `session_idle`, thirty minutes. The test that would have
      // caught it asserted only the play call.
      const player = new FakePlayer();
      const primary = remuxSession({ sessionId: 'primary', endpoint: { id: 'node-a', baseUrl: 'http://a' } });
      const alternate = remuxSession({ sessionId: 'alternate', endpoint: { id: 'node-b', baseUrl: 'http://b' } });
      const api = resolver(primary) as ReturnType<typeof resolver> & { prepareAlternate: ReturnType<typeof vi.fn> };
      api.prepareAlternate = vi.fn(async () => alternate);
      const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
      await coordinator.start();

      player.degrade(new PlaybackSourceError('first', 'stream'));
      await vi.waitFor(() => expect(api.prepareAlternate).toHaveBeenCalledTimes(1));
      await flush();
      expect(api.stop).not.toHaveBeenCalled();

      player.degrade(new PlaybackSourceError('second', 'stream'));
      await vi.waitFor(() => expect(player.playCalls).toHaveLength(2));
      await vi.waitFor(() => expect(api.stop).toHaveBeenCalledWith('primary'));
      expect(api.stop).not.toHaveBeenCalledWith('alternate');

      await coordinator.close();
    });

    it('tells the registry the abandoned node is unwell', async () => {
      // It never refused a session, it stopped serving bytes, so nothing else
      // would ever record it — and a later failover would pick it straight
      // back up as an apparently untried candidate.
      const player = new FakePlayer();
      const primary = remuxSession({ sessionId: 'primary', endpoint: { id: 'node-a', baseUrl: 'http://a' } });
      const alternate = remuxSession({ sessionId: 'alternate', endpoint: { id: 'node-b', baseUrl: 'http://b' } });
      const api = resolver(primary) as ReturnType<typeof resolver>
        & { prepareAlternate: ReturnType<typeof vi.fn>; recordEndpointFailure: ReturnType<typeof vi.fn> };
      api.prepareAlternate = vi.fn(async () => alternate);
      api.recordEndpointFailure = vi.fn();
      const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
      await coordinator.start();

      player.degrade(new PlaybackSourceError('first', 'stream'));
      await vi.waitFor(() => expect(api.prepareAlternate).toHaveBeenCalledTimes(1));
      await flush();
      player.degrade(new PlaybackSourceError('second', 'stream'));
      await vi.waitFor(() => expect(api.recordEndpointFailure).toHaveBeenCalledWith('node-a'));
    });

    it('does not promote on the first failure, because there is nothing built yet', async () => {
      const player = new FakePlayer();
      const api = resolver(remuxSession({ sessionId: 'primary' })) as ReturnType<typeof resolver> & { prepareAlternate: ReturnType<typeof vi.fn> };
      api.prepareAlternate = vi.fn(async () => remuxSession({ sessionId: 'alternate', endpoint: { id: 'node-b', baseUrl: 'http://b' } }));
      const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
      await coordinator.start();

      player.degrade(new PlaybackSourceError('first', 'stream'));
      await flush();

      // One play call: the original. The first failure builds the rescue, it
      // does not use it.
      expect(player.playCalls).toHaveLength(1);
    });

    it('leaves a seek alone rather than racing it with a second replacement', async () => {
      // A seek outside local coverage is already replacing this generation.
      // Promoting alongside it produces two live replacements for one viewer.
      const player = new FakePlayer();
      const primary = remuxSession({ sessionId: 'primary' });
      const alternate = remuxSession({ sessionId: 'alternate', endpoint: { id: 'node-b', baseUrl: 'http://b' } });
      const stuck = deferred<PlaybackSession>();
      const api = resolver(primary, async () => stuck.promise) as ReturnType<typeof resolver> & { prepareAlternate: ReturnType<typeof vi.fn> };
      api.prepareAlternate = vi.fn(async () => alternate);
      const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
      await coordinator.start();

      player.degrade(new PlaybackSourceError('first', 'stream'));
      await vi.waitFor(() => expect(api.prepareAlternate).toHaveBeenCalledTimes(1));
      await flush();

      coordinator.seek(600_000);
      await flush();
      player.degrade(new PlaybackSourceError('teardown from the seek', 'stream'));
      await flush();

      expect(coordinator.getSnapshot().session?.sessionId).toBe('primary');
    });
  });

  it('promotes a terminal platform-source failure into coordinator fatal state', async () => {
    const player = new FakePlayer();
    const api = resolver(session({ mode: 'transcode' }));
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
    await coordinator.start();

    player.fail(new Error('Web HLS media recovery exhausted'));

    expect(coordinator.getSnapshot().fatalError?.message).toBe('Web HLS media recovery exhausted');
    expect(coordinator.getSnapshot().starting).toBe(false);
  });

  it('recreates playback on another node from the latest client-owned intent before failing visibly', async () => {
    const player = new FakePlayer();
    const initial = session({ endpoint: { id: 'node-a', baseUrl: 'http://a' }, preferences: {
      ...session().preferences,
      mode: 'remux',
      maxHeight: 720,
      subtitleLanguage: 'eng',
    } });
    const replacement = session({
      sessionId: 's2',
      endpoint: { id: 'node-b', baseUrl: 'http://b' },
      mode: 'remux',
      seekMs: 42_000,
      source: { ...initial.source, mode: 'remux', url: 'http://b/replacement.m3u8' },
    });
    const api = resolver(initial) as ReturnType<typeof resolver> & { failover: ReturnType<typeof vi.fn> };
    api.failover = vi.fn(async () => replacement);
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
    await coordinator.start();
    player.emit({ positionMs: 0, durationMs: 600_000, paused: false, ended: false });
    player.emit({ positionMs: 42_000, durationMs: 600_000, paused: false, ended: false });

    player.fail(new Error('node A stream failed'));

    await vi.waitFor(() => expect(player.playCalls.at(-1)?.source.url).toBe('http://b/replacement.m3u8'));
    expect(api.failover).toHaveBeenCalledWith(
      initial,
      expect.objectContaining({ id: 'tmdb:movie:1' }),
      expect.objectContaining({ platform: 'web' }),
      42_000,
      expect.objectContaining({ mode: 'remux', maxHeight: 720, subtitleLanguage: 'eng' }),
      undefined,
    );
    expect(coordinator.getSnapshot().fatalError).toBeUndefined();
    expect(coordinator.getSnapshot().session?.endpoint?.id).toBe('node-b');
  });

  it('does not act on a stream error during an in-flight seek-driven generation replacement until the seek settles, then drops it as stale once the seek replaces the source', async () => {
    // Mirrors the degrade() race (see the transport-invariants test above),
    // but fail() can never just drop the error the way degrade() does — it
    // must wait for the seek's own generation replacement to settle and
    // judge from what actually happened, since a bare early return would
    // leave a genuinely unrelated fatal error with neither recovery nor
    // failure UI.
    const player = new FakePlayer();
    const initial = session({ mode: 'transcode', seekMs: 30_000 });
    const update = deferred<PlaybackSession>();
    const api = resolver(initial, async () => update.promise) as ReturnType<typeof resolver> & { failover: ReturnType<typeof vi.fn> };
    api.failover = vi.fn();
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 40_000 });
    await coordinator.start();

    coordinator.seek(10_000);
    await vi.waitFor(() => expect(api.update).toHaveBeenCalledTimes(1));

    player.fail(new PlaybackSourceError('old generation torn down', 'stream'));
    await flush();
    expect(coordinator.getSnapshot().fatalError).toBeUndefined();
    expect(api.failover).not.toHaveBeenCalled();

    update.resolve(session({ mode: 'transcode', seekMs: 8_000, source: { ...initial.source, url: '/generation-8000.m3u8' } }));
    await flush();
    await flush();

    expect(coordinator.getSnapshot().fatalError).toBeUndefined();
    expect(api.failover).not.toHaveBeenCalled();
    await coordinator.close();
  });

  it('still surfaces a fatal error that arrives during an in-flight seek once the seek settles without replacing the source', async () => {
    // The other half of the race above: the fatal error is genuinely
    // unrelated to the seek (here, the seek's own generation request fails),
    // so once the in-flight mutation settles the error must still be
    // handled — not silently swallowed by a naive copy of degrade()'s guard.
    const player = new FakePlayer();
    const initial = session({ mode: 'transcode', seekMs: 30_000 });
    const update = deferred<PlaybackSession>();
    const api = resolver(initial, async () => update.promise) as ReturnType<typeof resolver> & { failover: ReturnType<typeof vi.fn> };
    api.failover = vi.fn();
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 40_000 });
    await coordinator.start();

    coordinator.seek(10_000);
    await vi.waitFor(() => expect(api.update).toHaveBeenCalledTimes(1));

    player.fail(new PlaybackSourceError('browser rejected the video stream', 'media'));
    await flush();
    expect(coordinator.getSnapshot().fatalError).toBeUndefined();

    update.reject(new Error('generation update failed'));
    await vi.waitFor(() => expect(coordinator.getSnapshot().fatalError?.message).toBe('browser rejected the video stream'));
    expect(api.failover).not.toHaveBeenCalled();
    await coordinator.close();
  });

  it('recreates a failed generation with a representation change the failed node had not yet confirmed', async () => {
    const player = new FakePlayer();
    const initial = session({ endpoint: { id: 'node-a', baseUrl: 'http://a' } });
    const stuckUpdate = deferred<PlaybackSession>();
    const replacement = session({
      sessionId: 's2', endpoint: { id: 'node-b', baseUrl: 'http://b' },
      source: { ...initial.source, url: 'http://b/replacement.mp4' },
    });
    const api = resolver(initial, async () => stuckUpdate.promise) as ReturnType<typeof resolver> & { failover: ReturnType<typeof vi.fn> };
    api.failover = vi.fn(async () => replacement);
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
    await coordinator.start();

    // A representation change is in flight to node A (never resolves in this
    // test) when node A's stream itself fails. The not-yet-confirmed
    // preference must still reach the replacement node.
    coordinator.update({ preferences: { audioStream: 2, audioLanguage: 'fra' } });
    expect(coordinator.getSnapshot().pendingPreferences).toMatchObject({ audioStream: 2, audioLanguage: 'fra' });

    player.fail(new Error('node A stream failed'));

    await vi.waitFor(() => expect(api.failover).toHaveBeenCalledWith(
      initial,
      expect.any(Object),
      expect.any(Object),
      0,
      expect.objectContaining({ audioStream: 2, audioLanguage: 'fra' }),
      undefined,
    ));
    await vi.waitFor(() => expect(player.playCalls.at(-1)?.source.url).toBe('http://b/replacement.mp4'));
    stuckUpdate.resolve(initial);
    await flush();
  });

  it('leaves the failed session to the resolver that abandoned it', async () => {
    // Teardown after a failover belongs to `resolver.failover()`, which
    // released the old session at the moment it gave up on it. Two of the
    // four clients call the resolver directly and never build a coordinator,
    // so teardown up here is teardown half the consumers never get — and a
    // second owner would DELETE a session already gone and charge the
    // registry for the dead node failing to answer about it.
    const player = new FakePlayer();
    const initial = session({ endpoint: { id: 'node-a', baseUrl: 'http://a' } });
    const replacement = session({
      sessionId: 's2', endpoint: { id: 'node-b', baseUrl: 'http://b' },
      source: { ...initial.source, url: 'http://b/replacement.mp4' },
    });
    const api = resolver(initial) as ReturnType<typeof resolver> & { failover: ReturnType<typeof vi.fn> };
    api.failover = vi.fn(async () => replacement);
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
    await coordinator.start();

    player.fail(new PlaybackSourceError('primary stream failed', 'stream'));
    await vi.waitFor(() => expect(player.playCalls.at(-1)?.source.url).toBe('http://b/replacement.mp4'));
    // The event that used to release the deferred cleanup. Nothing is owed.
    player.emit({ positionMs: 0, durationMs: 600_000, paused: false, ended: false, bufferedRangesMs: [{ startMs: 0, endMs: 5_000 }] });
    await flush();

    expect(api.stop).not.toHaveBeenCalled();
    await coordinator.close();
  });

  it('promotes a preflighted transformed generation without negotiating another session', async () => {
    const player = new FakePlayer();
    const initial = session({
      mode: 'remux', endpoint: { id: 'node-a', baseUrl: 'http://a' },
      source: { ...session().source, mode: 'remux', url: 'http://a/primary.m3u8' },
    });
    const alternate = session({
      sessionId: 'standby', mode: 'remux', endpoint: { id: 'node-b', baseUrl: 'http://b' },
      source: { ...session().source, mode: 'remux', url: 'http://b/standby.m3u8' },
    });
    const api = resolver(initial) as ReturnType<typeof resolver> & {
      prepareAlternate: ReturnType<typeof vi.fn>;
      failover: ReturnType<typeof vi.fn>;
    };
    api.prepareAlternate = vi.fn(async () => alternate);
    api.failover = vi.fn(async (_failed, _media, _capabilities, _seek, _preferences, prepared) => prepared);
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
    await coordinator.start();
    expect(api.prepareAlternate).not.toHaveBeenCalled();
    player.degrade(new PlaybackSourceError('primary HLS network degraded', 'stream'));
    await vi.waitFor(() => expect(player.preflightCalls).toEqual([alternate.source]));

    player.fail(new PlaybackSourceError('primary HLS network exhausted', 'stream'));

    await vi.waitFor(() => expect(player.playCalls.at(-1)?.source.url).toBe('http://b/standby.m3u8'));
    expect(api.failover).toHaveBeenCalledWith(
      initial,
      expect.objectContaining({ id: media().id }),
      expect.any(Object),
      0,
      expect.any(Object),
      alternate,
    );
  });

  it('prepares and promotes transformed standby when an existing player has no preflight hook', async () => {
    const player = new FakePlayer();
    (player as Player).preflightSource = undefined;
    const initial = session({
      mode: 'remux', endpoint: { id: 'node-a', baseUrl: 'http://a' },
      source: { ...session().source, mode: 'remux', url: 'http://a/primary.m3u8' },
    });
    const alternate = session({
      sessionId: 'standby', mode: 'remux', endpoint: { id: 'node-b', baseUrl: 'http://b' },
      source: { ...session().source, mode: 'remux', url: 'http://b/standby.m3u8' },
    });
    const api = resolver(initial) as ReturnType<typeof resolver> & {
      prepareAlternate: ReturnType<typeof vi.fn>;
      failover: ReturnType<typeof vi.fn>;
    };
    api.prepareAlternate = vi.fn(async () => alternate);
    api.failover = vi.fn(async (_failed, _media, _capabilities, _seek, _preferences, prepared) => prepared);
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });

    await coordinator.start();
    player.degrade(new PlaybackSourceError('primary HLS network degraded', 'stream'));
    await vi.waitFor(() => expect(api.prepareAlternate).toHaveBeenCalledTimes(1));
    player.fail(new PlaybackSourceError('primary HLS network exhausted', 'stream'));

    await vi.waitFor(() => expect(player.playCalls.at(-1)?.source.url).toBe('http://b/standby.m3u8'));
    expect(api.failover).toHaveBeenCalledWith(
      initial,
      expect.objectContaining({ id: media().id }),
      expect.any(Object),
      0,
      expect.any(Object),
      alternate,
    );
  });

  it('closes a transformed standby lease when its stream preflight fails', async () => {
    const player = new FakePlayer();
    player.preflightSource = vi.fn(async () => { throw new TypeError('standby TCP failed'); });
    const initial = session({
      mode: 'remux', endpoint: { id: 'node-a', baseUrl: 'http://a' },
      source: { ...session().source, mode: 'remux', url: 'http://a/primary.m3u8' },
    });
    const alternate = session({
      sessionId: 'standby', mode: 'remux', endpoint: { id: 'node-b', baseUrl: 'http://b' },
      source: { ...session().source, mode: 'remux', url: 'http://b/standby.m3u8' },
    });
    const api = resolver(initial) as ReturnType<typeof resolver> & { prepareAlternate: ReturnType<typeof vi.fn> };
    api.prepareAlternate = vi.fn(async () => alternate);
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });

    await coordinator.start();
    player.degrade(new PlaybackSourceError('primary HLS network degraded', 'stream'));
    await vi.waitFor(() => expect(api.stop).toHaveBeenCalledWith('standby'));
    await coordinator.close();
  });

  it('asks a replacement node for the same segment container the generation was created with', async () => {
    // A device handed fragmented MP4 where it asked for MPEG-TS shows a black
    // picture and reports nothing, so the starvation is charged to a node
    // that did exactly what it was told. `container` is not among a session's
    // confirmed preferences, so failover has to restate it — the update path
    // already does.
    const player = new FakePlayer();
    const remux = { mode: 'remux' as const, maxHeight: null, maxBitrate: null, audioStream: 1, subtitleStream: null, audioLanguage: '', subtitleLanguage: '' };
    const initial = session({ mode: 'remux', preferences: remux, endpoint: { id: 'node-a', baseUrl: 'http://a' } });
    const api = resolver(initial) as ReturnType<typeof resolver> & { failover: ReturnType<typeof vi.fn> };
    api.failover = vi.fn(async () => session({
      sessionId: 'replacement', mode: 'remux', preferences: remux, endpoint: { id: 'node-b', baseUrl: 'http://b' },
    }));
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: api, capabilities: async () => capabilities(),
      initialPreferences: { mode: 'remux', container: 'mpegts' }, initialPositionMs: 0,
    });
    await coordinator.start();

    player.fail(new PlaybackSourceError('node A stream failed', 'stream'));

    await vi.waitFor(() => expect(api.failover).toHaveBeenCalled());
    expect(api.failover.mock.calls[0][4]).toMatchObject({ mode: 'remux', container: 'mpegts' });
    await coordinator.close();
  });

  it('enters terminal failure only after alternate generation recreation is exhausted', async () => {
    const player = new FakePlayer();
    const initial = session({ endpoint: { id: 'node-a', baseUrl: 'http://a' } });
    const api = resolver(initial) as ReturnType<typeof resolver> & { failover: ReturnType<typeof vi.fn> };
    api.failover = vi.fn(async () => { throw new Error('No untried Macha playback endpoint remains.'); });
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
    await coordinator.start();

    player.fail(new Error('node A stream failed'));

    await vi.waitFor(() => expect(coordinator.getSnapshot().fatalError?.message).toContain('No untried'));
    expect(api.failover).toHaveBeenCalledTimes(1);
  });
});


describe('PlaybackCoordinator lease teardown', () => {
  it('waits for an in-flight session create and deletes the late lease before close resolves', async () => {
    const player = new FakePlayer();
    const pending = deferred<PlaybackSession>();
    const api = resolver(session());
    api.resolve.mockImplementationOnce(async () => pending.promise);
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });

    const starting = coordinator.start();
    await vi.waitFor(() => expect(api.resolve).toHaveBeenCalledTimes(1));
    const closing = coordinator.close();
    pending.resolve(session());
    await Promise.all([starting, closing]);

    expect(api.stop).toHaveBeenCalledWith('s1', {});
    expect(player.playCalls).toHaveLength(0);
    expect(player.stopCalls).toBe(1);
    expect(player.detachCalls).toBe(0);
  });

  it('propagates keepalive to the owned lease teardown', async () => {
    const player = new FakePlayer();
    const api = resolver(session());
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
    await coordinator.start();

    await coordinator.close({ keepalive: true });

    expect(api.stop).toHaveBeenCalledWith('s1', { keepalive: true });
  });
});

describe('choosing an instruction mid-session', () => {
  it('re-decides when the viewer selects Auto, rather than silently changing nothing', async () => {
    // The failure this pins: an absent mode on an update leaves the server on
    // whatever it was already doing, so the control highlights and does
    // nothing — worse than an error, because there is nothing to notice.
    const updates: PlaybackUpdate[] = [];
    const initial = session({ mode: 'transcode' });
    const api = resolver(initial, async (update) => {
      updates.push(update);
      return session({ mode: 'direct', preferences: { ...initial.preferences, ...update.preferences } as PlaybackPreferences });
    });
    const player = new FakePlayer();

    let profileLookups = 0;
    const coordinator = new PlaybackCoordinator({
      media: media(),
      player,
      resolver: api,
      capabilities: async () => capabilities(),
      initialPositionMs: 0,
      initialPreferences: { mode: 'transcode' },
      facts: async () => {
        profileLookups += 1;
        return { profile: { mediaId: 'm1', format: 'mov,mp4', container: 'mp4', durationMs: 1_000, bitrate: 1_000, streams: [
          { index: 0, type: 'video', codec: 'h264', profile: '', language: '', default: true, forced: false },
          { index: 1, type: 'audio', codec: 'aac', profile: '', language: '', default: true, forced: false },
        ] } };
      },
    });
    await coordinator.start();

    coordinator.update({ preferences: { mode: 'choose' } });
    await vi.waitFor(() => expect(updates.length).toBeGreaterThan(0));

    // The sentinel never reaches the resolver: it arrives as a real decision.
    const sent = updates.at(-1)?.preferences;
    expect(sent?.mode).toBe('direct');
    expect(sent?.video).toBe('copy');
    expect(sent?.audio).toBe('copy');

    // And the immutable facts were fetched once, not per toggle.
    coordinator.update({ preferences: { mode: 'choose' } });
    await vi.waitFor(() => expect(updates.length).toBeGreaterThan(1));
    expect(profileLookups).toBe(1);
  });
});

describe('the instruction has a symptom when it is a fallback', () => {
  it('reports withoutFacts rather than looking like a decision', async () => {
    // The worst failure in the chooser is silent: facts unavailable, fall back
    // to transcode, viewer sees a working picture, nobody ever looks. A whole
    // library quietly transcoded on a cluster that appears healthy.
    const player = new FakePlayer();
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: resolver(session({ mode: 'transcode' })),
      capabilities: async () => capabilities(), initialPositionMs: 0,
      facts: async () => { throw Object.assign(new Error('no route'), { status: 404 }); },
    });
    await coordinator.start();

    const report = coordinator.getSnapshot().instruction;
    expect(report?.withoutFacts).toBe(true);
    expect(report?.chosenByViewer).toBe(false);
    expect(report?.mode).toBe('transcode');
    expect(report?.reasons).toContain('no-technical-facts');
  });

  it('still asks for the host\'s container when it has no facts to reason from', async () => {
    // A Samsung host asks for MPEG-TS because fragmented MP4 black-screens on
    // the device, and a failed facts lookup says nothing about that: carriage
    // is decided by the host and the device, and `segmentContainer` needs
    // neither the profile nor the node's operations to decide it. Asked for
    // no container at all, the node defaults to fMP4 — and failover then
    // restates that wrong answer into every replacement, which is the silent
    // starvation 0.6.3 already paid for once.
    const player = new FakePlayer();
    const api = resolver(session({ mode: 'transcode' }));
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: api,
      capabilities: async () => ({ ...capabilities(), hlsTs: true }),
      initialPositionMs: 0,
      policyOverrides: { preferSegmentContainer: 'mpegts' },
      facts: async () => undefined,
    });

    await coordinator.start();

    expect(api.resolve.mock.calls[0][3]).toMatchObject({ mode: 'transcode', container: 'mpegts' });
    expect(coordinator.getSnapshot().instruction).toMatchObject({ withoutFacts: true, container: 'mpegts' });
  });

  it('shows the container it asked for beside the one it got', async () => {
    // A node that ignores a segment-container preference produces a real
    // container on screen that is not the requested one, and nothing points
    // at the discrepancy unless both are reported together.
    const player = new FakePlayer();
    const coordinator = new PlaybackCoordinator({
      media: media(), player,
      resolver: resolver(session({ mode: 'remux', output: { format: 'hls', container: 'fmp4' } })),
      capabilities: async () => capabilities(), initialPositionMs: 0,
      initialPreferences: { mode: 'remux', container: 'mpegts' },
    });
    await coordinator.start();

    expect(coordinator.getSnapshot().instruction).toMatchObject({
      container: 'mpegts', servedContainer: 'fmp4', containerHonoured: false,
    });
  });

  it('confirms the preference when the node honoured it', async () => {
    const player = new FakePlayer();
    const coordinator = new PlaybackCoordinator({
      media: media(), player,
      resolver: resolver(session({ mode: 'remux', output: { format: 'hls', container: 'mpegts' } })),
      capabilities: async () => capabilities(), initialPositionMs: 0,
      initialPreferences: { mode: 'remux', container: 'mpegts' },
    });
    await coordinator.start();

    expect(coordinator.getSnapshot().instruction).toMatchObject({
      container: 'mpegts', servedContainer: 'mpegts', containerHonoured: true,
    });
  });

  it('does not claim the preference was honoured by a node that never said', async () => {
    // An unanswered question must not read as an answer — a node predating
    // the field would otherwise silently confirm every preference it ignores.
    const player = new FakePlayer();
    const coordinator = new PlaybackCoordinator({
      media: media(), player,
      resolver: resolver(session({ mode: 'remux', output: { format: 'hls' } })),
      capabilities: async () => capabilities(), initialPositionMs: 0,
      initialPreferences: { mode: 'remux', container: 'mpegts' },
    });
    await coordinator.start();

    const report = coordinator.getSnapshot().instruction;
    expect(report?.container).toBe('mpegts');
    expect(report?.servedContainer).toBeUndefined();
    expect(report?.containerHonoured).toBeUndefined();
  });

  it('marks a viewer’s own choice as theirs, not the chooser’s', async () => {
    const player = new FakePlayer();
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: resolver(session({ mode: 'direct' })),
      capabilities: async () => capabilities(), initialPositionMs: 0,
      initialPreferences: { mode: 'direct' },
    });
    await coordinator.start();

    expect(coordinator.getSnapshot().instruction).toMatchObject({ mode: 'direct', chosenByViewer: true, withoutFacts: false });
  });
});

describe('preferences a mode change clears', () => {
  // Server 0.34.0: naming `mode` on a PATCH restates the whole transform.
  const capped = session({
    mode: 'transcode',
    preferences: {
      mode: 'transcode', maxHeight: 720, maxBitrate: 4_000_000,
      audioStream: 1, subtitleStream: null, audioLanguage: '', subtitleLanguage: '',
    },
  });

  it('carries a quality ceiling into a transcode that can still apply it', () => {
    const update = restatePreferencesClearedByMode({ preferences: { mode: 'transcode' } }, capped, 'mpegts');
    expect(update.preferences).toEqual({
      mode: 'transcode', maxHeight: 720, maxBitrate: 4_000_000, container: 'mpegts',
    });
  });

  it('lets the ceiling go when the viewer asks for a copy', () => {
    // Nothing re-encodes in Direct or Remux, so there is no step at which a
    // cap could apply. Restating it would only make the server refuse, or
    // make `reconcileQualityCaps` overturn the mode the viewer just picked.
    for (const mode of ['direct', 'remux'] as const) {
      const update = restatePreferencesClearedByMode({ preferences: { mode } }, capped, 'mpegts');
      expect(update.preferences?.maxHeight).toBeUndefined();
      expect(update.preferences?.maxBitrate).toBeUndefined();
    }
  });

  it('lets it go for a video stream this same request asked to copy', () => {
    const update = restatePreferencesClearedByMode(
      { preferences: { mode: 'transcode', video: 'copy', audio: 'transcode' } }, capped, undefined);
    expect(update.preferences?.maxHeight).toBeUndefined();
  });

  it('never overrides a ceiling or container the request already names', () => {
    const update = restatePreferencesClearedByMode(
      { preferences: { mode: 'transcode', maxHeight: 480, container: 'fmp4' } }, capped, 'mpegts');
    expect(update.preferences).toMatchObject({ maxHeight: 480, container: 'fmp4' });
  });

  it('restates the segment container for every mode that produces segments', () => {
    expect(restatePreferencesClearedByMode({ preferences: { mode: 'remux' } }, capped, 'mpegts').preferences?.container)
      .toBe('mpegts');
    // Direct serves the file itself; there are no segments to package.
    expect(restatePreferencesClearedByMode({ preferences: { mode: 'direct' } }, capped, 'mpegts').preferences?.container)
      .toBeUndefined();
  });

  it('leaves an update that names no mode exactly as it was', () => {
    // The server only restates the transform when asked to, so a bare
    // subtitle or quality change must not acquire fields it did not have.
    const update = { preferences: { subtitleStream: 3 } };
    expect(restatePreferencesClearedByMode(update, capped, 'mpegts')).toBe(update);
    expect(restatePreferencesClearedByMode({ preferences: { mode: 'choose' } }, capped, 'mpegts').preferences)
      .toEqual({ mode: 'choose' });
  });

  it('sends the ceiling and container on the wire when the viewer changes mode', async () => {
    const player = new FakePlayer();
    const api = resolver(capped);
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: api,
      capabilities: async () => capabilities(), initialPositionMs: 0,
      initialPreferences: { mode: 'remux', container: 'mpegts' },
    });
    await coordinator.start();

    coordinator.update({ preferences: { mode: 'transcode' } });
    await vi.waitFor(() => expect(api.update).toHaveBeenCalledTimes(1));
    expect(api.update.mock.calls[0][1].preferences).toMatchObject({
      mode: 'transcode', maxHeight: 720, maxBitrate: 4_000_000, container: 'mpegts',
    });
    await coordinator.close();
  });
});

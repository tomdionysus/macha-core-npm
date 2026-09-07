import { describe, expect, it, vi } from 'vitest';
import { PlaybackSourceError, type Player, type PlaybackDegradationListener, type PlaybackFailureListener, type PlaybackListener } from '../platform/Platform.js';
import type { MediaSummary, PlaybackCapabilities, PlaybackEvent, PlaybackSource, PlaybackTimeRange } from '../types.js';
import type { PlaybackResolver, PlaybackSession, PlaybackUpdate } from './PlaybackResolver.js';
import { equivalentDirectSources, generationLocalPosition, isPrematurePlaybackEnd, PlaybackCoordinator, mergePlaybackUpdate } from './PlaybackCoordinator.js';

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
    preferences: { mode: 'auto', maxHeight: null, maxBitrate: null, audioStream: 1, subtitleStream: null, audioLanguage: '', subtitleLanguage: '' },
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
      return session({ mode: 'transcode', seekMs: update.seekMs ?? 0, preferences: { ...initial.preferences, ...update.preferences } });
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
    player.emit({
      positionMs: 0,
      durationMs: 600_000,
      paused: false,
      ended: false,
      bufferedRangesMs: [{ startMs: 0, endMs: 10_000 }],
    });
    await vi.waitFor(() => expect(api.stop).toHaveBeenCalledWith('s1'));
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

  it('backs off cleanup of the old session only after the replacement is streaming', async () => {
    vi.useFakeTimers();
    try {
      const player = new FakePlayer();
      const initial = session({ endpoint: { id: 'node-a', baseUrl: 'http://a' } });
      const replacement = session({
        sessionId: 's2', endpoint: { id: 'node-b', baseUrl: 'http://b' },
        source: { ...initial.source, url: 'http://b/replacement.mp4' },
      });
      const api = resolver(initial) as ReturnType<typeof resolver> & { failover: ReturnType<typeof vi.fn> };
      api.failover = vi.fn(async () => replacement);
      api.stop
        .mockRejectedValueOnce(new TypeError('old node unreachable'))
        .mockRejectedValueOnce(new TypeError('old node still unreachable'))
        .mockResolvedValue(undefined);
      const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
      await coordinator.start();

      player.fail(new PlaybackSourceError('primary stream failed', 'stream'));
      await flush();
      await flush();
      expect(api.stop).not.toHaveBeenCalled();
      player.emit({ positionMs: 0, durationMs: 600_000, paused: false, ended: false, bufferedRangesMs: [{ startMs: 0, endMs: 5_000 }] });
      await flush();
      expect(api.stop).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(api.stop).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(api.stop).toHaveBeenCalledTimes(3);
      await coordinator.close();
    } finally {
      vi.useRealTimers();
    }
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

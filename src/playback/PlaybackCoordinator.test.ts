import { describe, expect, it, vi } from 'vitest';
import { PlaybackSourceError, type Player } from '../platform/Platform.js';
import type { MediaSummary, PlaybackCapabilities, PlaybackEvent, PlaybackSource } from '../types.js';
import type { PlaybackPreferences, PlaybackPreferencesUpdate, PlaybackResolver, PlaybackSession, PlaybackUpdate } from './PlaybackResolver.js';
import { FakePlayer } from '../testing/FakePlayer.js';
import { MOVE_LEAD_MARGIN_MS } from './generationStart.js';
import { playbackVersions, versionPreferences, type QualityCeiling } from './playbackVersions.js';
import { clearClientDiagnostics, clientDiagnosticsSnapshot } from '../diagnostics/ClientLog.js';
import { endpointFailure, isAccountSessionLimit, playbackFailureCode, playbackFailureStatus } from '../cluster/endpointFailure.js';
import { equivalentDirectSources, generationLocalPosition, isPrematurePlaybackEnd, LOOK_AHEAD_MARGIN_MS, PlaybackCoordinator, mergePlaybackUpdate, preparePlaybackPatch, REPLACEMENT_LEAD_TIME_MS, restatePreferencesClearedByMode,
  alternateRecoveryWindowMs,
} from './PlaybackCoordinator.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
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

    expect(coordinator.getSnapshot().notice).toEqual({ code: 'cannot-seek' });
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
    expect(player.playCalls).toEqual([{ source: aligned.source, positionMs: 0, startPaused: false, transition: 'relocate' }]);
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

  it('moves to a chosen node, promotes it, and only then releases the old one', async () => {
    // A move is a failover that nothing failed, so the ordering is the whole
    // point: the outgoing generation keeps presenting until the replacement is
    // live. Closing first is the 13.2 s gap this exists to remove, and the cap
    // being counted per node is what makes holding both free.
    const player = new FakePlayer();
    const primary = session({ sessionId: 'primary', mediaId: 'macha:one', endpoint: { id: 'node-a', baseUrl: 'http://a' } });
    const moved = session({
      sessionId: 'moved',
      mediaId: 'macha:one',
      endpoint: { id: 'node-b', baseUrl: 'http://b' },
      source: { ...primary.source, mediaId: 'macha:one', url: 'http://b/direct' },
    });
    const order: string[] = [];
    const api = resolver(primary) as ReturnType<typeof resolver> & { prepareOn: ReturnType<typeof vi.fn> };
    api.prepareOn = vi.fn(async () => { order.push('prepared'); return moved; });
    const stop = api.stop as ReturnType<typeof vi.fn>;
    stop.mockImplementation(async (sessionId: string) => { order.push(`stopped:${sessionId}`); });
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });

    await coordinator.start();
    const playsBefore = player.playCalls.length;

    await expect(coordinator.moveTo('node-b')).resolves.toBe(true);

    expect(api.prepareOn).toHaveBeenCalledTimes(1);
    expect(api.prepareOn.mock.calls[0]?.[0]).toBe('node-b');
    expect(coordinator.getSnapshot().session?.endpoint?.id).toBe('node-b');
    // The player was pointed at the replacement, and the old session was
    // released after that rather than before it.
    expect(player.playCalls.length).toBeGreaterThan(playsBefore);
    expect(order).toEqual(['prepared', 'stopped:primary']);
  });

  describe('a move, across the window before the cut', () => {
    // Measured on the web client 2026-09-23, fi-1 to gbni-1: the host kept the
    // outgoing element presenting and fetching for 36 s after activation. Core
    // had already deleted the session behind it, the element's 404s reached the
    // reap path attributed to that session, and the reap path rebuilt it on the
    // old node over the live one -- the viewer yanked back twenty seconds after
    // a clean move, and the new node's only transcode slot leaked.
    const onA = () => session({ sessionId: 'primary', mode: 'transcode', mediaId: 'macha:one', endpoint: { id: 'node-a', baseUrl: 'http://a' } });
    const onB = () => session({
      sessionId: 'moved', mode: 'transcode', mediaId: 'macha:one',
      endpoint: { id: 'node-b', baseUrl: 'http://b' },
      source: { ...onA().source, mediaId: 'macha:one', url: 'http://b/moved.m3u8' },
    });
    const regenerated = () => session({
      sessionId: 'regenerated', mode: 'transcode', mediaId: 'macha:one',
      endpoint: { id: 'node-a', baseUrl: 'http://a' },
      source: { ...onA().source, mediaId: 'macha:one', url: 'http://a/regenerated.m3u8' },
    });
    const notFound = () => new PlaybackSourceError('HTTP Error 404', 'not-found');

    function moving() {
      const player = new FakePlayer();
      const api = resolver(onA()) as any;
      api.prepareOn = vi.fn(async () => onB());
      // What the node says after the move: the old session is gone once core
      // has closed it, the moved one is alive.
      const closed = new Set<string>();
      api.stop.mockImplementation(async (id: string) => { closed.add(id); });
      api.sessionAlive = vi.fn(async (id: string) => !closed.has(id));
      api.regenerate = vi.fn(async () => regenerated());
      api.failover = vi.fn(async () => regenerated());
      const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
      return { player, api, coordinator };
    }

    it('releases the session it moved away from at the cut, not at activation', async () => {
      const { player, api, coordinator } = moving();
      await coordinator.start();
      const cut = deferred<boolean>();
      player.playResult = cut.promise;

      await expect(coordinator.moveTo('node-b')).resolves.toBe(true);
      await flush();
      // The outgoing element is still on screen and still fetching.
      expect(api.stop).not.toHaveBeenCalledWith('primary', expect.anything());

      cut.resolve(true);
      await vi.waitFor(() => expect(api.stop).toHaveBeenCalledWith('primary', expect.anything()));
      expect(api.stop).not.toHaveBeenCalledWith('moved', expect.anything());
      await coordinator.close();
    });

    it('does not rebuild the session it moved away from when that element reports a 404 before the cut', async () => {
      const { player, api, coordinator } = moving();
      await coordinator.start();
      const cut = deferred<boolean>();
      player.playResult = cut.promise;
      await coordinator.moveTo('node-b');
      // Force the field condition regardless of when the close lands: the
      // outgoing session is gone on the node.
      api.sessionAlive.mockImplementation(async (id: string) => id !== 'primary');

      player.degrade(notFound());
      await vi.waitFor(() => expect(api.sessionAlive).toHaveBeenCalled());
      await flush();

      // Asked about the generation core owns, which is alive -- and so did
      // nothing on either side of the cut.
      expect(api.sessionAlive).toHaveBeenLastCalledWith('moved');
      expect(api.regenerate).not.toHaveBeenCalled();
      expect(api.failover).not.toHaveBeenCalled();
      cut.resolve(true);
      await vi.waitFor(() => expect(coordinator.getSnapshot().session?.sessionId).toBe('moved'));
      expect(api.stop).not.toHaveBeenCalledWith('moved', expect.anything());
      await coordinator.close();
    });

    it('releases, rather than adopts, a replacement that lands for a generation a move has since replaced', async () => {
      // The last line of defence: a regeneration already negotiating when the
      // viewer moves must not overwrite the move and orphan its session.
      const { player, api, coordinator } = moving();
      const negotiating = deferred<PlaybackSession>();
      api.regenerate = vi.fn(() => negotiating.promise);
      await coordinator.start();
      // Reaped for real, with no cover to defer against: build now.
      api.sessionAlive.mockImplementation(async () => false);
      player.degrade(notFound());
      await vi.waitFor(() => expect(api.regenerate).toHaveBeenCalledTimes(1));

      await expect(coordinator.moveTo('node-b')).resolves.toBe(true);
      negotiating.resolve(regenerated());
      await vi.waitFor(() => expect(api.stop).toHaveBeenCalledWith('regenerated', expect.anything()));
      expect(coordinator.getSnapshot().session?.sessionId).toBe('moved');
      expect(player.playCalls.at(-1)?.source.url).toBe('http://b/moved.m3u8');
      await coordinator.close();
    });
  });

  describe('a move that asks the node to start ahead of the viewer', () => {
    // Measured on the web client 2026-09-23: gbni-1 took 8.5-12.3 s to a first
    // fragment, and a generation asked for at the viewer's position begins that
    // far behind them and never catches up at realtime. So a move asks for the
    // viewer's position plus a lead, and a host that can hold plays the old
    // source up to the new generation's start.
    const onA = () => session({ sessionId: 'primary', mode: 'transcode', mediaId: 'macha:one', seekMs: 0, endpoint: { id: 'node-a', baseUrl: 'http://a' } });

    function leading(options: { holds: boolean; estimate?: number; positionMs: number }) {
      const player = new FakePlayer();
      player.holdsThroughLead = options.holds;
      const api = resolver(onA()) as any;
      api.startCostEstimate = vi.fn(() => options.estimate);
      api.prepareOn = vi.fn(async (_endpointId: string, _active: PlaybackSession, _media: MediaSummary, _caps: PlaybackCapabilities, seekMs: number) => session({
        sessionId: 'moved', mode: 'transcode', mediaId: 'macha:one', seekMs,
        endpoint: { id: 'node-b', baseUrl: 'http://b' },
        source: { ...onA().source, mediaId: 'macha:one', url: 'http://b/moved.m3u8' },
      }));
      const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: options.positionMs });
      return { player, api, coordinator };
    }

    it('asks for the viewer position plus the estimate and margin, and hands the player the viewer before the start', async () => {
      const { player, api, coordinator } = leading({ holds: true, estimate: 12_300, positionMs: 182_820 });
      await coordinator.start();
      const cut = deferred<boolean>();
      player.playResult = cut.promise;

      await expect(coordinator.moveTo('node-b')).resolves.toBe(true);

      const lead = 12_300 + MOVE_LEAD_MARGIN_MS;
      expect(api.prepareOn.mock.calls[0]?.[4]).toBe(182_820 + lead);
      // Negative: the viewer is a whole lead before this generation begins.
      expect(player.playCalls.at(-1)?.positionMs).toBe(-lead);
      expect(player.playCalls.at(-1)?.transition).toBe('continue');
      // And no renegotiation back to the viewer's position, which would throw
      // the lead away and pay a second full start on the target.
      expect(api.update).not.toHaveBeenCalled();

      cut.resolve(true);
      await vi.waitFor(() => expect(coordinator.getSnapshot().session?.sessionId).toBe('moved'));
      // The host cut when the viewer reached the generation's start, so that is
      // where the readout lands, not a lead behind the picture.
      expect(coordinator.getSnapshot().intent.positionMs).toBe(182_820 + lead);
      await coordinator.close();
    });

    it("takes the host's lead over its own estimate", async () => {
      const { api, coordinator } = leading({ holds: true, estimate: 12_300, positionMs: 100_000 });
      await coordinator.start();
      await coordinator.moveTo('node-b', { leadMs: 20_000 });
      expect(api.prepareOn.mock.calls[0]?.[4]).toBe(120_000);
      await coordinator.close();
    });

    it('gives a player that cannot hold the move it had before leads existed, whatever it is told', async () => {
      const { player, api, coordinator } = leading({ holds: false, estimate: 12_300, positionMs: 100_000 });
      await coordinator.start();
      await coordinator.moveTo('node-b', { leadMs: 20_000 });
      expect(api.prepareOn.mock.calls[0]?.[4]).toBe(100_000);
      expect(player.playCalls.at(-1)?.positionMs).toBeGreaterThanOrEqual(0);
      await coordinator.close();
    });

    it('asks for no lead where core has no evidence about that node', async () => {
      const { api, coordinator } = leading({ holds: true, estimate: undefined, positionMs: 100_000 });
      await coordinator.start();
      await coordinator.moveTo('node-b');
      expect(api.prepareOn.mock.calls[0]?.[4]).toBe(100_000);
      await coordinator.close();
    });

    it('asks for no lead that would reach past the end of the title', async () => {
      const { api, coordinator } = leading({ holds: true, estimate: 12_300, positionMs: 590_000 });
      await coordinator.start();
      await coordinator.moveTo('node-b');
      expect(api.prepareOn.mock.calls[0]?.[4]).toBe(590_000);
      await coordinator.close();
    });
  });

  it('declines a move to the node already serving, without asking anyone', async () => {
    const player = new FakePlayer();
    const primary = session({ sessionId: 'primary', mediaId: 'macha:one', endpoint: { id: 'node-a', baseUrl: 'http://a' } });
    const api = resolver(primary) as ReturnType<typeof resolver> & { prepareOn: ReturnType<typeof vi.fn> };
    api.prepareOn = vi.fn();
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });

    await coordinator.start();
    await expect(coordinator.moveTo('node-a')).resolves.toBe(false);
    expect(api.prepareOn).not.toHaveBeenCalled();
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
    await vi.waitFor(() => expect(api.stop).toHaveBeenCalledWith('primary', { endpointAlreadyCharged: true }));
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
    await vi.waitFor(() => expect(api.stop).toHaveBeenCalledWith('primary', { endpointAlreadyCharged: true }));

    player.degrade(new PlaybackSourceError('read-ahead TCP failed', 'stream'));
    await vi.waitFor(() => expect(player.directAlternatives).toHaveLength(2));
    expect(player.directAlternatives[1]).toEqual({ active: primary.source, alternate: alternateB.source });
    await vi.waitFor(() => expect(api.stop).toHaveBeenCalledWith('alternate-a', { endpointAlreadyCharged: true }));

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
      await vi.waitFor(() => expect(api.stop).toHaveBeenCalledWith('primary', { endpointAlreadyCharged: true }));
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

  it('waits for an in-flight failover to release the session it built before close() resolves, and releases it with the close options', async () => {
    // `close()` used to await the start, the mutation loop and every alternate
    // preparation, and not the failover. So it resolved while a replacement
    // session was still being negotiated on another node — the recovery does
    // stop what it built once it sees `disposed`, but a host that tears down
    // auth on the strength of `close()` resolving races that `DELETE`. On the
    // unload path the flag is the difference between the DELETE surviving and
    // the node holding the entitlement for thirty minutes.
    const player = new FakePlayer();
    const initial = session({ endpoint: { id: 'node-a', baseUrl: 'http://a' } });
    const replacement = session({
      sessionId: 's2', endpoint: { id: 'node-b', baseUrl: 'http://b' },
      source: { ...initial.source, url: 'http://b/replacement.mp4' },
    });
    const built = deferred<PlaybackSession>();
    const api = resolver(initial) as ReturnType<typeof resolver> & { failover: ReturnType<typeof vi.fn> };
    api.failover = vi.fn(async () => built.promise);
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
    await coordinator.start();
    player.fail(new Error('node A stream failed'));
    await vi.waitFor(() => expect(api.failover).toHaveBeenCalled());

    let closed = false;
    const closing = coordinator.close({ keepalive: true }).then(() => { closed = true; });
    // Generously more turns than the close path itself needs, so this is a
    // statement about the failover being awaited and not about scheduling.
    for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
    expect(closed).toBe(false);

    built.resolve(replacement);
    await closing;

    expect(closed).toBe(true);
    expect(api.stop).toHaveBeenCalledWith('s2', { keepalive: true });
    expect(api.stop).toHaveBeenCalledWith('s1', expect.objectContaining({ keepalive: true }));
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

  it('does not let a source it is replacing move the resume point backwards', async () => {
    // The dying source is left playing on purpose — its buffered tail is what
    // covers the failover, and stopping it to silence it would be the black
    // screen the whole mechanism exists to avoid. But it has stopped being a
    // witness: an element reporting zero as it tears down would otherwise
    // become the position the replacement is activated at, and the viewer
    // returns to the start of the film with no way to tell why.
    const player = new FakePlayer();
    const initial = session({ endpoint: { id: 'node-a', baseUrl: 'http://a' } });
    const replacement = session({
      sessionId: 's2', endpoint: { id: 'node-b', baseUrl: 'http://b' },
      source: { ...initial.source, url: 'http://b/replacement.mp4' },
    });
    const api = resolver(initial) as ReturnType<typeof resolver> & { failover: ReturnType<typeof vi.fn> };
    const negotiation = deferred<PlaybackSession>();
    api.failover = vi.fn(() => negotiation.promise);
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
    await coordinator.start();
    player.emit({ positionMs: 0, durationMs: 600_000, paused: false, ended: false });
    player.emit({ positionMs: 300_000, durationMs: 600_000, paused: false, ended: false });
    expect(coordinator.getSnapshot().intent.positionMs).toBe(300_000);

    player.fail(new PlaybackSourceError('node A stream failed', 'stream'));
    await flush();
    player.emit({ positionMs: 0, durationMs: 600_000, paused: false, ended: false });
    await flush();

    expect(coordinator.getSnapshot().intent.positionMs).toBe(300_000);

    // Forward is still forward: the tail it plays out is real progress, and
    // the replacement should start after what the viewer actually saw.
    player.emit({ positionMs: 303_000, durationMs: 600_000, paused: false, ended: false });
    await flush();
    expect(coordinator.getSnapshot().intent.positionMs).toBe(303_000);

    negotiation.resolve(replacement);
    await vi.waitFor(() => expect(player.playCalls.at(-1)?.source.url).toBe('http://b/replacement.mp4'));
    expect(player.playCalls.at(-1)?.positionMs).toBe(303_000);
    await coordinator.close();
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

    await vi.waitFor(() => expect(coordinator.getSnapshot().fatalError).toBeDefined());
    expect(api.failover).toHaveBeenCalledTimes(1);
  });

  it('reports the failure that started the recovery, not the last node the walk tried', async () => {
    // These name different nodes, and until 2026-09-17 the walk's last refusal
    // was what reached the screen: a session on es-1 failed, the walk ended on
    // fi-1, and the viewer was shown fi-1's address for a session it had never
    // held. A day of diagnosis went to the wrong machine on the strength of it.
    const player = new FakePlayer();
    const initial = session({ endpoint: { id: 'node-a', baseUrl: 'http://a' } });
    const api = resolver(initial) as ReturnType<typeof resolver> & { failover: ReturnType<typeof vi.fn> };
    const exhausted = new Error('Macha endpoint node-c failed: Failed to fetch');
    api.failover = vi.fn(async () => { throw exhausted; });
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
    await coordinator.start();

    player.fail(new PlaybackSourceError('node A stream failed', 'stream'));

    await vi.waitFor(() => expect(coordinator.getSnapshot().fatalError).toBeDefined());
    const fatal = coordinator.getSnapshot().fatalError!;
    expect(fatal.message).toBe('node A stream failed');
    // Kept, not discarded: "and nothing else could serve it either" is the
    // other half of what happened, and a diagnostic trail wants both.
    expect(fatal.cause).toBe(exhausted);
    // The originating error object itself, so a host still reads its kind.
    expect(fatal).toBeInstanceOf(PlaybackSourceError);
    await coordinator.close();
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

    expect(api.stop).toHaveBeenCalledWith('s1', expect.objectContaining({ keepalive: true }));
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

describe('a facts lookup that failed is retried, within a budget', () => {
  /**
   * Caching the answer is right; caching a thrown lookup was not. One
   * transient fault — a node 500ing, a request issued microseconds before the
   * session existed — permanently condemned the generation to the factless
   * fallback, with no retry possible for as long as playback lasted. A viewer
   * met exactly that: a facts call failing 18 ms after load, and a picture
   * that never recovered once the cluster was answering perfectly again.
   */
  it('asks again after a failure rather than condemning the generation', async () => {
    const player = new FakePlayer();
    const facts = vi.fn()
      .mockRejectedValueOnce(new Error('node 500'))
      .mockRejectedValueOnce(new Error('node 500'));
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: resolver(session({ mode: 'transcode' })),
      capabilities: async () => capabilities(), initialPositionMs: 0,
      facts,
    });
    await coordinator.start();
    const first = facts.mock.calls.length;

    coordinator.update({ preferences: { mode: 'choose' } });
    await vi.waitFor(() => expect(facts.mock.calls.length).toBeGreaterThan(first));
    await coordinator.close();
  });

  it('stops asking once the budget is spent', async () => {
    // Each retry is a request on the viewer's critical path. Unbounded, a
    // viewer touching the mode control while a node was down would fire one
    // every time.
    const player = new FakePlayer();
    const facts = vi.fn().mockRejectedValue(new Error('node down'));
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: resolver(session({ mode: 'transcode' })),
      capabilities: async () => capabilities(), initialPositionMs: 0,
      facts,
    });
    await coordinator.start();

    for (let attempt = 0; attempt < 12; attempt += 1) { coordinator.update({ preferences: { mode: 'choose' } }); await vi.waitFor(() => undefined); }

    expect(facts.mock.calls.length).toBeLessThanOrEqual(4);
    await coordinator.close();
  });

  /**
   * With only `withoutFacts` a screen could report that something was degraded
   * but not that the lookup itself failed — so the fallback's symptoms reach
   * the viewer looking like a property of the file. A warning in a ring buffer
   * is not a degraded mode a viewer can act on.
   */
  it('carries why the lookup failed, so a client can say what went wrong', async () => {
    const boom = new Error('Macha playback facts failed: a valid session bearer token is required');
    const player = new FakePlayer();
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: resolver(session({ mode: 'transcode' })),
      capabilities: async () => capabilities(), initialPositionMs: 0,
      facts: async () => { throw boom; },
    });
    await coordinator.start();

    const instruction = coordinator.getSnapshot().instruction;
    expect(instruction?.withoutFacts).toBe(true);
    expect(instruction?.factsError).toBe(boom);
    await coordinator.close();
  });

  it('reports no factsError when there is simply no supplier', async () => {
    // A configuration, not a fault, and the two must stay distinguishable.
    const player = new FakePlayer();
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: resolver(session({ mode: 'transcode' })),
      capabilities: async () => capabilities(), initialPositionMs: 0,
    });
    await coordinator.start();

    expect(coordinator.getSnapshot().instruction?.withoutFacts).toBe(true);
    expect(coordinator.getSnapshot().instruction?.factsError).toBeUndefined();
    await coordinator.close();
  });
});

describe('a node that reaped the session it was serving', () => {
  // The P0 of 2026-09-17, reproduced live from the web client and again here.
  //
  // A viewer pauses. hls.js fills its forward buffer, hits `maxBufferLength`
  // and stops asking for fragments, so nothing touches the session and
  // `streaming.session_idle_ms` erases it half an hour later. The node is
  // fine. It holds the title's pipeline and will happily issue another
  // session. It simply does not have that one any more, and says so with a
  // `404`.
  //
  // What the viewer got instead was their cache playing out, sixty-two
  // seconds of blind retries, and a failure screen naming a node their
  // session had never been on.

  function reapedResolver(initial: PlaybackSession, replacement: PlaybackSession) {
    return {
      available: true,
      resolve: vi.fn(async () => initial),
      update: vi.fn(async () => initial),
      stop: vi.fn(async () => undefined),
      sessionAlive: vi.fn(async () => false),
      regenerate: vi.fn(async () => replacement),
      failover: vi.fn(async () => replacement),
      prepareAlternate: vi.fn(async () => undefined),
      recordEndpointFailure: vi.fn(),
    } as any;
  }

  const onNodeA = () => session({ sessionId: 's1', mode: 'transcode', endpoint: { id: 'node-a', baseUrl: 'http://a' } });
  const replacement = () => session({
    sessionId: 's2',
    mode: 'transcode',
    endpoint: { id: 'node-a', baseUrl: 'http://a' },
    source: {
      mediaId: 'm1', url: '/generation-replacement.m3u8', mimeType: 'application/vnd.apple.mpegurl',
      isManifest: true, mode: 'transcode', durationMs: 600_000,
    },
  });
  const notFound = () => new PlaybackSourceError('HTTP Error 404', 'not-found');

  describe('a player that cannot ride a hold', () => {
    // The Samsung build's native HLS element fails or stalls silently when its
    // first segment answers `500 segment_not_ready`. It used to be protected by
    // a bytes=0-0 probe of the media, which Tom ruled out; the node already
    // says the same thing on the session route, as `production.produced_ms`.
    const starting = () => session({
      sessionId: 's1', mode: 'transcode', endpoint: { id: 'node-a', baseUrl: 'http://a' },
      production: { producedMs: 0, producingMs: 0, producedAgeMs: 0, producerParked: false },
    });

    function waiting(outcome: Promise<'produced' | 'gone' | 'unknown'>, needs = true) {
      const player = new FakePlayer();
      player.needsProducedSource = needs;
      const api = reapedResolver(starting(), replacement());
      api.awaitProduced = vi.fn(() => outcome);
      const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
      return { player, api, coordinator };
    }

    it('hands over the source only once the node says something has been produced', async () => {
      const produced = deferred<'produced' | 'gone' | 'unknown'>();
      const { player, api, coordinator } = waiting(produced.promise);
      const started = coordinator.start();
      await vi.waitFor(() => expect(api.awaitProduced).toHaveBeenCalledTimes(1));
      expect(player.playCalls).toHaveLength(0);

      produced.resolve('produced');
      await started;
      await vi.waitFor(() => expect(player.playCalls).toHaveLength(1));
      await coordinator.close();
    });

    it('hands over as before when the node cannot say', async () => {
      const { player, coordinator } = waiting(Promise.resolve('unknown'));
      await coordinator.start();
      await vi.waitFor(() => expect(player.playCalls).toHaveLength(1));
      await coordinator.close();
    });

    it('sends a generation that vanished before producing into the reaped-session recovery, not to the player', async () => {
      const { player, api, coordinator } = waiting(Promise.resolve('gone'));
      await coordinator.start();
      await vi.waitFor(() => expect(api.sessionAlive).toHaveBeenCalledWith('s1'));
      await vi.waitFor(() => expect(api.regenerate).toHaveBeenCalled());
      expect(player.playCalls.some((call) => call.source.url === starting().source.url)).toBe(false);
      expect(api.failover).not.toHaveBeenCalled();
      await coordinator.close();
    });

    it('never makes any other player wait', async () => {
      const { player, api, coordinator } = waiting(new Promise(() => undefined), false);
      await coordinator.start();
      expect(player.playCalls).toHaveLength(1);
      expect(api.awaitProduced).not.toHaveBeenCalled();
      await coordinator.close();
    });
  });

  describe('a fatal that says nothing about what failed', () => {
    // Measured on the Android TV set 2026-09-23: expo-video's terminal error
    // carries no status, so a reaped direct-play session arrived as `unknown`,
    // and two reaps each charged a healthy local node and failed over across
    // the internet. The session route can tell the two apart without anyone
    // reading the message.
    const unclassified = () => new PlaybackSourceError('Source error Response code: 404', 'unknown');

    it('regenerates on the same node, uncharged, when the node says the session is gone', async () => {
      const player = new FakePlayer();
      const api = reapedResolver(onNodeA(), replacement());
      const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
      await coordinator.start();

      player.fail(unclassified());

      await vi.waitFor(() => expect(api.regenerate).toHaveBeenCalledTimes(1));
      expect(api.sessionAlive).toHaveBeenCalledWith('s1');
      expect(api.failover).not.toHaveBeenCalled();
      expect(api.recordEndpointFailure).not.toHaveBeenCalled();
      await coordinator.close();
    });

    it('fails over and charges as before when the session is alive, because then the stream really failed', async () => {
      const player = new FakePlayer();
      const api = reapedResolver(onNodeA(), replacement());
      api.sessionAlive = vi.fn(async () => true);
      const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
      await coordinator.start();

      player.fail(unclassified());

      await vi.waitFor(() => expect(api.failover).toHaveBeenCalledTimes(1));
      expect(api.sessionAlive).toHaveBeenCalledWith('s1');
      expect(api.regenerate).not.toHaveBeenCalled();
      await coordinator.close();
    });

    it('fails over when the node cannot answer, rather than reading silence as gone', async () => {
      const player = new FakePlayer();
      const api = reapedResolver(onNodeA(), replacement());
      api.sessionAlive = vi.fn(async () => { throw new Error('Session s1 liveness unanswered within 8000 ms.'); });
      const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
      await coordinator.start();

      player.fail(unclassified());

      await vi.waitFor(() => expect(api.failover).toHaveBeenCalledTimes(1));
      expect(api.regenerate).not.toHaveBeenCalled();
      await coordinator.close();
    });

    it('leaves an unclassified report on the degradation channel as it was', async () => {
      const player = new FakePlayer();
      const api = reapedResolver(onNodeA(), replacement());
      const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
      await coordinator.start();

      player.degrade(unclassified());

      await vi.waitFor(() => expect(api.prepareAlternate).toHaveBeenCalledTimes(1));
      expect(api.sessionAlive).not.toHaveBeenCalled();
      await coordinator.close();
    });
  });

  it('asks the same node for a new generation instead of condemning it', async () => {
    const player = new FakePlayer();
    const api = reapedResolver(onNodeA(), replacement());
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
    await coordinator.start();

    player.degrade(notFound());

    await vi.waitFor(() => expect(api.regenerate).toHaveBeenCalledTimes(1));
    expect(api.sessionAlive).toHaveBeenCalledWith('s1');
    // The three things that were happening before, none of which should.
    expect(api.failover).not.toHaveBeenCalled();
    expect(api.prepareAlternate).not.toHaveBeenCalled();
    expect(api.recordEndpointFailure).not.toHaveBeenCalled();
    await coordinator.close();
  });

  it('swaps the source under a paused viewer, so pressing play just works', async () => {
    // The whole point of catching it on the degradation channel. Measured on
    // 2026-09-17, the first 404 arrived 3.7 seconds *before* the viewer pressed
    // play, with 62.8 seconds of buffer still in front of them. A replacement
    // activated inside that cover is invisible.
    const player = new FakePlayer();
    const api = reapedResolver(onNodeA(), replacement());
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
    await coordinator.start();
    coordinator.setPaused(true);

    player.degrade(notFound());

    await vi.waitFor(() => expect(api.regenerate).toHaveBeenCalled());
    await vi.waitFor(() => expect(player.playCalls.at(-1)?.source.url).toBe(replacement().source.url));
    expect(player.playCalls.at(-1)?.startPaused).toBe(true);
    expect(coordinator.getSnapshot().fatalError).toBeUndefined();
    await coordinator.close();
  });

  it('leaves a live session alone, because then the 404 was a miss and not a reaping', async () => {
    // Both answer `404` with the identical code `not_found`, measured against
    // one node in one run, so the status cannot separate them and the session
    // route has to. A fragment past the end of a live plan is not fixed by
    // replacing the session it is already being served by.
    const player = new FakePlayer();
    const api = reapedResolver(onNodeA(), replacement());
    api.sessionAlive = vi.fn(async () => true);
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
    await coordinator.start();

    player.degrade(notFound());

    await vi.waitFor(() => expect(api.sessionAlive).toHaveBeenCalled());
    await flush();
    expect(api.regenerate).not.toHaveBeenCalled();
    expect(api.failover).not.toHaveBeenCalled();
    // And no standby either. The node is cleared, so building one is the churn
    // `not-found` exists to stop — this is the case that must *not* fall back
    // into ordinary degradation handling.
    expect(api.prepareAlternate).not.toHaveBeenCalled();
    await coordinator.close();
  });

  it('builds a standby when it cannot find out, rather than swallowing the warning', async () => {
    // The node went away between answering the 404 and being asked about it.
    // Core does not know its state, the source may still be playing, and this
    // is exactly the evidence the standby machinery exists for.
    //
    // The first version of the fix returned here, which made the degradation
    // channel *worse* than before `not-found` existed: the same evidence used
    // to arrive as `stream` and build a rescue. Swallowing it left the viewer
    // waiting for the fatal with nothing being prepared.
    const player = new FakePlayer();
    const api = reapedResolver(onNodeA(), replacement());
    api.sessionAlive = vi.fn(async () => { throw new Error('Failed to fetch'); });
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0,
    });
    await coordinator.start();

    player.degrade(notFound());

    await vi.waitFor(() => expect(api.prepareAlternate).toHaveBeenCalledTimes(1));
    // Still not a failover, and still nothing charged: not knowing is not
    // evidence that the node is bad.
    expect(api.failover).not.toHaveBeenCalled();
    expect(api.recordEndpointFailure).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().fatalError).toBeUndefined();
    await coordinator.close();
  });

  it('fails over when it cannot find out and there is no cover left', async () => {
    // Same unresolved answer arriving on the fatal channel instead. There is
    // nothing still playing to protect, so a standby is no longer the useful
    // move and failover is the remaining option.
    const player = new FakePlayer();
    const api = reapedResolver(onNodeA(), replacement());
    api.sessionAlive = vi.fn(async () => { throw new Error('Failed to fetch'); });
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0,
    });
    await coordinator.start();

    player.fail(notFound());

    await vi.waitFor(() => expect(api.failover).toHaveBeenCalledTimes(1));
    expect(api.regenerate).not.toHaveBeenCalled();
    await coordinator.close();
  });

  it('does not read a probe it could not complete as a session that is gone', async () => {
    // "I could not find out" and "it is gone" are different answers, and
    // acting on the second when you have the first tears down a live session
    // because a node was briefly unreachable.
    const player = new FakePlayer();
    const api = reapedResolver(onNodeA(), replacement());
    api.sessionAlive = vi.fn(async () => { throw new Error('Failed to fetch'); });
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
    await coordinator.start();

    player.degrade(notFound());

    await vi.waitFor(() => expect(api.sessionAlive).toHaveBeenCalled());
    await flush();
    expect(api.regenerate).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().fatalError).toBeUndefined();
    await coordinator.close();
  });

  it('stops regenerating when regenerating changed nothing', async () => {
    // A `404` can also mean a fragment no plan will ever contain. Left
    // unbounded, that regenerates, asks again, regenerates, for as long as the
    // viewer sits there. Arriving twice at the same position is the proof that
    // the last replacement did not help, and the next step has to differ.
    const player = new FakePlayer();
    const api = reapedResolver(onNodeA(), replacement());
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
    await coordinator.start();

    player.fail(notFound());
    await vi.waitFor(() => expect(api.regenerate).toHaveBeenCalledTimes(1));

    player.fail(notFound());
    await vi.waitFor(() => expect(api.failover).toHaveBeenCalledTimes(1));
    expect(api.regenerate).toHaveBeenCalledTimes(1);
    await coordinator.close();
  });

  it('recovers from the fatal channel too, for an adapter with no early warning', async () => {
    // Not every player reports degradation, and the cover can run out before
    // recovery finishes. Same question, same answer, and still not a reason to
    // condemn the node.
    const player = new FakePlayer();
    const api = reapedResolver(onNodeA(), replacement());
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
    await coordinator.start();

    player.fail(notFound());

    await vi.waitFor(() => expect(api.regenerate).toHaveBeenCalledTimes(1));
    expect(api.failover).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().fatalError).toBeUndefined();
    await coordinator.close();
  });

  it('falls over to another node when the same one refuses fresh work', async () => {
    // A node that will not issue a new session is making a claim about itself,
    // unlike the `404` that started this, and that one is ordinary evidence.
    const player = new FakePlayer();
    const api = reapedResolver(onNodeA(), replacement());
    api.regenerate = vi.fn(async () => { throw new Error('Macha endpoint node-a failed: 503'); });
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
    await coordinator.start();

    player.fail(notFound());

    await vi.waitFor(() => expect(api.failover).toHaveBeenCalledTimes(1));
    await coordinator.close();
  });
});

describe('a host that keeps the old source playing while it prepares the new one', () => {
  // A host that replaces a source seamlessly does not tear the old element
  // down: it prepares the replacement alongside, and cuts when the join is
  // resident. `play()` resolving is that cut. For nine measured seconds the
  // OUTGOING element is still the one playing and reporting, and core must
  // still be describing that element.
  //
  // Switching at call time mapped its ranges through the incoming generation's
  // origin: a buffer of [0, 120.7] drawn at 2407.7 s when its own generation
  // started at 1772.8 s — ten minutes to the right of the media it described,
  // while the incoming element had buffered nothing at all.
  //
  // Invisible to every fake that resolves play() immediately, which is why it
  // survived: call-time and resolve-time are the same instant there.

  it('keeps describing the outgoing source until the host says it has cut', async () => {
    const player = new FakePlayer();
    const outgoing = session({ sessionId: 's1', mode: 'transcode', seekMs: 100_000 });
    const incoming = session({
      sessionId: 's2', mode: 'transcode', seekMs: 150_000,
      source: {
        mediaId: 'm1', url: '/generation-incoming.m3u8', mimeType: 'application/vnd.apple.mpegurl',
        isManifest: true, mode: 'transcode', durationMs: 600_000,
      },
    });
    const api = resolver(outgoing, async () => incoming);
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 100_000,
    });
    await coordinator.start();
    // The viewer has watched 50 s of the outgoing generation.
    player.emit({ positionMs: 49_800, durationMs: 600_000, paused: false, ended: false });
    player.emit({ positionMs: 50_000, durationMs: 600_000, paused: false, ended: false });
    await flush();

    // Hold the cut open, exactly as a real handover does.
    const cut = deferred<boolean>();
    player.playResult = cut.promise;
    coordinator.update({ preferences: { maxHeight: 720 } });
    await vi.waitFor(() => expect(player.playCalls).toHaveLength(2));

    // Mid-handover: the outgoing element reports 20 s into its own generation.
    player.emit({
      positionMs: 60_000, durationMs: 600_000, paused: false, ended: false,
      bufferedRangesMs: [{ startMs: 0, endMs: 120_000 }],
    });
    await flush();

    // Described through the generation actually playing — 100 s origin, not
    // 400 s. Mapping through the incoming origin would put both 300 s out.
    // Described through the generation actually playing — 100 s origin, not the
    // incoming 150 s. Mapping through the incoming origin would put both 50 s out.
    const during = coordinator.getSnapshot();
    expect(during.event.positionMs).toBe(160_000);
    expect(during.event.bufferedRangesMs?.[0]).toEqual({ startMs: 100_000, endMs: 220_000 });
    expect(during.session?.sessionId).toBe('s1');

    // The host cuts.
    cut.resolve(true);
    await vi.waitFor(() => expect(coordinator.getSnapshot().session?.sessionId).toBe('s2'));

    player.emit({ positionMs: 5_000, durationMs: 600_000, paused: false, ended: false });
    player.emit({ positionMs: 7_000, durationMs: 600_000, paused: false, ended: false });
    await flush();
    expect(coordinator.getSnapshot().event.positionMs).toBe(157_000);
    await coordinator.close();
  });
});

describe('a player that settles somewhere other than core asked for', () => {
  // Observed in the live client and reported by the viewer for several
  // sessions before anyone had an explanation: after a seamless source
  // replacement the reported position froze permanently at the new
  // generation's origin, while the picture played on and the buffer ran ahead.
  // The drawn gap between playhead and buffer grew as the player evicted
  // behind a playhead that was not moving, and every later seek was computed
  // from the frozen value.
  //
  // `seekIntentActive` exists to stop the transient zero/paused events a
  // source emits while attaching from overwriting a transport target. It was
  // released only by the player arriving within 1.5 s of that target — so a
  // host that cuts at the point the outgoing element actually reached, rather
  // than the point core nominated, never released it at all.

  it('reports the position again once the player is demonstrably tracking', async () => {
    const player = new FakePlayer();
    const api = resolver(session({ mode: 'transcode', seekMs: 60_000 }));
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 60_000,
    });
    await coordinator.start();

    // The host joined 40 s into the generation, nowhere near the 0 core asked
    // for, and then plays on normally.
    player.emit({ positionMs: 40_000, durationMs: 600_000, paused: false, ended: false });
    player.emit({ positionMs: 42_000, durationMs: 600_000, paused: false, ended: false });
    await flush();

    // 60_000 generation origin + 42_000 local.
    expect(coordinator.getSnapshot().intent.positionMs).toBe(102_000);
    await coordinator.close();
  });

  it('does not let the outgoing source talk the viewer out of a seek', async () => {
    // A regression this fix caused once already, caught by the viewer dragging
    // the scrubber. The release had been widened to "the player is moving",
    // but during a seek that needs a new generation the OUTGOING source is
    // still playing and still reporting progress — so the target was discarded
    // 65 ms after the request, with the reported position and the target 685
    // seconds apart, and the generation was created at the position the viewer
    // was already at. The scrubber snapped back.
    //
    // Movement is not the question. The question is whether what core asked
    // for is being shown yet.
    const player = new FakePlayer();
    const current = session({ mode: 'transcode', seekMs: 100_000 });
    const api = resolver(current, async (update) => session({
      sessionId: 's2', mode: 'transcode', seekMs: update.seekMs ?? 0,
    }));
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 150_000,
    });
    await coordinator.start();
    player.emit({ positionMs: 50_000, durationMs: 600_000, paused: false, ended: false });

    coordinator.seek(500_000);
    // The outgoing source plays on while the generation is negotiated.
    player.emit({ positionMs: 50_200, durationMs: 600_000, paused: false, ended: false });
    player.emit({ positionMs: 50_400, durationMs: 600_000, paused: false, ended: false });
    await flush();

    expect(coordinator.getSnapshot().intent.positionMs).toBe(500_000);
    await vi.waitFor(() => expect(api.update).toHaveBeenCalled());
    // The generation must be asked for where the viewer pointed.
    expect(api.update.mock.calls.at(-1)?.[1].seekMs).toBe(500_000);
    await coordinator.close();
  });

  it('still ignores the transient events a source emits while attaching', async () => {
    // The latch has a job and this is it: one zero-position report during
    // attachment must not drag the viewer back to the start of the film.
    const player = new FakePlayer();
    const api = resolver(session({ mode: 'transcode', seekMs: 60_000 }));
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 60_000,
    });
    await coordinator.start();

    player.emit({ positionMs: 0, durationMs: 600_000, paused: true, ended: false });
    await flush();

    expect(coordinator.getSnapshot().intent.positionMs).toBe(60_000);
    await coordinator.close();
  });
});

describe('replacing a reaped source without making the viewer wait', () => {
  // Three measurements against `es-1` shaped this, and each overturned the
  // shape before it.
  //
  // Attaching the replacement the moment it existed emptied an element holding
  // 62.1 s of playable video: 5.16 s of frozen picture.
  //
  // Creating it immediately and *holding* it until the runway ran down was
  // worse — 12.7 s, 9.0 s of it on one fragment. The cause is the production
  // frontier: a node produces out to `look_ahead_ms` past the last fragment
  // requested and parks, so a generation held 28 s leaves the viewer arriving
  // beyond anything ever asked for, and the encoder runs forward at roughly
  // realtime to reach them.
  //
  // *Not* because a held session goes cold. It does not — the pipeline starts
  // inside the session POST and a node reported startup complete in 1.9 s
  // before answering. Both sides believed the cold-session explanation for
  // several hours, which is why this says so explicitly.
  //
  // So: create nothing until it is nearly needed, create it at the position it
  // will actually be used, and lead by less than the node says it produces
  // ahead. Law 2 — the cost is spent inside the viewer's remaining media,
  // not in front of them.

  function reapedResolver(initial: PlaybackSession, replacement: PlaybackSession) {
    return {
      available: true,
      resolve: vi.fn(async () => initial),
      update: vi.fn(async () => initial),
      stop: vi.fn(async () => undefined),
      sessionAlive: vi.fn(async () => false),
      regenerate: vi.fn(async () => replacement),
      failover: vi.fn(async () => replacement),
      prepareAlternate: vi.fn(async () => undefined),
      recordEndpointFailure: vi.fn(),
    } as any;
  }

  const onNodeA = () => session({ sessionId: 's1', mode: 'transcode', endpoint: { id: 'node-a', baseUrl: 'http://a' } });
  const replacement = () => session({
    sessionId: 's2', mode: 'transcode', endpoint: { id: 'node-a', baseUrl: 'http://a' },
    source: {
      mediaId: 'm1', url: '/generation-replacement.m3u8', mimeType: 'application/vnd.apple.mpegurl',
      isManifest: true, mode: 'transcode', durationMs: 600_000,
    },
  });
  const notFound = () => new PlaybackSourceError('HTTP Error 404', 'not-found');
  const playing = (forwardBufferMs: number, extra: Record<string, unknown> = {}) => ({
    positionMs: 0, durationMs: 600_000, paused: false, ended: false, forwardBufferMs, ...extra,
  }) as PlaybackEvent;

  const ampleRunway = REPLACEMENT_LEAD_TIME_MS * 3;
  const spentRunway = REPLACEMENT_LEAD_TIME_MS - 1_000;

  async function pending() {
    const player = new FakePlayer();
    const api = reapedResolver(onNodeA(), replacement());
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0,
    });
    await coordinator.start();
    player.emit(playing(ampleRunway));
    player.degrade(notFound());
    await vi.waitFor(() => expect(api.sessionAlive).toHaveBeenCalled());
    await flush();
    // The precondition for everything below: the source is known dead, and
    // nothing has been built. A regression to building on notice fails them all.
    expect(api.regenerate).not.toHaveBeenCalled();
    expect(player.playCalls).toHaveLength(1);
    return { player, api, coordinator };
  }

  it('builds nothing while the viewer still has media to watch', async () => {
    const { api, coordinator } = await pending();
    expect(api.failover).not.toHaveBeenCalled();
    expect(api.prepareAlternate).not.toHaveBeenCalled();
    expect(api.recordEndpointFailure).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().fatalError).toBeUndefined();
    await coordinator.close();
  });

  it('builds it once the runway is down to the lead time, and warms it before attaching', async () => {
    const { player, api, coordinator } = await pending();

    player.emit(playing(spentRunway));
    await vi.waitFor(() => expect(player.playCalls).toHaveLength(2));

    expect(api.regenerate).toHaveBeenCalledTimes(1);
    expect(player.playCalls.at(-1)?.source.url).toBe('/generation-replacement.m3u8');
    await coordinator.close();
  });

  it('creates it at the position it will be used, not where the failure was noticed', async () => {
    // The 9.0 s fragment. A generation aimed at where the viewer was 28 s ago
    // makes the node produce forward to catch up before it can serve anything.
    const { player, api, coordinator } = await pending();

    player.emit(playing(spentRunway, { positionMs: 240_000 }));
    await vi.waitFor(() => expect(api.regenerate).toHaveBeenCalled());

    expect(api.regenerate.mock.calls[0][3]).toBe(240_000);
    await coordinator.close();
  });

  it('costs the node nothing when the viewer leaves first', async () => {
    // The obligation the earlier shape created and this one removes. Holding a
    // built session meant closing it explicitly or leaking the node's only
    // video transcode slot until `session_idle`, thirty minutes later.
    const { api, coordinator } = await pending();

    await coordinator.close();

    expect(api.regenerate).not.toHaveBeenCalled();
    expect(api.stop).not.toHaveBeenCalledWith('s2', expect.anything());
  });

  it('builds immediately when the viewer is already waiting', async () => {
    const { player, api, coordinator } = await pending();

    player.emit(playing(ampleRunway, { buffering: true }));
    await vi.waitFor(() => expect(api.regenerate).toHaveBeenCalled());
    await coordinator.close();
  });

  it('builds at the seek target rather than stranding the seek on a dead session', async () => {
    // Until it is built, the coordinator still names the session the node
    // reaped — so the seek's own mutation would PATCH a 404 and read as the
    // replacement failing.
    const { player, api, coordinator } = await pending();

    coordinator.seek(300_000);
    await vi.waitFor(() => expect(api.regenerate).toHaveBeenCalled());

    expect(api.regenerate.mock.calls[0][3]).toBe(300_000);
    expect(api.update).not.toHaveBeenCalled();
    expect(player.playCalls).toHaveLength(2);
    await coordinator.close();
  });

  it('never asks about a session it has already given up on', async () => {
    // Run 1, which cost a viewer 82 s of playable video. A late failure names
    // a source that has been replaced, and `regenerate()` released the endpoint
    // binding the probe resolves through — so it is unprobeable by
    // construction and must never reach the probe.
    const { player, api, coordinator } = await pending();
    api.sessionAlive.mockClear();
    api.sessionAlive.mockImplementation(async () => {
      throw new Error('Playback generation http://a::old-id has no endpoint provenance.');
    });

    player.fail(notFound());
    await flush();

    expect(api.sessionAlive).not.toHaveBeenCalled();
    expect(api.failover).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().fatalError).toBeUndefined();
    await coordinator.close();
  });

  it('does not spend the viewer\'s media because the player gave up first', async () => {
    // The channel must not decide this. hls concedes about 28 s into a dead
    // source, against a lead of 10 — so a rule that built on any fatal would
    // build every time and the deferral would never once happen.
    //
    // It is only safe because an adapter reporting `not-found` leaves the
    // element alone, so a fatal now arrives with the buffer intact. That is
    // the obligation written on `Player.subscribeFailure`.
    const { player, api, coordinator } = await pending();

    player.fail(notFound());
    await flush();

    expect(api.regenerate).not.toHaveBeenCalled();
    expect(player.playCalls).toHaveLength(1);

    // And the stall, when the media really does run out, is what builds it.
    player.emit(playing(0, { buffering: true }));
    await vi.waitFor(() => expect(api.regenerate).toHaveBeenCalledTimes(1));
    await coordinator.close();
  });

  it('resolves a pending replacement even if no further event ever arrives', async () => {
    // Core is now the only thing that ends this playback: the client stops
    // tearing down its presentation on `not-found`, so nothing else will. A
    // recovery that waits on an event is a recovery that hangs when one does
    // not come, and the cost of being wrong is a viewer watching a frozen
    // picture with nothing on the way.
    vi.useFakeTimers();
    try {
      const player = new FakePlayer();
      const api = reapedResolver(onNodeA(), replacement());
      const coordinator = new PlaybackCoordinator({
        media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0,
      });
      await coordinator.start();
      player.emit(playing(ampleRunway));
      player.degrade(notFound());
      await vi.advanceTimersByTimeAsync(0);
      expect(api.regenerate).not.toHaveBeenCalled();

      // Not one further player event, ever.
      await vi.advanceTimersByTimeAsync(ampleRunway);

      expect(api.regenerate).toHaveBeenCalledTimes(1);
      await coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets the dead source go on complaining without building three times', async () => {
    const { player, api, coordinator } = await pending();
    api.sessionAlive.mockClear();

    player.degrade(notFound());
    player.degrade(notFound());
    player.degrade(notFound());
    await flush();

    expect(api.sessionAlive).not.toHaveBeenCalled();
    expect(api.regenerate).not.toHaveBeenCalled();
    expect(player.playCalls).toHaveLength(1);
    await coordinator.close();
  });

  it('counts a host read-ahead as cover, not just what the element has taken', async () => {
    // `forwardBufferMs` is `video.buffered` and nothing else, so on Direct Play
    // — where a worker reads ahead in front of the element — core was blind to
    // most of the real cover and built earlier than it needed to.
    const player = new FakePlayer();
    const direct = session({ sessionId: 's1', mode: 'direct', endpoint: { id: 'node-a', baseUrl: 'http://a' } });
    const api = reapedResolver(direct, session({
      sessionId: 's2', mode: 'direct', endpoint: { id: 'node-a', baseUrl: 'http://a' },
      source: { mediaId: 'm1', url: '/direct-replacement', mimeType: 'video/mp4', isManifest: false, mode: 'direct', durationMs: 600_000 },
    }));
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0,
    });
    await coordinator.start();
    // Ten seconds in the element and a minute more in the worker: the source
    // runs at 10 Mbit/s, so 75 MB is another 60 s of cover.
    player.emit(playing(10_000, { readAheadBytes: 75_000_000 }));

    player.degrade(notFound());
    await vi.waitFor(() => expect(api.sessionAlive).toHaveBeenCalled());
    await flush();

    // Deferred: the element's 10 s alone would have been under the lead time.
    expect(api.regenerate).not.toHaveBeenCalled();
    await coordinator.close();
  });

  it('leads by less than the node says it produces ahead', async () => {
    // The 12.7 s freeze, in one number. A node configured with half the
    // default look-ahead authorises 16 s of production, not 32 — and a client
    // leading by more than that puts the viewer past the frontier, where every
    // fragment is refused until the encoder walks to them.
    const player = new FakePlayer();
    const tightNode = session({
      sessionId: 's1', mode: 'transcode', endpoint: { id: 'node-a', baseUrl: 'http://a' },
      lookAheadMs: 8_000,
    });
    const api = reapedResolver(tightNode, replacement());
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0,
    });
    await coordinator.start();
    // Comfortably above the default lead, and above this node's frontier too.
    player.emit(playing(REPLACEMENT_LEAD_TIME_MS - 1_000));

    player.degrade(notFound());
    await vi.waitFor(() => expect(api.sessionAlive).toHaveBeenCalled());
    await flush();

    // Deferred: the default lead would have built here, but 8 s of look-ahead
    // means the arrival point has to be nearer than that.
    expect(api.regenerate).not.toHaveBeenCalled();
    await coordinator.close();
  });

  it('is not bounded by a frontier direct play does not have', async () => {
    // `null` is "no pipeline, so no frontier", which is a different claim from
    // a frontier of zero. Collapsing them would clamp the lead to nothing and
    // build every direct replacement late.
    const player = new FakePlayer();
    const direct = session({
      sessionId: 's1', mode: 'direct', endpoint: { id: 'node-a', baseUrl: 'http://a' },
      lookAheadMs: null,
    });
    const api = reapedResolver(direct, session({
      sessionId: 's2', mode: 'direct', endpoint: { id: 'node-a', baseUrl: 'http://a' },
      source: { mediaId: 'm1', url: '/direct-replacement', mimeType: 'video/mp4', isManifest: false, mode: 'direct', durationMs: 600_000 },
    }));
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0,
    });
    await coordinator.start();
    player.emit(playing(REPLACEMENT_LEAD_TIME_MS + 5_000));

    player.degrade(notFound());
    await vi.waitFor(() => expect(api.sessionAlive).toHaveBeenCalled());
    await flush();

    expect(api.regenerate).not.toHaveBeenCalled();
    await coordinator.close();
  });

  it('accepts a generation the node started ahead, because asking again returns the same one', async () => {
    // A bound here was tried and livelocked. A node's alignment is
    // deterministic: asked for 2926000 it returned 2934933, and returned it
    // again every time it was asked. Measured — 147 negotiations in 33.3 s,
    // every `serverSeekMs` identical, nothing ever activated, the viewer's seek
    // never happened, and the node took four requests a second throughout.
    //
    // Rejecting cannot converge when the answer does not change. The overshoot
    // is the server's to fix; what core owes is to attach *something* and to
    // report where the viewer actually landed rather than where they asked to.
    const player = new FakePlayer();
    const overshot = session({
      sessionId: 's2', mode: 'transcode', seekMs: 15_300,
      endpoint: { id: 'node-a', baseUrl: 'http://a' },
      source: {
        mediaId: 'm1', url: '/generation-overshot.m3u8', mimeType: 'application/vnd.apple.mpegurl',
        isManifest: true, mode: 'transcode', durationMs: 600_000,
      },
    });
    const api = reapedResolver(onNodeA(), overshot);
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0,
    });
    await coordinator.start();
    player.emit({ positionMs: 5_800, durationMs: 600_000, paused: false, ended: false, forwardBufferMs: 1_000 });
    player.emit({ positionMs: 6_000, durationMs: 600_000, paused: false, ended: false, forwardBufferMs: 1_000 });
    await flush();

    player.degrade(notFound());
    await vi.waitFor(() => expect(player.playCalls).toHaveLength(2));
    await flush();

    // Attached, once, and never renegotiated.
    expect(player.playCalls.at(-1)?.source.url).toBe('/generation-overshot.m3u8');
    expect(api.update).not.toHaveBeenCalled();
    // Reported where they landed — the generation's origin — not where they
    // asked to be. Claiming the latter is what made the skip invisible.
    expect(coordinator.getSnapshot().intent.positionMs).toBe(15_300);
    await coordinator.close();
  });

  it('leads by the measured cost of replacing a source, inside what a node produces ahead', () => {
    // Measured: ~4 s to negotiate a session, because the node blocks on the
    // first fragment inside the 201, plus up to 16 s for a host to get the join
    // point resident before it can cut to it. The preparation figure tracks the
    // node rather than the mechanism — 1.0 s, 14.5 s and 16.0 s across one
    // evening — so the lead is built on the worst observed, not the first.
    //
    // Bounded above by the node's look-ahead, and that bound is what makes
    // leading long safe at all: inside it the join is already produced, past it
    // the encoder runs forward sequentially to reach the viewer.
    const MEASURED_REPLACEMENT_COST_MS = 20_000;
    const CONSERVATIVE_LOOK_AHEAD_MS = 32_000;
    expect(REPLACEMENT_LEAD_TIME_MS).toBeGreaterThan(MEASURED_REPLACEMENT_COST_MS);
    expect(REPLACEMENT_LEAD_TIME_MS).toBeLessThan(CONSERVATIVE_LOOK_AHEAD_MS - LOOK_AHEAD_MARGIN_MS);
  });

  it('attaches a generation the node started slightly ahead, rather than negotiating another', async () => {
    // The largest single slice of a measured recovery: 6.21 s of frozen picture.
    // A node aligns a requested start to the next keyframe, so a generation
    // asked for at X can begin a segment later — and a viewer who travelled less
    // than that while it was being negotiated ends up behind its own origin.
    // The old test was exact equality of requested and desired, which holds only
    // if playback did not advance during the request, and a recovery takes
    // seconds the viewer spends watching.
    const player = new FakePlayer();
    const initial = onNodeA();
    // Server aligned the start 2 s past where the viewer now is.
    const aligned = session({
      sessionId: 's2', mode: 'transcode', seekMs: 8_000,
      endpoint: { id: 'node-a', baseUrl: 'http://a' },
      source: {
        mediaId: 'm1', url: '/generation-aligned.m3u8', mimeType: 'application/vnd.apple.mpegurl',
        isManifest: true, mode: 'transcode', durationMs: 600_000,
      },
    });
    const api = reapedResolver(initial, aligned);
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0,
    });
    await coordinator.start();
    player.emit({ positionMs: 5_800, durationMs: 600_000, paused: false, ended: false, forwardBufferMs: 1_000 });
    player.emit({ positionMs: 6_000, durationMs: 600_000, paused: false, ended: false, forwardBufferMs: 1_000 });
    await flush();

    player.degrade(notFound());
    await vi.waitFor(() => expect(player.playCalls).toHaveLength(2));

    // Attached at the generation's own origin. The alternative was a whole
    // second negotiation for a forward skip of two seconds.
    expect(player.playCalls.at(-1)?.source.url).toBe('/generation-aligned.m3u8');
    expect(player.playCalls.at(-1)?.positionMs).toBe(0);
    expect(api.update).not.toHaveBeenCalled();
    await coordinator.close();
  });
});

describe('the runway is measured when it is spent, not when it was last reported', () => {
  // Found 2026-09-19, answering a client's question about how long it may
  // spend classifying a statusless player error. `runwayMs()` reads
  // `snapshot.event`, which is the *last event the player sent* — and on the
  // terminal path the player has by definition stopped sending. Then
  // `recoverFromMissingSession` awaits `sessionAlive()`, a whole router walk,
  // and only then compares the cover against the lead time. So the comparison
  // was between a figure measured before two round trips and a lead time that
  // assumed it was current. It only ever reads high, so core deferred a
  // replacement it no longer had the cover to defer.

  function reapedResolver(initial: PlaybackSession, replacement: PlaybackSession, aliveDelayMs: number) {
    return {
      available: true,
      resolve: vi.fn(async () => initial),
      update: vi.fn(async () => initial),
      stop: vi.fn(async () => undefined),
      sessionAlive: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, aliveDelayMs));
        return false;
      }),
      regenerate: vi.fn(async () => replacement),
      failover: vi.fn(async () => replacement),
      prepareAlternate: vi.fn(async () => undefined),
      recordEndpointFailure: vi.fn(),
    } as any;
  }

  const onNodeA = () => session({ sessionId: 's1', mode: 'transcode', endpoint: { id: 'node-a', baseUrl: 'http://a' } });
  const replacement = () => session({
    sessionId: 's2',
    mode: 'transcode',
    endpoint: { id: 'node-a', baseUrl: 'http://a' },
    source: {
      mediaId: 'm1', url: '/generation-replacement.m3u8', mimeType: 'application/vnd.apple.mpegurl',
      isManifest: true, mode: 'transcode', durationMs: 600_000,
    },
  });
  const notFound = () => new PlaybackSourceError('HTTP Error 404', 'not-found');

  it('builds at once when the probe outlasted the cover it was deferring against', async () => {
    // 40 s of cover against a 26 s lead defers — but the probe takes 20 s, so
    // by the time the answer arrives there are 20 s left and the lead is no
    // longer covered. Reading the pre-probe figure defers anyway, and the
    // viewer then waits for the 15 s silence guard to notice.
    vi.useFakeTimers();
    try {
      const player = new FakePlayer();
      const api = reapedResolver(onNodeA(), replacement(), 20_000);
      const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
      await coordinator.start();
      player.emit({ positionMs: 10_000, durationMs: 600_000, paused: false, ended: false, forwardBufferMs: 40_000 });

      player.degrade(notFound());
      await vi.advanceTimersByTimeAsync(20_000);

      await vi.waitFor(() => expect(api.sessionAlive).toHaveBeenCalled());
      expect(api.regenerate).toHaveBeenCalledTimes(1);
      await coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not spend a paused viewer’s buffer, because a paused element drains nothing', async () => {
    // The counterpart, and the reason the decay cannot simply be elapsed time.
    // This whole fault begins with a pause long enough to have the session
    // reaped, so the paused case is the common one rather than the corner.
    vi.useFakeTimers();
    try {
      const player = new FakePlayer();
      const api = reapedResolver(onNodeA(), replacement(), 40_000);
      const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
      await coordinator.start();
      coordinator.setPaused(true);
      player.emit({ positionMs: 10_000, durationMs: 600_000, paused: true, ended: false, forwardBufferMs: 60_000 });

      player.degrade(notFound());
      await vi.advanceTimersByTimeAsync(40_000);

      await vi.waitFor(() => expect(api.sessionAlive).toHaveBeenCalled());
      expect(api.regenerate).not.toHaveBeenCalled();
      await coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('distrusts an empty buffer from an element that is not reporting the viewer waiting', async () => {
    // The obvious fix for the above is to have the adapter emit a fresh event
    // before it reports a failure. It is unsafe today: `positionMs` is guarded
    // against a tearing-down element reporting zero, and `forwardBufferMs`
    // rides through the same spread with no guard at all. A player that zeroes
    // its buffer on the way down would write `no-cover` straight into this
    // decision. A playing element with no cover ahead and no `buffering` flag
    // is describing a state that cannot happen, so it is not evidence.
    vi.useFakeTimers();
    try {
      const player = new FakePlayer();
      const api = reapedResolver(onNodeA(), replacement(), 0);
      const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
      await coordinator.start();
      player.emit({ positionMs: 10_000, durationMs: 600_000, paused: false, ended: false, forwardBufferMs: 40_000 });
      player.emit({ positionMs: 10_000, durationMs: 600_000, paused: false, ended: false, forwardBufferMs: 0 });

      player.degrade(notFound());
      await vi.advanceTimersByTimeAsync(10);

      await vi.waitFor(() => expect(api.sessionAlive).toHaveBeenCalled());
      expect(api.regenerate).not.toHaveBeenCalled();
      await coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not invent cover when the buffer genuinely drained to nothing', async () => {
    // Raised by the web client 2026-09-20, against the guard above. On a
    // `source-gone` generation that adapter deliberately does not tear down,
    // so the element plays out the buffer built before the source went away.
    // As `currentMs` passes the end of the last range `forwardBufferMs` is
    // genuinely `0`, while `readyState` stays at 4 for a beat before dropping
    // below `HAVE_FUTURE_DATA` and flipping `buffering` true. That is a real
    // zero wearing the exact shape the guard distrusts.
    //
    // It is harmless, and the reason is that the two halves of this fix are
    // not independent: the trusted figure is *aged*, and a buffer that drained
    // by playing took exactly as long to drain as it was worth. So by the
    // moment the true zero arrives the decayed figure has reached zero too,
    // and the guard can only ever hold a figure the viewer has already spent.
    // Pinned rather than reasoned about, because the guard would otherwise be
    // one edit away from handing core cover it does not have.
    vi.useFakeTimers();
    try {
      const player = new FakePlayer();
      const api = reapedResolver(onNodeA(), replacement(), 0);
      const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
      await coordinator.start();
      // Deliberately above the 26 s lead, so the two behaviours differ: an
      // un-aged trusted figure would still read as 40 s of cover here and
      // defer, which is the failure this pins.
      player.emit({ positionMs: 10_000, durationMs: 600_000, paused: false, ended: false, forwardBufferMs: 40_000 });
      // The forty seconds of cover are actually watched.
      await vi.advanceTimersByTimeAsync(40_000);
      player.emit({ positionMs: 50_000, durationMs: 600_000, paused: false, ended: false, forwardBufferMs: 0 });

      player.degrade(notFound());
      await vi.advanceTimersByTimeAsync(10);

      await vi.waitFor(() => expect(api.regenerate).toHaveBeenCalledTimes(1));
      await coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('believes an empty buffer when the element says the viewer is waiting', async () => {
    // The other half, and the one that stops the guard becoming a way to
    // ignore real exhaustion: `buffering` means the viewer is already waiting,
    // whatever the arithmetic says, so there is nothing left to defer for.
    vi.useFakeTimers();
    try {
      const player = new FakePlayer();
      const api = reapedResolver(onNodeA(), replacement(), 0);
      const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
      await coordinator.start();
      player.emit({ positionMs: 10_000, durationMs: 600_000, paused: false, ended: false, forwardBufferMs: 40_000 });
      player.emit({ positionMs: 10_000, durationMs: 600_000, paused: false, ended: false, forwardBufferMs: 0, buffering: true });

      player.degrade(notFound());
      await vi.advanceTimersByTimeAsync(10);

      await vi.waitFor(() => expect(api.regenerate).toHaveBeenCalledTimes(1));
      await coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a recovery restates the transforms the chooser picked', () => {
  // The Android TV client measured this on hardware, 2026-09-20. A generation
  // passing HEVC 1920x1040 through untouched — `mode: transcode`, `video:
  // copy`, DTS 5.1 converted to AAC — was reaped on its node, and the
  // replacement re-encoded the video to H264, taking the new node's only
  // `max_video_transcodes` slot to convert a picture the television had been
  // decoding natively. The server ruled out its own substitution: its journal
  // showed `mode=transcode` from admission. Something asked for it, and this
  // is what asked.

  function copyVideoTranscodeAudio(): PlaybackCapabilities {
    return { platform: 'android', videoCodecs: ['hevc'], audioCodecs: ['aac'], containers: ['mp4'], hlsFmp4: true, dash: false, hdr: [] };
  }

  function hevcWithDts() {
    return { profile: { mediaId: 'm1', format: 'matroska', container: 'mkv', durationMs: 600_000, bitrate: 20_000_000, streams: [
      { index: 0, type: 'video' as const, codec: 'hevc', profile: 'Main 10', language: '', default: true, forced: false },
      { index: 1, type: 'audio' as const, codec: 'dts', profile: '', language: '', default: true, forced: false },
    ] } };
  }

  async function startChosen(api: PlaybackResolver, player: FakePlayer): Promise<PlaybackCoordinator> {
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: api,
      capabilities: async () => copyVideoTranscodeAudio(),
      initialPositionMs: 0,
      facts: async () => hevcWithDts(),
    });
    await coordinator.start();
    return coordinator;
  }

  it('sends video and audio on a failover, not a bare mode the server reads as a fresh transcode', async () => {
    const player = new FakePlayer();
    const initial = session({
      mode: 'transcode',
      endpoint: { id: 'node-a', baseUrl: 'http://a' },
      preferences: { mode: 'transcode', maxHeight: null, maxBitrate: null, audioStream: 1, subtitleStream: null, audioLanguage: '', subtitleLanguage: '' },
    });
    const replacement = session({
      sessionId: 's2', mode: 'transcode',
      endpoint: { id: 'node-b', baseUrl: 'http://b' },
      source: { ...initial.source, mode: 'transcode', url: 'http://b/replacement.m3u8' },
    });
    const api = resolver(initial) as ReturnType<typeof resolver> & { failover: ReturnType<typeof vi.fn> };
    api.failover = vi.fn(async () => replacement);
    const coordinator = await startChosen(api, player);

    // The chooser did pick a copy, or this test pins nothing.
    expect(coordinator.getSnapshot().instruction).toMatchObject({ mode: 'transcode', video: 'copy', audio: 'transcode' });

    player.emit({ positionMs: 0, durationMs: 600_000, paused: false, ended: false });
    player.fail(new Error('node A stream failed'));

    await vi.waitFor(() => expect(api.failover).toHaveBeenCalled());
    expect(api.failover.mock.calls[0]?.[4]).toMatchObject({ mode: 'transcode', video: 'copy', audio: 'transcode' });
  });

  it('gives up the copy once when the replacement node refuses it, rather than leaving the viewer with nothing', async () => {
    // Restating the copy asks a node that never agreed to it to perform it,
    // and a 400 is not a retryable endpoint failure — the candidate walk
    // throws rather than trying the next one. Without the single step down,
    // this fix would trade a silent full transcode for a terminal failure.
    const player = new FakePlayer();
    const initial = session({
      mode: 'transcode',
      endpoint: { id: 'node-a', baseUrl: 'http://a' },
      preferences: { mode: 'transcode', maxHeight: null, maxBitrate: null, audioStream: 1, subtitleStream: null, audioLanguage: '', subtitleLanguage: '' },
    });
    const replacement = session({
      sessionId: 's2', mode: 'transcode',
      endpoint: { id: 'node-b', baseUrl: 'http://b' },
      source: { ...initial.source, mode: 'transcode', url: 'http://b/replacement.m3u8' },
    });
    const api = resolver(initial) as ReturnType<typeof resolver> & { failover: ReturnType<typeof vi.fn> };
    api.failover = vi.fn(async (_failed, _media, _caps, _seekMs, preferences: PlaybackPreferencesUpdate) => {
      if (preferences.video === 'copy') throw Object.assign(new Error('cannot copy HEVC into fMP4 on this build'), { status: 400 });
      return replacement;
    });
    const coordinator = await startChosen(api, player);

    player.emit({ positionMs: 0, durationMs: 600_000, paused: false, ended: false });
    player.fail(new Error('node A stream failed'));

    await vi.waitFor(() => expect(api.failover).toHaveBeenCalledTimes(2));
    expect(api.failover.mock.calls[1]?.[4]).toMatchObject({ mode: 'transcode', video: 'transcode' });
    await vi.waitFor(() => expect(coordinator.getSnapshot().session?.endpoint?.id).toBe('node-b'));
    expect(coordinator.getSnapshot().fatalError).toBeUndefined();

    // And the downgrade is what the generation is now running on, so the next
    // recovery does not re-ask for the copy this one has already given up.
    expect(coordinator.getSnapshot().instruction).toMatchObject({ mode: 'transcode', video: 'transcode' });
  });

  it('does not pair the old mode\'s transforms with a mode the viewer has just changed to', async () => {
    // A wrong restatement is worse than none: it pins a transform to a mode it
    // did not belong to. The pending change is the mode being sent, so the
    // report describing the previous one has nothing to say about it.
    const player = new FakePlayer();
    const initial = session({
      mode: 'transcode',
      endpoint: { id: 'node-a', baseUrl: 'http://a' },
      preferences: { mode: 'transcode', maxHeight: null, maxBitrate: null, audioStream: 1, subtitleStream: null, audioLanguage: '', subtitleLanguage: '' },
    });
    const update = deferred<PlaybackSession>();
    const api = resolver(initial, async () => update.promise) as ReturnType<typeof resolver> & { failover: ReturnType<typeof vi.fn> };
    api.failover = vi.fn(async () => session({
      sessionId: 's2', mode: 'remux',
      endpoint: { id: 'node-b', baseUrl: 'http://b' },
      source: { ...initial.source, mode: 'remux', url: 'http://b/replacement.m3u8' },
    }));
    const coordinator = await startChosen(api, player);

    player.emit({ positionMs: 0, durationMs: 600_000, paused: false, ended: false });
    coordinator.update({ preferences: { mode: 'remux' } });
    await flush();
    player.fail(new Error('node A stream failed'));

    await vi.waitFor(() => expect(api.failover).toHaveBeenCalled());
    const sent = api.failover.mock.calls[0]?.[4] as PlaybackPreferencesUpdate;
    expect(sent.mode).toBe('remux');
    expect(sent.video).toBeUndefined();
    expect(sent.audio).toBeUndefined();
    update.resolve(initial);
  });
});

describe('a dead source goes on talking while its replacement is negotiated', () => {
  // The last uncovered scenario in ACTIVE.md's coverage table. A source that
  // has failed is neither stopped nor unsubscribed while recovery runs, so it
  // plays out its buffer and reports `ended` short of duration — which
  // `onPlayerEvent` correctly reads as a premature end and sends back as a
  // second fatal failure, from the same source, about the same outage, one to
  // three seconds after the first. Taken terminal it closes the coordinator,
  // and the replacement that was seconds from ready is thrown away by the
  // disposed path: the viewer gets the failure screen instead of the recovery
  // that had already worked.

  const onNodeA = () => session({ sessionId: 's1', mode: 'transcode', endpoint: { id: 'node-a', baseUrl: 'http://a' } });
  const onNodeB = () => session({
    sessionId: 's2', mode: 'transcode', endpoint: { id: 'node-b', baseUrl: 'http://b' },
    source: {
      mediaId: 'm1', url: 'http://b/replacement.m3u8', mimeType: 'application/vnd.apple.mpegurl',
      isManifest: true, mode: 'transcode', durationMs: 600_000,
    },
  });

  // **Guarded twice, and this test pins the behaviour rather than either
  // line.** `failNow` returns early on `failoverPromise`, and
  // `beginSourceFailover` refuses to start a second failover on the same
  // field. Removing either alone leaves the whole suite green — 935 tests,
  // checked — and only removing both turns this red. The two are not the same
  // intent (one drops a dying source's noise, one keeps recovery single), so
  // both belong; but neither may be described as the thing under test here.
  it('drops a second failure that arrives while a failover is still in flight', async () => {
    const player = new FakePlayer();
    const initial = onNodeA();
    const api = resolver(initial) as ReturnType<typeof resolver> & { failover: ReturnType<typeof vi.fn> };
    const negotiation = deferred<PlaybackSession>();
    api.failover = vi.fn(() => negotiation.promise);
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
    await coordinator.start();
    player.emit({ positionMs: 30_000, durationMs: 600_000, paused: false, ended: false });

    player.fail(new PlaybackSourceError('node A stream failed', 'stream'));
    await vi.waitFor(() => expect(api.failover).toHaveBeenCalledTimes(1));

    // The tail running out, arriving as a bare Error — which the default
    // classification treats as endpoint evidence, so it would otherwise
    // condemn a node for an outage already being recovered from.
    player.fail(new Error('Playback ended at 33000 of 600000'));
    await flush();
    player.fail(new Error('Playback ended at 33000 of 600000'));
    await flush();

    expect(coordinator.getSnapshot().fatalError).toBeUndefined();
    expect(api.failover).toHaveBeenCalledTimes(1);

    negotiation.resolve(onNodeB());
    await vi.waitFor(() => expect(player.playCalls.at(-1)?.source.url).toBe('http://b/replacement.m3u8'));
    expect(coordinator.getSnapshot().fatalError).toBeUndefined();
    await coordinator.close();
  });

  it('drops a failure that arrives while the session is being regenerated', async () => {
    // Same shape through the other recovery door. The node forgot the session
    // rather than failing, so the replacement is being built on the node that
    // is fine — and the element draining in the meantime must not be allowed
    // to condemn it.
    const player = new FakePlayer();
    const initial = onNodeA();
    const regeneration = deferred<PlaybackSession>();
    const api = {
      available: true,
      resolve: vi.fn(async () => initial),
      update: vi.fn(async () => initial),
      stop: vi.fn(async () => undefined),
      sessionAlive: vi.fn(async () => false),
      regenerate: vi.fn(() => regeneration.promise),
      failover: vi.fn(async () => onNodeB()),
      prepareAlternate: vi.fn(async () => undefined),
      recordEndpointFailure: vi.fn(),
    } as any;
    const coordinator = new PlaybackCoordinator({ media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0 });
    await coordinator.start();
    // No cover left, so the replacement is built now rather than deferred.
    player.emit({ positionMs: 30_000, durationMs: 600_000, paused: false, ended: false, forwardBufferMs: 0, buffering: true } as PlaybackEvent);

    player.fail(new PlaybackSourceError('HTTP Error 404', 'not-found'));
    await vi.waitFor(() => expect(api.regenerate).toHaveBeenCalledTimes(1));

    player.fail(new Error('Playback ended at 30000 of 600000'));
    await flush();

    expect(coordinator.getSnapshot().fatalError).toBeUndefined();
    expect(api.failover).not.toHaveBeenCalled();

    regeneration.resolve(onNodeB());
    await vi.waitFor(() => expect(player.playCalls.at(-1)?.source.url).toBe('http://b/replacement.m3u8'));
    expect(coordinator.getSnapshot().fatalError).toBeUndefined();
    await coordinator.close();
  });
});

describe('a node that performs a different mode from the one it was asked for', () => {
  // The server does exactly one substitution and it is not silent — it is
  // merely unexamined. When a remux's keyframe index is unusable as a segment
  // plan and the node allows the video-transcode fallback, it plans a
  // transcode and says so: the top-level `mode` is what it performed while
  // `preferences` still echoes what it was asked for. Nothing in core compared
  // the two, so a title whose keyframe index will never be usable was
  // re-asked for a remux on every recovery and substituted every time.

  function substitutionReports(): unknown[] {
    return clientDiagnosticsSnapshot().filter((entry) => entry.event === 'generation-mode-substituted');
  }

  const remuxPreferences = (): PlaybackPreferences => ({
    mode: 'remux', maxHeight: null, maxBitrate: null,
    audioStream: 1, subtitleStream: null, audioLanguage: '', subtitleLanguage: '',
  });

  it('reports the substitution rather than leaving it to be inferred from a slow generation', async () => {
    clearClientDiagnostics();
    const player = new FakePlayer();
    // Asked for remux; the node planned a transcode and said so.
    const substituted = session({
      sessionId: 's1', mode: 'transcode', preferences: remuxPreferences(),
      endpoint: { id: 'node-a', baseUrl: 'http://a' },
    });
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: resolver(substituted),
      capabilities: async () => capabilities(), initialPositionMs: 0,
      initialPreferences: { mode: 'remux' },
    });
    await coordinator.start();

    const report = coordinator.getSnapshot().instruction;
    expect(report?.performedMode).toBe('transcode');
    expect(report?.modeHonoured).toBe(false);
    expect(substitutionReports()).toHaveLength(1);
    await coordinator.close();
  });

  it('says the mode was honoured when the node did what it was asked', async () => {
    clearClientDiagnostics();
    const player = new FakePlayer();
    const honoured = session({
      sessionId: 's1', mode: 'remux', preferences: remuxPreferences(),
      endpoint: { id: 'node-a', baseUrl: 'http://a' },
    });
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: resolver(honoured),
      capabilities: async () => capabilities(), initialPositionMs: 0,
      initialPreferences: { mode: 'remux' },
    });
    await coordinator.start();

    expect(coordinator.getSnapshot().instruction?.modeHonoured).toBe(true);
    expect(substitutionReports()).toHaveLength(0);
    await coordinator.close();
  });

  it('does not report a viewer mode change as a node substitution', async () => {
    // The distinction the field exists to keep, and the case that actually
    // separates the two candidate comparisons. `snapshot.instruction` is
    // patched by the chooser and by a degrade, but **not** by a plain viewer
    // mode change — so after the viewer switches, the report still names the
    // mode the chooser picked at start. Comparing the performed mode against
    // *that* calls every viewer mode change a server substitution. Comparing
    // it against the node's own echo of what it was asked for does not.
    clearClientDiagnostics();
    const player = new FakePlayer();
    const startedOn = session({
      sessionId: 's1', mode: 'transcode',
      preferences: { ...remuxPreferences(), mode: 'transcode' },
      endpoint: { id: 'node-a', baseUrl: 'http://a' },
    });
    const switchedTo = session({
      sessionId: 's1', mode: 'remux', preferences: remuxPreferences(),
      endpoint: { id: 'node-a', baseUrl: 'http://a' },
      source: { ...startedOn.source, mode: 'remux', url: '/generation-remux.m3u8' },
    });
    const api = resolver(startedOn, async () => switchedTo);
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: api,
      capabilities: async () => capabilities(), initialPositionMs: 0,
      initialPreferences: { mode: 'transcode' },
    });
    await coordinator.start();
    expect(coordinator.getSnapshot().instruction?.mode).toBe('transcode');

    coordinator.update({ preferences: { mode: 'remux' } });
    await vi.waitFor(() => expect(coordinator.getSnapshot().session?.mode).toBe('remux'));

    // The node did exactly what the viewer asked. Nothing was substituted.
    expect(coordinator.getSnapshot().instruction?.performedMode).toBe('remux');
    expect(coordinator.getSnapshot().instruction?.modeHonoured).toBe(true);
    expect(substitutionReports()).toHaveLength(0);
    await coordinator.close();
  });

  it('reports once per generation, not once per snapshot patch', async () => {
    // `setSession` runs on every session change, and a diagnostics surface a
    // viewer can see is on screen for the whole of a film on at least one
    // client. A substitution that reported itself repeatedly would be noise.
    clearClientDiagnostics();
    const player = new FakePlayer();
    const substituted = session({
      sessionId: 's1', mode: 'transcode', preferences: remuxPreferences(),
      endpoint: { id: 'node-a', baseUrl: 'http://a' },
    });
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: resolver(substituted),
      capabilities: async () => capabilities(), initialPositionMs: 0,
      initialPreferences: { mode: 'remux' },
    });
    await coordinator.start();
    expect(substitutionReports()).toHaveLength(1);

    // A subtitle change re-runs `setSession` for the same generation — the
    // cheapest path that patches the report twice without replacing it.
    coordinator.update({ preferences: { subtitleStream: 2 } });
    await vi.waitFor(() => expect(player.subtitleCalls.length).toBeGreaterThan(0));
    await flush();

    expect(substitutionReports()).toHaveLength(1);
    await coordinator.close();
  });
});

describe('a failure the host never classified is still charged to a node', () => {
  // `isEndpointRetryablePlaybackFailure` cannot tell a host that never wired
  // classification from one whose classifier ran and could not tell — and, as
  // the Android TV client measured on 2026-09-20, it cannot tell either of
  // those from a classifier that was meant to run and silently did not. That
  // last case sent a reaped session through as `kind: 'unknown'` carrying
  // `Response code: 404` in its message: core charged a node that had
  // answered honestly and walked a generation `not-found` would have
  // regenerated in place. Core must not read the status out of the message.
  // It can stop the charge being silent, which is what these pin.

  function unclassifiedReports(): Array<Record<string, unknown>> {
    return clientDiagnosticsSnapshot()
      .filter((entry) => entry.event === 'source-failure-unclassified')
      // The coordinator's logger is scoped, so its own context is the entry
      // and what the call site passed is nested under `detail`.
      .map((entry) => ((entry.data as { detail?: unknown })?.detail ?? {}) as Record<string, unknown>);
  }

  const onNodeA = () => session({ sessionId: 's1', mode: 'transcode', endpoint: { id: 'node-a', baseUrl: 'http://a' } });
  const onNodeB = () => session({
    sessionId: 's2', mode: 'transcode', endpoint: { id: 'node-b', baseUrl: 'http://b' },
    source: {
      mediaId: 'm1', url: 'http://b/replacement.m3u8', mimeType: 'application/vnd.apple.mpegurl',
      isManifest: true, mode: 'transcode', durationMs: 600_000,
    },
  });

  function failingResolver(initial: PlaybackSession) {
    return {
      available: true,
      resolve: vi.fn(async () => initial),
      update: vi.fn(async () => initial),
      stop: vi.fn(async () => undefined),
      failover: vi.fn(async () => onNodeB()),
      recordEndpointFailure: vi.fn(),
    } as any;
  }

  it('names the node it is about to charge on a failure carrying no kind at all', async () => {
    clearClientDiagnostics();
    const player = new FakePlayer();
    const api = failingResolver(onNodeA());
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: api,
      capabilities: async () => capabilities(), initialPositionMs: 0,
    });
    await coordinator.start();
    player.emit({ positionMs: 30_000, durationMs: 600_000, paused: false, ended: false });

    // The shape the Android TV client shipped: the status is in the message,
    // and nothing else about the error says what happened.
    player.fail(new Error('A playback exception has occurred: Source error Response code: 404'));
    await vi.waitFor(() => expect(api.failover).toHaveBeenCalledTimes(1));

    const reports = unclassifiedReports();
    expect(reports).toHaveLength(1);
    expect(reports[0].classified).toBe(false);
    expect(reports[0].channel).toBe('fatal');
    expect(reports[0].endpoint).toEqual({ id: 'node-a', baseUrl: 'http://a' });
    // The evidence core is forbidden from parsing is carried verbatim, so a
    // capture shows what the host had and did not use.
    expect(reports[0].message).toContain('Response code: 404');
    await coordinator.close();
  });

  it('separates a host that tried and could not tell from one that never tried', async () => {
    clearClientDiagnostics();
    const player = new FakePlayer();
    const api = failingResolver(onNodeA());
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: api,
      capabilities: async () => capabilities(), initialPositionMs: 0,
    });
    await coordinator.start();
    player.emit({ positionMs: 30_000, durationMs: 600_000, paused: false, ended: false });

    player.fail(new PlaybackSourceError('could not establish a cause', 'unknown'));
    await vi.waitFor(() => expect(api.failover).toHaveBeenCalledTimes(1));

    expect(unclassifiedReports()).toHaveLength(1);
    expect(unclassifiedReports()[0].classified).toBe(true);
    await coordinator.close();
  });

  it('says nothing when the host classified the failure', async () => {
    clearClientDiagnostics();
    const player = new FakePlayer();
    const api = failingResolver(onNodeA());
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: api,
      capabilities: async () => capabilities(), initialPositionMs: 0,
    });
    await coordinator.start();
    player.emit({ positionMs: 30_000, durationMs: 600_000, paused: false, ended: false });

    // Real evidence about the node. The charge is earned and needs no note.
    player.fail(new PlaybackSourceError('node A stream failed', 'stream'));
    await vi.waitFor(() => expect(api.failover).toHaveBeenCalledTimes(1));

    expect(unclassifiedReports()).toHaveLength(0);
    await coordinator.close();
  });

  it('reports once per session, not once per failure', async () => {
    // **The fatal channel cannot show this and must not be used for it.** A
    // second fatal arriving during a failover is dropped by `failNow`'s
    // `failoverPromise` guard before it ever reaches the note, so a test
    // driven that way passes with the latch deleted — checked, and that is
    // exactly how this test read on its first writing.
    //
    // The degradation channel does reach it twice, when `prepareAlternate`
    // has nothing to offer: no standby is held, so nothing short-circuits the
    // next one. That is also the live shape — a dead source goes on emitting
    // while a cluster with no spare node has nothing to prepare, so the same
    // unclassified outage arrives over and over. One line per generation, for
    // the reason the mode substitution takes one: a client renders this onto
    // a television for the whole of a film.
    clearClientDiagnostics();
    const player = new FakePlayer();
    const api = failingResolver(onNodeA());
    api.prepareAlternate = vi.fn(async () => undefined);
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: api,
      capabilities: async () => capabilities(), initialPositionMs: 0,
    });
    await coordinator.start();
    player.emit({ positionMs: 30_000, durationMs: 600_000, paused: false, ended: false });

    player.degrade(new Error('Source error Response code: 404'));
    await vi.waitFor(() => expect(api.prepareAlternate).toHaveBeenCalledTimes(1));
    player.degrade(new Error('Source error Response code: 404'));
    await vi.waitFor(() => expect(api.prepareAlternate).toHaveBeenCalledTimes(2));

    expect(unclassifiedReports()).toHaveLength(1);
    expect(unclassifiedReports()[0].channel).toBe('degradation');
    await coordinator.close();
  });
});

describe('a recovery that never comes back and never fails', () => {
  // **The shape no named mechanism explains, and the viewer was still frozen.**
  // On 2026-09-20 a reap reached `session-reaped-regenerating` and then nothing
  // for minutes, `preparingSource` true the whole time. Afterwards every branch
  // was closed: the close settled, the create is bounded and cannot compute a
  // zero budget, `activateSession` is synchronous, nothing was disposed, the
  // bundle held one copy of core, and the silence was read off three frames by
  // eye rather than by the detector that later turned out to be broken.
  //
  // So this does not pin a suspect. It pins the rule that the work item has a
  // budget even when its limbs each have one - which is what turns every
  // unnamed mechanism, including ones nobody has thought of, from an indefinite
  // freeze into a bounded wait and the failover that already exists.

  const onNodeA = () => session({ sessionId: 's1', mode: 'transcode', endpoint: { id: 'node-a', baseUrl: 'http://a' } });
  const onNodeB = () => session({
    sessionId: 's2', mode: 'transcode', endpoint: { id: 'node-b', baseUrl: 'http://b' },
    source: {
      mediaId: 'm1', url: 'http://b/replacement.m3u8', mimeType: 'application/vnd.apple.mpegurl',
      isManifest: true, mode: 'transcode', durationMs: 600_000,
    },
  });

  function stuckResolver(initial: PlaybackSession, regenerate: () => Promise<PlaybackSession>) {
    return {
      available: true,
      resolve: vi.fn(async () => initial),
      update: vi.fn(async () => initial),
      stop: vi.fn(async () => undefined),
      sessionAlive: vi.fn(async () => false),
      regenerate: vi.fn(regenerate),
      failover: vi.fn(async () => onNodeB()),
      recordEndpointFailure: vi.fn(),
    } as any;
  }

  it('gives up on a regeneration that neither returns nor throws, and fails over', async () => {
    vi.useFakeTimers();
    try {
      const player = new FakePlayer();
      // Neither resolves nor rejects: the observed shape exactly.
      const api = stuckResolver(onNodeA(), () => new Promise<PlaybackSession>(() => {}));
      const coordinator = new PlaybackCoordinator({
        media: media(), player, resolver: api,
        capabilities: async () => capabilities(), initialPositionMs: 0,
      });
      await coordinator.start();
      player.emit({ positionMs: 30_000, durationMs: 600_000, paused: false, ended: false, forwardBufferMs: 0, buffering: true } as PlaybackEvent);

      player.fail(new PlaybackSourceError('HTTP Error 404', 'not-found'));
      await vi.waitFor(() => expect(api.regenerate).toHaveBeenCalledTimes(1));
      expect(coordinator.getSnapshot().preparingSource).toBe(true);

      // The node's stated budget is 19 s, so supervision lands at 48 s.
      await vi.advanceTimersByTimeAsync(60_000);

      expect(api.failover).toHaveBeenCalled();
      expect(coordinator.getSnapshot().preparingSource).toBe(false);
      await coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases a replacement that lands after supervision gave up', async () => {
    // A success nobody is waiting for is a generation nobody will ever close,
    // and on a node whose max_video_transcodes is 1 that is the next viewer's
    // refusal. Never cancelled, because a cancelled create tells the node
    // nothing about whether to keep the work.
    vi.useFakeTimers();
    try {
      const player = new FakePlayer();
      let admitLate!: (session: PlaybackSession) => void;
      const api = stuckResolver(onNodeA(), () => new Promise<PlaybackSession>((resolve) => { admitLate = resolve; }));
      const coordinator = new PlaybackCoordinator({
        media: media(), player, resolver: api,
        capabilities: async () => capabilities(), initialPositionMs: 0,
      });
      await coordinator.start();
      player.emit({ positionMs: 30_000, durationMs: 600_000, paused: false, ended: false, forwardBufferMs: 0, buffering: true } as PlaybackEvent);
      player.fail(new PlaybackSourceError('HTTP Error 404', 'not-found'));
      await vi.waitFor(() => expect(api.regenerate).toHaveBeenCalledTimes(1));

      await vi.advanceTimersByTimeAsync(60_000);
      api.stop.mockClear();

      admitLate(session({ sessionId: 'late-1', mode: 'transcode', endpoint: { id: 'node-a', baseUrl: 'http://a' } }));
      await vi.advanceTimersByTimeAsync(100);

      expect(api.stop).toHaveBeenCalledWith('late-1', expect.anything());
      await coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not interrupt a recovery that is merely slow', async () => {
    // A false positive crosses to another node and loses the stream copy, so
    // the bound is deliberately above anything the limbs may legitimately
    // spend - twice the node's own attempt budget plus head-room.
    vi.useFakeTimers();
    try {
      const player = new FakePlayer();
      const api = stuckResolver(onNodeA(), () => new Promise<PlaybackSession>((resolve) => {
        setTimeout(() => resolve(onNodeB()), 30_000);
      }));
      const coordinator = new PlaybackCoordinator({
        media: media(), player, resolver: api,
        capabilities: async () => capabilities(), initialPositionMs: 0,
      });
      await coordinator.start();
      player.emit({ positionMs: 30_000, durationMs: 600_000, paused: false, ended: false, forwardBufferMs: 0, buffering: true } as PlaybackEvent);
      player.fail(new PlaybackSourceError('HTTP Error 404', 'not-found'));
      await vi.waitFor(() => expect(api.regenerate).toHaveBeenCalledTimes(1));

      await vi.advanceTimersByTimeAsync(40_000);

      expect(api.failover).not.toHaveBeenCalled();
      expect(player.playCalls.at(-1)?.source.url).toBe('http://b/replacement.m3u8');
      await coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the cap refusal a host has to turn into a sentence', () => {
  // **All three clients build a viewer-facing sentence on
  // `isAccountSessionLimit(snapshot.fatalError)`, and nothing verified the
  // code survives the journey to get there.**
  //
  // It is a long journey: MachaPlaybackError from the node resolver, wrapped
  // by endpointFailure into a MachaEndpointError that carries neither status
  // nor code of its own, then chained by terminalRecoveryError behind the
  // originating player failure, then set as a bare Error on the snapshot. If
  // the code does not survive that, three clients' sentences are dead and the
  // failure reads as "Macha playback request failed" on a television - which
  // is a breakage when the node is behaving exactly as designed.
  //
  // The phone client named this risk in its own tree: a branch that has never
  // executed for real. This is core's version of the same check.

  const onNodeA = () => session({ sessionId: 's1', mode: 'transcode', endpoint: { id: 'node-a', baseUrl: 'http://a' } });

  const capRefusal = () => Object.assign(
    new Error('Macha playback request failed: account is at its session limit'),
    { status: 429, code: 'account_session_limit' },
  );

  it('reaches the host through the whole chain, not just out of the resolver', async () => {
    const player = new FakePlayer();
    const api = {
      available: true,
      resolve: vi.fn(async () => onNodeA()),
      update: vi.fn(async () => onNodeA()),
      stop: vi.fn(async () => undefined),
      // The node refuses the replacement because the account is at its limit.
      failover: vi.fn(async () => { throw endpointFailure('node-b', 'http://b', capRefusal()); }),
      recordEndpointFailure: vi.fn(),
    } as any;
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: api,
      capabilities: async () => capabilities(), initialPositionMs: 0,
    });
    await coordinator.start();
    player.emit({ positionMs: 30_000, durationMs: 600_000, paused: false, ended: false });

    player.fail(new PlaybackSourceError('node A stream failed', 'stream'));
    await vi.waitFor(() => expect(coordinator.getSnapshot().fatalError).toBeDefined());

    const fatal = coordinator.getSnapshot().fatalError;
    // The three predicates every client is about to depend on.
    expect(isAccountSessionLimit(fatal)).toBe(true);
    expect(playbackFailureCode(fatal)).toBe('account_session_limit');
    expect(playbackFailureStatus(fatal)).toBe(429);
    await coordinator.close();
  });

  it('still leads with the failure that started the recovery', async () => {
    // The cap explains why recovery could not finish; it is not what went
    // wrong. A host showing only the cap would tell a viewer their account is
    // busy when the actual event was a node dying under them.
    const player = new FakePlayer();
    const api = {
      available: true,
      resolve: vi.fn(async () => onNodeA()),
      update: vi.fn(async () => onNodeA()),
      stop: vi.fn(async () => undefined),
      failover: vi.fn(async () => { throw endpointFailure('node-b', 'http://b', capRefusal()); }),
      recordEndpointFailure: vi.fn(),
    } as any;
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: api,
      capabilities: async () => capabilities(), initialPositionMs: 0,
    });
    await coordinator.start();
    player.emit({ positionMs: 30_000, durationMs: 600_000, paused: false, ended: false });
    player.fail(new PlaybackSourceError('node A stream failed', 'stream'));
    await vi.waitFor(() => expect(coordinator.getSnapshot().fatalError).toBeDefined());

    expect(coordinator.getSnapshot().fatalError?.message).toContain('node A stream failed');
    await coordinator.close();
  });
});

describe('how long a standby is worth holding', () => {
  const sourced = (mode: string, pipelineIdleMs?: number) => ({
    mode,
    source: { budgets: { deadlineMs: 1, segmentHoldMs: 1, ...(pipelineIdleMs !== undefined ? { pipelineIdleMs } : {}) } },
  } as unknown as PlaybackSession);

  it('keeps the guaranteed floor when the node has not said', () => {
    // Every node older than server 0.48.0 states nothing, and absence is not
    // zero. `config_base.cpp:359` refuses to start a node under ten seconds,
    // so this is true of any node that is running at all.
    expect(alternateRecoveryWindowMs(sourced('remux'))).toBe(10_000);
  });

  it('takes the node figure, bounded by what the window is actually for', () => {
    // The deployed cluster serves 60,000. Holding a standby for a minute buys
    // nothing: what the window exists for is a node that degrades once and
    // recovers, measured at about thirty seconds. The node's number is a
    // ceiling, not a target.
    expect(alternateRecoveryWindowMs(sourced('remux', 60_000))).toBe(30_000);
  });

  it('never exceeds a node that reclaims sooner than the floor would assume', () => {
    // A node configured tighter than the useful window governs: holding past
    // its reclaim promotes onto a session whose engine is gone.
    expect(alternateRecoveryWindowMs(sourced('remux', 12_000))).toBe(12_000);
  });

  it('ignores a figure no node should send rather than shortening on it', () => {
    expect(alternateRecoveryWindowMs(sourced('remux', 0))).toBe(10_000);
    expect(alternateRecoveryWindowMs(sourced('remux', Number.NaN))).toBe(10_000);
  });

  it('leaves a transcode standby on its own shorter window', () => {
    // A transcode standby holds the node's only video slot, so it is bounded
    // by contention rather than by engine reclamation.
    expect(alternateRecoveryWindowMs(sourced('transcode', 60_000))).toBe(8_000);
  });
});

/**
 * Tom, 2026-09-24: a player that cannot decode a copied stream falls back to a
 * transcode on the same node, once, unless the viewer chose the mode. Found on
 * the Android TV set: MPEG-4 Part 2 video in an AVI failed in the hardware
 * decoder, and the failure moved node, which a decode failure follows.
 */
describe('a copied stream the player could not decode', () => {
  const facts = async () => ({ profile: { mediaId: 'm1', format: 'mov,mp4', container: 'mp4', durationMs: 60_000, bitrate: 1_000, streams: [
    { index: 0, type: 'video' as const, codec: 'h264', profile: '', language: '', default: true, forced: false },
    { index: 1, type: 'audio' as const, codec: 'aac', profile: '', language: '', default: true, forced: false },
  ] } });

  function setup(initialPreferences?: PlaybackPreferencesUpdate) {
    const updates: PlaybackUpdate[] = [];
    const api = resolver(session({ mode: 'direct' }), async (update) => {
      updates.push(update);
      return session({ mode: 'transcode', preferences: { ...session().preferences, mode: 'transcode' } as PlaybackPreferences });
    });
    const player = new FakePlayer();
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: api, capabilities: async () => capabilities(),
      initialPositionMs: 0, initialPreferences, facts,
    });
    return { coordinator, player, updates };
  }

  it('asks the same node for a transcode of every copied stream, and says why', async () => {
    const { coordinator, player, updates } = setup();
    await coordinator.start();
    expect(coordinator.getSnapshot().instruction?.video).toBe('copy');

    player.fail(new PlaybackSourceError('decoder init failed', 'media'));
    await vi.waitFor(() => expect(updates).toHaveLength(1));

    expect(updates[0]?.preferences).toMatchObject({ mode: 'transcode', video: 'transcode', audio: 'transcode' });
    expect(coordinator.getSnapshot().notice?.code).toBe('decode-fallback');
    expect(coordinator.getSnapshot().instruction?.reasons).toContain('player-could-not-decode');
    expect(coordinator.getSnapshot().fatalError).toBeUndefined();
  });

  it("drops 'source-plays-as-is' from the reasons, which stopped being true", async () => {
    const { coordinator, player, updates } = setup();
    await coordinator.start();
    expect(coordinator.getSnapshot().instruction?.reasons).toContain('source-plays-as-is');
    player.fail(new PlaybackSourceError('decoder init failed', 'media'));
    await vi.waitFor(() => expect(updates).toHaveLength(1));
    expect(coordinator.getSnapshot().instruction?.reasons).toEqual(['player-could-not-decode']);
  });

  it("reports a mode the viewer chose partway through as the viewer's", async () => {
    // Measured on the Android TV set: Transcode chosen during playback, and
    // the report went on describing the automatic copy.
    const { coordinator } = setup();
    await coordinator.start();
    expect(coordinator.getSnapshot().instruction?.chosenByViewer).toBe(false);
    const container = coordinator.getSnapshot().instruction?.container;

    coordinator.update({ preferences: { mode: 'transcode' } });

    expect(coordinator.getSnapshot().instruction).toMatchObject({ mode: 'transcode', chosenByViewer: true, reasons: [] });
    expect(coordinator.getSnapshot().instruction?.container).toBe(container);
  });

  it('ends playback as before when the viewer chose the mode at the start', async () => {
    const { coordinator, player, updates } = setup({ mode: 'direct' });
    await coordinator.start();

    player.fail(new PlaybackSourceError('decoder init failed', 'media'));
    await vi.waitFor(() => expect(coordinator.getSnapshot().fatalError).toBeDefined());
    expect(updates).toHaveLength(0);
  });

  it('and when the viewer switched to it partway through', async () => {
    // The chooser picked the copy at the start, so an instruction exists; the
    // viewer's later choice is what has to stop the fallback.
    const { coordinator, player, updates } = setup();
    await coordinator.start();
    coordinator.update({ preferences: { mode: 'direct' } });
    await vi.waitFor(() => expect(updates).toHaveLength(1));

    player.fail(new PlaybackSourceError('decoder init failed', 'media'));
    await vi.waitFor(() => expect(coordinator.getSnapshot().fatalError).toBeDefined());
    expect(updates).toHaveLength(1);
  });

  it('falls back once per playback, even if the chooser picks the copy again', async () => {
    const { coordinator, player, updates } = setup();
    await coordinator.start();
    player.fail(new PlaybackSourceError('decoder init failed', 'media'));
    await vi.waitFor(() => expect(updates).toHaveLength(1));

    // "Decide for me" again: the chooser picks the copy it picked before.
    coordinator.update({ preferences: { mode: 'choose' } });
    await vi.waitFor(() => expect(updates).toHaveLength(2));
    expect(updates[1]?.preferences?.video).toBe('copy');

    player.fail(new PlaybackSourceError('still cannot decode', 'unsupported'));
    await vi.waitFor(() => expect(coordinator.getSnapshot().fatalError).toBeDefined());
    expect(updates).toHaveLength(2);
  });

  it('leaves a node failure to the node path', async () => {
    const { coordinator, player, updates } = setup();
    await coordinator.start();
    player.fail(new PlaybackSourceError('fragment failed', 'stream'));
    await vi.waitFor(() => expect(coordinator.getSnapshot().fatalError ?? coordinator.getSnapshot().preparingSource).toBeTruthy());
    expect(updates).toHaveLength(0);
  });
});

/**
 * A change queued while the drain loop is finishing its last pass. The loop
 * returns when it finds nothing pending and only marks itself stopped a
 * microtask later, so a change queued in that gap saw a loop "running",
 * started none, and was never applied. Seen 2026-09-24 as a "decide for me"
 * lost behind a fallback's update.
 */
describe('a change queued as the previous one finishes', () => {
  it('is applied, not stranded', async () => {
    const updates: PlaybackUpdate[] = [];
    const api = resolver(session({ mode: 'direct' }), async (update) => {
      updates.push(update);
      return session({ mode: 'transcode', preferences: { ...session().preferences, ...update.preferences } as PlaybackPreferences });
    });
    const player = new FakePlayer();
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: api, capabilities: async () => capabilities(),
      initialPositionMs: 0, initialPreferences: { mode: 'direct' },
    });
    await coordinator.start();
    // The loop activates the new source synchronously and returns on its next
    // check; a microtask queued from inside that activation runs after the
    // return and before the loop marks itself stopped.
    const play = player.play.bind(player);
    let queued = false;
    player.play = (...args: Parameters<typeof player.play>) => {
      if (updates.length === 1 && !queued) {
        queued = true;
        queueMicrotask(() => coordinator.update({ preferences: { maxHeight: 720 } }));
      }
      return play(...args);
    };

    coordinator.update({ preferences: { mode: 'transcode' } });
    await vi.waitFor(() => expect(updates).toHaveLength(2));
    expect(updates[1]?.preferences?.maxHeight).toBe(720);
  });
});

/**
 * Choosing among an item's files is the client's decision (Tom, 2026-09-24).
 * Given only an item, the server played its first directly-playable file in
 * stored order, while the chooser reasoned about whichever file the host
 * handed it, so the two could disagree.
 */
describe('an item with several files', () => {
  const file = (mediaId: string, codec: string) => ({
    mediaId,
    profile: { mediaId, format: 'mov,mp4', container: 'mp4', durationMs: 60_000, bitrate: 1_000, streams: [
      { index: 0, type: 'video' as const, codec, profile: '', language: '', default: true, forced: false },
      { index: 1, type: 'audio' as const, codec: 'aac', profile: '', language: '', default: true, forced: false },
    ] },
  });

  function start(facts: unknown, mediaIds: string[]) {
    const api = resolver(session({ mode: 'direct' }));
    const coordinator = new PlaybackCoordinator({
      media: { ...media(), mediaIds }, player: new FakePlayer(), resolver: api,
      capabilities: async () => capabilities(), initialPositionMs: 0,
      facts: async () => facts as never,
    });
    return { api, coordinator };
  }

  it('plays the file that plays best, and names it on the session', async () => {
    const { api, coordinator } = start([file('hevc-file', 'hevc'), file('h264-file', 'h264')], ['hevc-file', 'h264-file']);
    await coordinator.start();
    expect(api.resolve.mock.calls[0]?.[3]).toMatchObject({ mode: 'direct', mediaId: 'h264-file' });
    expect(coordinator.getSnapshot().instruction?.mediaId).toBe('h264-file');
  });

  it('still picks the file when the viewer chose the mode: under direct, one it plays directly', async () => {
    // Tom, 2026-09-25: on direct play, something still has to pick which file.
    const api = resolver(session({ mode: 'direct' }));
    const coordinator = new PlaybackCoordinator({
      media: { ...media(), mediaIds: ['hevc-file', 'h264-file'] }, player: new FakePlayer(), resolver: api,
      capabilities: async () => capabilities(), initialPositionMs: 0, initialPreferences: { mode: 'direct' },
      facts: async () => [file('hevc-file', 'hevc'), file('h264-file', 'h264')] as never,
    });
    await coordinator.start();
    expect(api.resolve.mock.calls[0]?.[3]).toMatchObject({ mode: 'direct', mediaId: 'h264-file' });
    expect(coordinator.getSnapshot().instruction).toMatchObject({ chosenByViewer: true, mediaId: 'h264-file' });
  });

  it('names the first file when there are no facts at all, rather than none', async () => {
    const api = resolver(session({ mode: 'transcode' }));
    const coordinator = new PlaybackCoordinator({
      media: { ...media(), mediaIds: ['first', 'second'] }, player: new FakePlayer(), resolver: api,
      capabilities: async () => capabilities(), initialPositionMs: 0,
      facts: async () => undefined,
    });
    await coordinator.start();
    expect(api.resolve.mock.calls[0]?.[3]).toMatchObject({ mode: 'transcode', mediaId: 'first' });
  });

  it('asks for no facts before starting when the viewer chose direct on a single-file item', async () => {
    // Off the critical path: the start needs none. They are fetched once the
    // session exists, for the modes to offer (`snapshot.modes`).
    const order: string[] = [];
    const facts = vi.fn(async () => { order.push('facts'); return undefined; });
    const api = resolver(session({ mode: 'direct' }));
    api.resolve.mockImplementation(async () => { order.push('resolve'); return session({ mode: 'direct' }); });
    const coordinator = new PlaybackCoordinator({
      media: { ...media(), mediaIds: ['only'] }, player: new FakePlayer(), resolver: api,
      capabilities: async () => capabilities(), initialPositionMs: 0, initialPreferences: { mode: 'direct' }, facts,
    });
    await coordinator.start();
    expect(order[0]).toBe('resolve');
    expect(api.resolve.mock.calls[0]?.[3]?.mediaId).toBe('only');
  });

  it('takes the first of equals, as stored order had it', async () => {
    const { api, coordinator } = start([file('a', 'h264'), file('b', 'h264')], ['a', 'b']);
    await coordinator.start();
    expect(api.resolve.mock.calls[0]?.[3]?.mediaId).toBe('a');
  });

  it('names an only file even from facts that carry no id, and the first when it cannot know', async () => {
    const single = { profile: file('x', 'h264').profile };
    const one = start(single, ['only']);
    await one.coordinator.start();
    expect(one.api.resolve.mock.calls[0]?.[3]?.mediaId).toBe('only');

    const several = start(single, ['a', 'b']);
    await several.coordinator.start();
    // The server is to stop choosing, so a create never goes without a file.
    expect(several.api.resolve.mock.calls[0]?.[3]?.mediaId).toBe('a');
  });
});

/**
 * Server 0.58.0 chooses nothing: a remux or transcode names its container,
 * and a file with several video or audio streams names the one to play.
 */
describe('against a node that chooses nothing', () => {
  const twoAudio = (container = 'matroska') => [{
    mediaId: 'm1',
    profile: { mediaId: 'm1', format: container, container, durationMs: 60_000, bitrate: 1_000, streams: [
      { index: 0, type: 'video' as const, codec: 'h264', profile: '', language: '', default: true, forced: false },
      { index: 1, type: 'audio' as const, codec: 'aac', profile: '', language: 'eng', default: false, forced: false },
      { index: 2, type: 'audio' as const, codec: 'aac', profile: '', language: 'fre', default: true, forced: false },
    ] },
  }];

  function start(options: { initialPreferences?: PlaybackPreferencesUpdate; resolve?: (...args: any[]) => Promise<PlaybackSession> } = {}) {
    const api = resolver(session({ mode: 'remux' }));
    if (options.resolve) api.resolve.mockImplementation(options.resolve);
    const facts = vi.fn(async () => twoAudio() as never);
    const coordinator = new PlaybackCoordinator({
      media: media(), player: new FakePlayer(), resolver: api,
      capabilities: async () => capabilities(), initialPositionMs: 0, facts,
      ...(options.initialPreferences ? { initialPreferences: options.initialPreferences } : {}),
    });
    return { api, coordinator, facts };
  }

  it('names the default audio stream where there are several, and no video stream where there is one', async () => {
    const { api, coordinator } = start();
    await coordinator.start();
    const sent = api.resolve.mock.calls[0]?.[3] as PlaybackPreferencesUpdate;
    expect(sent).toMatchObject({ mode: 'remux', audioStream: 2, container: 'fmp4' });
    expect(sent.videoStream).toBeUndefined();
  });

  it("names the one stream in the viewer's language, and sends the stream rather than the language", async () => {
    const { api, coordinator } = start({ initialPreferences: { audioLanguage: 'ENG' } });
    await coordinator.start();
    const sent = api.resolve.mock.calls[0]?.[3] as PlaybackPreferencesUpdate;
    expect(sent.audioStream).toBe(1);
    expect(sent).not.toHaveProperty('audioLanguage');
  });

  it('sends no language the file lacks, which the node would refuse outright', async () => {
    // Until 0.58.0 the node fell back to the default track; now it answers
    // choice_not_available, and the title does not play.
    const { api, coordinator } = start({ initialPreferences: { audioLanguage: 'jpn', subtitleLanguage: 'deu' } });
    await coordinator.start();
    const sent = api.resolve.mock.calls[0]?.[3] as PlaybackPreferencesUpdate;
    expect(sent).toMatchObject({ audioStream: 2 });
    expect(sent).not.toHaveProperty('audioLanguage');
    expect(sent).not.toHaveProperty('subtitleLanguage');
    expect(sent.subtitleStream ?? null).toBeNull();
  });

  it('names the container and the audio stream on a change from direct into a transcode', async () => {
    // The web client's failure on 0.58.0: a session begun direct names
    // neither, and the PATCH into a transcode was refused, so the title
    // started and then stopped.
    const streams = twoAudio()[0]!.profile.streams.map((stream) => ({ ...stream, profile: '', language: stream.language }));
    const direct = session({ mode: 'direct', sourceInfo: { path: '/movie', format: 'matroska', size: 1, bitrate: 1, streams } as never,
      preferences: { mode: 'direct', maxHeight: null, maxBitrate: null, audioStream: null, subtitleStream: null, audioLanguage: '', subtitleLanguage: '' } });
    const updates: PlaybackUpdate[] = [];
    const api = resolver(direct, async (update) => { updates.push(update); return direct; });
    const coordinator = new PlaybackCoordinator({
      media: media(), player: new FakePlayer(), resolver: api,
      capabilities: async () => ({ ...capabilities(), containers: ['matroska', 'mp4'] }), initialPositionMs: 0,
      facts: async () => twoAudio() as never,
    });
    await coordinator.start();
    expect(api.resolve.mock.calls[0]?.[3]).toMatchObject({ mode: 'direct' });

    coordinator.update({ preferences: { mode: 'transcode' } });
    await vi.waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]?.preferences).toMatchObject({ mode: 'transcode', container: 'fmp4', audioStream: 2 });
  });

  it("names the container and streams under a mode the viewer chose, even for an item's only file", async () => {
    const { api, coordinator, facts } = start({ initialPreferences: { mode: 'transcode' } });
    await coordinator.start();
    expect(facts).toHaveBeenCalled();
    expect(api.resolve.mock.calls[0]?.[3]).toMatchObject({ mode: 'transcode', container: 'fmp4', audioStream: 2, mediaId: 'm1' });
    expect(coordinator.getSnapshot().instruction).toMatchObject({ chosenByViewer: true, container: 'fmp4' });
  });

  it("carries the node's refusal on update-failed, as data for the host to word", async () => {
    const refusal = Object.assign(new Error('name one'), { status: 400, code: 'choice_required', choice: 'audio_stream', choices: [1, 2] });
    const api = resolver(session({ mode: 'direct' }), async () => { throw refusal; });
    const coordinator = new PlaybackCoordinator({
      media: media(), player: new FakePlayer(), resolver: api,
      capabilities: async () => capabilities(), initialPositionMs: 0, initialPreferences: { mode: 'direct' },
    });
    await coordinator.start();
    coordinator.update({ preferences: { mode: 'transcode' } });
    await vi.waitFor(() => expect(coordinator.getSnapshot().notice?.code).toBe('update-failed'));
    expect(coordinator.getSnapshot().notice?.refusal).toEqual({ status: 400, code: 'choice_required', choice: 'audio_stream', choices: [1, 2] });
  });

  it('does not step the mode down over a choice the node says is open', async () => {
    // choice_required is a question about the request, not a refusal to
    // perform it; a transcode would ask the same question again.
    const refusal = Object.assign(new Error('choose an audio stream'), { status: 400, code: 'choice_required' });
    const { api, coordinator } = start({ resolve: async () => { throw refusal; } });
    await coordinator.start().catch(() => undefined);
    expect(api.resolve).toHaveBeenCalledTimes(1);
  });

  it('still steps down once over a plain refusal', async () => {
    const refusal = Object.assign(new Error('cannot copy'), { status: 400 });
    const { api, coordinator } = start({ resolve: async () => { throw refusal; } });
    await coordinator.start().catch(() => undefined);
    expect(api.resolve).toHaveBeenCalledTimes(2);
  });
});

describe('preparePlaybackPatch, for a host that PATCHes without the coordinator', () => {
  it('names the device container and the default audio stream on a change into a transcode', () => {
    const streams = [
      { index: 0, type: 'video', codec: 'h264', language: '', default: true },
      { index: 1, type: 'audio', codec: 'aac', language: 'eng', default: false },
      { index: 2, type: 'audio', codec: 'aac', language: 'fre', default: true },
    ];
    const direct = session({ mode: 'direct', sourceInfo: { path: '/m', format: 'matroska', size: 1, bitrate: 1, streams } as never,
      preferences: { mode: 'direct', maxHeight: null, maxBitrate: null, audioStream: null, subtitleStream: null, audioLanguage: '', subtitleLanguage: '' } });
    const prepared = preparePlaybackPatch({ preferences: { mode: 'transcode' } }, direct, capabilities());
    expect(prepared.preferences).toMatchObject({ mode: 'transcode', container: 'fmp4', audioStream: 2 });
  });
});

describe('versions and the quality ceiling', () => {
  const sized = (mediaId: string, width: number, height: number) => ({
    mediaId,
    profile: { mediaId, format: 'mov,mp4', container: 'mp4', durationMs: 60_000, bitrate: 1_000, streams: [
      { index: 0, type: 'video' as const, codec: 'h264', profile: '', language: '', default: true, forced: false, width, height },
      { index: 1, type: 'audio' as const, codec: 'aac', profile: '', language: '', default: true, forced: false },
    ] },
  });
  const files = () => [sized('uhd', 3840, 2160), sized('fhd', 1920, 1080)];

  function start(options: { ceiling?: QualityCeiling; initialPreferences?: PlaybackPreferencesUpdate; facts?: unknown } = {}) {
    const updates: PlaybackUpdate[] = [];
    const initial = session({ mode: 'direct', mediaId: 'uhd' });
    const api = resolver(initial, async (update) => { updates.push(update); return initial; });
    const coordinator = new PlaybackCoordinator({
      media: { ...media(), mediaIds: ['uhd', 'fhd'] }, player: new FakePlayer(), resolver: api,
      capabilities: async () => capabilities(), initialPositionMs: 0,
      facts: async () => (options.facts ?? files()) as never,
      ...(options.ceiling ? { qualityCeiling: () => options.ceiling } : {}),
      ...(options.initialPreferences ? { initialPreferences: options.initialPreferences } : {}),
    });
    return { api, coordinator, updates };
  }

  it('plays the largest file uncapped, and reports every step', async () => {
    const { api, coordinator } = start();
    await coordinator.start();
    expect(api.resolve.mock.calls[0]?.[3]).toMatchObject({ mode: 'direct', mediaId: 'uhd' });
    expect(coordinator.getSnapshot().versions?.steps.map((step) => step.quality)).toEqual([2160, 1440, 1080, 720]);
  });

  it('keeps automatic play at or below the ceiling, and says the ceiling did it', async () => {
    const ceiling: QualityCeiling = { quality: 1080, reason: 'ceiling-display' };
    const { api, coordinator } = start({ ceiling });
    await coordinator.start();
    expect(api.resolve.mock.calls[0]?.[3]).toMatchObject({ mode: 'direct', mediaId: 'fhd' });
    expect(coordinator.getSnapshot().versions?.limitedBy).toEqual(ceiling);
  });

  it('transcodes down to a ceiling below every file', async () => {
    const { api, coordinator } = start({ ceiling: { quality: 720, reason: 'ceiling-cellular' } });
    await coordinator.start();
    expect(api.resolve.mock.calls[0]?.[3]).toMatchObject({ mode: 'transcode', video: 'transcode', maxHeight: 720, mediaId: 'fhd', container: 'fmp4' });
  });

  it('never caps a version the viewer starts on', async () => {
    const step = playbackVersions(files(), capabilities()).steps[0]!;
    const { api, coordinator } = start({ ceiling: { quality: 720, reason: 'ceiling-cellular' }, initialPreferences: versionPreferences(step) });
    await coordinator.start();
    const sent = api.resolve.mock.calls[0]?.[3] as PlaybackPreferencesUpdate;
    expect(sent).toMatchObject({ mode: 'direct', mediaId: 'uhd' });
    expect(sent.maxHeight).toBeUndefined();
    expect(coordinator.getSnapshot().instruction).toMatchObject({ chosenByViewer: true, mediaId: 'uhd' });
    expect(coordinator.getSnapshot().versions?.steps).toHaveLength(4);
  });

  it('switches file for a version on another file, as the viewer choice', async () => {
    const { coordinator, updates } = start();
    await coordinator.start();
    const step = coordinator.getSnapshot().versions!.steps.find((candidate) => candidate.quality === 1080)!;
    await coordinator.playVersion(step);
    await vi.waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]).toMatchObject({ mediaId: 'fhd', preferences: { mode: 'direct' } });
    expect(coordinator.getSnapshot().instruction).toMatchObject({ chosenByViewer: true, mediaId: 'fhd' });
  });

  it("does not carry the old file's stream indexes onto another file", async () => {
    const streams = [
      { index: 0, type: 'video', codec: 'h264', language: '', default: true, width: 3840, height: 2160 },
      { index: 5, type: 'audio', codec: 'aac', language: 'eng', default: true },
    ];
    const updates: PlaybackUpdate[] = [];
    const initial = session({ mode: 'direct', mediaId: 'uhd', sourceInfo: { path: '/m', format: 'mp4', size: 1, bitrate: 1, streams } as never,
      preferences: { mode: 'direct', maxHeight: null, maxBitrate: null, audioStream: 5, subtitleStream: null, audioLanguage: '', subtitleLanguage: '' } });
    const api = resolver(initial, async (update) => { updates.push(update); return initial; });
    const coordinator = new PlaybackCoordinator({
      media: { ...media(), mediaIds: ['uhd', 'fhd'] }, player: new FakePlayer(), resolver: api,
      capabilities: async () => capabilities(), initialPositionMs: 0, facts: async () => files() as never,
    });
    await coordinator.start();
    const step = playbackVersions(files(), capabilities()).steps.find((candidate) => candidate.quality === 720)!;
    await coordinator.playVersion(step);
    await vi.waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]).toMatchObject({ mediaId: 'fhd', preferences: { mode: 'transcode', maxHeight: 720 } });
    expect(updates[0]?.preferences?.audioStream).toBeUndefined();
  });

  it("clears a transcode step's cap when a file step that transcodes follows it", async () => {
    // The file step names no cap of its own, and a PATCH into a transcode
    // restates the session's: so the file came back still capped at 720.
    const hevc = (mediaId: string) => ({ ...sized(mediaId, 3840, 2160), profile: { ...sized(mediaId, 3840, 2160).profile,
      streams: sized(mediaId, 3840, 2160).profile.streams.map((stream) => stream.type === 'video' ? { ...stream, codec: 'hevc' } : stream) } });
    const updates: PlaybackUpdate[] = [];
    const capped = session({ mode: 'transcode', mediaId: 'uhd',
      preferences: { mode: 'transcode', maxHeight: 720, maxBitrate: null, audioStream: null, subtitleStream: null, audioLanguage: '', subtitleLanguage: '' } });
    const api = resolver(capped, async (update) => { updates.push(update); return capped; });
    const coordinator = new PlaybackCoordinator({
      media: { ...media(), mediaIds: ['uhd'] }, player: new FakePlayer(), resolver: api,
      capabilities: async () => capabilities(), initialPositionMs: 0, facts: async () => [hevc('uhd')] as never,
    });
    await coordinator.start();
    const step = coordinator.getSnapshot().versions!.steps.find((candidate) => candidate.quality === 2160)!;
    expect(step).toMatchObject({ source: 'file', instruction: { mode: 'transcode' } });
    await coordinator.playVersion(step);
    await vi.waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]?.preferences?.maxHeight).toBeNull();
    expect(coordinator.getSnapshot().instruction?.quality).toBe(2160);
  });

  it('offers only what the device plays, and everything when the viewer asks', async () => {
    const run = async (offerAll: boolean) => {
      const coordinator = new PlaybackCoordinator({
        media: { ...media(), mediaIds: ['uhd', 'fhd'] }, player: new FakePlayer(), resolver: resolver(session({ mode: 'direct', mediaId: 'fhd' })),
        capabilities: async () => ({ ...capabilities(), maxWidth: 1920, maxHeight: 1080 }), initialPositionMs: 0,
        facts: async () => files() as never, offerAll: () => offerAll,
      });
      await coordinator.start();
      return coordinator.getSnapshot().versions!;
    };
    expect((await run(false)).steps.map((step) => step.quality)).toEqual([1080, 720]);
    const all = await run(true);
    expect(all.steps.map((step) => step.quality)).toEqual([2160, 1440, 1080, 720]);
    expect(all.automatic).toMatchObject({ quality: 1080, mediaId: 'fhd' });
  });

  it('reports the quality playing, automatic or picked', async () => {
    const auto = start({ ceiling: { quality: 1080, reason: 'ceiling-display' } });
    await auto.coordinator.start();
    expect(auto.coordinator.getSnapshot().instruction?.quality).toBe(1080);

    const step = playbackVersions(files(), capabilities()).steps.find((candidate) => candidate.quality === 1440)!;
    const picked = start({ initialPreferences: versionPreferences(step) });
    await picked.coordinator.start();
    expect(picked.coordinator.getSnapshot().instruction).toMatchObject({ chosenByViewer: true, quality: 1440 });
  });

  it('caps a version on the same file with a transcode, and does not name the file again', async () => {
    const { coordinator, updates } = start();
    await coordinator.start();
    const step = coordinator.getSnapshot().versions!.steps.find((candidate) => candidate.quality === 1440)!;
    await coordinator.playVersion(step);
    await vi.waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]?.mediaId).toBeUndefined();
    expect(updates[0]?.preferences).toMatchObject({ mode: 'transcode', video: 'transcode', maxHeight: 1440 });
  });
});

/**
 * Tom, 2026-09-25: resuming from Continue Watching "sometimes" started at 0.
 * Reproduced by the Android TV client: expo-video ticks position 0 from an
 * idle player, and one such tick while the session was being made became the
 * resume point.
 */
describe('a player event before anything is presented', () => {
  function start(mode: 'direct' | 'transcode') {
    const player = new FakePlayer();
    const initial = session({ mode, seekMs: mode === 'direct' ? 0 : 300_000, ...(mode === 'direct' ? {} : { seekOffsetMs: 0 }) } as Partial<PlaybackSession>);
    const updates: PlaybackUpdate[] = [];
    const api = resolver(initial, async (update) => { updates.push(update); return initial; });
    api.resolve.mockImplementation(async () => {
      player.emit({ positionMs: 0, durationMs: 0, paused: true, ended: false });
      return initial;
    });
    const coordinator = new PlaybackCoordinator({
      media: media(), player, resolver: api, capabilities: async () => capabilities(), initialPositionMs: 300_000,
      initialPreferences: { mode },
    });
    return { coordinator, player, updates };
  }

  it('does not move a direct resume back to the start', async () => {
    const { coordinator, player } = start('direct');
    await coordinator.start();
    expect(player.playCalls[0]?.positionMs).toBe(300_000);
  });

  it('does not seek a transcode resume back to the start', async () => {
    const { coordinator, updates } = start('transcode');
    await coordinator.start();
    await flush();
    expect(updates.some((update) => update.seekMs === 0)).toBe(false);
    expect(coordinator.getSnapshot().intent.positionMs).toBe(300_000);
  });
});

/**
 * The web client, 2026-09-25: a page reload left a 720p transcode alive on
 * fi-1 for the node's five-minute idle rule, refusing the next viewer 429.
 * `close()` waited for work in flight before its DELETE, and a page being
 * unloaded does not wait for any of it.
 */
describe('closing for a page exit', () => {
  it('sends the DELETE at once, not after the work in flight', async () => {
    const initial = session({ mode: 'transcode' });
    const hung = deferred<PlaybackSession>();
    const api = resolver(initial, async () => hung.promise);
    const coordinator = new PlaybackCoordinator({
      media: media(), player: new FakePlayer(), resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0,
      initialPreferences: { mode: 'transcode' },
    });
    await coordinator.start();
    coordinator.update({ preferences: { maxHeight: 720 } });
    await flush();
    expect(api.update).toHaveBeenCalled(); // a PATCH is in flight and will never answer

    void coordinator.close({ keepalive: true });
    // With the signed stream URL, for the close that survives an unload.
    expect(api.stop).toHaveBeenCalledWith(initial.sessionId, expect.objectContaining({ keepalive: true, streamUrl: initial.source.url }));
  });

  it('does not send it twice once the orderly close catches up', async () => {
    const initial = session({ mode: 'transcode' });
    const api = resolver(initial);
    const coordinator = new PlaybackCoordinator({
      media: media(), player: new FakePlayer(), resolver: api, capabilities: async () => capabilities(), initialPositionMs: 0,
      initialPreferences: { mode: 'transcode' },
    });
    await coordinator.start();
    await coordinator.close({ keepalive: true });
    expect(api.stop).toHaveBeenCalledTimes(1);
  });
});

describe("the playing file's facts on the snapshot", () => {
  const mkv = (operations?: unknown) => [{
    mediaId: 'm1',
    ...(operations ? { operations } : {}),
    profile: { mediaId: 'm1', format: 'matroska', container: 'matroska', durationMs: 60_000, bitrate: 1_000, streams: [
      { index: 0, type: 'video' as const, codec: 'h264', profile: '', language: '', default: true, forced: false, width: 1920, height: 1080 },
      { index: 1, type: 'audio' as const, codec: 'aac', profile: '', language: '', default: true, forced: false },
    ] },
  }];
  const cannotCopy = {
    direct: true, copyIntoFmp4: { video: true, audio: false }, copyIntoMpegts: { video: false, audio: false },
    transcodeVideo: true, transcodeAudio: true,
  };

  async function start(facts: unknown, initialPreferences?: PlaybackPreferencesUpdate) {
    const coordinator = new PlaybackCoordinator({
      media: media(), player: new FakePlayer(), resolver: resolver(session({ mode: 'transcode' })),
      capabilities: async () => capabilities(), initialPositionMs: 0, facts: async () => facts as never,
      ...(initialPreferences ? { initialPreferences } : {}),
    });
    await coordinator.start();
    return coordinator;
  }

  it("carries the node's operations, and offers no remux the node would refuse", async () => {
    const coordinator = await start(mkv(cannotCopy));
    expect(coordinator.getSnapshot().playingFile?.operations).toEqual(cannotCopy);
    expect(coordinator.getSnapshot().modes?.map(({ mode, offered }) => [mode, offered])).toEqual([
      ['direct', false], ['remux', false], ['transcode', true],
    ]);
  });

  it('fetches the facts after a start that needed none, for the modes', async () => {
    const coordinator = await start(mkv(), { mode: 'direct' });
    await vi.waitFor(() => expect(coordinator.getSnapshot().modes).toBeDefined());
    expect(coordinator.getSnapshot().modes?.find((mode) => mode.mode === 'remux')?.offered).toBe(true);
  });
});

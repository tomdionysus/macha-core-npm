import { describe, expect, it, vi } from 'vitest';
import type { Platform, Player, PlaybackFailureListener, PlaybackListener } from '../platform/Platform.js';
import type { MediaSummary, MediaTechnicalProfile, PlaybackCapabilities, PlaybackEvent, PlaybackSource, PlaybackTimeRange } from '../types.js';
import type { PlaybackPreferencesUpdate, PlaybackResolver, PlaybackSession, PlaybackStopOptions, PlaybackUpdate } from './PlaybackResolver.js';
import { PlaybackRuntime } from './PlaybackRuntime.js';

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

class FakePlayer implements Player {
  listener?: PlaybackListener;
  failureListener?: PlaybackFailureListener;
  attachCalls = 0;
  detachHostCalls = 0;
  detachCalls = 0;
  stopCalls = 0;
  pauseCalls = 0;
  resumeCalls = 0;
  playCalls: PlaybackSource[] = [];
  prepareCalls: MediaTechnicalProfile[] = [];
  playResult: Promise<boolean> = Promise.resolve(true);

  attach(): void { this.attachCalls += 1; }
  detachHost(): void { this.detachHostCalls += 1; }
  detach(): void { this.detachCalls += 1; this.stop(); }
  play(source: PlaybackSource): Promise<boolean> { this.playCalls.push(source); return this.playResult; }
  prepare(profile: MediaTechnicalProfile): void { this.prepareCalls.push(profile); }
  pause(): void { this.pauseCalls += 1; }
  resume(): void { this.resumeCalls += 1; }
  seek(): void {}
  localSeekCoverage(): readonly PlaybackTimeRange[] { return [{ startMs: 0, endMs: Number.POSITIVE_INFINITY }]; }
  setVolume(): void {}
  stop(): void { this.stopCalls += 1; }
  subscribe(listener: PlaybackListener): () => void {
    this.listener = listener;
    return () => { if (this.listener === listener) this.listener = undefined; };
  }
  subscribeFailure(listener: PlaybackFailureListener): () => void {
    this.failureListener = listener;
    return () => { if (this.failureListener === listener) this.failureListener = undefined; };
  }
  emit(event: PlaybackEvent): void { this.listener?.(event); }
  fail(error: Error): void { this.failureListener?.(error); }
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

    await vi.waitFor(() => expect(api.stop).toHaveBeenCalledWith('session:A', { keepalive: true }));
  });

  it('rejects non-playable catalogue requests without acquiring a server session', async () => {
    const player = new FakePlayer();
    const api = resolver();
    const runtime = new PlaybackRuntime(new FakePlatform(player), api);
    runtime.attach(host());
    const album: MediaSummary = { id: 'album:A', kind: 'album', title: 'Album A', mediaIds: [] };

    await runtime.play({ media: album, startPositionMs: 0, returnTo: '/music/albums/A' });

    expect(runtime.getSnapshot().phase).toBe('failed');
    expect(runtime.getSnapshot().fatalError?.message).toContain('not directly playable');
    expect(api.resolve).not.toHaveBeenCalled();
    expect(api.stop).not.toHaveBeenCalled();
  });
});

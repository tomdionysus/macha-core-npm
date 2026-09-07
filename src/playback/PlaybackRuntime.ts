import { createClientLogger } from '../diagnostics/ClientLog.js';
import type { Platform, Player } from '../platform/Platform.js';
import type { MediaSummary, MediaTechnicalProfile, PlaybackCapabilities } from '../types.js';
import {
  PlaybackCoordinator,
  type PlaybackCoordinatorSnapshot,
} from './PlaybackCoordinator.js';
import type {
  PlaybackPreferencesUpdate,
  PlaybackResolver,
  PlaybackStopOptions,
  PlaybackUpdate,
} from './PlaybackResolver.js';

export type PlaybackRuntimePhase = 'idle' | 'starting' | 'playing' | 'paused' | 'stopping' | 'failed';

export interface PlaybackRuntimeRequest {
  media: MediaSummary;
  startPositionMs: number;
  returnTo: string;
}

export interface PlaybackRuntimeSnapshot {
  phase: PlaybackRuntimePhase;
  generation: number;
  request?: PlaybackRuntimeRequest;
  fatalError?: Error;
}

type LifecycleListener = (snapshot: PlaybackRuntimeSnapshot) => void;
type PlaybackListener = (snapshot: PlaybackCoordinatorSnapshot | undefined) => void;

function requestError(media: MediaSummary): Error | undefined {
  if (media.kind !== 'movie' && media.kind !== 'episode' && media.kind !== 'track') {
    return new Error('This catalogue item is not directly playable.');
  }
  return undefined;
}

/**
 * Application-scoped owner of playback resources.
 *
 * React owns presentation only. PlaybackRuntime owns the Player, the current
 * PlaybackCoordinator, and therefore the one server playback-session lease.
 * Resource-changing commands are generation-ordered: an old generation is
 * fully closed before a newer generation may acquire a server session.
 */
export class PlaybackRuntime {
  private readonly log = createClientLogger('playback.runtime');
  private readonly player: Player;
  private resolver: PlaybackResolver;
  private coordinator?: PlaybackCoordinator;
  private unsubscribeCoordinator?: () => void;
  private lifecycleListeners = new Set<LifecycleListener>();
  private playbackListeners = new Set<PlaybackListener>();
  private lifecycle: PlaybackRuntimeSnapshot = { phase: 'idle', generation: 0 };
  private playback?: PlaybackCoordinatorSnapshot;
  private generation = 0;
  private transitionTail: Promise<void> = Promise.resolve();
  private host?: HTMLElement;
  private hostWaiters = new Set<() => void>();
  private teardownBarrier: Promise<void> = Promise.resolve();
  private disposed = false;
  private failureCleanupGeneration?: number;
  private capabilitiesPromise?: Promise<PlaybackCapabilities>;

  constructor(
    private readonly platform: Platform,
    resolver: PlaybackResolver,
  ) {
    this.resolver = resolver;
    this.player = platform.createPlayer();
  }

  getSnapshot(): PlaybackRuntimeSnapshot {
    return {
      ...this.lifecycle,
      request: this.lifecycle.request ? { ...this.lifecycle.request } : undefined,
    };
  }

  getPlaybackSnapshot(): PlaybackCoordinatorSnapshot | undefined {
    const snapshot = this.playback;
    if (!snapshot) return undefined;
    return {
      ...snapshot,
      intent: { ...snapshot.intent },
      event: { ...snapshot.event },
    };
  }

  subscribeLifecycle(listener: LifecycleListener): () => void {
    this.lifecycleListeners.add(listener);
    listener(this.getSnapshot());
    return () => this.lifecycleListeners.delete(listener);
  }

  subscribePlayback(listener: PlaybackListener): () => void {
    this.playbackListeners.add(listener);
    listener(this.getPlaybackSnapshot());
    return () => this.playbackListeners.delete(listener);
  }

  setResolver(resolver: PlaybackResolver): void {
    this.resolver = resolver;
  }

  setReturnTo(returnTo: string): void {
    const request = this.lifecycle.request;
    if (!request || request.returnTo === returnTo) return;
    this.patchLifecycle({
      ...this.lifecycle,
      request: { ...request, returnTo },
    });
  }

  attach(host: HTMLElement): void {
    if (this.disposed) return;
    if (this.host === host) return;
    this.host = host;
    this.player.attach(host);
    for (const wake of this.hostWaiters) wake();
    this.hostWaiters.clear();
  }

  detach(host: HTMLElement): void {
    if (this.host !== host) return;
    this.host = undefined;
    // Presentation lifetime is not playback lifetime. In particular React
    // StrictMode and route/chrome changes may transiently unmount a host.
    this.player.detachHost?.();
  }

  /** Begin reusable local work from an advisory immutable profile. */
  prepare(profile: MediaTechnicalProfile): void {
    if (this.disposed) return;
    this.player.prepare?.(profile);
    // Capability detection is independent of the selected media. Starting it
    // here removes it from the Play critical path; all later generations share
    // this result.
    void this.capabilities().catch((error) => {
      this.log.warn('capability-preparation-failed', { error });
    });
  }

  play(request: PlaybackRuntimeRequest, initialPreferences?: PlaybackPreferencesUpdate): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const generation = ++this.generation;
    this.wakeHostWaiters();
    this.failureCleanupGeneration = undefined;
    const closeCurrent = this.beginCloseCurrent();
    this.publishPlayback(undefined);
    const normalizedRequest = { ...request, startPositionMs: Math.max(0, request.startPositionMs) };
    const invalid = requestError(request.media);
    this.patchLifecycle({
      phase: invalid ? 'failed' : 'starting',
      generation,
      request: normalizedRequest,
      fatalError: invalid,
    });

    if (invalid) {
      return this.enqueue(async () => {
        await closeCurrent;
        if (this.isCurrent(generation)) this.publishPlayback(undefined);
      });
    }

    return this.enqueue(async () => {
      await closeCurrent;
      await this.teardownBarrier;
      if (!this.isCurrent(generation)) return;

      // A prior transition may have installed a coordinator after play() was
      // called but before this queued transition became runnable.
      await this.beginCloseCurrent();
      if (!this.isCurrent(generation)) return;

      const coordinator = new PlaybackCoordinator({
        media: request.media,
        player: this.player,
        resolver: this.resolver,
        capabilities: () => this.capabilities(),
        initialPositionMs: Math.max(0, request.startPositionMs),
        initialPreferences: initialPreferences ? { ...initialPreferences } : undefined,
      });
      this.coordinator = coordinator;
      this.unsubscribeCoordinator = coordinator.subscribe((snapshot) => {
        if (this.coordinator !== coordinator || !this.isCurrent(generation)) return;
        this.publishPlayback(snapshot);
        this.syncLifecycleFromCoordinator(generation, snapshot);
      });

      await this.waitForHost(generation);
      if (!this.isCurrent(generation) || this.coordinator !== coordinator) {
        await this.closeCoordinator(coordinator);
        return;
      }

      await coordinator.start();
      if (!this.isCurrent(generation) || this.coordinator !== coordinator) {
        await this.closeCoordinator(coordinator);
        return;
      }
      this.syncLifecycleFromCoordinator(generation, coordinator.getSnapshot());
    });
  }

  stop(options: PlaybackStopOptions = {}): Promise<void> {
    if (this.disposed && !options.keepalive) return Promise.resolve();
    const generation = ++this.generation;
    this.wakeHostWaiters();
    this.failureCleanupGeneration = undefined;
    const closeCurrent = this.beginCloseCurrent(options);
    const request = this.lifecycle.request;
    this.patchLifecycle({
      phase: 'stopping',
      generation,
      request,
      fatalError: this.lifecycle.fatalError,
    });

    return this.enqueue(async () => {
      await closeCurrent;
      await this.beginCloseCurrent(options);
      await this.teardownBarrier;
      if (generation !== this.generation) return;
      this.player.stop();
      this.publishPlayback(undefined);
      this.patchLifecycle({ phase: 'idle', generation, request: undefined, fatalError: undefined });
    });
  }

  setPaused(paused: boolean): void {
    if (this.coordinator) {
      this.coordinator.setPaused(paused);
      return;
    }
    // A terminal source failure has already released the failed generation.
    // Play is therefore an explicit retry command, not a mutation of a dead
    // coordinator/session.
    if (!paused && this.lifecycle.phase === 'failed') void this.retry();
  }

  seek(positionMs: number): boolean {
    if (this.coordinator) return this.coordinator.seek(positionMs);
    if (this.lifecycle.phase !== 'failed' || !this.lifecycle.request) return false;
    const bounded = Math.max(0, Number.isFinite(positionMs) ? positionMs : 0);
    this.patchLifecycle({
      ...this.lifecycle,
      request: { ...this.lifecycle.request, startPositionMs: bounded },
    });
    if (this.playback) {
      this.publishPlayback({
        ...this.playback,
        intent: { ...this.playback.intent, positionMs: bounded },
        event: { ...this.playback.event, positionMs: bounded, ended: false },
      });
    }
    return true;
  }

  seekBy(deltaMs: number): boolean {
    if (this.coordinator) return this.coordinator.seekBy(deltaMs);
    if (this.lifecycle.phase !== 'failed' || !this.lifecycle.request) return false;
    return this.seek(this.lifecycle.request.startPositionMs + deltaMs);
  }

  update(update: PlaybackUpdate): void {
    if (this.coordinator) {
      this.coordinator.update(update);
      return;
    }
    // Options remain useful after a terminal source failure. Reconfiguring a
    // failed generation means acquiring a fresh generation with the selected
    // preferences; PATCHing the released session would be meaningless.
    if (this.lifecycle.phase === 'failed' && update.preferences) {
      void this.retry(update.preferences);
    }
  }

  retry(preferences?: PlaybackPreferencesUpdate): Promise<void> {
    if (this.disposed || this.lifecycle.phase !== 'failed' || !this.lifecycle.request) {
      return Promise.resolve();
    }
    const failedRequest = this.lifecycle.request;
    const failedPreferences = this.playback?.session?.preferences;
    const initialPreferences: PlaybackPreferencesUpdate | undefined = failedPreferences || preferences
      ? {
          ...(failedPreferences ? {
            mode: failedPreferences.mode,
            maxHeight: failedPreferences.maxHeight,
            maxBitrate: failedPreferences.maxBitrate,
            audioStream: failedPreferences.audioStream,
            subtitleStream: failedPreferences.subtitleStream,
            audioLanguage: failedPreferences.audioLanguage,
            subtitleLanguage: failedPreferences.subtitleLanguage,
          } : {}),
          ...preferences,
        }
      : undefined;
    this.log.info('retry-failed-generation', {
      mediaId: failedRequest.media.id,
      positionMs: failedRequest.startPositionMs,
      preferences: initialPreferences,
    });
    return this.play({ ...failedRequest }, initialPreferences);
  }

  setVolume(volume: number): void {
    this.player.setVolume(volume);
  }

  /**
   * Browser exit is a best-effort teardown. keepalive lets a DELETE survive
   * navigation; the normal awaited stop path remains authoritative in-app.
   */
  terminateForPageExit(): void {
    if (this.lifecycle.phase === 'idle') return;
    void this.stop({ keepalive: true });
  }

  async dispose(options: PlaybackStopOptions = {}): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.wakeHostWaiters();
    const close = this.beginCloseCurrent(options);
    await close;
    await this.teardownBarrier;
    this.player.detach();
    this.host = undefined;
    this.lifecycleListeners.clear();
    this.playbackListeners.clear();
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.transitionTail.catch(() => undefined).then(operation);
    this.transitionTail = run.catch((error) => {
      this.log.error('transition-failed', error);
    });
    return run;
  }

  private capabilities(): Promise<PlaybackCapabilities> {
    if (!this.capabilitiesPromise) {
      const pending = this.platform.capabilities();
      const cached = pending.catch((error) => {
        if (this.capabilitiesPromise === cached) this.capabilitiesPromise = undefined;
        throw error;
      });
      this.capabilitiesPromise = cached;
    }
    return this.capabilitiesPromise;
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private waitForHost(generation: number): Promise<void> {
    if (this.host || !this.isCurrent(generation)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const wake = () => {
        this.hostWaiters.delete(wake);
        resolve();
      };
      this.hostWaiters.add(wake);
    });
  }

  private beginCloseCurrent(options: PlaybackStopOptions = {}): Promise<void> {
    const coordinator = this.coordinator;
    if (!coordinator) return Promise.resolve();
    this.coordinator = undefined;
    this.unsubscribeCoordinator?.();
    this.unsubscribeCoordinator = undefined;
    return this.trackTeardown(this.closeCoordinator(coordinator, options));
  }

  private trackTeardown(teardown: Promise<void>): Promise<void> {
    const previous = this.teardownBarrier;
    const barrier = Promise.all([
      previous.catch((error) => this.log.warn('prior-teardown-failed', { error })),
      teardown.catch((error) => this.log.warn('teardown-failed', { error })),
    ]).then(() => undefined);
    this.teardownBarrier = barrier;
    return barrier;
  }

  private wakeHostWaiters(): void {
    for (const wake of this.hostWaiters) wake();
    this.hostWaiters.clear();
  }

  private async closeCoordinator(coordinator: PlaybackCoordinator, options: PlaybackStopOptions = {}): Promise<void> {
    await coordinator.close(options);
  }

  private syncLifecycleFromCoordinator(generation: number, snapshot: PlaybackCoordinatorSnapshot): void {
    if (!this.isCurrent(generation)) return;
    if (snapshot.fatalError) {
      this.patchLifecycle({
        phase: 'failed',
        generation,
        request: this.lifecycle.request
          ? { ...this.lifecycle.request, startPositionMs: Math.max(0, snapshot.intent.positionMs) }
          : undefined,
        fatalError: snapshot.fatalError,
      });
      this.cleanupFailedGeneration(generation);
      return;
    }
    const phase: PlaybackRuntimePhase = snapshot.starting
      ? 'starting'
      : snapshot.intent.paused
        ? 'paused'
        : 'playing';
    if (phase !== this.lifecycle.phase) {
      this.patchLifecycle({ ...this.lifecycle, phase, generation });
    }
  }

  private cleanupFailedGeneration(generation: number): void {
    if (this.failureCleanupGeneration === generation) return;
    this.failureCleanupGeneration = generation;
    const coordinator = this.coordinator;
    if (!coordinator) return;
    this.coordinator = undefined;
    this.unsubscribeCoordinator?.();
    this.unsubscribeCoordinator = undefined;
    void this.trackTeardown(this.closeCoordinator(coordinator)).catch((error) => {
      this.log.warn('failed-generation-cleanup-failed', { generation, error });
    });
  }

  private patchLifecycle(snapshot: PlaybackRuntimeSnapshot): void {
    const changed = snapshot.phase !== this.lifecycle.phase
      || snapshot.generation !== this.lifecycle.generation
      || snapshot.request !== this.lifecycle.request
      || snapshot.fatalError !== this.lifecycle.fatalError;
    this.lifecycle = snapshot;
    if (!changed) return;
    const current = this.getSnapshot();
    for (const listener of this.lifecycleListeners) listener(current);
  }

  private publishPlayback(snapshot: PlaybackCoordinatorSnapshot | undefined): void {
    this.playback = snapshot;
    const current = this.getPlaybackSnapshot();
    for (const listener of this.playbackListeners) listener(current);
  }
}

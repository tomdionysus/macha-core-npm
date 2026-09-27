import { MachaPlaybackError } from './MachaPlaybackResolver.js';
import { createClientLogger } from '../diagnostics/ClientLog.js';
import type { PlaybackHost, Platform, Player } from '../platform/Platform.js';
import type { PlaybackPolicyOverrides } from './choosePlaybackInstruction.js';
import { versionPreferences, type QualityCeiling, type VersionStep } from './playbackVersions.js';
import type { MediaSummary, MediaTechnicalProfile, PlaybackCapabilities } from '../types.js';
import {
  PlaybackCoordinator,
  type PlaybackCoordinatorSnapshot,
  type PlaybackFacts,
  type PlaybackInstructionReport,
  type PlaybackMoveOptions,
} from './PlaybackCoordinator.js';
import type {
  PlaybackPreferences,
  PlaybackPreferencesUpdate,
  PlaybackResolver,
  PlaybackStopOptions,
  PlaybackUpdate,
} from './PlaybackResolver.js';

/**
 * The parts of a failed generation's preferences that are the viewer's own
 * choices about *content* — which audio track, which subtitles, what quality
 * ceiling. A retry echoes them unchanged: nothing about a node failing makes
 * any of them wrong.
 */
function viewerStreamChoices(preferences: PlaybackPreferences): PlaybackPreferencesUpdate {
  return {
    maxHeight: preferences.maxHeight,
    maxBitrate: preferences.maxBitrate,
    audioStream: preferences.audioStream,
    subtitleStream: preferences.subtitleStream,
    audioLanguage: preferences.audioLanguage,
    subtitleLanguage: preferences.subtitleLanguage,
  };
}

/**
 * How a retry should ask for the media to be carried.
 *
 * Taken from the instruction the coordinator reported, not from the session
 * the server echoed back, because the echo is wrong in two directions at
 * once. It carries no `container`, so a retry asked for no carriage at all
 * and the node fell back to its own default — the silent starvation 0.6.3
 * already paid for. And its `mode` is a concrete mode, which arriving as
 * `initialPreferences.mode` reads as a mode the *viewer* picked:
 * `chosenByViewer: true` is reported to the host though the chooser decided
 * it, the chooser is skipped on the retry, and the one-shot 400 downgrade in
 * `resolveInstructed` is switched off for a decision no viewer ever made.
 *
 * So a chooser-made decision retries as `choose`. It should be made again
 * anyway: a retry usually lands on a different node, and the instruction that
 * was right for the last one is exactly the thing in question. Only a mode
 * the viewer actually picked is restated, with the carriage that went with it.
 */
function retriedCarriage(
  instruction: PlaybackInstructionReport | undefined,
  failedPreferences: PlaybackPreferences | undefined,
): PlaybackPreferencesUpdate {
  if (!instruction) return failedPreferences ? { mode: failedPreferences.mode } : {};
  if (!instruction.chosenByViewer) return { mode: 'choose' };
  return {
    mode: instruction.mode,
    video: instruction.video,
    audio: instruction.audio,
    container: instruction.container,
    // The file the viewer's version named, which a retry must not re-rank.
    ...(instruction.mediaId ? { mediaId: instruction.mediaId } : {}),
  };
}

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

/**
 * `fatalError.code` when a host asks to play a catalogue item that is not a
 * movie, episode or track. The host words it; the message is log text.
 */
export const NOT_PLAYABLE_CODE = 'not_playable';

function requestError(media: MediaSummary): Error | undefined {
  if (media.kind !== 'movie' && media.kind !== 'episode' && media.kind !== 'track') {
    return new MachaPlaybackError(`Catalogue ${media.kind} ${media.id} is not directly playable.`, undefined, NOT_PLAYABLE_CODE);
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
/**
 * What a host supplies so the runtime can choose an instruction.
 *
 * Without these the chooser decides from capabilities alone, which is enough
 * to be wrong: it never learns what the source actually is, nor what this
 * device gets wrong about itself.
 */
export interface PlaybackRuntimeOptions {
  /** What the media is and what the node can do with it. See `PlaybackCoordinatorOptions`. */
  facts?: (media: MediaSummary) => Promise<PlaybackFacts | undefined>;
  /** Platform truths no capability probe can discover. */
  policyOverrides?: PlaybackPolicyOverrides;
  /** See `PlaybackCoordinatorOptions.qualityCeiling`. */
  qualityCeiling?: () => QualityCeiling | undefined;
  /** See `PlaybackCoordinatorOptions.offerAll`. */
  offerAll?: () => boolean;
}

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
  private host?: PlaybackHost;
  private hostWaiters = new Set<() => void>();
  private teardownBarrier: Promise<void> = Promise.resolve();
  private disposed = false;
  private failureCleanupGeneration?: number;
  private capabilitiesPromise?: Promise<PlaybackCapabilities>;

  constructor(
    private readonly platform: Platform,
    resolver: PlaybackResolver,
    private readonly options: PlaybackRuntimeOptions = {},
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

  attach(host: PlaybackHost): void {
    if (this.disposed) return;
    if (this.host === host) return;
    this.host = host;
    this.player.attach(host);
    for (const wake of this.hostWaiters) wake();
    this.hostWaiters.clear();
  }

  detach(host: PlaybackHost): void {
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
        facts: this.options.facts,
        policyOverrides: this.options.policyOverrides,
        qualityCeiling: this.options.qualityCeiling,
        offerAll: this.options.offerAll,
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

  /**
   * Play one of the snapshot's `versions.steps` as the viewer's choice; see
   * `PlaybackCoordinator.playVersion`. After a terminal failure it starts a
   * fresh generation on that version, as `retry` would.
   */
  playVersion(step: VersionStep): Promise<void> {
    if (this.coordinator) return this.coordinator.playVersion(step);
    if (this.lifecycle.phase === 'failed' && this.lifecycle.request) {
      return this.play({ ...this.lifecycle.request }, versionPreferences(step));
    }
    return Promise.resolve();
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

  /**
   * Serve the current title from a node the viewer chose, without stopping.
   *
   * Forwarded because a host holds a runtime and never the coordinator, so
   * `PlaybackCoordinator.moveTo` had no caller from any client. `false` when
   * there is no generation to move — idle, or failed. A failed generation is
   * already released, so moving it is a retry on another node, and a host
   * spells that as `prefer(endpointId)` on the registry and then `retry()`;
   * there is nothing here for a move to act on.
   */
  moveTo(endpointId: string, options?: PlaybackMoveOptions): Promise<boolean> {
    if (this.coordinator) return this.coordinator.moveTo(endpointId, options);
    return Promise.resolve(false);
  }

  retry(preferences?: PlaybackPreferencesUpdate): Promise<void> {
    if (this.disposed || this.lifecycle.phase !== 'failed' || !this.lifecycle.request) {
      return Promise.resolve();
    }
    const failedRequest = this.lifecycle.request;
    const failedPreferences = this.playback?.session?.preferences;
    const initialPreferences: PlaybackPreferencesUpdate | undefined = failedPreferences || preferences
      ? {
          ...(failedPreferences ? viewerStreamChoices(failedPreferences) : {}),
          ...retriedCarriage(this.playback?.instruction, failedPreferences),
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

  /**
   * Apply a level to the active player. Forwarded verbatim; a player that does
   * not do app volume simply has none.
   *
   * **This applies a volume. It does not persist one, and the two share only a
   * word.** Persisting a viewer's chosen level is a client's own business —
   * core carried a `VolumeStore` until `0.10.0` and it is gone, because volume
   * is player logic and a level is a property of one surface on one device.
   *
   * The distinction is not academic; it has misled twice. This method was
   * twice described in core's own plan as a passthrough that existed only to
   * carry that store, and scheduled for deletion with it — it touches no store
   * and never did. And a client's volume hook passes *this* method the level
   * the player should be hearing (zero while muted) while passing its own
   * store the level to restore on next launch, **four lines apart in the same
   * file**. Write the wrong one to disk and the television comes up silent
   * with nothing on screen explaining why, which is the failure the whole area
   * exists to prevent.
   *
   * So: applying takes the effective level, persisting takes the chosen one.
   * Core only does the first.
   */
  setVolume(volume: number): void {
    this.player.setVolume?.(volume);
  }

  /**
   * Best-effort teardown on the way out. `keepalive` lets the `DELETE` survive
   * a navigation; the normal awaited stop path remains authoritative in-app.
   *
   * **Best-effort is not a hedge, and on two platforms it is closer to a
   * hope.** `keepalive` is browser-only: React Native ignores it and Tizen 3
   * does not have the property at all — precisely the platforms that suspend
   * an app rather than navigate away from it. A host that is force-quit,
   * crashes or loses power sends nothing anywhere.
   *
   * What that costs is not local. A node counts a session against
   * `max_video_transcodes` from admission until the session record is erased,
   * which is `session_idle` — **30 minutes** — and reclaiming the idle pipeline
   * at 60 s does not release it. So an unsent `DELETE` on a one-slot node
   * means the next viewer gets `429 resource_limit` for up to half an hour,
   * and nothing about it is visible from the client that caused it.
   *
   * There is no server-side mitigation today: no shorter idle for a session
   * nothing was ever fetched from, and admission refuses rather than evicting.
   * Both have been raised. Until one exists, calling this promptly and
   * correctly is the whole of the defence, which is why it is the host's job
   * and cannot be inferred here.
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

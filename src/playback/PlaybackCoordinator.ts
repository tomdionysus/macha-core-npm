import { createClientLogger } from '../diagnostics/ClientLog.js';
import { isEndpointRetryablePlaybackFailure, PlaybackSourceError, type Player } from '../platform/Platform.js';
import type { MediaSummary, PlaybackCapabilities, PlaybackEvent, PlaybackSource } from '../types.js';
import type {
  PlaybackPreferencesUpdate,
  PlaybackResolver,
  PlaybackSession,
  PlaybackStopOptions,
  PlaybackUpdate,
} from './PlaybackResolver.js';
import { technicalProfileFromSession } from './MediaTechnicalProfile.js';
import { machaHost } from '../runtime/host.js';

export interface PlaybackIntent {
  positionMs: number;
  paused: boolean;
}

export interface PlaybackCoordinatorSnapshot {
  intent: PlaybackIntent;
  event: PlaybackEvent;
  session?: PlaybackSession;
  starting: boolean;
  preparingSource: boolean;
  pendingPreferences?: PlaybackPreferencesUpdate;
  fatalError?: Error;
  notice?: string;
}

export interface PlaybackCoordinatorOptions {
  media: MediaSummary;
  player: Player;
  resolver: PlaybackResolver;
  capabilities: () => Promise<PlaybackCapabilities>;
  initialPositionMs: number;
  initialPreferences?: PlaybackPreferencesUpdate;
}

type Listener = (snapshot: PlaybackCoordinatorSnapshot) => void;
const ALTERNATE_RECOVERY_WINDOW_MS = 30_000;
const PLAYBACK_END_TOLERANCE_MS = 5_000;
const UNCACHED_SEEK_DEBOUNCE_MS = 300;

interface PendingMutation {
  update: PlaybackUpdate;
  reason: 'seek' | 'representation' | 'subtitle';
}

function awaitUnlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener('abort', aborted);
      reject(signal.reason);
    };
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      },
    );
  });
}

function clampPosition(positionMs: number, durationMs: number | undefined): number {
  const finite = Number.isFinite(positionMs) ? positionMs : 0;
  if (!durationMs || durationMs <= 0) return Math.max(0, finite);
  return Math.max(0, Math.min(durationMs, finite));
}

export function isPrematurePlaybackEnd(positionMs: number, durationMs: number): boolean {
  return durationMs > 0 && positionMs + PLAYBACK_END_TOLERANCE_MS < durationMs;
}

export function generationLocalPosition(
  session: PlaybackSession,
  absolutePositionMs: number,
): number | undefined {
  if (session.mode === 'direct') return clampPosition(absolutePositionMs, session.durationMs);
  const generationStartMs = Math.max(0, session.seekMs);
  if (absolutePositionMs < generationStartMs) return undefined;
  return clampPosition(absolutePositionMs - generationStartMs, Math.max(0, session.durationMs - generationStartMs));
}

function rangeContainsPosition(
  ranges: readonly { startMs: number; endMs: number }[],
  positionMs: number,
): boolean {
  return ranges.some((range) => range.startMs <= positionMs && positionMs <= range.endMs);
}

function mergePreferences(
  current: PlaybackPreferencesUpdate | undefined,
  next: PlaybackPreferencesUpdate | undefined,
): PlaybackPreferencesUpdate | undefined {
  if (!current) return next ? { ...next } : undefined;
  if (!next) return { ...current };
  return { ...current, ...next };
}

export function mergePlaybackUpdate(current: PlaybackUpdate | undefined, next: PlaybackUpdate): PlaybackUpdate {
  if (!current) return {
    ...next,
    preferences: next.preferences ? { ...next.preferences } : undefined,
  };
  return {
    ...current,
    ...next,
    preferences: mergePreferences(current.preferences, next.preferences),
  };
}

export function isSubtitleOnlyPlaybackUpdate(update: PlaybackUpdate): boolean {
  if (update.seekMs !== undefined || update.mediaId !== undefined || !update.preferences) return false;
  const keys = Object.entries(update.preferences)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
  return keys.length > 0 && keys.every((key) => key === 'subtitleStream' || key === 'subtitleLanguage');
}

function sourceIdentity(session: PlaybackSession): string {
  return `${session.mode}|${session.source.url}|${session.source.mimeType ?? ''}|${session.mediaId}`;
}

function preservedSeekPreferences(session: PlaybackSession): PlaybackPreferencesUpdate {
  return {
    subtitleStream: session.selected.subtitleStream >= 0 ? session.selected.subtitleStream : null,
    subtitleLanguage: session.preferences.subtitleLanguage,
  };
}

function completePreferences(session: PlaybackSession): PlaybackPreferencesUpdate {
  return {
    mode: session.preferences.mode,
    maxHeight: session.preferences.maxHeight,
    maxBitrate: session.preferences.maxBitrate,
    audioStream: session.preferences.audioStream,
    subtitleStream: session.preferences.subtitleStream,
    audioLanguage: session.preferences.audioLanguage,
    subtitleLanguage: session.preferences.subtitleLanguage,
  };
}

export function equivalentDirectSources(primary: PlaybackSession, alternate: PlaybackSession): boolean {
  const primaryMime = (primary.source.mimeType ?? primary.mimeType).split(';', 1)[0]?.trim().toLowerCase();
  const alternateMime = (alternate.source.mimeType ?? alternate.mimeType).split(';', 1)[0]?.trim().toLowerCase();
  return primary.mode === 'direct'
    && alternate.mode === 'direct'
    && primary.mediaId === alternate.mediaId
    && !primary.mediaId.startsWith('path:')
    && Boolean(primary.source.sizeBytes && primary.source.sizeBytes > 0)
    && primary.source.sizeBytes === alternate.source.sizeBytes
    && primaryMime === alternateMime;
}

/**
 * PlaybackCoordinator is the sole owner of playback intent and source-generation
 * transitions. Transport commands are always local and immediate when the active
 * generation can represent them. Server work is restricted to creating/replacing
 * source generations and is coalesced behind the latest user intent.
 */
export class PlaybackCoordinator {
  private readonly log: ReturnType<typeof createClientLogger>;
  private readonly listeners = new Set<Listener>();
  private readonly unsubscribePlayer: () => void;
  private readonly unsubscribePlayerFailure?: () => void;
  private readonly unsubscribePlayerDegradation?: () => void;
  private disposed = false;
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private closeOptions: PlaybackStopOptions = {};
  private mutationLoop?: Promise<void>;
  private pendingMutation?: PendingMutation;
  private debouncedSeekMutation?: PendingMutation;
  private seekDebounceTimer?: ReturnType<typeof setTimeout>;
  private activeMutation?: { reason: PendingMutation['reason']; controller: AbortController; settled: Promise<void> };
  private lastSeekTransitionAt = 0;
  private mutationRevision = 0;
  private sourceActivationRevision = 0;
  private positionRevision = 0;
  private seekIntentActive = false;
  /** The last position the player itself reported, independent of optimistic seek intent. */
  private lastObservedPositionMs?: number;
  private failoverPromise?: Promise<void>;
  private readonly alternateSessions = new Map<string, PlaybackSession>();
  private readonly alternatePreparations = new Set<Promise<void>>();
  private readonly alternateExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private supersededCleanup?: { oldSessionId: string; newSessionId: string; attempt: number; timer?: ReturnType<typeof setTimeout> };
  private streamOffsetMs = 0;
  /** Latest server-side session state; may be ahead of the source currently visible. */
  private serverSession?: PlaybackSession;
  /**
   * The Direct Play source actually loaded into the player right now, kept
   * distinct from `serverSession.source`. A silently promoted alternate
   * (see `promoteSilentDirectAlternate`) moves session bookkeeping forward
   * without ever touching the player, so the read-ahead worker's fallback
   * registration must keep addressing the URL genuinely loaded in the video
   * element — not whatever session is current for lifecycle purposes — or
   * it targets a source key the worker never configured.
   */
  private activeDirectPlaySource?: PlaybackSource;

  private snapshot: PlaybackCoordinatorSnapshot;

  constructor(private readonly options: PlaybackCoordinatorOptions) {
    this.log = createClientLogger('playback.coordinator', { mediaId: options.media.id });
    const initialPositionMs = Math.max(0, options.initialPositionMs);
    this.snapshot = {
      intent: { positionMs: initialPositionMs, paused: false },
      event: {
        positionMs: initialPositionMs,
        durationMs: options.media.durationMs ?? 0,
        paused: true,
        ended: false,
      },
      starting: true,
      preparingSource: false,
    };
    this.unsubscribePlayer = options.player.subscribe((event) => this.onPlayerEvent(event));
    this.unsubscribePlayerFailure = options.player.subscribeFailure?.((error) => this.fail(error));
    this.unsubscribePlayerDegradation = options.player.subscribeDegradation?.((error) => this.degrade(error));
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): PlaybackCoordinatorSnapshot {
    return {
      ...this.snapshot,
      intent: { ...this.snapshot.intent },
      event: { ...this.snapshot.event },
      pendingPreferences: this.snapshot.pendingPreferences
        ? { ...this.snapshot.pendingPreferences }
        : undefined,
    };
  }

  start(): Promise<void> {
    if (!this.startPromise) this.startPromise = this.startInternal();
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    if (this.disposed) return;
    const startedAt = machaHost().now();
    try {
      const capabilities = await this.options.capabilities();
      if (this.disposed) return;
      const requestedPositionMs = this.snapshot.intent.positionMs;
      const requestedPositionRevision = this.positionRevision;
      const session = await this.options.resolver.resolve(
        this.options.media,
        capabilities,
        requestedPositionMs,
        this.options.initialPreferences,
      );
      if (this.disposed) {
        await this.options.resolver.stop(session.sessionId, this.closeOptions).catch(() => undefined);
        return;
      }
      this.log.info('initial-generation-ready', {
        sessionId: session.sessionId,
        mode: session.mode,
        requestedPositionMs,
        serverSeekMs: session.seekMs,
        elapsedMs: Math.round((machaHost().now() - startedAt) * 10) / 10,
      });
      this.serverSession = session;

      const currentDesired = this.snapshot.intent.positionMs;
      const userMovedDuringResolve = requestedPositionRevision !== this.positionRevision;
      if (userMovedDuringResolve && this.activationPosition(session, currentDesired, requestedPositionMs) === undefined) {
        this.scheduleSeekMutation({
          reason: 'seek',
          update: {
            seekMs: currentDesired,
            preferences: preservedSeekPreferences(session),
          },
        });
      } else {
        // A transformed server may keyframe-align the requested generation after
        // the exact requested point. When this is the generation we explicitly
        // requested, accept that alignment rather than creating a retry loop.
        this.activateSession(session, currentDesired, requestedPositionMs);
      }
    } catch (error) {
      this.fail(error);
    } finally {
      if (!this.disposed) {
        this.patchSnapshot({ starting: false });
      }
    }
  }

  close(options: PlaybackStopOptions = {}): Promise<void> {
    if (options.keepalive) this.closeOptions = { ...this.closeOptions, keepalive: true };
    if (this.closePromise) return this.closePromise;

    this.disposed = true;
    this.mutationRevision += 1;
    this.sourceActivationRevision += 1;
    this.pendingMutation = undefined;
    this.debouncedSeekMutation = undefined;
    this.activeMutation?.controller.abort(new DOMException('Playback coordinator closed', 'AbortError'));
    if (this.seekDebounceTimer !== undefined) clearTimeout(this.seekDebounceTimer);
    this.seekDebounceTimer = undefined;
    this.unsubscribePlayer();
    this.unsubscribePlayerFailure?.();
    this.unsubscribePlayerDegradation?.();
    if (this.supersededCleanup?.timer !== undefined) clearTimeout(this.supersededCleanup.timer);
    // Coordinator teardown ends source acquisition immediately, but deliberately
    // leaves DOM-host ownership to PlaybackRuntime/PlayerHost.
    this.options.player.stop();
    const ownedAtClose = this.serverSession ?? this.snapshot.session;

    this.closePromise = (async () => {
      await this.startPromise?.catch(() => undefined);
      await this.mutationLoop?.catch(() => undefined);
      await Promise.all([...this.alternatePreparations].map((preparation) => preparation.catch(() => undefined)));
      const session = this.serverSession ?? this.snapshot.session ?? ownedAtClose;
      if (session) {
        try {
          await this.options.resolver.stop(session.sessionId, this.closeOptions);
        } catch (error) {
          this.log.warn('session-close-failed', { sessionId: session.sessionId, error });
        }
      }
      for (const alternate of this.alternateSessions.values()) {
        if (alternate.sessionId === session?.sessionId) continue;
        await this.options.resolver.stop(alternate.sessionId, this.closeOptions).catch((error) => {
          this.log.warn('alternate-session-close-failed', { sessionId: alternate.sessionId, error });
        });
      }
      this.alternateSessions.clear();
      for (const timer of this.alternateExpiryTimers.values()) clearTimeout(timer);
      this.alternateExpiryTimers.clear();
      this.listeners.clear();
    })();
    return this.closePromise;
  }

  ownedSessionId(): string | undefined {
    return (this.serverSession ?? this.snapshot.session)?.sessionId;
  }

  setPaused(paused: boolean): void {
    if (this.disposed) return;
    const intent = { ...this.snapshot.intent, paused };
    this.patchSnapshot({ intent });
    if (paused) this.options.player.pause();
    else this.options.player.resume();
    this.log.info(paused ? 'pause-intent' : 'play-intent', {
      sessionId: this.snapshot.session?.sessionId,
      positionMs: intent.positionMs,
    });
  }

  seek(positionMs: number): boolean {
    if (this.disposed) return false;
    const durationMs = this.snapshot.session?.durationMs || this.snapshot.event.durationMs || this.options.media.durationMs;
    const bounded = clampPosition(positionMs, durationMs);
    this.lastSeekTransitionAt = Date.now();
    this.positionRevision += 1;
    this.seekIntentActive = true;
    const intent = { ...this.snapshot.intent, positionMs: bounded };
    this.patchSnapshot({
      intent,
      event: { ...this.snapshot.event, positionMs: bounded, ended: false },
      notice: undefined,
    });

    const session = this.snapshot.session;
    if (!session) {
      this.log.info('seek-intent-before-generation', { positionMs: bounded });
      return true;
    }
    if (!session.options.canSeek) {
      this.patchSnapshot({ notice: 'This stream cannot seek.' });
      return false;
    }

    const localPositionMs = this.activeLocalPosition(session, bounded);
    if (localPositionMs !== undefined) {
      this.cancelInFlightSeek();
      this.cancelDebouncedSeek();
      this.log.info('seek-local', {
        sessionId: session.sessionId,
        mode: session.mode,
        absolutePositionMs: bounded,
        localPositionMs,
      });
      this.options.player.seek(localPositionMs);
      return true;
    }

    this.log.info('seek-needs-generation', {
      sessionId: session.sessionId,
      mode: session.mode,
      absolutePositionMs: bounded,
      generationStartMs: session.seekMs,
      localCoverage: this.options.player.localSeekCoverage(),
    });
    this.cancelInFlightSeek();
    this.scheduleSeekMutation({
      reason: 'seek',
      update: {
        seekMs: bounded,
        preferences: preservedSeekPreferences(session),
      },
    });
    return true;
  }

  seekBy(deltaMs: number): boolean {
    const base = this.seekIntentActive ? this.snapshot.intent.positionMs : this.snapshot.event.positionMs;
    return this.seek(base + deltaMs);
  }

  private activeLocalPosition(session: PlaybackSession, absolutePositionMs: number): number | undefined {
    const localPositionMs = generationLocalPosition(session, absolutePositionMs);
    if (localPositionMs === undefined) return undefined;
    return rangeContainsPosition(this.options.player.localSeekCoverage(), localPositionMs)
      ? localPositionMs
      : undefined;
  }

  private activationPosition(
    session: PlaybackSession,
    desiredAbsoluteMs: number,
    preparedAbsoluteMs: number,
  ): number | undefined {
    const localPositionMs = generationLocalPosition(session, desiredAbsoluteMs);
    if (localPositionMs !== undefined) return localPositionMs;
    // A transformed server may align the exact requested point to a later
    // keyframe. Accept that explicit result at its local origin. If playback
    // merely advanced while the request was in flight, localPositionMs above
    // catches the new source up without negotiating another generation.
    return Math.round(preparedAbsoluteMs) === Math.round(desiredAbsoluteMs) ? 0 : undefined;
  }

  update(update: PlaybackUpdate): void {
    if (this.disposed) return;
    const session = this.snapshot.session;
    if (!session) {
      this.patchSnapshot({ notice: 'Playback options are still loading.' });
      return;
    }

    const subtitleOnly = isSubtitleOnlyPlaybackUpdate(update);
    const prepared: PlaybackUpdate = subtitleOnly || !session.options.canSeek
      ? update
      : { ...update, seekMs: this.snapshot.intent.positionMs };
    this.queueMutation({
      reason: subtitleOnly ? 'subtitle' : 'representation',
      update: prepared,
    });
  }

  private queueMutation(next: PendingMutation): void {
    const existing = this.pendingMutation;
    this.pendingMutation = existing
      ? {
          reason: next.reason === 'representation' || existing.reason === 'representation'
            ? 'representation'
            : next.reason,
          update: mergePlaybackUpdate(existing.update, next.update),
        }
      : next;
    this.patchSnapshot({
      preparingSource: true,
      pendingPreferences: mergePreferences(this.snapshot.pendingPreferences, next.update.preferences),
      notice: next.reason === 'subtitle' ? 'Loading subtitles…' : undefined,
    });
    this.mutationRevision += 1;
    if (!this.mutationLoop) {
      this.mutationLoop = this.drainMutations().finally(() => {
        this.mutationLoop = undefined;
        if (!this.disposed && this.seekDebounceTimer === undefined && !this.debouncedSeekMutation) {
          this.patchSnapshot({ preparingSource: false, pendingPreferences: undefined });
        }
      });
    }
  }

  private scheduleSeekMutation(next: PendingMutation): void {
    this.debouncedSeekMutation = this.debouncedSeekMutation
      ? {
          reason: 'seek',
          update: mergePlaybackUpdate(this.debouncedSeekMutation.update, next.update),
        }
      : next;
    if (this.seekDebounceTimer !== undefined) clearTimeout(this.seekDebounceTimer);
    this.patchSnapshot({ preparingSource: true, notice: undefined });
    const elapsedMs = Date.now() - this.lastSeekTransitionAt;
    const delayMs = Math.max(0, UNCACHED_SEEK_DEBOUNCE_MS - elapsedMs);
    this.seekDebounceTimer = setTimeout(() => {
      this.seekDebounceTimer = undefined;
      const pending = this.debouncedSeekMutation;
      this.debouncedSeekMutation = undefined;
      if (!pending || this.disposed) return;
      this.queueMutation(pending);
    }, delayMs);
  }

  private cancelDebouncedSeek(): void {
    if (this.seekDebounceTimer !== undefined) clearTimeout(this.seekDebounceTimer);
    this.seekDebounceTimer = undefined;
    this.debouncedSeekMutation = undefined;
    if (!this.mutationLoop && !this.pendingMutation) {
      this.patchSnapshot({ preparingSource: false });
    }
  }

  private cancelInFlightSeek(): void {
    const active = this.activeMutation;
    if (active?.reason !== 'seek' || active.controller.signal.aborted) return;
    active.controller.abort(new DOMException('Seek superseded by newer viewer intent', 'AbortError'));
  }

  /**
   * `seek()` pins its target optimistically, and until the player reports
   * reaching it `onPlayerEvent` deliberately ignores real positions. A
   * mutation that never lands would otherwise leave that target pinned for
   * the rest of the session — the scrubber (`PlayerScreen` renders
   * `intent.positionMs`) frozen at a position playback never reached while it
   * plays on elsewhere, and resume requests derived from the same field.
   * Fall back to the last position the player actually reported, unless newer
   * seek intent is already queued to supersede this one anyway.
   */
  private rollbackUnfulfilledSeek(): void {
    if (!this.seekIntentActive || this.pendingMutation || this.debouncedSeekMutation) return;
    this.seekIntentActive = false;
    const positionMs = this.lastObservedPositionMs;
    if (positionMs === undefined) return;
    this.patchSnapshot({
      intent: { ...this.snapshot.intent, positionMs },
      event: { ...this.snapshot.event, positionMs },
    });
  }

  private async drainMutations(): Promise<void> {
    while (!this.disposed) {
      const pending = this.pendingMutation;
      const current = this.serverSession ?? this.snapshot.session;
      if (!pending || !current) return;
      this.pendingMutation = undefined;
      const requestRevision = this.mutationRevision;
      // A queued generation mutation may have been formed before a newer local
      // transport intent arrived. Generation work is a correctness fallback, so
      // bind it to the latest position at dispatch time rather than preparing a
      // representation around stale transport state.
      const update = pending.reason === 'subtitle' || !current.options.canSeek
        ? pending.update
        : { ...pending.update, seekMs: this.snapshot.intent.positionMs };
      const requestedPositionMs = update.seekMs ?? this.snapshot.intent.positionMs;
      const requestedPositionRevision = this.positionRevision;
      const startedAt = machaHost().now();
      const controller = new AbortController();
      let resolveSettled!: () => void;
      const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
      this.activeMutation = { reason: pending.reason, controller, settled };

      try {
        // AbortSignal cancels modern fetch implementations. The local race also
        // makes cancellation non-blocking on older TV engines whose fetch may
        // accept a signal but fail to terminate the underlying request.
        const next = await awaitUnlessAborted(
          this.options.resolver.update(current.sessionId, update, controller.signal),
          controller.signal,
        );
        if (this.disposed) return;
        this.serverSession = next;
        this.log.info('generation-update-ready', {
          sessionId: next.sessionId,
          mode: next.mode,
          reason: pending.reason,
          requestedPositionMs,
          serverSeekMs: next.seekMs,
          superseded: requestRevision !== this.mutationRevision,
          elapsedMs: Math.round((machaHost().now() - startedAt) * 10) / 10,
        });

        // Newer server-side intent is already queued. Do not churn the media
        // element through an intermediate representation that the user no
        // longer wants; the immutable current source can keep playing meanwhile.
        if (this.pendingMutation) continue;

        const currentDesired = this.snapshot.intent.positionMs;
        const userMovedDuringRequest = requestedPositionRevision !== this.positionRevision;
        if (userMovedDuringRequest && this.activationPosition(next, currentDesired, requestedPositionMs) === undefined) {
          this.scheduleSeekMutation({
            reason: 'seek',
            update: {
              seekMs: currentDesired,
              preferences: preservedSeekPreferences(next),
            },
          });
          this.mutationRevision += 1;
          return;
        }

        if (pending.reason === 'subtitle' && sourceIdentity(current) === sourceIdentity(next) && this.options.player.setSubtitle) {
          await this.options.player.setSubtitle(next.source.subtitleUrl);
          if (!this.disposed) {
            this.setSession(next);
            this.patchSnapshot({ notice: undefined });
          }
          continue;
        }

        this.activateSession(next, currentDesired, requestedPositionMs);
        if (!this.disposed) this.patchSnapshot({ notice: undefined });
      } catch (error) {
        if (this.disposed) return;
        if (controller.signal.aborted) {
          this.log.debug('generation-update-superseded', {
            sessionId: current.sessionId,
            reason: pending.reason,
            update,
          });
          continue;
        }
        this.log.error('generation-update-failed', {
          sessionId: current.sessionId,
          reason: pending.reason,
          update,
          error,
        });
        this.patchSnapshot({ notice: error instanceof Error ? error.message : String(error) });
        this.rollbackUnfulfilledSeek();
      } finally {
        if (this.activeMutation?.controller === controller) this.activeMutation = undefined;
        resolveSettled();
      }
    }
  }

  private activateSession(session: PlaybackSession, desiredAbsoluteMs: number, preparedAbsoluteMs: number): void {
    if (this.disposed) return;
    // Catalogue profiling may already have prepared the reusable player. The
    // session supplies the same facts authoritatively and completes that setup
    // without introducing another awaited step in source activation.
    this.options.player.prepare?.(technicalProfileFromSession(session));
    const activationRevision = ++this.sourceActivationRevision;
    this.releaseObsoleteAlternates(session.sessionId);
    const localPositionMs = this.activationPosition(session, desiredAbsoluteMs, preparedAbsoluteMs);

    if (localPositionMs === undefined) {
      // The user moved behind the generation while it was being prepared. This
      // is genuine source-generation work, not a transport wait.
      this.scheduleSeekMutation({
        reason: 'seek',
        update: {
          seekMs: desiredAbsoluteMs,
          preferences: preservedSeekPreferences(session),
        },
      });
      return;
    }

    this.serverSession = session;
    this.setSession(session);
    this.activeDirectPlaySource = session.mode === 'direct' ? session.source : undefined;
    this.streamOffsetMs = session.mode === 'direct' ? 0 : Math.max(0, session.seekMs);
    const absoluteStartMs = session.mode === 'direct'
      ? localPositionMs
      : this.streamOffsetMs + localPositionMs;
    // Source attachment emits transient zero/paused media events. Keep the
    // requested transport target authoritative until the active player reports
    // that it has actually reached this source-generation position.
    this.seekIntentActive = true;
    this.patchSnapshot({
      intent: { ...this.snapshot.intent, positionMs: absoluteStartMs },
      event: {
        ...this.snapshot.event,
        positionMs: absoluteStartMs,
        durationMs: session.durationMs,
        paused: this.snapshot.intent.paused,
        ended: false,
        // Buffer residency belongs to a source generation. Never carry the old
        // generation's ranges across a transformed source activation.
        bufferedRangesMs: [],
        forwardBufferMs: 0,
      },
    });

    this.log.info('source-activate', {
      sessionId: session.sessionId,
      mode: session.mode,
      source: session.source.url,
      generationStartMs: this.streamOffsetMs,
      desiredAbsoluteMs,
      localPositionMs,
      paused: this.snapshot.intent.paused,
    });

    const startPaused = this.snapshot.intent.paused;
    void this.options.player.play(session.source, localPositionMs, startPaused).then((started) => {
      if (this.disposed || activationRevision !== this.sourceActivationRevision) return;
      // User intent may have changed while the source was attaching. Reconcile
      // only the delta; source readiness is never a transport-state barrier.
      if (this.snapshot.intent.paused !== startPaused) {
        if (this.snapshot.intent.paused) this.options.player.pause();
        else this.options.player.resume();
      } else if (!startPaused && !started) {
        // Autoplay policy is not a source failure. The observed media event will
        // report paused=true and the always-enabled Play control can retry.
        this.log.info('source-attached-autoplay-not-started', { sessionId: session.sessionId });
      }
    }).catch((error) => {
      if (this.disposed || activationRevision !== this.sourceActivationRevision) return;
      this.fail(error);
    });
  }

  /**
   * The client-owned preferences to recreate a generation with: the last
   * server-confirmed session preferences, overridden by any representation
   * change the viewer has already requested but the server has not yet
   * confirmed. Both alternate preparation and failover must use this rather
   * than the bare session echo, or a preference change racing a node failure
   * would be silently dropped on recovery.
   */
  private currentPreferences(session: PlaybackSession): PlaybackPreferencesUpdate {
    return { ...completePreferences(session), ...this.snapshot.pendingPreferences };
  }

  private degrade(error: Error): void {
    if (this.disposed || !isEndpointRetryablePlaybackFailure(error)) return;
    const session = this.snapshot.session ?? this.serverSession;
    if (!session || this.alternatePreparations.size > 0 || this.alternateSessions.size > 0) return;
    // A seek already outside local coverage is itself replacing this
    // generation via resolver.update() — the server tearing down the old
    // pipeline to honor that PATCH is expected, not independent failure
    // evidence. Without this, a stream error surfacing from that expected
    // teardown raced a second, fully redundant session into existence
    // alongside the seek's own legitimate replacement.
    if (this.activeMutation?.reason === 'seek') return;
    this.log.warn('source-degradation-evidence', {
      sessionId: session.sessionId,
      endpoint: session.endpoint,
      error,
    });
    this.prepareAlternate(session, this.sourceActivationRevision);
  }

  private prepareAlternate(session: PlaybackSession, activationRevision: number): void {
    const prepare = this.options.resolver.prepareAlternate?.bind(this.options.resolver);
    const preflight = this.options.player.preflightSource?.bind(this.options.player);
    if (!prepare) {
      this.log.info('alternate-preparation-unavailable', { sessionId: session.sessionId });
      return;
    }

    // A transport preflight hook improves the quality of a warm standby, but
    // must never gate creation of that standby. Application-scoped Player
    // instances can legitimately predate a hot module update, and third-party
    // platform players need not implement either optional hook. In both cases
    // the prepared generation remains immediately promotable by player.play().
    this.log.info('alternate-preparation-start', {
      sessionId: session.sessionId,
      mode: session.mode,
      transportPreflight: session.mode !== 'direct' && Boolean(preflight),
    });

    let preparation!: Promise<void>;
    preparation = (async () => {
      let alternate: PlaybackSession | undefined;
      try {
        const capabilities = await this.options.capabilities();
        alternate = await prepare(
          session,
          this.options.media,
          capabilities,
          this.snapshot.intent.positionMs,
          this.currentPreferences(session),
        );
        if (!alternate) return;
        if (this.disposed || activationRevision !== this.sourceActivationRevision || this.snapshot.session?.sessionId !== session.sessionId) {
          await this.options.resolver.stop(alternate.sessionId, this.closeOptions).catch(() => undefined);
          return;
        }
        if (session.mode === 'direct') {
          if (!equivalentDirectSources(session, alternate)) {
            await this.options.resolver.stop(alternate.sessionId).catch(() => undefined);
            return;
          }
          // Byte-identical Direct Play content on a different node can be
          // served under the same read-ahead cache key: register it as a
          // fallback source now so an in-flight range request fails over
          // silently the moment the primary node stops answering, with no
          // video reload or visible stall. Must address the source actually
          // loaded in the player, not `session.source` — a prior silent
          // promotion already moved session bookkeeping on without ever
          // touching the player, and the read-ahead worker only recognises
          // the key it was originally configured with.
          const activeSource = this.activeDirectPlaySource ?? session.source;
          const registered = this.options.player.addDirectSourceAlternative?.(activeSource, alternate.source);
          if (registered) {
            this.promoteSilentDirectAlternate(session, alternate);
            return;
          }
          // No read-ahead hook, or registration failed: fall through to the
          // slower, reactive standby path below.
        } else if (alternate.mediaId !== session.mediaId
          || alternate.mode !== session.mode
          || (preflight ? !await preflight(alternate.source) : false)) {
          await this.options.resolver.stop(alternate.sessionId).catch(() => undefined);
          return;
        }
        this.alternateSessions.set(alternate.sessionId, alternate);
        const expiry = setTimeout(() => {
          this.alternateExpiryTimers.delete(alternate!.sessionId);
          if (!this.alternateSessions.delete(alternate!.sessionId)) return;
          this.log.info('alternate-recovery-window-expired', { sessionId: alternate!.sessionId });
          void this.options.resolver.stop(alternate!.sessionId).catch((error) => {
            this.log.warn('expired-alternate-close-failed', { sessionId: alternate!.sessionId, error });
          });
        }, ALTERNATE_RECOVERY_WINDOW_MS);
        this.alternateExpiryTimers.set(alternate.sessionId, expiry);
        this.log.info('alternate-ready', {
          primarySessionId: session.sessionId,
          alternateSessionId: alternate.sessionId,
          endpoint: alternate.endpoint,
        });
      } catch (error) {
        if (alternate && !this.alternateSessions.has(alternate.sessionId)) {
          await this.options.resolver.stop(alternate.sessionId).catch(() => undefined);
        }
        this.log.warn('alternate-preparation-failed', { sessionId: session.sessionId, error });
      } finally {
        this.alternatePreparations.delete(preparation);
      }
    })();
    this.alternatePreparations.add(preparation);
  }

  /**
   * The read-ahead worker can start actually depending on a registered
   * fallback source at any moment, with no signal back to the coordinator.
   * Bookkeeping must move with it immediately rather than treating it as a
   * disposable, thirty-second standby: leaving it on that clock would let it
   * be stopped server-side while still in silent use, and would keep any
   * future failure evidence pointed at a session that is no longer really
   * the one in service. `activeDirectPlaySource` is deliberately left alone
   * — the player itself is never touched here.
   */
  private promoteSilentDirectAlternate(previous: PlaybackSession, alternate: PlaybackSession): void {
    this.serverSession = alternate;
    this.setSession(alternate);
    this.log.info('alternate-promoted-silently', {
      previousSessionId: previous.sessionId,
      alternateSessionId: alternate.sessionId,
      endpoint: alternate.endpoint,
    });
    // No session-negotiation failure ever surfaces for this endpoint — the
    // transport layer just quietly stopped using it — so nothing else would
    // ever tell the registry it is down. Without this, a later reactive
    // failover (for an unrelated cause) can still blindly pick this same
    // endpoint back up as an apparently-untried, apparently-healthy candidate.
    if (previous.endpoint) this.options.resolver.recordEndpointFailure?.(previous.endpoint.id);
    void this.options.resolver.stop(previous.sessionId).catch((error) => {
      this.log.warn('superseded-primary-close-failed', { sessionId: previous.sessionId, error });
    });
  }

  private releaseObsoleteAlternates(nextSessionId: string): void {
    for (const [sessionId] of this.alternateSessions) {
      if (sessionId === nextSessionId) continue;
      this.alternateSessions.delete(sessionId);
      const timer = this.alternateExpiryTimers.get(sessionId);
      if (timer !== undefined) clearTimeout(timer);
      this.alternateExpiryTimers.delete(sessionId);
      void this.options.resolver.stop(sessionId).catch((error) => {
        this.log.warn('obsolete-alternate-close-failed', { sessionId, error });
      });
    }
  }

  private setSession(session: PlaybackSession): void {
    this.patchSnapshot({ session });
  }

  private onPlayerEvent(next: PlaybackEvent): void {
    if (this.disposed) return;
    const session = this.snapshot.session;
    const absolutePositionMs = next.positionMs + (session?.mode === 'direct' ? 0 : this.streamOffsetMs);
    this.lastObservedPositionMs = absolutePositionMs;
    const absolute: PlaybackEvent = {
      ...next,
      positionMs: absolutePositionMs,
      durationMs: session?.durationMs || next.durationMs,
      bufferedRangesMs: next.bufferedRangesMs?.map((range) => ({
        startMs: range.startMs + (session?.mode === 'direct' ? 0 : this.streamOffsetMs),
        endMs: range.endMs + (session?.mode === 'direct' ? 0 : this.streamOffsetMs),
      })),
    };

    // HTML media stacks may emit `ended` when a truncated TCP/HLS generation
    // runs out, even though the item itself is nowhere near complete. Treating
    // that observation as normal completion closes the player and navigates
    // away before cluster recovery has a chance to run.
    if (absolute.ended && isPrematurePlaybackEnd(absolute.positionMs, absolute.durationMs)) {
      const interrupted: PlaybackEvent = {
        ...absolute,
        paused: this.snapshot.intent.paused,
        ended: false,
        buffering: !this.snapshot.intent.paused,
      };
      const intent = this.seekIntentActive
        ? this.snapshot.intent
        : { ...this.snapshot.intent, positionMs: absolutePositionMs };
      this.patchSnapshot({ event: interrupted, intent });
      this.log.warn('premature-source-end', {
        sessionId: session?.sessionId,
        positionMs: absolute.positionMs,
        durationMs: absolute.durationMs,
        remainingMs: absolute.durationMs - absolute.positionMs,
      });
      this.fail(new PlaybackSourceError('Playback source ended before the media was complete', 'stream'));
      return;
    }

    const cleanup = this.supersededCleanup;
    if (cleanup
      && session?.sessionId === cleanup.newSessionId
      && !next.paused
      && !next.seeking
      && (next.bufferedRangesMs ?? []).some((range) => range.endMs > next.positionMs)) {
      this.beginSupersededCleanup(cleanup);
    }

    const target = this.snapshot.intent.positionMs;
    if (this.seekIntentActive && !next.seeking && Math.abs(absolutePositionMs - target) <= 1_500) {
      this.seekIntentActive = false;
    }

    // Media events are observations, not commands. In particular, source swaps
    // may transiently emit pause/play events and must never overwrite a Pause or
    // Play intent the user issued while that source was being prepared. Position
    // follows the player only once an outstanding seek/source target is reached.
    const intent = this.seekIntentActive
      ? this.snapshot.intent
      : { ...this.snapshot.intent, positionMs: absolutePositionMs };
    this.patchSnapshot({ event: absolute, intent });
  }

  private fail(error: unknown): void {
    if (this.disposed || this.snapshot.fatalError) return;
    const fatalError = error instanceof Error ? error : new Error(String(error));
    const activeMutation = this.activeMutation;
    if (activeMutation?.reason === 'seek') {
      // Same expected-teardown race degrade() guards against: a stream error
      // can surface from the server tearing down this generation to honor an
      // in-flight seek PATCH, indistinguishable at the moment it arrives from
      // a genuine fatal failure. Unlike degrade(), a fatal error must always
      // end up recovered or shown — never silently dropped — so instead of a
      // bare early return, wait for the mutation to settle and judge from
      // what actually happened: if it replaced the source, this error was
      // about a generation already gone and is dropped as stale; otherwise
      // it's handled exactly as if this guard were never here.
      const failingSource = this.snapshot.session ?? this.serverSession;
      void activeMutation.settled.then(() => {
        if (this.disposed || this.snapshot.fatalError) return;
        const current = this.snapshot.session ?? this.serverSession;
        if (failingSource && current && sourceIdentity(failingSource) !== sourceIdentity(current)) {
          this.log.debug('stream-error-superseded-by-seek', { sessionId: failingSource.sessionId, error: fatalError });
          return;
        }
        this.failNow(fatalError);
      });
      return;
    }
    this.failNow(fatalError);
  }

  private failNow(fatalError: Error): void {
    const failedSession = this.snapshot.session ?? this.serverSession;
    if (failedSession && this.options.resolver.failover && isEndpointRetryablePlaybackFailure(fatalError) && !this.failoverPromise) {
      this.failoverPromise = this.recoverFromSourceFailure(failedSession, fatalError).finally(() => {
        this.failoverPromise = undefined;
      });
      return;
    }
    this.failTerminal(fatalError);
  }

  private beginSupersededCleanup(cleanup: NonNullable<PlaybackCoordinator['supersededCleanup']>): void {
    if (this.supersededCleanup !== cleanup || cleanup.timer !== undefined) return;
    const attempt = () => {
      if (this.disposed || this.supersededCleanup !== cleanup) return;
      cleanup.timer = undefined;
      void this.options.resolver.stop(cleanup.oldSessionId).then(() => {
        if (this.supersededCleanup === cleanup) this.supersededCleanup = undefined;
        this.log.info('superseded-session-closed', { sessionId: cleanup.oldSessionId, attempts: cleanup.attempt + 1 });
      }).catch((error) => {
        if (this.disposed || this.supersededCleanup !== cleanup) return;
        cleanup.attempt += 1;
        const delayMs = Math.min(30_000, 1_000 * (2 ** Math.min(cleanup.attempt - 1, 5)));
        this.log.warn('superseded-session-close-retry', {
          sessionId: cleanup.oldSessionId,
          attempt: cleanup.attempt + 1,
          delayMs,
          error,
        });
        cleanup.timer = setTimeout(attempt, delayMs);
      });
    };
    attempt();
  }

  private async recoverFromSourceFailure(failedSession: PlaybackSession, error: Error): Promise<void> {
    const requestedPositionMs = this.snapshot.intent.positionMs;
    const requestedPositionRevision = this.positionRevision;
    this.log.warn('source-failover-start', {
      sessionId: failedSession.sessionId,
      endpoint: failedSession.endpoint,
      requestedPositionMs,
      error,
    });
    this.patchSnapshot({ preparingSource: true, notice: undefined });
    try {
      await Promise.all([...this.alternatePreparations].map((preparation) => preparation.catch(() => undefined)));
      const preparedAlternate = [...this.alternateSessions.values()].find((alternate) => (
          alternate.mediaId === failedSession.mediaId
          && alternate.mode === failedSession.mode
          && alternate.endpoint?.id !== failedSession.endpoint?.id
        ));
      const capabilities = await this.options.capabilities();
      if (this.disposed) return;
      const next = await this.options.resolver.failover!(
        failedSession,
        this.options.media,
        capabilities,
        requestedPositionMs,
        this.currentPreferences(failedSession),
        preparedAlternate,
      );
      if (this.disposed) {
        await this.options.resolver.stop(next.sessionId).catch(() => undefined);
        return;
      }
      this.serverSession = next;
      this.alternateSessions.delete(next.sessionId);
      const alternateExpiry = this.alternateExpiryTimers.get(next.sessionId);
      if (alternateExpiry !== undefined) clearTimeout(alternateExpiry);
      this.alternateExpiryTimers.delete(next.sessionId);
      const currentDesired = this.snapshot.intent.positionMs;
      const userMovedDuringRequest = requestedPositionRevision !== this.positionRevision;
      if (userMovedDuringRequest && this.activationPosition(next, currentDesired, requestedPositionMs) === undefined) {
        this.queueMutation({
          reason: 'seek',
          update: { seekMs: currentDesired, preferences: preservedSeekPreferences(next) },
        });
      } else {
        this.activateSession(next, currentDesired, requestedPositionMs);
      }
      this.supersededCleanup = {
        oldSessionId: failedSession.sessionId,
        newSessionId: next.sessionId,
        attempt: 0,
      };
      this.log.info('source-failover-ready', {
        oldSessionId: failedSession.sessionId,
        newSessionId: next.sessionId,
        endpoint: next.endpoint,
        positionMs: currentDesired,
      });
      this.patchSnapshot({ preparingSource: false, notice: undefined });
    } catch (failoverError) {
      if (this.disposed) return;
      this.log.error('source-failover-exhausted', { failedSessionId: failedSession.sessionId, error: failoverError });
      this.failTerminal(failoverError instanceof Error ? failoverError : error);
    }
  }

  private failTerminal(fatalError: Error): void {
    if (this.disposed || this.snapshot.fatalError) return;
    this.log.error('fatal', fatalError);
    this.patchSnapshot({ fatalError, notice: undefined, starting: false, preparingSource: false });
  }

  private patchSnapshot(patch: Partial<PlaybackCoordinatorSnapshot>): void {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener(this.getSnapshot());
  }
}

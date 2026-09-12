import type { EndpointRegistry, MachaEndpoint } from '../cluster/EndpointRegistry.js';
import { endpointFailure, isPerTitleFailure, retryableEndpointFailure } from '../cluster/endpointFailure.js';
import { createClientLogger } from '../diagnostics/ClientLog.js';
import { ClusterEndpointRouter } from '../cluster/endpointRouting.js';
import type { MediaSummary, PlaybackCapabilities } from '../types.js';
import { MachaPlaybackResolver, newPlaybackIdempotencyKey } from './MachaPlaybackResolver.js';
import { NO_AUTH, type AuthenticatedFetch } from '../api/SessionManager.js';
import type {
  PlaybackPreferencesUpdate,
  PlaybackResolver,
  PlaybackSession,
  PlaybackStopOptions,
  PlaybackUpdate,
} from './PlaybackResolver.js';

interface OwnedSession {
  endpoint: MachaEndpoint;
  resolver: MachaPlaybackResolver;
  nodeSessionId: string;
}

function awaitWithEndpointDeadline<T>(request: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => finish(() => reject(Object.assign(
      new Error(`Playback generation attempt exceeded ${timeoutMs} ms.`),
      { status: 504, code: 'client_endpoint_deadline' },
    ))), timeoutMs);
    // A deadline abandons only the local wait. The HTTP operation remains
    // independent and observed, avoiding client-generated request cancellation.
    request.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

/** Creates disposable playback generations on any suitable bootstrap endpoint. */
/**
 * Carry the carriage a failed generation was actually served with into its
 * replacement.
 *
 * `container` is not among a session's confirmed preferences, so a replacement
 * built from those asks for whatever the node defaults to. A set that had asked
 * for MPEG-TS is then handed fragmented MP4 by every replacement node — the one
 * carriage it cannot play — and a native player given that fetches nothing and
 * reports nothing, so each silent starvation is charged to a healthy node until
 * the candidate list is empty.
 *
 * `PlaybackCoordinator` already restates it on the paths it owns. This is the
 * same fix one layer down, where **every** consumer passes rather than only the
 * three that drive the coordinator — a fix landing in the coordinator reaches
 * three of four clients and silently misses the fourth.
 *
 * It deliberately uses `output.container` — what the node *served* — rather
 * than what the instruction asked for. Those agree until they do not, and a
 * node answering with something other than what was requested is precisely the
 * case a failover is most likely to be recovering from. The replacement should
 * match reality, not intent.
 *
 * Absent or unrecognised leaves the preferences untouched: a node that does not
 * report its container gives no grounds to choose one, and today's behaviour is
 * the right no-op. `direct` is skipped because copying passes the file through
 * whole and has no step at which a container could be chosen.
 */
function withServedSegmentContainer(
  preferences: PlaybackPreferencesUpdate,
  failedSession: PlaybackSession,
): PlaybackPreferencesUpdate {
  if (preferences.container !== undefined) return preferences;
  const mode = preferences.mode ?? failedSession.mode;
  if (mode !== 'remux' && mode !== 'transcode') return preferences;
  const served = failedSession.output?.container?.trim().toLowerCase();
  if (served !== 'fmp4' && served !== 'mpegts') return preferences;
  return { ...preferences, container: served };
}

export class ClusterPlaybackResolver implements PlaybackResolver {
  readonly available = true;
  private readonly log = createClientLogger('playback.cluster');
  private readonly resolvers = new Map<string, MachaPlaybackResolver>();
  private readonly sessions = new Map<string, OwnedSession>();
  private failedGenerationEndpoints = new Set<string>();
  private readonly registry: EndpointRegistry;

  constructor(
    routerOrRegistry: ClusterEndpointRouter | EndpointRegistry,
    private readonly auth: AuthenticatedFetch = NO_AUTH,
    private readonly generationAttemptTimeoutMs = 12_000,
  ) {
    this.registry = routerOrRegistry instanceof ClusterEndpointRouter
      ? routerOrRegistry.registry
      : routerOrRegistry;
  }

  async resolve(
    media: MediaSummary,
    capabilities: PlaybackCapabilities,
    seekMs?: number,
    preferences?: PlaybackPreferencesUpdate,
  ): Promise<PlaybackSession> {
    this.failedGenerationEndpoints = new Set();
    return this.create(media, capabilities, seekMs, preferences, new Set(), true, this.generationAttemptTimeoutMs);
  }

  async failover(
    failedSession: PlaybackSession,
    media: MediaSummary,
    capabilities: PlaybackCapabilities,
    seekMs: number,
    preferences: PlaybackPreferencesUpdate,
    preparedAlternate?: PlaybackSession,
  ): Promise<PlaybackSession> {
    // Shares the exact bookkeeping PlaybackCoordinator calls explicitly for a
    // silent (no-reload) transition — see recordEndpointFailure below — so
    // "an endpoint just failed" is recorded identically regardless of which
    // path noticed it, rather than two independent inline copies drifting.
    if (failedSession.endpoint) this.recordEndpointFailure(failedSession.endpoint.id);
    this.releaseFailedSession(failedSession);
    if (preparedAlternate) {
      const owned = this.sessions.get(preparedAlternate.sessionId);
      if (owned
        && owned.endpoint.id !== failedSession.endpoint?.id
        && preparedAlternate.mediaId === failedSession.mediaId) {
        this.registry.recordSuccess(owned.endpoint.id);
        return preparedAlternate;
      }
    }
    return this.create(
      media,
      capabilities,
      seekMs,
      withServedSegmentContainer(preferences, failedSession),
      this.failedGenerationEndpoints,
      true,
      this.generationAttemptTimeoutMs,
    );
  }

  /**
   * Close the session being failed away from, without waiting for it.
   *
   * The decision to abandon it is made here, so closing it belongs here. A
   * caller asked to fail over, not to end up holding two sessions — and every
   * consumer of `failover` has this exposure, not only the ones driving a
   * coordinator that happens to do its own superseded cleanup.
   *
   * What skipping it costs: a node counts a session against
   * `max_video_transcodes` from admission until the session record is erased,
   * which is `session_idle` — **30 minutes** — and reclaiming the idle pipeline
   * at 60 s does not release it. With one slot per node, failing away from a
   * node that is alive but slow closes it to every other viewer's transcode
   * for half an hour, and the viewer who caused it is the one person who
   * cannot observe it.
   *
   * **Never awaited, and never allowed to fail the failover.** A slow node is
   * exactly where failover fires, so awaiting this would hang the recovery it
   * is part of. Sessions are node-local and a `DELETE` for an id a node does
   * not hold answers a bare `404`, which `stop()` already treats as success —
   * so there is no need to decide first whether the node is still alive, and
   * racing a coordinator's own superseded cleanup is harmless rather than a
   * conflict.
   */
  private releaseFailedSession(failedSession: PlaybackSession): void {
    void this.stop(failedSession.sessionId).catch(() => undefined);
  }

  async prepareAlternate(
    activeSession: PlaybackSession,
    media: MediaSummary,
    capabilities: PlaybackCapabilities,
    seekMs: number,
    preferences: PlaybackPreferencesUpdate,
  ): Promise<PlaybackSession | undefined> {
    if (!activeSession.endpoint) return undefined;
    const excluded = new Set(this.failedGenerationEndpoints);
    excluded.add(activeSession.endpoint.id);
    try {
      const alternate = await this.create(
        media,
        capabilities,
        seekMs,
        { ...preferences, mode: activeSession.mode === 'direct' ? 'direct' : preferences.mode },
        excluded,
        false,
        this.generationAttemptTimeoutMs,
      );
      if (alternate.mode === activeSession.mode) return alternate;
      await this.stop(alternate.sessionId).catch(() => undefined);
      return undefined;
    } catch {
      // Standby preparation is opportunistic and must never become a viewer
      // failure or alter the already-playing primary generation.
      return undefined;
    }
  }

  private async create(
    media: MediaSummary,
    capabilities: PlaybackCapabilities,
    seekMs: number | undefined,
    preferences: PlaybackPreferencesUpdate | undefined,
    excluded: ReadonlySet<string>,
    preferOnSuccess: boolean,
    attemptTimeoutMs?: number,
  ): Promise<PlaybackSession> {
    let lastError: unknown;
    const idempotencyKey = newPlaybackIdempotencyKey();
    for (const { endpoint } of this.registry.candidates(excluded)) {
      const resolver = this.resolver(endpoint);
      this.log.info('generation-attempt', {
        endpointId: endpoint.id,
        endpoint: endpoint.baseUrl,
        mediaId: media.id,
        seekMs: seekMs ?? 0,
        standby: !preferOnSuccess,
      });
      try {
        const request = resolver.resolve(media, capabilities, seekMs, preferences, undefined, idempotencyKey);
        const session = attemptTimeoutMs
          ? await awaitWithEndpointDeadline(request, attemptTimeoutMs)
          : await request;
        session.endpoint = { id: endpoint.id, baseUrl: endpoint.baseUrl };
        const nodeSessionId = session.sessionId;
        session.sessionId = `${endpoint.id}::${encodeURIComponent(nodeSessionId)}`;
        this.sessions.set(session.sessionId, { endpoint, resolver, nodeSessionId });
        if (preferOnSuccess) this.registry.recordSuccess(endpoint.id);
        else this.registry.recordProbeSuccess(endpoint.id);
        return session;
      } catch (error) {
        if (!retryableEndpointFailure(error)) throw error;
        this.log.warn('generation-attempt-failed', {
          endpointId: endpoint.id,
          endpoint: endpoint.baseUrl,
          mediaId: media.id,
          standby: !preferOnSuccess,
          error,
        });
        if (!isPerTitleFailure(error)) this.registry.recordFailure(endpoint.id);
        lastError = endpointFailure(endpoint.id, endpoint.baseUrl, error);
      }
    }
    throw lastError ?? new Error('No untried Macha playback endpoint remains.');
  }

  async update(sessionId: string, update: PlaybackUpdate, signal?: AbortSignal): Promise<PlaybackSession> {
    const owned = this.sessions.get(sessionId);
    if (!owned) throw new Error(`Playback generation ${sessionId} has no endpoint provenance.`);
    try {
      const session = await owned.resolver.update(owned.nodeSessionId, update, signal);
      const nodeSessionId = session.sessionId;
      session.sessionId = sessionId;
      session.endpoint = { id: owned.endpoint.id, baseUrl: owned.endpoint.baseUrl };
      owned.nodeSessionId = nodeSessionId;
      this.registry.recordSuccess(owned.endpoint.id);
      return session;
    } catch (error) {
      // Superseded client intent is not evidence that the owning node failed.
      if (signal?.aborted) throw signal.reason ?? error;
      if (retryableEndpointFailure(error) && !isPerTitleFailure(error)) this.registry.recordFailure(owned.endpoint.id);
      throw endpointFailure(owned.endpoint.id, owned.endpoint.baseUrl, error);
    }
  }

  async stop(sessionId: string, options?: PlaybackStopOptions): Promise<void> {
    const owned = this.sessions.get(sessionId);
    if (!owned) return;
    try {
      await owned.resolver.stop(owned.nodeSessionId, options);
      this.sessions.delete(sessionId);
    } catch (error) {
      if (retryableEndpointFailure(error) && !isPerTitleFailure(error)) this.registry.recordFailure(owned.endpoint.id);
      throw endpointFailure(owned.endpoint.id, owned.endpoint.baseUrl, error);
    }
  }

  recordEndpointFailure(endpointId: string): void {
    this.failedGenerationEndpoints.add(endpointId);
    this.registry.recordFailure(endpointId);
  }

  private resolver(endpoint: MachaEndpoint): MachaPlaybackResolver {
    let resolver = this.resolvers.get(endpoint.id);
    if (!resolver) {
      resolver = new MachaPlaybackResolver(endpoint.baseUrl, this.auth);
      this.resolvers.set(endpoint.id, resolver);
    }
    return resolver;
  }
}

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
    if (preparedAlternate) {
      const owned = this.sessions.get(preparedAlternate.sessionId);
      if (owned
        && owned.endpoint.id !== failedSession.endpoint?.id
        && preparedAlternate.mediaId === failedSession.mediaId) {
        this.registry.recordSuccess(owned.endpoint.id);
        return preparedAlternate;
      }
    }
    return this.create(media, capabilities, seekMs, preferences, this.failedGenerationEndpoints, true, this.generationAttemptTimeoutMs);
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

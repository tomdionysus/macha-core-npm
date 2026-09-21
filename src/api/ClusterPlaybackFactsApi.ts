import type { EndpointRegistry, MachaEndpoint } from '../cluster/EndpointRegistry.js';
import { ClusterEndpointRouter } from '../cluster/endpointRouting.js';
import { isPerTitleFailure, retryableEndpointFailure } from '../cluster/endpointFailure.js';
import { MachaPlaybackFactsApi } from './MachaPlaybackFactsApi.js';
import type { PlaybackFactsApi, PlaybackMediaFacts } from './PlaybackFactsApi.js';
import { NO_AUTH, type AuthenticatedFetch } from './SessionManager.js';
import { abortError } from '../errors.js';

/**
 * Playback facts from whichever endpoint is currently preferred, resolved per
 * call.
 *
 * Resolving per call is the whole point, not an implementation detail.
 * `operations` describes what *one node's build* can perform, so a client
 * that binds an endpoint once and reuses it will eventually reason about a
 * node that is not the one executing the instruction. During a partial
 * cluster upgrade — some nodes fixed, some not — that produces a chooser
 * confidently reading the wrong node's abilities and instructing a copy the
 * executing node will refuse, which is exactly the failure the operations
 * gate exists to prevent, reappearing one level up.
 *
 * Prefer this over constructing `MachaPlaybackFactsApi` against a fixed base
 * URL, unless the host genuinely has one endpoint and always will.
 */
export class ClusterPlaybackFactsApi implements PlaybackFactsApi {
  private readonly apis = new Map<string, MachaPlaybackFactsApi>();
  private readonly router: ClusterEndpointRouter;

  constructor(
    routerOrRegistry: ClusterEndpointRouter | EndpointRegistry,
    private readonly auth: AuthenticatedFetch = NO_AUTH,
  ) {
    this.router = routerOrRegistry instanceof ClusterEndpointRouter
      ? routerOrRegistry
      : new ClusterEndpointRouter(routerOrRegistry);
  }

  /**
   * Tries each candidate in turn, treating a 404 as "this node cannot answer"
   * rather than as a final result.
   *
   * The router's normal rule is that a 404 is terminal, which is right for a
   * missing resource and wrong here: a node whose build predates the facts
   * endpoint answers 404 for *every* media. During a partial cluster upgrade
   * that would make the facts unavailable whenever the preferred node happens
   * to be an older one — and unavailable facts mean the chooser falls back to
   * transcoding everything, silently.
   *
   * Continuing costs at most one request per node, because media that
   * genuinely does not exist answers 404 everywhere and the loop still ends
   * with that answer.
   */
  async facts(ref: { itemId?: string; mediaId?: string }, signal?: AbortSignal): Promise<PlaybackMediaFacts[]> {
    let lastError: unknown;
    let attempted = 0;
    for (const { endpoint } of this.router.registry.candidates()) {
      if (signal?.aborted) throw signal.reason ?? abortError();
      attempted += 1;
      try {
        const facts = await this.api(endpoint).facts(ref, signal);
        this.router.registry.recordSuccess(endpoint.id);
        return facts;
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        if (status !== 404 && !retryableEndpointFailure(error)) throw error;
        // One unreadable extent is a fact about the title, not about the node
        // — the same guard `ClusterPlaybackResolver.create` has. Without it a
        // single bad file demoted the node for every other title on it.
        if (status !== 404 && !isPerTitleFailure(error)) this.router.registry.recordFailure(endpoint.id);
        lastError = error;
      }
    }
    if (attempted === 0) throw new Error('No Macha API endpoint is configured.');
    throw lastError;
  }

  private api(endpoint: MachaEndpoint): MachaPlaybackFactsApi {
    let api = this.apis.get(endpoint.id);
    if (!api) {
      api = new MachaPlaybackFactsApi(endpoint.baseUrl, this.auth);
      this.apis.set(endpoint.id, api);
    }
    return api;
  }
}

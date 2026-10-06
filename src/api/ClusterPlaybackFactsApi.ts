import type { EndpointRegistry, MachaEndpoint } from '../cluster/EndpointRegistry.js';
import { ClusterEndpointRouter } from '../cluster/endpointRouting.js';
import { failureBlamesEndpoint, noEndpointError, retryableEndpointFailure } from '../cluster/endpointFailure.js';
import { MachaPlaybackFactsApi } from './MachaPlaybackFactsApi.js';
import type { PlaybackFactsApi, PlaybackFactsReport, PlaybackMediaFacts } from './PlaybackFactsApi.js';
import { NO_AUTH, type AuthenticatedFetch } from './SessionManager.js';
import { abortError } from '../errors.js';

/**
 * The waits between tries of one facts lookup before it gives up. Tom,
 * 2026-10-04: "Retry bounded, then decide without facts", and 2026-10-06: in
 * core's facts lookup itself, so playback and downloads on every client get
 * it, not only a start through `PlaybackCoordinator`. Two retries, about
 * 1.3 s in all on top of the requests, ride out a blip or a session that had
 * not quite arrived. A choice, not a measurement.
 */
export const FACTS_RETRY_DELAYS_MS: readonly number[] = [250, 1000];

/**
 * Playback facts from whichever endpoint is currently preferred, resolved per
 * call.
 *
 * Resolving per call is the whole point, not an implementation detail.
 * `operations` describes what *one node's build* can perform, so a client
 * that binds an endpoint once and reuses it will eventually reason about a
 * node that is not the one executing the instruction. During a partial
 * cluster upgrade (some nodes fixed, some not) that produces a chooser
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
   * to be an older one, and unavailable facts mean the chooser falls back to
   * transcoding everything, silently.
   *
   * Continuing costs at most one request per node, because media that
   * genuinely does not exist answers 404 everywhere and the loop still ends
   * with that answer.
   */
  async facts(ref: { itemId?: string; mediaId?: string }, signal?: AbortSignal): Promise<PlaybackMediaFacts[]> {
    return (await this.factsReport(ref, signal)).files;
  }

  /**
   * As `facts`, and then, where the answering node could not read some of the
   * item's files, the same question of the remaining nodes for those.
   *
   * A file one node cannot read in time another often can: fi-1 fetches
   * nearly every extent from gbni-1 over the WAN, so its probe of a large
   * file can time out where gbni-1's answers at once. The first answer
   * decides the item; a later node only fills in the files the earlier ones
   * listed as unavailable, and a node that fails outright is passed over.
   * What no node could read stays in `unavailable`, with the last reason.
   */
  async factsReport(ref: { itemId?: string; mediaId?: string }, signal?: AbortSignal): Promise<PlaybackFactsReport> {
    // Retried while the walk fails for a reason a moment may cure. A `404`
    // from every node is an answer (the media is not there), and a refusal
    // no node would change is final, so neither is retried.
    for (let retry = 0; ; retry += 1) {
      try {
        return await this.walk(ref, signal);
      } catch (error) {
        const wait = FACTS_RETRY_DELAYS_MS[retry];
        const status = (error as { status?: unknown }).status;
        if (wait === undefined || signal?.aborted || status === 404 || !retryableEndpointFailure(error)) throw error;
        await delay(wait, signal);
      }
    }
  }

  private async walk(ref: { itemId?: string; mediaId?: string }, signal?: AbortSignal): Promise<PlaybackFactsReport> {
    const candidates = this.router.registry.candidates().map(({ endpoint }) => endpoint);
    let lastError: unknown;
    let attempted = 0;
    for (const [position, endpoint] of candidates.entries()) {
      if (signal?.aborted) throw signal.reason ?? abortError();
      attempted += 1;
      try {
        const report = await this.api(endpoint).factsReport(ref, signal);
        this.router.registry.recordSuccess(endpoint.id);
        return await this.fillUnavailable(report, candidates.slice(position + 1), signal);
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        if (status !== 404 && !retryableEndpointFailure(error)) throw error;
        // One unreadable extent is a fact about the title, not about the node,
        // the same guard `ClusterPlaybackResolver.create` has. Without it a
        // single bad file demoted the node for every other title on it.
        if (status !== 404 && failureBlamesEndpoint(error)) this.router.registry.recordFailure(endpoint.id);
        lastError = error;
      }
    }
    if (attempted === 0) throw noEndpointError(this.router.registry);
    throw lastError;
  }

  private async fillUnavailable(report: PlaybackFactsReport, rest: readonly MachaEndpoint[], signal?: AbortSignal): Promise<PlaybackFactsReport> {
    let { files, unavailable } = report;
    for (const endpoint of rest) {
      if (unavailable.length === 0 || signal?.aborted) break;
      const missing = unavailable;
      const answers = await Promise.all(missing.map((file) => this.api(endpoint).factsReport({ mediaId: file.mediaId }, signal)
        .then((answer) => ({ file, answer }), () => ({ file, answer: undefined }))));
      const found = answers.flatMap(({ answer }) => answer?.files ?? []);
      files = [...files, ...found.filter((file) => !files.some((known) => known.mediaId === file.mediaId))];
      unavailable = answers.flatMap(({ file, answer }) => {
        if (answer?.files.some((candidate) => candidate.mediaId === file.mediaId)) return [];
        return [answer?.unavailable.find((candidate) => candidate.mediaId === file.mediaId) ?? file];
      });
    }
    return { files, unavailable };
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

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    const cancel = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? abortError());
    };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

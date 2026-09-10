import type { EndpointRegistry, MachaEndpoint } from './EndpointRegistry.js';
import { endpointFailure, isPerTitleFailure, retryableEndpointFailure, unreachableEndpointFailure } from './endpointFailure.js';
import { reportClusterReachable, SERVER_UNREACHABLE_MESSAGE } from '../api/serverConnection.js';
import { createClientLogger } from '../diagnostics/ClientLog.js';
import { abortError } from '../errors.js';

export type EndpointOperation<T> = (endpoint: MachaEndpoint) => Promise<T>;

const log = createClientLogger('cluster.routing');

export class MachaClusterRouteError extends Error {
  constructor(public readonly endpointIds: readonly string[], public readonly unreachable: boolean, public readonly cause?: unknown) {
    super(unreachable ? SERVER_UNREACHABLE_MESSAGE : 'All configured Macha API endpoints failed.');
    this.name = 'MachaClusterRouteError';
  }
}

/**
 * One routing authority shared by every client API family.
 *
 * Real successful work makes that endpoint authoritative through
 * EndpointRegistry.recordSuccess(). Background probes deliberately use
 * recordProbeSuccess(), so they can update health without stealing authority.
 */
export class ClusterEndpointRouter {
  constructor(readonly registry: EndpointRegistry) {}

  /**
   * A safe read, walking candidates until one answers.
   *
   * `signal` cancels the walk, not just the in-flight attempt: without it a
   * caller that has gone away — a screen unmounted mid-load — still pays for
   * every remaining candidate before the result is discarded. Cancellation is
   * client intent and never endpoint evidence, so an abort records no failure
   * against any node.
   */
  request<T>(operation: EndpointOperation<T>, signal?: AbortSignal): Promise<T> {
    return this.route(operation, signal);
  }

  mutation<T>(operation: EndpointOperation<T>): Promise<T> {
    const endpoint = this.registry.candidates()[0]?.endpoint;
    if (!endpoint) return Promise.reject(new Error('No Macha API endpoint is configured.'));
    log.debug('mutation-attempt', { endpointId: endpoint.id });
    return operation(endpoint).then((result) => {
      this.registry.recordSuccess(endpoint.id);
      reportClusterReachable();
      log.debug('mutation-success', { endpointId: endpoint.id });
      return result;
    }, (error) => {
      const retryable = retryableEndpointFailure(error);
      if (retryable) this.registry.recordFailure(endpoint.id);
      // Mutations never retry another endpoint, so this is always terminal.
      log.warn('mutation-failed', { endpointId: endpoint.id, retryable });
      throw endpointFailure(endpoint.id, endpoint.baseUrl, error);
    });
  }

  /**
   * Work that belongs to one endpoint and cannot be moved.
   *
   * A playback session lives on the node that created it: a PATCH to any other
   * node addresses a session that does not exist there, so failing over is not
   * a fallback but a different and wrong request. That makes this a third
   * category rather than a stricter `mutation` — `mutation` picks the best
   * candidate and declines to retry, while this one has no choice to make.
   *
   * It exists so pinned work still feeds endpoint health. Calling a node's API
   * directly is the obvious alternative and silently costs the registry every
   * success and failure on the node doing the most work.
   *
   * A per-title failure — a file this node cannot read, a pipeline that would
   * not start — leaves the health record alone. It says nothing about the
   * node's ability to serve anything else, and with a small cluster and an
   * escalating cooldown a single unplayable file could otherwise empty the
   * candidate list.
   */
  pinned<T>(endpoint: MachaEndpoint, operation: EndpointOperation<T>): Promise<T> {
    log.debug('pinned-attempt', { endpointId: endpoint.id });
    return operation(endpoint).then((result) => {
      this.registry.recordSuccess(endpoint.id);
      reportClusterReachable();
      log.debug('pinned-success', { endpointId: endpoint.id });
      return result;
    }, (error: unknown) => {
      const perTitle = isPerTitleFailure(error);
      const retryable = retryableEndpointFailure(error);
      if (retryable && !perTitle) this.registry.recordFailure(endpoint.id);
      log.warn('pinned-failed', { endpointId: endpoint.id, retryable, perTitle });
      throw error;
    });
  }

  /**
   * `advisory` marks operations, such as artwork retrieval, whose success is
   * health evidence but must not steal API authority from normal work; both
   * an advisory hit and a temporary absence then use recordProbeSuccess().
   */
  async find<T>(
    operation: EndpointOperation<T | undefined>,
    signal?: AbortSignal,
    options?: { advisory?: boolean },
  ): Promise<T | undefined> {
    let lastError: unknown;
    let observedTemporaryAbsence = false;
    let allUnreachable = true;
    const attempted: string[] = [];
    for (const { endpoint } of this.registry.candidates()) {
      attempted.push(endpoint.id);
      log.debug('find-attempt', { endpointId: endpoint.id, order: attempted.length, advisory: Boolean(options?.advisory) });
      if (signal?.aborted) throw signal.reason ?? abortError();
      try {
        const result = await operation(endpoint);
        if (result !== undefined) {
          if (options?.advisory) this.registry.recordProbeSuccess(endpoint.id);
          else this.registry.recordSuccess(endpoint.id);
          reportClusterReachable();
          log.debug('find-success', { endpointId: endpoint.id });
          return result;
        }
        this.registry.recordProbeSuccess(endpoint.id);
        reportClusterReachable();
        log.debug('find-temporary-absence', { endpointId: endpoint.id });
        observedTemporaryAbsence = true;
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? abortError();
        if (!retryableEndpointFailure(error)) throw error;
        allUnreachable = allUnreachable && unreachableEndpointFailure(error);
        this.registry.recordFailure(endpoint.id);
        lastError = endpointFailure(endpoint.id, endpoint.baseUrl, error);
        log.debug('find-endpoint-failed', { endpointId: endpoint.id, unreachable: unreachableEndpointFailure(error) });
      }
    }
    // One reachable node explicitly saying "not available yet" is a valid
    // advisory result. Failures from other candidates must not turn it into an
    // application error or make optional metadata block playback.
    if (lastError && !observedTemporaryAbsence) {
      log.warn('find-exhausted', { attempted, allUnreachable });
      throw new MachaClusterRouteError(attempted, allUnreachable, lastError);
    }
    return undefined;
  }

  private async route<T>(operation: EndpointOperation<T>, signal?: AbortSignal): Promise<T> {
    let lastError: unknown;
    const attempted: string[] = [];
    let allUnreachable = true;
    for (const { endpoint } of this.registry.candidates()) {
      attempted.push(endpoint.id);
      log.debug('route-attempt', { endpointId: endpoint.id, order: attempted.length });
      if (signal?.aborted) throw signal.reason ?? abortError();
      try {
        const result = await operation(endpoint);
        this.registry.recordSuccess(endpoint.id);
        reportClusterReachable();
        log.debug('route-success', { endpointId: endpoint.id });
        return result;
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? abortError();
        if (!retryableEndpointFailure(error)) throw error;
        allUnreachable = allUnreachable && unreachableEndpointFailure(error);
        this.registry.recordFailure(endpoint.id);
        lastError = endpointFailure(endpoint.id, endpoint.baseUrl, error);
        log.debug('route-endpoint-failed', { endpointId: endpoint.id, unreachable: unreachableEndpointFailure(error) });
      }
    }
    if (lastError) {
      log.warn('route-exhausted', { attempted, allUnreachable });
      throw new MachaClusterRouteError(attempted, allUnreachable, lastError);
    }
    throw new Error('No Macha API endpoint is configured.');
  }
}

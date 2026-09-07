import type { EndpointRegistry, MachaEndpoint } from './EndpointRegistry.js';
import { endpointFailure, retryableEndpointFailure, unreachableEndpointFailure } from './endpointFailure.js';
import { reportClusterReachable, SERVER_UNREACHABLE_MESSAGE } from '../api/serverConnection.js';
import { createClientLogger } from '../diagnostics/ClientLog.js';

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

  request<T>(operation: EndpointOperation<T>): Promise<T> {
    return this.route(operation);
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
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
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
        if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
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

  private async route<T>(operation: EndpointOperation<T>): Promise<T> {
    let lastError: unknown;
    const attempted: string[] = [];
    let allUnreachable = true;
    for (const { endpoint } of this.registry.candidates()) {
      attempted.push(endpoint.id);
      log.debug('route-attempt', { endpointId: endpoint.id, order: attempted.length });
      try {
        const result = await operation(endpoint);
        this.registry.recordSuccess(endpoint.id);
        reportClusterReachable();
        log.debug('route-success', { endpointId: endpoint.id });
        return result;
      } catch (error) {
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

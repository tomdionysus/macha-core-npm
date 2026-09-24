import type { EndpointRegistry, MachaEndpoint } from './EndpointRegistry.js';
import { endpointFailure, failureBlamesEndpoint, isPerTitleFailure, retryableEndpointFailure, unreachableEndpointFailure } from './endpointFailure.js';
import { reportClusterReachable } from '../api/serverConnection.js';
import { createClientLogger } from '../diagnostics/ClientLog.js';
import { abortError } from '../errors.js';

export type EndpointOperation<T> = (endpoint: MachaEndpoint) => Promise<T>;

const log = createClientLogger('cluster.routing');

export class MachaClusterRouteError extends Error {
  constructor(public readonly endpointIds: readonly string[], public readonly unreachable: boolean, public readonly cause?: unknown) {
    super(unreachable ? 'No configured Macha API endpoint could be reached.' : 'All configured Macha API endpoints failed.');
    this.name = 'MachaClusterRouteError';
  }
}

/**
 * How a `find` walk that produced nothing ended.
 *
 * `find` answers `undefined` both when every node said "not here yet" and when
 * some said that while another failed — deliberately, so optional metadata
 * cannot be blocked by an unrelated node failure. For some callers those are
 * different answers: an absent media profile makes the chooser transcode
 * everything, silently, and "nobody has it" and "the node that might have had
 * it was broken" deserve different handling and at minimum different logs.
 *
 * Reported through a callback rather than in the return, so the callers that
 * do not care are unchanged.
 */
export interface FindAbsence {
  /** Every node asked, in the order they were asked. */
  attempted: readonly string[];
  /** Nodes that answered, and said the thing is not there yet. */
  absent: readonly string[];
  /** Nodes whose attempt failed in a way the walk tolerated and moved past. */
  failed: readonly string[];
  /** True when every node asked answered absence and none failed. */
  unanimous: boolean;
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
   *
   * `advisory` is for a read whose outcome is health evidence but which is not
   * a claim on API authority — the ten-second cluster status call is the case
   * it exists for. Control work must not reshuffle the endpoint the viewer's
   * media is flowing through: a status timeout would otherwise un-stick the
   * preferred node, and a status success elsewhere would steal preference from
   * it, both on a schedule nobody asked for.
   *
   * **Stronger than `find`'s advisory, deliberately.** There an advisory hit
   * records probe success but a failure is still recorded as a failure,
   * because artwork is a real request a viewer is waiting on and a node that
   * cannot serve it has failed real work. Nothing routed here is waited on by
   * anyone, so both directions use the probe variants.
   */
  request<T>(operation: EndpointOperation<T>, signal?: AbortSignal, options?: { advisory?: boolean }): Promise<T> {
    return this.route(operation, signal, options);
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
      const blames = failureBlamesEndpoint(error, { pinned: true });
      if (retryable && blames) this.registry.recordFailure(endpoint.id);
      log.warn('pinned-failed', { endpointId: endpoint.id, retryable, perTitle, blames });
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
    options?: { advisory?: boolean; onAbsence?: (absence: FindAbsence) => void },
  ): Promise<T | undefined> {
    let lastError: unknown;
    let observedTemporaryAbsence = false;
    let allUnreachable = true;
    const attempted: string[] = [];
    const absent: string[] = [];
    const failed: string[] = [];
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
        absent.push(endpoint.id);
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? abortError();
        if (!retryableEndpointFailure(error)) throw error;
        allUnreachable = allUnreachable && unreachableEndpointFailure(error);
        this.registry.recordFailure(endpoint.id);
        failed.push(endpoint.id);
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
    // Only on the way to answering `undefined`: a caller asks for this to tell
    // "nobody has it" from "the node that might have had it was broken", and
    // that question does not arise when the walk found the thing.
    options?.onAbsence?.({
      attempted,
      absent,
      failed,
      unanimous: failed.length === 0 && absent.length === attempted.length && attempted.length > 0,
    });
    return undefined;
  }

  private async route<T>(operation: EndpointOperation<T>, signal?: AbortSignal, options?: { advisory?: boolean }): Promise<T> {
    let lastError: unknown;
    const attempted: string[] = [];
    let allUnreachable = true;
    const advisory = Boolean(options?.advisory);
    for (const { endpoint } of this.registry.candidates()) {
      attempted.push(endpoint.id);
      log.debug('route-attempt', { endpointId: endpoint.id, order: attempted.length, advisory });
      if (signal?.aborted) throw signal.reason ?? abortError();
      try {
        const result = await operation(endpoint);
        if (advisory) this.registry.recordProbeSuccess(endpoint.id);
        else this.registry.recordSuccess(endpoint.id);
        reportClusterReachable();
        log.debug('route-success', { endpointId: endpoint.id });
        return result;
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? abortError();
        if (!retryableEndpointFailure(error)) throw error;
        allUnreachable = allUnreachable && unreachableEndpointFailure(error);
        if (advisory) this.registry.recordProbeFailure(endpoint.id);
        else this.registry.recordFailure(endpoint.id);
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

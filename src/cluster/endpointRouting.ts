import type { EndpointCandidate, EndpointRegistry, MachaEndpoint } from './EndpointRegistry.js';
import { machaHost } from '../runtime/host.js';
import { endpointFailure, failureBlamesEndpoint, isPerTitleFailure, MachaClusterRouteError, mutationOutcomeUnknown, noEndpointError, retryableEndpointFailure, unreachableEndpointFailure } from './endpointFailure.js';
import { MachaRequestTimeoutError, reportClusterReachable } from '../api/serverConnection.js';
import { createClientLogger } from '../diagnostics/ClientLog.js';
import { abortError } from '../errors.js';

export type EndpointOperation<T> = (endpoint: MachaEndpoint) => Promise<T>;

const log = createClientLogger('cluster.routing');

/**
 * How long after a write the reads and writes that follow go to the node that
 * took it, while it stays in good standing.
 *
 * From server 0.90.0 a namespace change, a catalogue edit or a torrent job
 * request is answered by the node that took it and reaches the others a round
 * trip later. Reading back through that node is always consistent; through
 * another it may not be, and a ranking that moved in between sent a reload
 * there (Tom, 2026-10-05: build it). A few round trips with margin, a choice
 * rather than a measurement.
 */
export const READ_YOUR_WRITES_MS = 5_000;

/**
 * How a `find` walk that produced nothing ended.
 *
 * `find` answers `undefined` both when every node said "not here yet" and when
 * some said that while another failed, deliberately, so optional metadata
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
  /** The node that took the last write, and when; see `READ_YOUR_WRITES_MS`. */
  private lastWrite?: { endpointId: string; at: number };

  constructor(readonly registry: EndpointRegistry) {}

  /**
   * The registry's candidates, with the node that took a write in the last
   * `READ_YOUR_WRITES_MS` first, if it is ready, not lapsed and has not
   * failed since. Otherwise the registry's own order, untouched.
   */
  private candidatesAfterWrites(): EndpointCandidate[] {
    const candidates = this.registry.candidates();
    const write = this.lastWrite;
    if (!write || machaHost().now() - write.at >= READ_YOUR_WRITES_MS) return candidates;
    const index = candidates.findIndex(({ endpoint }) => endpoint.id === write.endpointId);
    if (index <= 0) return candidates;
    const writer = candidates[index]!;
    if (!writer.ready || writer.lapsed || writer.health.consecutiveFailures > 0) return candidates;
    log.debug('read-your-writes', { endpointId: writer.endpoint.id });
    return [writer, ...candidates.slice(0, index), ...candidates.slice(index + 1)];
  }

  private wrote(endpointId: string): void {
    this.lastWrite = { endpointId, at: machaHost().now() };
  }

  /**
   * A safe read, walking candidates until one answers.
   *
   * `signal` cancels the walk, not just the in-flight attempt: without it a
   * caller that has gone away (a screen unmounted mid-load) still pays for
   * every remaining candidate before the result is discarded. Cancellation is
   * client intent and never endpoint evidence, so an abort records no failure
   * against any node.
   *
   * `advisory` is for a read whose outcome is health evidence but which is not
   * a claim on API authority: the ten-second cluster status call is the case
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
   *
   * `holdOnTimeout` is for a read that makes the node do real work, such as
   * listing unmatched files. When a node in good standing (not `lapsed`)
   * runs out of time on it, the node is working, not gone: every node would
   * do the same work over the same catalogue, so the walk stops with a
   * `MachaClusterRouteError` whose `slow` is true, and records nothing
   * against the node. The web measured this: unmatched took 18 s on fi-1 and
   * then 2.3 s, and walking four nodes at 8 s each cost the viewer 35 s and
   * every node the same work (2026-10-01). A lapsed node's timeout still
   * walks on, as a refused connection does from any node.
   */
  request<T>(operation: EndpointOperation<T>, signal?: AbortSignal, options?: { advisory?: boolean; holdOnTimeout?: boolean }): Promise<T> {
    return this.route(operation, signal, options);
  }

  mutation<T>(operation: EndpointOperation<T>): Promise<T> {
    // A run of writes stays on one node too, so the second does not reach a
    // node that has not yet seen the first.
    const endpoint = this.candidatesAfterWrites()[0]?.endpoint;
    if (!endpoint) return Promise.reject(noEndpointError(this.registry));
    log.debug('mutation-attempt', { endpointId: endpoint.id });
    return operation(endpoint).then((result) => {
      this.registry.recordSuccess(endpoint.id);
      this.wrote(endpoint.id);
      reportClusterReachable();
      log.debug('mutation-success', { endpointId: endpoint.id });
      return result;
    }, (error) => {
      const retryable = retryableEndpointFailure(error);
      // A write that ran out of time was being done, not refused: the node
      // is charged nothing, and the caller learns the outcome is unknown
      // (`mutationOutcomeUnknown`) rather than that the write failed.
      if (mutationOutcomeUnknown(error)) {
        // It may have been done there, so a reload must ask there.
        this.wrote(endpoint.id);
        log.warn('mutation-outcome-unknown', { endpointId: endpoint.id });
        throw endpointFailure(endpoint.id, endpoint.baseUrl, error);
      }
      if (retryable && failureBlamesEndpoint(error)) this.registry.recordFailure(endpoint.id);
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
   * category rather than a stricter `mutation`: `mutation` picks the best
   * candidate and declines to retry, while this one has no choice to make.
   *
   * It exists so pinned work still feeds endpoint health. Calling a node's API
   * directly is the obvious alternative and silently costs the registry every
   * success and failure on the node doing the most work.
   *
   * A per-title failure (a file this node cannot read, a pipeline that would
   * not start) leaves the health record alone. It says nothing about the
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
        // Walked past either way; charged only when the failure is the node's.
        if (failureBlamesEndpoint(error)) this.registry.recordFailure(endpoint.id);
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

  private async route<T>(operation: EndpointOperation<T>, signal?: AbortSignal, options?: { advisory?: boolean; holdOnTimeout?: boolean }): Promise<T> {
    let lastError: unknown;
    const attempted: string[] = [];
    let allUnreachable = true;
    const advisory = Boolean(options?.advisory);
    // An advisory read is bookkeeping, not a reload of what was written.
    const candidates = advisory ? this.registry.candidates() : this.candidatesAfterWrites();
    for (const { endpoint, lapsed } of candidates) {
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
        if (options?.holdOnTimeout && !lapsed && error instanceof MachaRequestTimeoutError) {
          log.warn('route-slow', { endpointId: endpoint.id, attempted, timeoutMs: error.timeoutMs });
          throw new MachaClusterRouteError(attempted, false, endpointFailure(endpoint.id, endpoint.baseUrl, error), true);
        }
        if (!retryableEndpointFailure(error)) throw error;
        allUnreachable = allUnreachable && unreachableEndpointFailure(error);
        // Walked past either way; charged only when the failure is the node's.
        if (failureBlamesEndpoint(error)) {
          if (advisory) this.registry.recordProbeFailure(endpoint.id);
          else this.registry.recordFailure(endpoint.id);
        }
        lastError = endpointFailure(endpoint.id, endpoint.baseUrl, error);
        log.debug('route-endpoint-failed', { endpointId: endpoint.id, unreachable: unreachableEndpointFailure(error) });
      }
    }
    if (lastError) {
      log.warn('route-exhausted', { attempted, allUnreachable });
      throw new MachaClusterRouteError(attempted, allUnreachable, lastError);
    }
    throw noEndpointError(this.registry);
  }
}

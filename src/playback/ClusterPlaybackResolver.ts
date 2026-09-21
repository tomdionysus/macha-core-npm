import type { EndpointRegistry, MachaEndpoint } from '../cluster/EndpointRegistry.js';
import {
  endpointFailure,
  isAccountSessionLimit,
  failureBlamesEndpoint,
  playbackFailureCode,
  playbackFailureStatus,
  retryableEndpointFailure,
} from '../cluster/endpointFailure.js';
import { createClientLogger } from '../diagnostics/ClientLog.js';
import { ClusterEndpointRouter } from '../cluster/endpointRouting.js';
import type { MediaSummary, PlaybackCapabilities } from '../types.js';
import { MachaPlaybackError, MachaPlaybackResolver, newPlaybackIdempotencyKey } from './MachaPlaybackResolver.js';
import { NO_AUTH, type AuthenticatedFetch } from '../api/SessionManager.js';
import {
  generationAttemptBudgetMs,
  segmentHoldMs,
} from './PlaybackResolver.js';
import { machaHost } from '../runtime/host.js';
import type {
  PlaybackPreferencesUpdate,
  PlaybackResolver,
  PlaybackSession,
  PlaybackStopOptions,
  PlaybackUpdate,
} from './PlaybackResolver.js';

/**
 * How many times a session on a node that has just failed is asked to close.
 *
 * The DELETE usually goes to a node that is already gone, so one attempt is
 * not a policy. Bounded rather than open-ended because the node's own
 * `session_idle` reclaims the lease after thirty minutes and this ladder only
 * has to cover a node that comes back sooner than that — roughly half a
 * minute of it. Longer would be a timer nothing in this class can cancel.
 */
const FAILED_SESSION_CLOSE_ATTEMPTS = 5;
/** Per endpoint, because a node down for an hour would otherwise accumulate one per failover. */
const MAX_ABANDONED_RELEASES_PER_ENDPOINT = 8;
const FAILED_SESSION_CLOSE_BASE_DELAY_MS = 1_000;
const FAILED_SESSION_CLOSE_MAX_DELAY_MS = 16_000;

interface OwnedSession {
  endpoint: MachaEndpoint;
  resolver: MachaPlaybackResolver;
  nodeSessionId: string;
}

/**
 * Bounds the wait on one generation attempt, and hands back anything that
 * arrives after the deadline so the caller can dispose of it.
 *
 * The deadline abandons only the local wait: the HTTP operation is left
 * running and observed rather than cancelled, because a client-cancelled POST
 * tells the node nothing about whether it should keep the work. That is why
 * `onAbandoned` has to exist — a request left running is a request that can
 * still succeed, and a success nobody is waiting for is a session nobody will
 * ever close.
 */
function awaitWithEndpointDeadline<T>(
  request: Promise<T>,
  timeoutMs: number,
  onAbandoned: (value: T) => void,
): Promise<T> {
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
    request.then(
      (value) => {
        if (settled) {
          onAbandoned(value);
          return;
        }
        finish(() => resolve(value));
      },
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
 * Applies to the standby path as well as the replacement path: a generation
 * prepared ahead of time is asked for on the same terms as one created after
 * the fact, or the carriage a host needs goes missing through whichever of the
 * two nobody looked at.
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
  servingSession: PlaybackSession,
): PlaybackPreferencesUpdate {
  if (preferences.container !== undefined) return preferences;
  const mode = preferences.mode ?? servingSession.mode;
  if (mode !== 'remux' && mode !== 'transcode') return preferences;
  const served = servingSession.output?.container?.trim().toLowerCase();
  if (served !== 'fmp4' && served !== 'mpegts') return preferences;
  return { ...preferences, container: served };
}

/**
 * A generation this resolver has no record of.
 *
 * **Typed because the bare `Error` it replaces reached a television screen.**
 * It was thrown as prose — *"Playback generation 72baee93… has no endpoint
 * provenance."* — carrying no code and no status, so `playbackFailureCode` and
 * `playbackFailureStatus` both answered `undefined` and a host had nothing to
 * classify it by. It rendered verbatim, which is a sentence about core's
 * internal bookkeeping shown to somebody trying to watch a film.
 *
 * The condition itself is real and worth raising: the caller is holding a
 * generation id this resolver cannot act on, which after a re-resolution means
 * a handle that has been superseded. Acting on it would PATCH a generation the
 * viewer has already moved off. `stop` and `sessionAlive` recover the node
 * from the id instead, because closing or asking about a session is safe
 * whatever its state — mutating one is not.
 *
 * `detail` is what a host should show; `code` is what it should branch on.
 */
function unknownGeneration(sessionId: string): MachaPlaybackError {
  return new MachaPlaybackError(
    `Playback generation ${sessionId} has no endpoint provenance.`,
    undefined,
    'session_provenance_unknown',
    undefined,
    undefined,
    'This stream is no longer available. Start it again.',
  );
}

/**
 * Whether a standby can stand in for the generation it would replace.
 *
 * Same media on a different node were the only questions asked, and they are
 * not enough. A standby prepared as a remux cannot replace a transcode, and
 * two transformed generations reporting different segment containers hand the
 * device carriage it may not be able to play — the exact case
 * `withServedSegmentContainer` exists for, arriving through the standby door
 * rather than the fresh-create one.
 *
 * **Nor is the mode the whole of the transform.** `transcode` covers both a
 * generation copying an HEVC stream through untouched and one re-encoding it to
 * H264, and those are not substitutes for each other: swapping the first for
 * the second hands the viewer a re-encoded picture and takes a scarce
 * `max_video_transcodes` slot to produce it, with nothing anywhere reporting a
 * change. So the per-stream transforms are compared as well, from what each
 * node says it is doing rather than from what either was asked for.
 *
 * An unreported container is not a mismatch. A node that does not say what it
 * served gives no grounds to reject a standby that is otherwise right, and
 * refusing one costs a viewer a rescue that is already built and ready over a
 * fact nobody stated.
 *
 * A rejected standby is not closed here. The coordinator stops every alternate
 * that is not the session it activates, so adding a second teardown on this
 * path would be the two-owners problem rather than a fix.
 */
function interchangeableGeneration(alternate: PlaybackSession, replaced: PlaybackSession): boolean {
  if (alternate.mode !== replaced.mode) return false;
  if (alternate.mode === 'direct') return true;
  if (alternate.transform && replaced.transform
    && (alternate.transform.video !== replaced.transform.video
      || alternate.transform.audio !== replaced.transform.audio)) return false;
  const alternateContainer = alternate.output?.container?.trim().toLowerCase();
  const replacedContainer = replaced.output?.container?.trim().toLowerCase();
  if (!alternateContainer || !replacedContainer) return true;
  return alternateContainer === replacedContainer;
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
    /**
     * The deadline for a node that has not stated one. Derived rather than
     * literal: a silent node gets the conservative published floor plus
     * transport, never the stale constant that abandoned working nodes inside
     * their own entitlement. An explicit value still wins, which is what lets a
     * test drive the abandonment path without waiting out a real budget.
     */
    private readonly generationAttemptTimeoutMs = generationAttemptBudgetMs(),
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
    void this.releaseFailedSession(failedSession);
    if (preparedAlternate) {
      const owned = this.sessions.get(preparedAlternate.sessionId);
      if (owned
        && owned.endpoint.id !== failedSession.endpoint?.id
        && preparedAlternate.mediaId === failedSession.mediaId
        && interchangeableGeneration(preparedAlternate, failedSession)) {
        this.registry.recordSuccess(owned.endpoint.id);
        return preparedAlternate;
      }
    }
    return this.create(
      media,
      capabilities,
      seekMs,
      withServedSegmentContainer(preferences, failedSession),
      this.failoverExclusion(failedSession),
      true,
      this.generationAttemptTimeoutMs,
    );
  }

  /**
   * Replace a generation on the node that was already serving it, without
   * holding that node responsible for it.
   *
   * **The condition this exists for is a node reaping a paused session.**
   * `streaming.session_idle_ms` erases any session whose client has stopped
   * asking for media, and a paused client is exactly that — see
   * `SERVER_SESSION_IDLE_MS`. Afterwards a reaped session is indistinguishable
   * from one that never existed: the session route and the stream route both
   * answer `404 not_found`. That `404` is a statement about **one session's
   * existence**, not about the node, which is fine, holds the title's
   * pipeline, and is the right place to ask again.
   *
   * Until this existed there was nowhere else to ask. Every terminal source
   * error had one exit, `failover`, whose first act is `recordEndpointFailure`
   * — so the node was charged for answering honestly, dropped from the
   * candidate list, and the viewer was sent to whatever remained. Observed
   * live on 2026-09-17: the session was created on es-1, es-1 was excluded for
   * the `404`, and the failure screen named fi-1, a node that had never held
   * the session at all. A recoverable condition became a terminal one, and the
   * report went to the wrong node.
   *
   * So: no `recordEndpointFailure`, no entry in `failedGenerationEndpoints`,
   * same endpoint, same viewer position. A failure of the **new** admission is
   * ordinary endpoint evidence and is recorded as such — that is the node
   * refusing fresh work, which is a different claim from it having forgotten
   * an old session.
   *
   * **The old session is closed before the new one is asked for, and this
   * waits for it.** `failover` does not wait, because it is going to a
   * different node. Here the node's video transcode slot — its only one, where
   * `max_video_transcodes` is 1 — is held by the session being replaced, so
   * asking before releasing is asking to be refused. When the session was
   * reaped there is nothing to release and the `404` returns at once.
   *
   * Rejects rather than falling back when the endpoint is unknown or gone from
   * the registry. Failing over is the caller's decision and the caller already
   * has to make it for a failed admission; making it here too would put the
   * same decision in two places.
   */
  async regenerate(
    failedSession: PlaybackSession,
    media: MediaSummary,
    capabilities: PlaybackCapabilities,
    seekMs: number,
    preferences: PlaybackPreferencesUpdate,
  ): Promise<PlaybackSession> {
    const endpointId = failedSession.endpoint?.id;
    const endpoint = endpointId === undefined
      ? undefined
      : this.registry.candidates().find((candidate) => candidate.endpoint.id === endpointId)?.endpoint;
    if (!endpoint) {
      throw new Error(`Playback generation ${failedSession.sessionId} has no endpoint to regenerate on.`);
    }
    // `warn`, like every other step of this recovery. At `info` these two
    // were the only blind spots on a path whose other lines are all visible,
    // so a capture could not distinguish "the POST never returned" from "the
    // POST returned and the failure is after it" — which cost the Android TV
    // client a hardware run on 2026-09-20. A regeneration is a degraded state
    // by definition; the contract says those must be visible.
    this.log.warn('generation-regenerate', {
      endpointId: endpoint.id,
      endpoint: endpoint.baseUrl,
      mediaId: media.id,
      previousSessionId: failedSession.sessionId,
      seekMs,
    });
    // **Bounded, and proceeding anyway is the point.** `releaseFailedSession`
    // resolves when the first `DELETE` settles, and nothing anywhere bounds
    // that `DELETE` — the attempt deadline wraps the `POST` in `createOn` and
    // nothing else. So this `await` is the one unbounded wait on the whole
    // recovery path, on a call whose own docblock says it must never be
    // awaited because "a slow node is exactly where failover fires".
    // Regenerating has to wait, because the node's transcode slot is held by
    // the session being replaced; it does not have to wait for ever.
    //
    // **Measured on the Android TV client 2026-09-20 and it hangs a viewer
    // indefinitely.** A reaped session took this path, the chrome sat on
    // "Preparing new stream" and the position froze, with no failure screen
    // and no further trail line for minutes. Nothing threw, so nothing failed
    // over: a hang is not an error, and every bounded thing below it was
    // waiting on the one unbounded thing above it.
    //
    // On expiry the release continues in the background on its own ladder and
    // the create is attempted regardless. If the slot really is still held
    // the node refuses, which throws, which fails over — bounded and visible,
    // and strictly better than a viewer watching a frozen frame. Same budget
    // as the create deliberately: one number for "how long core may spend on
    // this node before giving up on it".
    await this.releaseWithin(failedSession, this.generationAttemptTimeoutMs);
    try {
      return await this.createOn(
        endpoint,
        media,
        capabilities,
        seekMs,
        withServedSegmentContainer(preferences, failedSession),
        true,
        this.generationAttemptTimeoutMs,
        newPlaybackIdempotencyKey(),
      );
    } catch (error) {
      this.log.warn('generation-regenerate-failed', {
        endpointId: endpoint.id,
        endpoint: endpoint.baseUrl,
        mediaId: media.id,
        error,
      });
      if (retryableEndpointFailure(error) && failureBlamesEndpoint(error)) this.registry.recordFailure(endpoint.id);
      throw endpointFailure(endpoint.id, endpoint.baseUrl, error);
    }
  }

  /**
   * Which endpoints this failover may not use.
   *
   * Normally every endpoint that has failed during this playback, so one
   * recovery does not walk back onto a node another recovery already gave up
   * on. But that set only ever grows — it is cleared by `resolve()` and
   * nothing else — so on a long item it eventually names every node. Two
   * nodes and a two-hour film: A blips at minute ten, B at minute ninety, the
   * candidate list is empty, and the viewer gets a bare "No untried Macha
   * playback endpoint remains" while A has been probed healthy for eighty
   * minutes.
   *
   * The test is whether anything outside it is *usable*, not whether anything
   * is left in the list. "Is the list empty" only answers correctly in a two
   * node cluster: with three, one node cooling down from a failed health
   * probe keeps the list non-empty, so the recovery walks to the one endpoint
   * that is known to be unwell, fails, and gives up — while two nodes that
   * recovered an hour ago sit excluded and idle. Readiness is a question only
   * the registry can answer, because `retryAt` is a reading of its clock.
   *
   * When nothing outside the exclusion is ready, it collapses to the one
   * endpoint that must never be chosen — the one being failed away from this
   * second. Everything else has had a cooldown, and probably a successful
   * probe, since it last misbehaved; the registry's ordering decides between
   * them and already puts anything out of cooldown ahead of anything still in
   * it. Nothing waits for a cooldown to expire: an attempt that fails costs
   * one request, and making the viewer wait for a timer is not a trade this
   * package makes.
   *
   * Not relaxed for standby preparation, which excludes the endpoint
   * currently in service: relaxing there would prepare a rescue on the node
   * the rescue exists to escape.
   */
  private failoverExclusion(failedSession: PlaybackSession): ReadonlySet<string> {
    if (this.registry.candidates(this.failedGenerationEndpoints).some((candidate) => candidate.ready)) {
      return this.failedGenerationEndpoints;
    }
    const current = new Set(failedSession.endpoint ? [failedSession.endpoint.id] : []);
    this.log.warn('generation-exclusion-relaxed', {
      excluded: [...this.failedGenerationEndpoints],
      stillExcluded: [...current],
    });
    return current;
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
   * not hold answers a bare `404`, which the node resolver already treats as
   * success, so there is no need to decide first whether the node is alive.
   *
   * Three things it deliberately does *not* do, each of which it used to:
   *
   * - **It does not go through `stop()`.** That method records a failure
   *   against the endpoint when the DELETE throws, and the endpoint has
   *   already been charged once for this outage by `recordEndpointFailure`
   *   above. One observation was becoming a fresh record per attempt, walking
   *   the cooldown ladder — 500 ms, 2 s, 10 s, 30 s — for a node that failed
   *   exactly once.
   * - **It does not wait for success to drop the map entry.** `stop()` deletes
   *   only on success, so a throwing DELETE left the session in `sessions`,
   *   where every later cleanup path found it and charged the registry again.
   *   The entry is gone before the first attempt: this session is abandoned
   *   whether or not the node ever acknowledges it.
   * - **It does not defer to a coordinator.** Two of the four clients call
   *   `failover` directly and never build one, so teardown that lives up
   *   there is teardown half the consumers do not get. This is the only
   *   layer all of them pass through, which is why the retry ladder is here.
   */
  /**
   * Wait for the failed session's first close, but not indefinitely.
   *
   * Resolves either way and never rejects: the caller's next act is to ask
   * the node for fresh work, and that is bounded and can fail honestly. A
   * rejection here would only turn a slow close into a failure the node never
   * reported.
   */
  private async releaseWithin(failedSession: PlaybackSession, timeoutMs: number): Promise<void> {
    const release = this.releaseFailedSession(failedSession);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'expired'>((resolve) => {
      timer = setTimeout(() => resolve('expired'), timeoutMs);
    });
    try {
      if (await Promise.race([release.then(() => 'closed' as const), expired]) === 'expired') {
        this.log.warn('failed-session-close-timeout', {
          sessionId: failedSession.sessionId,
          endpoint: failedSession.endpoint,
          timeoutMs,
        });
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Closes the ladder gave up on, kept for the next time that node answers.
   *
   * **The ladder gives up after about 31 seconds; the node holds the slot for
   * thirty minutes.** Between those two numbers sits a session nothing will
   * release, and core is the only party that can close it — the server cannot,
   * because the node enforcing the cap is the node holding the session and it
   * considers itself perfectly reachable. It never saw a failed connection; it
   * saw requests stop arriving.
   *
   * **Measured by the web client on 2026-09-21, and it is the long strand
   * rather than the short one.** Its failover isolated the node *inside the
   * client* — page-context `fetch` and `XMLHttpRequest` rewritten to a closed
   * local port — so the process never died and the session map stayed intact.
   * A process kill would have cleared the map and ended the strand; this
   * leaves a session that **was playing**, so the node's 120-second
   * unused-idle never applies and it holds one of `max_sessions` (8 on es-1,
   * node-wide across every account) for the full `session_idle_ms`.
   *
   * **Opportunistic on purpose: no timer, no polling, no subscription.** The
   * retry rides on the next successful admission against that endpoint, which
   * is free and cannot itself fail a viewer. A node core never returns to
   * keeps its strand until the server expires it — exactly what happens today,
   * so this is strictly better and never worse.
   */
  private rememberAbandonedRelease(endpointId: string, nodeSessionId: string, resolver: MachaPlaybackResolver): void {
    const pending = this.abandonedReleases.get(endpointId) ?? [];
    // Bounded, because an endpoint that is down for an hour would otherwise
    // accumulate one entry per failover for ever. Oldest first: a strand the
    // node has already expired is worth less than a fresh one.
    if (pending.length >= MAX_ABANDONED_RELEASES_PER_ENDPOINT) pending.shift();
    pending.push({ nodeSessionId, abandonedAt: machaHost().now(), resolver });
    this.abandonedReleases.set(endpointId, pending);
  }

  /**
   * Build a generation on a node the viewer chose, rather than on whichever
   * node ranks first.
   *
   * **The verb core did not have.** `PlaybackUpdate` is
   * `{preferences, seekMs, mediaId}` and every other way into another node is
   * entered on failure, so "serve this from that node instead" had no
   * expression at all. A client that wanted it had to close the generation and
   * start a new one, which is a visible gap — 13.2 s measured on a web client
   * moving between fi-1 and gbni-1, against machinery built to be invisible.
   *
   * **Acquire before release, and it costs nothing to do so.** The server
   * counts `max_sessions_per_account` per node — `sessions_held_by_locked`
   * iterates that node's own session map — so holding the old generation while
   * the new one comes up does not spend an account slot twice. The one case
   * that does is moving to a node where this account already holds sessions,
   * which a caller can check first because the listing is per node too. This
   * therefore never stops the outgoing generation: it returns the replacement
   * and leaves the swap and the release to the caller, exactly as
   * `prepareAlternate` does.
   *
   * **A move is not a re-plan.** `withServedSegmentContainer` restates the
   * container the player is already consuming, and a replacement that comes
   * back in a different mode is stopped and refused rather than returned —
   * a viewer asking for a different *node* has not asked for a different
   * *transform*, and silently delivering one is how a deliberate action turns
   * into a surprise.
   *
   * Returns `undefined` when the target is the node already serving, when it
   * is not a candidate this registry knows, or when the node would not build
   * an equivalent generation. Unlike `prepareAlternate` this is not
   * opportunistic — it is a viewer's instruction — so the error from a node
   * that refuses is allowed to propagate rather than being swallowed.
   */
  async prepareOn(
    endpointId: string,
    activeSession: PlaybackSession,
    media: MediaSummary,
    capabilities: PlaybackCapabilities,
    seekMs: number,
    preferences: PlaybackPreferencesUpdate,
  ): Promise<PlaybackSession | undefined> {
    if (activeSession.endpoint?.id === endpointId) return undefined;
    const known = this.registry.candidates().some((candidate) => candidate.endpoint.id === endpointId);
    if (!known) {
      this.log.info('move-declined', { reason: 'unknown-endpoint', endpointId });
      return undefined;
    }
    // Everything but the chosen node. `create` walks `candidates(excluded)`,
    // so excluding the rest is what turns a ranked walk into an instruction —
    // and it keeps the attempt budget, the logging and the close ladder that
    // the walk already owns rather than growing a second copy of them.
    const excluded = new Set(
      this.registry.candidates()
        .map((candidate) => candidate.endpoint.id)
        .filter((id) => id !== endpointId),
    );
    const moved = await this.create(
      media,
      capabilities,
      seekMs,
      withServedSegmentContainer(
        { ...preferences, mode: activeSession.mode === 'direct' ? 'direct' : preferences.mode },
        activeSession,
      ),
      excluded,
      true,
      this.generationAttemptTimeoutMs,
    );
    if (moved.mode === activeSession.mode) return moved;
    this.log.info('move-declined', { reason: 'mode-changed', endpointId, from: activeSession.mode, to: moved.mode });
    await this.stop(moved.sessionId).catch(() => undefined);
    return undefined;
  }

  /**
   * That node just answered, so try the closes it stopped answering for.
   *
   * Fire-and-forget and never awaited: this rides on a viewer's admission and
   * must not delay it by a millisecond. A `DELETE` for an id the node no
   * longer holds answers `404`, which the node resolver already treats as
   * success, so a strand the server has expired in the meantime clears itself
   * on the first attempt rather than erroring.
   *
   * **No expiry check, deliberately, and this is the second version.** The
   * first dropped entries older than core's `SERVER_SESSION_IDLE_MS` constant
   * on the reasoning that the node had expired them anyway. That made a
   * server number core had assumed into a correctness boundary, and it is
   * wrong in both directions: if a node's real `session_idle_ms` is shorter,
   * core sends a request that harmlessly `404`s; if it is **longer** — and an
   * operator may set it to anything above 30 s — core silently abandons
   * strands the node is still holding, which is the leak this whole mechanism
   * exists to close.
   *
   * So the check is gone rather than corrected. A `DELETE` for an id the node
   * no longer holds answers `404`, which the node resolver already treats as
   * success, so a strand the server expired in the meantime clears itself on
   * the first attempt. The cost of being wrong is one request that succeeds
   * trivially; the list is bounded per endpoint, so the worst case is a
   * handful of `404`s once, against a node that has just come back.
   *
   * **Core now assumes nothing about the node's idle window on this path.**
   */
  private drainAbandonedReleases(endpointId: string): void {
    const pending = this.abandonedReleases.get(endpointId);
    if (!pending || pending.length === 0) return;
    this.abandonedReleases.delete(endpointId);
    for (const entry of pending) {
      void entry.resolver.stop(entry.nodeSessionId).then(() => {
        this.log.info('abandoned-release-completed', {
          endpointId,
          sessionId: entry.nodeSessionId,
          strandedMs: Math.round(machaHost().now() - entry.abandonedAt),
        });
      }).catch((error: unknown) => {
        // One attempt per recovery, not a second ladder. The node answered
        // once; if this still fails it will be tried again next time.
        this.log.debug('abandoned-release-failed', { endpointId, sessionId: entry.nodeSessionId, error });
        this.rememberAbandonedRelease(endpointId, entry.nodeSessionId, entry.resolver);
      });
    }
  }

  private readonly abandonedReleases = new Map<string, Array<{ nodeSessionId: string; abandonedAt: number; resolver: MachaPlaybackResolver }>>();

  private releaseFailedSession(failedSession: PlaybackSession): Promise<void> {
    const owned = this.sessions.get(failedSession.sessionId);
    if (!owned) return Promise.resolve();
    this.sessions.delete(failedSession.sessionId);

    // Resolves when the *first* close settles, either way; the retry ladder
    // below goes on in the background regardless. Failing over does not wait
    // — it is going to a different node, so the old node's slot is not in its
    // way — but regenerating on the same node is blocked by exactly that slot,
    // so it does wait. See `regenerate`.
    let firstAttemptSettled!: () => void;
    const firstAttempt = new Promise<void>((resolve) => { firstAttemptSettled = resolve; });

    const attempt = (attemptsMade: number): void => {
      void owned.resolver.stop(owned.nodeSessionId).then(() => {
        firstAttemptSettled();
        this.log.info('failed-session-closed', {
          endpointId: owned.endpoint.id,
          sessionId: owned.nodeSessionId,
          attempts: attemptsMade + 1,
        });
      }).catch((error) => {
        firstAttemptSettled();
        const attempts = attemptsMade + 1;
        if (attempts >= FAILED_SESSION_CLOSE_ATTEMPTS) {
          // Said plainly rather than swallowed: the node is now holding a
          // transcode slot nothing will release before `session_idle`, and
          // the next viewer it refuses will have no way to see why.
          this.log.warn('failed-session-close-abandoned', {
            endpointId: owned.endpoint.id,
            sessionId: owned.nodeSessionId,
            attempts,
            error,
          });
          this.rememberAbandonedRelease(owned.endpoint.id, owned.nodeSessionId, owned.resolver);
          return;
        }
        const delayMs = Math.min(
          FAILED_SESSION_CLOSE_MAX_DELAY_MS,
          FAILED_SESSION_CLOSE_BASE_DELAY_MS * (2 ** attemptsMade),
        );
        this.log.warn('failed-session-close-retry', {
          endpointId: owned.endpoint.id,
          sessionId: owned.nodeSessionId,
          attempts,
          delayMs,
          error,
        });
        setTimeout(() => attempt(attempts), delayMs);
      });
    };
    attempt(0);
    return firstAttempt;
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
        withServedSegmentContainer(
          { ...preferences, mode: activeSession.mode === 'direct' ? 'direct' : preferences.mode },
          activeSession,
        ),
        excluded,
        false,
        this.generationAttemptTimeoutMs,
      );
      if (alternate.mode === activeSession.mode) return alternate;
      await this.stop(alternate.sessionId).catch(() => undefined);
      return undefined;
    } catch (error) {
      // Standby preparation is opportunistic and must never become a viewer
      // failure or alter the already-playing primary generation. **But
      // swallowing it whole made core unable to tell "no standby was
      // available" from "the node refused one" from "this threw" — three very
      // different states behind one silent `undefined`.**
      //
      // That gap becomes acute with the per-account session cap. A standby is
      // the *first* thing an account at its limit will be refused, because it
      // is the speculative request rather than the one a viewer is waiting on
      // — so the mechanism most likely to meet the cap first was the one that
      // could not report having met it. Seamless failover would simply stop
      // happening, with nothing on any trail saying why, and the first
      // evidence would be a viewer watching a stall.
      //
      // `warn` because a standby that cannot be built is a degraded state the
      // contract says must be visible and actionable, and `isAccountSessionLimit`
      // is called out by name because it is the one cause a host can turn into
      // a sentence a person can act on.
      this.log.warn('standby-preparation-refused', {
        endpointId: activeSession.endpoint.id,
        mediaId: media.id,
        accountAtSessionLimit: isAccountSessionLimit(error),
        code: playbackFailureCode(error),
        status: playbackFailureStatus(error),
        error,
      });
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
      this.log.info('generation-attempt', {
        endpointId: endpoint.id,
        endpoint: endpoint.baseUrl,
        mediaId: media.id,
        seekMs: seekMs ?? 0,
        standby: !preferOnSuccess,
      });
      try {
        return await this.createOn(
          endpoint,
          media,
          capabilities,
          seekMs,
          preferences,
          preferOnSuccess,
          attemptTimeoutMs,
          idempotencyKey,
        );
      } catch (error) {
        if (!retryableEndpointFailure(error)) throw error;
        this.log.warn('generation-attempt-failed', {
          endpointId: endpoint.id,
          endpoint: endpoint.baseUrl,
          mediaId: media.id,
          standby: !preferOnSuccess,
          error,
        });
        if (failureBlamesEndpoint(error)) this.registry.recordFailure(endpoint.id);
        lastError = endpointFailure(endpoint.id, endpoint.baseUrl, error);
      }
    }
    throw lastError ?? new Error('No untried Macha playback endpoint remains.');
  }

  /**
   * One generation attempt against one endpoint, with the bookkeeping a
   * successful admission owes: endpoint provenance on the session, the
   * endpoint-namespaced session id every other method looks up by, ownership
   * recorded so the session can be closed later, and the registry told.
   *
   * It deliberately does **not** classify a failure — it throws whatever the
   * node threw, raw. Its two callers want opposite things from one: the walk
   * in `create` records and moves to the next candidate, while `regenerate`
   * has no next candidate and wraps it for the caller to failover on.
   */
  private async createOn(
    endpoint: MachaEndpoint,
    media: MediaSummary,
    capabilities: PlaybackCapabilities,
    seekMs: number | undefined,
    preferences: PlaybackPreferencesUpdate | undefined,
    preferOnSuccess: boolean,
    attemptTimeoutMs: number | undefined,
    idempotencyKey: string,
  ): Promise<PlaybackSession> {
    const resolver = this.resolver(endpoint);
    // What this node says about itself, where it has said anything. The health
    // cycle records it for every known node, including ones never used, which
    // is what makes a budget available for a failover target on first contact.
    const stated = this.registry.playbackBudgets(endpoint.id);
    // **The node's figure wins where it exists; the injected value is the
    // fallback, not a cap.** Keeping the constructor parameter meaningful for a
    // node that has said nothing is what lets a test set a short budget without
    // that short budget silently overriding a real node's stated entitlement in
    // production.
    const deadlineMs = attemptTimeoutMs === undefined
      ? undefined
      : (stated ? generationAttemptBudgetMs(stated) : attemptTimeoutMs);
    const request = resolver.resolve(media, capabilities, seekMs, preferences, undefined, idempotencyKey);
    const session = deadlineMs
      ? await awaitWithEndpointDeadline(
        request,
        deadlineMs,
        (late) => this.releaseGenerationAdmittedLate(endpoint, resolver, late),
      )
      : await request;
    // Hand the host the same figures core just bounded itself by, so the two
    // layers cannot disagree about what this node will wait for. Attached here
    // rather than in `mapSession` because only this layer knows which endpoint
    // served the session.
    session.source = {
      ...session.source,
      budgets: {
        deadlineMs: deadlineMs ?? generationAttemptBudgetMs(stated),
        segmentHoldMs: segmentHoldMs(stated),
        ...(stated?.pipelineIdleMs !== undefined ? { pipelineIdleMs: stated.pipelineIdleMs } : {}),
      },
    };
    session.endpoint = { id: endpoint.id, baseUrl: endpoint.baseUrl };
    const nodeSessionId = session.sessionId;
    session.sessionId = `${endpoint.id}::${encodeURIComponent(nodeSessionId)}`;
    this.sessions.set(session.sessionId, { endpoint, resolver, nodeSessionId });
    if (preferOnSuccess) this.registry.recordSuccess(endpoint.id);
    else this.registry.recordProbeSuccess(endpoint.id);
    // This node is answering again. Anything its close ladder gave up on is
    // still holding a slot there, and this is the cheapest moment core will
    // ever get to clear it.
    this.drainAbandonedReleases(endpoint.id);
    return session;
  }

  async update(sessionId: string, update: PlaybackUpdate, signal?: AbortSignal): Promise<PlaybackSession> {
    const owned = this.sessions.get(sessionId);
    if (!owned) throw unknownGeneration(sessionId);
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
      if (retryableEndpointFailure(error) && failureBlamesEndpoint(error, { pinned: true })) this.registry.recordFailure(owned.endpoint.id);
      throw endpointFailure(owned.endpoint.id, owned.endpoint.baseUrl, error);
    }
  }

  /**
   * Ask the node that issued this generation whether it still holds it.
   *
   * Pinned to the owning node — there is no walk and no failover. Every other
   * node would answer `404` truthfully for a session it never had, so asking a
   * second one could only produce a confident wrong answer.
   *
   * **Records nothing against the endpoint, in either direction.** A `404` is
   * the node answering correctly and is the whole point of asking; anything
   * else throws, and whatever the caller does about that will charge the node
   * on its own terms. A probe that moved the registry would make asking a
   * question cost the node something, which is how a diagnostic turns into the
   * fault it was meant to diagnose.
   */
  async sessionAlive(sessionId: string): Promise<boolean> {
    // Recovered from the id when the map has no entry, for the same reason
    // `stop` does: this is pinned to the owning node, and the id names it. A
    // host asking whether an orphan from a previous run is still alive — which
    // is exactly what a reclaim does before closing one — had no way to be
    // answered, because the map died with the process that created it.
    const owned = this.sessions.get(sessionId) ?? this.provenanceFromId(sessionId);
    if (!owned) throw unknownGeneration(sessionId);
    return owned.resolver.sessionAlive(owned.nodeSessionId);
  }

  async stop(sessionId: string, options?: PlaybackStopOptions): Promise<void> {
    const owned = this.sessions.get(sessionId);
    if (!owned) return this.stopByIdAlone(sessionId, options);
    // Abandoned before the attempt when the caller has already charged the
    // node: the generation is not coming back either way, and an entry left
    // behind by a throwing DELETE is what a later cleanup path finds and
    // charges the registry for again. Same two rules as `releaseFailedSession`
    // one level down, for a caller that cannot reach it.
    if (options?.endpointAlreadyCharged) this.sessions.delete(sessionId);
    try {
      await owned.resolver.stop(owned.nodeSessionId, options);
      this.sessions.delete(sessionId);
    } catch (error) {
      if (!options?.endpointAlreadyCharged
        && retryableEndpointFailure(error)
        && failureBlamesEndpoint(error, { pinned: true })) this.registry.recordFailure(owned.endpoint.id);
      throw endpointFailure(owned.endpoint.id, owned.endpoint.baseUrl, error);
    }
  }

  /**
   * Close a generation the attempt deadline gave up on but the node went on to
   * admit.
   *
   * The idempotency key is no help: sessions are node-local, so the retry
   * lands somewhere else and this node is left holding a session nothing
   * refers to — on a one-slot node, its only transcode slot — until
   * `session_idle` reclaims it thirty minutes later. The slow node the
   * deadline exists to route around is exactly the one that pays for it, and
   * it pays in the resource that made it slow.
   *
   * Never recorded as endpoint evidence, in either direction. The node did
   * nothing wrong; it was slower than we were prepared to wait, and it has
   * already been charged for that by the attempt that timed out.
   */
  private releaseGenerationAdmittedLate(
    endpoint: MachaEndpoint,
    resolver: MachaPlaybackResolver,
    session: PlaybackSession,
  ): void {
    this.log.warn('generation-admitted-after-deadline', {
      endpointId: endpoint.id,
      endpoint: endpoint.baseUrl,
      sessionId: session.sessionId,
    });
    void resolver.stop(session.sessionId).catch((error) => {
      // Nothing else will try: this session was never recorded, so no cleanup
      // path knows it exists. Saying so is the whole of what can be done.
      this.log.warn('late-generation-close-failed', {
        endpointId: endpoint.id,
        sessionId: session.sessionId,
        error,
      });
    });
  }

  recordEndpointFailure(endpointId: string): void {
    this.failedGenerationEndpoints.add(endpointId);
    this.registry.recordFailure(endpointId);
  }

  /**
   * Close a session this instance has no record of, on the strength of its id.
   *
   * **Best effort, and deliberately weaker than the tracked path.** A tracked
   * close knows the session was live and treats a failure as evidence about
   * the node. This one knows nothing: the id may name a session that was
   * abandoned an hour ago by a failover that already charged for the outage,
   * or one left behind by a process that died, and the two are
   * indistinguishable from here. So it never charges, never throws, and
   * reports what happened to the trail instead of to the caller.
   *
   * **That distinction is load-bearing and was nearly lost.** Dropping the map
   * entry is how a released session is marked as dealt with — `failover`
   * abandons and charges once, and the missing entry is what stops every later
   * cleanup path charging the same outage again, walking a healthy node up the
   * 500 ms / 2 s / 10 s / 30 s cooldown ladder for one failure. Recovering
   * provenance from the id removes that protection unless the recovered path
   * also declines to charge, which is why it does.
   */
  private async stopByIdAlone(sessionId: string, options?: PlaybackStopOptions): Promise<void> {
    // `endpointAlreadyCharged` is the caller stating that it owns this
    // teardown and has already accounted for it — the seam that keeps one
    // outage from walking the cooldown ladder. It is also the only thing that
    // tells a session deliberately abandoned moments ago from one left behind
    // by a process that died, because both are simply absent from the map. So
    // an untracked close under that flag does nothing: the caller has said it
    // is handled, and re-attempting would re-open the case it closed.
    if (options?.endpointAlreadyCharged) return;
    const recovered = this.provenanceFromId(sessionId);
    if (!recovered) return;
    try {
      await recovered.resolver.stop(recovered.nodeSessionId, options);
      this.log.info('untracked-session-closed', { sessionId, endpointId: recovered.endpoint.id });
    } catch (error) {
      // Not raised and not charged. The caller asked core to tidy up after
      // something it cannot describe; a node that will not answer reaps the
      // session on its own clock.
      this.log.info('untracked-session-close-failed', { sessionId, endpointId: recovered.endpoint.id, error });
    }
  }

  /**
   * Recover which node holds a session from the session id alone.
   *
   * **This is why every client leaked sessions.** `stop()` looked the id up in
   * `this.sessions` and returned silently when it was missing — no request, no
   * log, a resolved promise — so a host could close everything it had and
   * produce no `DELETE` at all while believing it had cleaned up. Measured on
   * fi-1: 57 creates and zero deletes since 13:00, across four clients that
   * each leak by a different route.
   *
   * **And "provenance missing" is the ordinary case, not the exotic one.**
   * That map is in-process, so nothing survives a reload, a relaunch or a
   * crash; `releaseFailedSession` deletes the entry for the id a host may
   * still be holding; and a `moveTo` or a failover replaces it. The map is a
   * cache of something the id already states.
   *
   * It states it because core mints it: `${endpoint.id}::${nodeSessionId}`,
   * with the node part URI-encoded. `encodeURIComponent` escapes `:` as
   * `%3A`, so the encoded half contains no colon and the **last** `::` is
   * always the separator — which is what keeps an IPv6 endpoint id like
   * `http://[::1]:7438` from being split in the middle of its own address.
   *
   * Returns `undefined` for an id this core did not mint or an endpoint the
   * registry no longer configures, which keeps `stop()` a no-op for genuine
   * nonsense while making it act on everything it can.
   */
  private provenanceFromId(sessionId: string): { endpoint: MachaEndpoint; resolver: MachaPlaybackResolver; nodeSessionId: string } | undefined {
    const separator = sessionId.lastIndexOf('::');
    if (separator <= 0) return undefined;
    const endpointId = sessionId.slice(0, separator);
    const nodeSessionId = decodeURIComponent(sessionId.slice(separator + 2));
    if (!nodeSessionId) return undefined;
    const endpoint = this.registry.candidates().find((candidate) => candidate.endpoint.id === endpointId)?.endpoint;
    if (!endpoint) return undefined;
    this.log.info('session-provenance-recovered', { sessionId, endpointId });
    return { endpoint, resolver: this.resolver(endpoint), nodeSessionId };
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

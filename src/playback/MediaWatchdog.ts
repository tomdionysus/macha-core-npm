import { SERVER_SEGMENT_HOLD_MS } from './streamProtocol.js';
/**
 * Bounds the one playback failure the player could not previously see: a media
 * element that accepted a source, began its fetch, and then received nothing
 * at all — ever.
 *
 * Every other deadline in this client covers a *server request*: the session
 * POST and PATCH, the endpoint deadlines, the API layer's own request timeout,
 * the HLS standby preflight. Once `video.src` is assigned, nothing watched
 * whether the element got anywhere, because every failure and degradation
 * channel is driven by something the element *emits* — a `MediaError`, an
 * hls.js error, a read-ahead worker failure. An element sitting silently at
 * `HAVE_NOTHING` emits none of those, so this fault shape walked straight past
 * the entire cluster-failover apparatus that exists precisely for "this node
 * is not delivering bytes", and the viewer got an unchanging spinner for as
 * long as they were willing to watch it (four minutes, on the report that
 * prompted this).
 *
 * That is an unbounded wait, which `docs/principles-and-laws.md` forbids
 * outright: failure and degraded states must be visible and actionable rather
 * than becoming indefinite waiting. This bound holds whatever the underlying
 * cause turns out to be, which is the point — the cause is still open.
 *
 * Two things keep it honest rather than making it a blunt timer.
 *
 * **It triggers on zero bytes, never on "slow".** A media element fires
 * `progress` as data arrives, well before `readyState` climbs off
 * `HAVE_NOTHING`, so a link that is merely bad — and one node here is
 * deliberately across a saturated WAN — cancels this watch on its first few
 * bytes and is never judged. Only a source that has delivered literally
 * nothing can reach the deadline.
 *
 * **Only visible time counts.** Chromium throttles media loading in a
 * backgrounded or occluded tab, and a tab that is not loading because nobody
 * is looking at it is the browser working correctly, not a node failing. That
 * distinction is not hypothetical here: it is the confound that invalidated a
 * whole evening's investigation of this bug, where screenshots kept rendering
 * a tab Chromium had backgrounded. Pausing the clock while hidden means a
 * fired watchdog is evidence of a real fault, and stops us burning every
 * candidate node to reach a fatal error screen on a tab the viewer had simply
 * switched away from.
 */

/**
 * How long a source may hold the element without delivering one byte.
 *
 * Deliberately generous. The failure this bounds is unbounded today, so
 * anything finite is the whole improvement; buying that with needless node
 * churn on a slow-but-working start would be a poor trade. Twenty seconds of
 * *visible* time with zero bytes is not a slow link, it is a dead one.
 */
export const MEDIA_START_STARVATION_MS = 20_000;

export interface MediaWatchdogEnvironment {
  now(): number;
  /**
   * Whether the app is on screen for the viewer.
   *
   * A host that cannot answer must return `true`. Only a positive "nobody is
   * looking" counts as hidden: a missing API has to leave the bound in force
   * rather than silently disabling it, since a watchdog that quietly stops
   * watching is worse than one that never existed.
   */
  visible(): boolean;
  /** Subscribe to visibility transitions. Returns an unsubscribe. */
  onVisibilityChange(listener: () => void): () => void;
  /** Schedule work. Returns a cancel function, so no handle type escapes. */
  schedule(callback: () => void, delayMs: number): () => void;
}


/**
 * A deadline measured in *visible* time, which both watchdogs need and neither
 * should reimplement.
 *
 * Chromium throttles media loading in a backgrounded or occluded tab, and a TV
 * app sent to the home screen is not playing either. Time spent that way is
 * the platform working correctly rather than a node failing, so it counts
 * toward no deadline here.
 */
class VisibleDeadline {
  private cancelTimer?: () => void;
  private unsubscribeVisibility?: () => void;
  private expired?: (visibleMs: number) => void;
  /** Visible milliseconds banked from segments that have already ended. */
  private bankedMs = 0;
  /** When the current visible segment began, or undefined while hidden. */
  private segmentStartedAt?: number;

  constructor(
    private readonly timeoutMs: number,
    private readonly environment: MediaWatchdogEnvironment,
  ) {}

  get running(): boolean { return this.expired !== undefined; }

  arm(expired: (visibleMs: number) => void): void {
    this.disarm();
    this.expired = expired;
    this.unsubscribeVisibility = this.environment.onVisibilityChange(() => this.syncVisibility());
    this.syncVisibility();
  }

  /** Restart the countdown while keeping the visibility subscription. */
  restart(): void {
    if (!this.expired) return;
    this.bankedMs = 0;
    this.segmentStartedAt = undefined;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.syncVisibility();
  }

  disarm(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.unsubscribeVisibility?.();
    this.unsubscribeVisibility = undefined;
    this.expired = undefined;
    this.bankedMs = 0;
    this.segmentStartedAt = undefined;
  }

  /** Visible milliseconds accrued so far, banked plus the open segment. */
  private elapsedMs(): number {
    const open = this.segmentStartedAt === undefined ? 0 : this.environment.now() - this.segmentStartedAt;
    return this.bankedMs + open;
  }

  private syncVisibility(): void {
    if (!this.expired) return;
    const visible = this.environment.visible();
    if (visible && this.segmentStartedAt === undefined) {
      this.segmentStartedAt = this.environment.now();
      this.cancelTimer?.();
      this.cancelTimer = this.environment.schedule(
        () => this.expire(),
        Math.max(0, this.timeoutMs - this.bankedMs),
      );
      return;
    }
    if (!visible && this.segmentStartedAt !== undefined) {
      this.bankedMs += this.environment.now() - this.segmentStartedAt;
      this.segmentStartedAt = undefined;
      this.cancelTimer?.();
      this.cancelTimer = undefined;
    }
  }

  private expire(): void {
    const expired = this.expired;
    const visibleMs = this.elapsedMs();
    this.cancelTimer = undefined;
    // Tear down before notifying: the callback fails the source generation,
    // which must not be able to re-enter a deadline that is still armed.
    this.disarm();
    expired?.(visibleMs);
  }
}

/**
 * The start watchdog: a source the element accepted and never got a byte from.
 *
 * Triggers on *zero bytes ever*, never on "slow" — a media element fires
 * `progress` as data arrives, well before `readyState` leaves `HAVE_NOTHING`,
 * so a merely bad link cancels this on its first few bytes and is never judged.
 */
export class MediaStartWatchdog {
  private readonly deadline: VisibleDeadline;

  constructor(
    environment: MediaWatchdogEnvironment,
    timeoutMs: number = MEDIA_START_STARVATION_MS,
  ) {
    this.deadline = new VisibleDeadline(timeoutMs, environment);
  }

  start(starved: (visibleMs: number) => void): void {
    this.deadline.arm(starved);
  }

  /** Evidence that bytes reached the element. Idempotent; safe when idle. */
  noteProgress(): void {
    this.deadline.disarm();
  }

  stop(): void {
    this.deadline.disarm();
  }
}

/**
 * How long a picture may sit frozen with nothing arriving before the source is
 * called dead.
 *
 * Seven seconds, set by a rule rather than a feeling: **the budget must be
 * longer than the longest legitimate wait the server can impose.** That is
 * `streaming.segment_timeout`, 6000 ms, which is how long a node holds a
 * request for a fragment it has not produced before answering
 * `500 segment_not_ready`. Below that the watchdog can expire while a node is
 * mid-hold and about to deliver; at exactly that, budget and hold expire
 * together and the outcome is a coin flip. Above it, firing means the node
 * failed to answer its own hold, which is evidence rather than a race.
 *
 * The seven-second measurement below is deliberately *not* cleared.
 *
 * On 2026-09-08 a node that was working — producing a transcode below realtime
 * — delivered in bursts separated by **seven seconds** of no progress at all.
 * That was first read as a floor to stay above, so as not to blame a healthy
 * node. Wrong frame: whether the node deserves blame is not the question this
 * budget answers. A node that goes quiet for seven seconds is making the
 * viewer wait seven seconds, and the client has somewhere better to be. Slow
 * for any reason is a reason to move.
 *
 * The cost of moving is bounded and the cost of staying is not: a replacement
 * generation is a session POST and a first fragment, while a node delivering
 * in bursts goes on doing it for the length of the film. And on a set whose
 * native player raises no `MediaError` this budget is the *whole* of failover
 * detection — the picture is simply frozen for all of it before anything is
 * told.
 *
 * Was fifteen seconds, then five, then this, over 2026-09-08 and 09. Fifteen
 * was a viewer staring at a frozen frame; five proved too eager in use and sat
 * *under* the server's own hold — so a node answering a held fragment exactly
 * as designed was called stalled before it could answer.
 *
 * That is why this is now expressed against `SERVER_SEGMENT_HOLD_MS` rather
 * than written as a number. The relationship is the requirement; the figure is
 * a consequence.
 *
 * **The margin does not make a hold safe, and an earlier version of this
 * comment claimed it did.** It argued that a second was enough because the
 * hold ends with a response rather than with silence, so the budget only had
 * to outlast the wait. That is wrong about what this watchdog can see. It
 * reads `currentTime` and `buffered` and nothing else, and a `500` carries no
 * bytes — so the response that ends the hold moves neither. What has to fit
 * inside the budget is the hold *plus* the player's retry delay *plus* the
 * first byte of the fragment that finally arrives, and that total exceeds
 * seven seconds routinely.
 *
 * So: **a node that holds a fragment for its full timeout will trip this, and
 * that is accepted.** It is the same trade the budget is built on — the
 * viewer has been waiting six seconds and the client has somewhere better to
 * be, whether or not the node deserves blame. Recorded plainly because the
 * previous phrasing invited someone to shave the margin on the strength of an
 * argument that was never true.
 */
export const MEDIA_STALL_TIMEOUT_MS = SERVER_SEGMENT_HOLD_MS + 1_000;

/**
 * The stall watchdog: playback stopped and nothing is arriving to restart it.
 *
 * The reason this exists is that failover already works — `PlaybackCoordinator`
 * recovers a `'stream'` failure onto another node — and on a platform whose
 * player reports nothing, no one ever tells it to. A Samsung set had a frame
 * frozen for thirty seconds with every recovery mechanism intact and idle,
 * because its native HLS player swallowed the failure and the element's
 * `error` event is the only channel that platform has.
 *
 * **Position alone is the wrong signal, and this is the whole design.** A node
 * producing a transcode below realtime freezes the picture repeatedly while
 * remaining perfectly healthy — bytes keep arriving, the buffer keeps growing,
 * playback simply cannot keep ahead. Judging on a stopped clock would evict
 * exactly the node that was doing the work. So a stall is only evidence when
 * the buffer has stopped growing too: nothing playing *and* nothing arriving.
 * Slow is a buffer that advances while the picture waits; dead is neither.
 *
 * Deliberately player-agnostic — `currentTime` and `buffered` are all it reads,
 * so it works behind hls.js, behind a television's native HLS player, and
 * behind a progressive file alike. That matters because the platforms most
 * likely to swallow a failure are the ones least able to report it.
 */
/**
 * What was true when a stall was called.
 *
 * `bufferedEndMs` is absent when the platform could not measure it, which is
 * the same figure `note()` was given — a stall reported without one carries no
 * evidence about the node, only that the viewer was waiting.
 */
export interface StallDetail {
  visibleMs: number;
  positionMs: number;
  bufferedEndMs?: number;
}

export class MediaStallWatchdog {
  private readonly deadline: VisibleDeadline;
  private stalled?: (detail: StallDetail) => void;
  private lastPositionMs?: number;
  private lastBufferedEndMs?: number;
  /** Set by `suspend()`, cleared by the first `note()` after it. */
  private suspended = false;

  constructor(
    environment: MediaWatchdogEnvironment,
    timeoutMs: number = MEDIA_STALL_TIMEOUT_MS,
  ) {
    this.deadline = new VisibleDeadline(timeoutMs, environment);
  }

  /**
   * Watch a generation that has started playing. Nothing is armed until the
   * first `note()`, so a source still loading is the start watchdog's business
   * and cannot be judged twice.
   */
  watch(stalled: (detail: StallDetail) => void): void {
    this.stop();
    this.stalled = stalled;
  }

  /**
   * Report where playback is and how far the buffer reaches. Either advancing
   * restarts the countdown; neither advancing lets it run.
   *
   * **`bufferedEndMs` may be omitted by a platform that cannot measure it**,
   * and absent is not zero — a player reporting zero buffering forever would
   * otherwise read as permanently stalled while perfectly healthy. Omitting it
   * costs the slow-versus-dead distinction: without a buffer figure a node
   * producing below realtime looks the same as one that has died, and this
   * will fire on both.
   *
   * That is the right trade only because of what the caller does next. Moving
   * off a node the viewer is waiting on is correct whether or not the node
   * deserves blame — those are different questions, and this budget answers
   * the second one. But a caller acting on a stall from a platform that cannot
   * measure buffering must not *record endpoint health* from it: it has
   * evidence that a viewer is waiting and no evidence about the node. Core
   * already draws exactly that line for per-title failures, which move a
   * session without condemning the endpoint.
   *
   * **The first report only establishes a baseline — it must not start a
   * countdown.** A generation that has never produced anything has not
   * stalled, it has not started, and that is the start watchdog's business at
   * its own deadline. Arming here on first sight made this watchdog kill every
   * freshly promoted source after 15 s, which on a failover meant: recover
   * onto a healthy node, kill it before it could deliver a frame, recover
   * again, and exhaust the cluster — surfacing as "No untried Macha playback
   * endpoint remains" with three working nodes. Observed on a Samsung set
   * 2026-09-08, caused by this method.
   */
  note(positionMs: number, bufferedEndMs?: number): void {
    if (!this.stalled) return;
    const first = this.lastPositionMs === undefined;

    // A discontinuity: the timeline this was measuring against no longer
    // exists. Either the position moved backwards, or the buffered end did —
    // and ordinary playback can do neither. A seek is the ordinary cause, and
    // on a D-pad it is the *only* seek affordance, so on a television this is
    // routine viewing rather than an edge case.
    const movedBack = !first && positionMs < this.lastPositionMs!;
    const bufferRebuilt = bufferedEndMs !== undefined
      && this.lastBufferedEndMs !== undefined
      && bufferedEndMs < this.lastBufferedEndMs;
    const discontinuity = movedBack || bufferRebuilt;
    // Re-base rather than carry the old high-water mark forward. `advanced`
    // compares the buffer against a running max, so without this the buffer
    // growing at the new position never counts — it is still below where the
    // buffer had reached before the seek — and a node busy refilling is called
    // dead 7 s later. That is precisely the eviction of a healthy
    // below-realtime transcode this class exists to avoid, arrived at from the
    // other direction.
    if (discontinuity) this.lastBufferedEndMs = undefined;

    // Playback is running again after a deliberate pause. The countdown was
    // disarmed and only advancement re-arms it, so without this a node that
    // died during the pause leaves the picture frozen forever: nothing
    // advances, so nothing arms, so nothing is ever judged.
    const resumed = this.suspended && !first;
    this.suspended = false;

    const advanced = !first
      && (discontinuity
        || positionMs > this.lastPositionMs!
        || (bufferedEndMs !== undefined && bufferedEndMs > (this.lastBufferedEndMs ?? 0)));
    this.lastPositionMs = positionMs;
    if (bufferedEndMs !== undefined) {
      this.lastBufferedEndMs = Math.max(bufferedEndMs, this.lastBufferedEndMs ?? 0);
    }
    if (first || !(advanced || resumed)) {
      // Nothing has ever moved: leave the start watchdog to it. Once something
      // has moved, a later report that has not moved is what the deadline is
      // measuring, so an already-running countdown is deliberately left alone.
      return;
    }
    if (this.deadline.running) {
      this.deadline.restart();
      return;
    }
    const stalled = this.stalled;
    this.deadline.arm((visibleMs) => {
      this.stop();
      stalled({ visibleMs, positionMs: this.lastPositionMs ?? positionMs, bufferedEndMs: this.lastBufferedEndMs ?? bufferedEndMs });
    });
  }

  /**
   * Paused is not stalled: the viewer stopped it on purpose.
   *
   * The flag matters as much as the disarm. Only advancement re-arms the
   * deadline, and a node that dies while paused produces none — so resuming
   * onto a dead node would leave the picture frozen with nothing counting,
   * which is the failure this whole class exists to prevent, reached through
   * the one door that was left open.
   */
  suspend(): void {
    this.suspended = true;
    this.deadline.disarm();
  }

  stop(): void {
    this.deadline.disarm();
    this.stalled = undefined;
    this.lastPositionMs = undefined;
    this.lastBufferedEndMs = undefined;
    this.suspended = false;
  }
}

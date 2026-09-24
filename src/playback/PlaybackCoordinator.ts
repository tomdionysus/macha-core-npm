import { createClientLogger } from '../diagnostics/ClientLog.js';
import { MOVE_LEAD_MARGIN_MS } from './generationStart.js';
import { isEndpointRetryablePlaybackFailure, PlaybackSourceError, type PlaybackTransition, type Player } from '../platform/Platform.js';
import type { MediaSummary, MediaTechnicalProfile, PlaybackCapabilities, PlaybackEvent, PlaybackSource, PlaybackMode } from '../types.js';
import { generationAttemptBudgetMs } from './PlaybackResolver.js';
import { CHOICE_NOT_AVAILABLE_CODE, CHOICE_REQUIRED_CODE } from './MachaPlaybackResolver.js';
import type {
  PlaybackPreferencesUpdate,
  PlaybackResolver,
  PlaybackSession,
  PlaybackStopOptions,
  PlaybackUpdate,
} from './PlaybackResolver.js';
import { technicalProfileFromSession } from './MediaTechnicalProfile.js';
import type { PlaybackDecisionFacts, PlaybackMediaFacts } from '../api/PlaybackFactsApi.js';
import { chooseAmongFiles, degradeInstruction, segmentContainer, streamsToName, withoutLanguages, transcodeUndecodable, type FileFacts, type PlaybackChoiceAssumption, type PlaybackDecisionReason, type PlaybackInstruction, type PlaybackPolicyOverrides, type SegmentContainer } from './choosePlaybackInstruction.js';
import { machaHost } from '../runtime/host.js';
import { abortError } from '../errors.js';

export interface PlaybackIntent {
  positionMs: number;
  paused: boolean;
}

/**
 * Why the coordinator is telling the host something, for the host to word:
 * - `copy-refused`: the node could not copy the source streams, so it is
 *   converting them (the instruction's reasons carry `executor-refused-copy`);
 * - `decode-fallback`: the player could not decode the copied streams, so they
 *   are being converted (reasons carry `player-could-not-decode`); `error` is
 *   the player's report;
 * - `cannot-seek`: a seek was refused because this stream cannot seek;
 * - `not-ready`: an update or a move was asked for before a session existed;
 * - `instruction-failed`: re-choosing how to play failed; `error` says why;
 * - `subtitles-loading`: a subtitle change is being applied;
 * - `update-failed`: a change to the running generation failed; `error` says why.
 */
export type PlaybackNoticeCode =
  | 'copy-refused'
  | 'decode-fallback'
  | 'cannot-seek'
  | 'not-ready'
  | 'instruction-failed'
  | 'subtitles-loading'
  | 'update-failed';

export interface PlaybackNotice {
  code: PlaybackNoticeCode;
  /** The failure behind it, for the two codes that have one. Its message is log text, not viewer text. */
  error?: Error;
  /**
   * What the node said when it refused, where it said anything: the HTTP
   * status and error code, and for `choice_required` / `choice_not_available`
   * which choice and its candidates. Data for a host to word; see
   * `CHOICE_REQUIRED_CODE`.
   */
  refusal?: PlaybackRefusal;
}

export interface PlaybackRefusal {
  status?: number;
  code?: string;
  choice?: string;
  choices?: Array<number | string>;
}

function refusalOf(error: unknown): PlaybackRefusal | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const { status, code, choice, choices } = error as { status?: unknown; code?: unknown; choice?: unknown; choices?: unknown };
  const refusal: PlaybackRefusal = {
    ...(typeof status === 'number' ? { status } : {}),
    ...(typeof code === 'string' ? { code } : {}),
    ...(typeof choice === 'string' ? { choice } : {}),
    ...(Array.isArray(choices) ? { choices: choices as Array<number | string> } : {}),
  };
  return Object.keys(refusal).length > 0 ? refusal : undefined;
}

export interface PlaybackCoordinatorSnapshot {
  intent: PlaybackIntent;
  event: PlaybackEvent;
  session?: PlaybackSession;
  starting: boolean;
  preparingSource: boolean;
  pendingPreferences?: PlaybackPreferencesUpdate;
  /**
   * Why playback stopped and could not be recovered — **a chain, not a
   * message.**
   *
   * Core does not decide what a viewer is shown. This carries everything core
   * knows, leading with the failure that started the recovery, with each
   * further `cause` a later stage of it: for an exhausted failover, the head is
   * the source failure that began the walk and the tail is the attempt that
   * ended it. Those are routinely about different nodes, and a host that
   * renders only the head tells a viewer the node lost the source while never
   * saying that nothing else could serve it either.
   *
   * **A host is expected to walk it**, and to choose how much of it a given
   * surface deserves — a television and a diagnostics panel want different
   * amounts of the same chain, and only the host knows which it is. A
   * `PlaybackSourceError` anywhere in the chain keeps its `kind`, so a host can
   * classify without parsing prose.
   */
  fatalError?: Error;
  /**
   * Something the viewer may want told, as a code. Core writes no viewer
   * text (Tom, 2026-09-24); the host words each code, or shows nothing.
   */
  notice?: PlaybackNotice;
  /**
   * How this generation's instruction was arrived at, so a host can show it.
   *
   * Without this the worst failure in the chooser has no symptom. When the
   * facts lookup fails, the coordinator falls back to `transcode` — correct,
   * because it is the only always-performable instruction — and the viewer
   * sees a picture that works. Nothing prompts anyone to look, so a client
   * can quietly transcode a whole library that would have direct-played, on
   * a cluster that looks healthy, indefinitely. A log line on a television is
   * not a symptom. Surface this somewhere a person can see it.
   */
  instruction?: PlaybackInstructionReport;
}

export interface PlaybackInstructionReport {
  mode: PlaybackMode;
  video?: 'copy' | 'transcode';
  audio?: 'copy' | 'transcode';
  reasons: PlaybackDecisionReason[];
  /**
   * Optional inputs no host supplied, which this decision assumed answers
   * for. A non-empty list on a client that believes it wires everything is
   * the symptom of a field declared, consumed, and populated by nobody.
   */
  assumed: PlaybackChoiceAssumption[];
  /** The segment container this instruction asked for, when it asked for one. */
  container?: SegmentContainer;
  /**
   * The container the server says it served, once a session exists.
   *
   * Requested and served are kept side by side deliberately. A host policy
   * preferring MPEG-TS against a node that ignores the preference produces
   * `mpegts` in the policy and `fmp4` on the wire, and until both were
   * reported in one place nothing pointed at the discrepancy — the panel
   * showed a container, it was a real one, and it was not the one asked for.
   */
  servedContainer?: string;
  /**
   * False when the node served a container other than the one requested.
   *
   * Undefined rather than true when either side is unknown: no container was
   * requested, or the node does not report what it served. An unanswered
   * question must not read as an answer, which is the same rule the status
   * line follows for the container itself.
   */
  containerHonoured?: boolean;
  /**
   * The mode the node actually performed, once a session exists.
   *
   * The server's own account, from the session's top-level `mode`, as against
   * the `preferences.mode` it echoes back — which is what it was *asked* for.
   * Those agree until the node substitutes.
   */
  performedMode?: PlaybackMode;
  /**
   * False when the node performed a mode other than the one it was asked for.
   *
   * **There is exactly one substitution the server does, and it is not silent
   * — it is merely unexamined.** When a remux's keyframe index is unusable as
   * a segment plan and the node allows the video-transcode fallback, it plans
   * a transcode instead and says so: the top-level `mode` is what was
   * performed while `preferences` still echoes what was asked for. Nothing in
   * core compared the two until 2026-09-20, so a title whose keyframe index
   * will never be usable was re-asked for a remux on every recovery, got
   * substituted every time, and nothing anywhere said so.
   *
   * **This is deliberately not the same question as "did core get what it
   * chose", and the difference is observable.** `snapshot.instruction` is
   * patched by the chooser and by a step down, but **not** by a plain viewer
   * mode change — so after a viewer switches from transcode to remux the
   * report still names transcode. Comparing the performed mode against *that*
   * calls every viewer mode change a server substitution. Comparing it against
   * the node's own echo of what it was asked for does not, and does not depend
   * on core keeping its own report in sync to stay correct.
   *
   * Undefined rather than true when either side is unknown, the same rule the
   * container follows one field up.
   */
  modeHonoured?: boolean;
  /** The viewer chose this mode themselves; the chooser was not consulted. */
  chosenByViewer: boolean;
  /**
   * The file the chooser picked among the item's files, sent as the session's
   * `media_id`. Absent when the chooser did not pick one: the viewer chose the
   * mode, or there were no facts, on an item with several files.
   */
  mediaId?: string;
  /**
   * True when the instruction is a fallback rather than a decision — the
   * facts were unavailable, so nothing could be reasoned from.
   */
  withoutFacts: boolean;
  /**
   * Why the facts were unavailable, when they were unavailable because asking
   * failed rather than because nothing answers.
   *
   * **Present so a client can say what actually went wrong.** With only
   * `withoutFacts` a screen could report that something was degraded but not
   * that the lookup itself failed, and the fallback's own symptoms reach the
   * viewer looking like a property of the file — the web client's viewer met
   * `MEDIA_ELEMENT_ERROR: Format error` and had no way to know the client had
   * simply been unable to ask what the file was. A warning in a ring buffer is
   * not a degraded mode a viewer can act on.
   *
   * Absent when there is no facts supplier at all, which is a configuration
   * rather than a fault.
   */
  factsError?: unknown;
}

/**
 * How many times a *failed* facts lookup may be retried for one generation.
 *
 * Bounded rather than unlimited: each retry is a request on the viewer's
 * critical path, and an unbounded one would fire on every touch of the mode
 * control while a node was down. Three is enough to ride out a node restarting
 * or a session arriving late, and few enough that a genuinely absent answer
 * settles quickly.
 */
const FACTS_ATTEMPT_BUDGET = 3;

export interface PlaybackCoordinatorOptions {
  media: MediaSummary;
  player: Player;
  resolver: PlaybackResolver;
  capabilities: () => Promise<PlaybackCapabilities>;
  initialPositionMs: number;
  initialPreferences?: PlaybackPreferencesUpdate;
  /**
   * What the media is, and what the node can do with it, for choosing an
   * instruction when the viewer has not chosen a mode themselves.
   *
   * Supplied as a function so the host decides where the facts come from and
   * what they cost: a cached catalogue profile is free, a probe is not.
   * `MachaPlaybackFactsApi.facts()` returns exactly this shape; a host with
   * only a catalogue profile can return `{ profile }` and omit `operations`.
   * It may resolve to undefined, in which case the coordinator falls back to
   * `transcode`, the only instruction that is always performable.
   *
   * It takes the media rather than closing over it. A runtime plays many
   * items over its lifetime, and a zero-argument thunk captured once returns
   * the first item's facts for every later title — a wrong instruction that
   * looks entirely reasonable.
   *
   * **Return every file.** An item can hold several files, and choosing among
   * them is the client's decision, not the server's (Tom, 2026-09-24).
   * `MachaPlaybackFactsApi.facts({ itemId })` returns one entry per file; hand
   * the whole list over and the coordinator chooses the file and names it on
   * the session. A single `PlaybackDecisionFacts` is still accepted, and then
   * describes the item's only file, or whichever the host picked.
   */
  facts?: (media: MediaSummary) => Promise<PlaybackFacts | undefined>;
  /** Platform truths no capability probe can discover. */
  policyOverrides?: PlaybackPolicyOverrides;
}

type Listener = (snapshot: PlaybackCoordinatorSnapshot) => void;
/**
 * How long a prepared standby is held before being closed unused.
 *
 * This window was originally chosen against `streaming.pipeline_idle_ms` — the
 * 60 s after which a node reclaims an idle transcode pipeline — on the belief
 * that a standby older than that would promote onto a dead session. **That
 * reasoning was wrong and is recorded here so it does not come back.** The two
 * server clocks are independent: `pipeline_idle` reclaims the *engine*, while
 * `session_idle` (30 minutes) erases the *session*. An aged standby is a live
 * session with a cold engine, so promoting it costs a cold start rather than a
 * failure, and 60 s was never the binding constraint.
 *
 * What thirty seconds actually buys is the case where a node produces one
 * degradation and then recovers: the rescue is held long enough to be there if
 * a second failure follows, and released if none does. For a remux or direct
 * standby that costs the node a session record and nothing anyone else is
 * competing for, so the window can afford to be generous.
 *
 * A transcode standby is not in that position — see
 * `ALTERNATE_TRANSCODE_RECOVERY_WINDOW_MS` below, which is the constraint that
 * turned out to be real.
 */
/**
 * **The server's validated floor, not its default — and that is the whole
 * point.** `streaming.pipeline_idle_ms` is configurable, and until server
 * 0.48.0 it was **not on the wire**: `status_api.cpp` stated only
 * `startup_timeout_ms` and `segment_timeout_ms`, and the idle figures were
 * read from configuration and never serialised. So core could not ask, and
 * this was `30_000` — the default — which is the exact fault `look_ahead_ms`
 * produced when a client believed one.
 *
 * **Core cannot read it, so core takes the number the server guarantees.**
 * `config_base.cpp:359` refuses to start a node with `pipeline_idle` under ten
 * seconds, so **10,000 ms is true of every node that is running at all**,
 * whatever its configuration. A standby held inside that window cannot outlive
 * a pipeline the node has torn down.
 *
 * **Wasteful in the cheap direction, deliberately.** On a node configured
 * generously this discards a standby that would still have been good, costing
 * a preparation that has to happen again. Holding one *past* teardown costs a
 * promotion of something that cannot serve — on the viewer's critical path, at
 * the moment recovery is already running, on the mechanism whose entire job is
 * to be invisible. **A lost standby is cheaper than a dead one.**
 *
 * **This is now the floor rather than the answer.** Server 0.48.0 states
 * `pipeline_idle_ms` per node on `/api/v1/status`, and all three deployed
 * nodes serve 60,000 — six times this. `alternateRecoveryWindowMs` below
 * reads it where a node states one and falls back here where none does, which
 * is every node older than 0.48.0 and any node that has not been heard from.
 * **Absence stays the ordinary case**, and absence is never zero.
 */
const ALTERNATE_RECOVERY_WINDOW_MS = 10_000;

/**
 * What a standby is worth holding for, and it is not simply what the node
 * allows.
 *
 * Two different numbers meet here and neither alone is the answer. The node's
 * `pipeline_idle_ms` is a **ceiling**: hold a standby past it and the
 * promotion lands on a live session whose engine has been reclaimed, which
 * costs a cold start. What the window is actually *for* is narrower — the case
 * where a node produces one degradation and then recovers, so the rescue is
 * there if a second failure follows and released if none does. That was
 * measured as worth about thirty seconds, and a standby held longer than that
 * is holding a session record nobody is going to use.
 *
 * So: the lesser of what is useful and what the node guarantees. On the
 * deployed cluster that restores the full thirty seconds — the figure this
 * had before it was cut to the guaranteed floor — rather than stretching to
 * the node's sixty, which would buy nothing and hold a session for a minute
 * to do it.
 *
 * **A node that says nothing keeps the floor**, which is the conservative
 * direction on purpose: discarding a standby early costs a preparation that
 * happens again, while holding one past teardown costs a promotion onto
 * something that cannot serve, on the viewer's critical path. A lost standby
 * is cheaper than a dead one.
 */
const ALTERNATE_RECOVERY_WINDOW_TARGET_MS = 30_000;

export function alternateRecoveryWindowMs(session: PlaybackSession): number {
  if (session.mode === 'transcode') return ALTERNATE_TRANSCODE_RECOVERY_WINDOW_MS;
  const stated = session.source.budgets?.pipelineIdleMs;
  if (stated === undefined || !Number.isFinite(stated) || stated <= 0) return ALTERNATE_RECOVERY_WINDOW_MS;
  return Math.max(ALTERNATE_RECOVERY_WINDOW_MS, Math.min(ALTERNATE_RECOVERY_WINDOW_TARGET_MS, stated));
}
/**
 * How long a standby against a **transcode** session is held.
 *
 * Much shorter, because that standby is not merely idle — it holds a scarce,
 * node-wide resource for every other viewer. A node admits a session as video
 * transcode entitled and counts it against `max_video_transcodes` **from
 * admission until the session record is destroyed**, not while its pipeline is
 * running: the entitlement lives on the session, and `video_transcodes_locked()`
 * never inspects whether an engine exists. These nodes are configured with one
 * slot.
 *
 * The two server clocks are worth keeping straight, because confusing them is
 * what made this look smaller than it is. `pipeline_idle` (60 s) reclaims the
 * *engine*; `session_idle` (**30 minutes**) erases the *session*. Only the
 * second releases the slot. So this window bounds how long core *intends* to
 * hold a slot, and an explicit close is what actually returns it — a standby
 * dropped by letting the reference go strands the node's only video slot for
 * up to half an hour. Every path here that abandons one calls
 * `resolver.stop()`, and that is not incidental.
 *
 * The full window buys the case where a node produces one degradation and then
 * recovers, and the rescue turns out not to have been needed. That is worth
 * holding a cheap resource for and not worth holding the only one. Long enough
 * to cover the second failure that promotes it, which follows the first within
 * seconds when it comes at all; short enough that a false alarm costs a
 * stranger a few seconds rather than half a minute.
 *
 * Remux and direct standbys keep the full window — they are entitled to no
 * transcode slot and cost the node nothing but a session record.
 */
/**
 * **Safe against the same floor by construction**, which is worth stating so
 * nobody "corrects" it upward later: eight seconds is below the ten the server
 * refuses to start beneath, so a transcode standby is always discarded before
 * a node could tear its pipeline down, on every node that is running.
 */
const ALTERNATE_TRANSCODE_RECOVERY_WINDOW_MS = 8_000;
const PLAYBACK_END_TOLERANCE_MS = 5_000;
/**
 * How far playback must actually advance before a regeneration counts as
 * having worked, and the loop stop on `lastRegenerationPositionMs` is cleared.
 *
 * Comfortably more than the jitter of a position report and comfortably less
 * than a fragment, so a replacement that genuinely resumed clears it on the
 * first progress event while one that attached and immediately failed again
 * does not.
 */
const REGENERATION_PROGRESS_MS = 1_000;

/**
 * How much playable media a viewer must still have in front of them before
 * core starts building the replacement for a source that has died.
 *
 * **Every component is measured, against `es-1` on 2026-09-17**, because the
 * two figures chosen by reasoning before it were both wrong and in opposite
 * directions.
 *
 * - **Negotiation: 3.3–3.8 s, and structurally expensive.** The node calls
 *   `start_pipeline` and blocks on the first fragment inside the `201`, so
 *   there is no version of this where creating a session is cheap.
 * - **Host preparation: 9.5 s**, almost all of it fetching the join fragment.
 *   A host that replaces a source seamlessly has to get the join point
 *   *resident* before it can cut to it, and at full quality over a WAN link
 *   that is megabytes. Aligning and cutting were 0.5 s of the 9.5.
 *
 * 13.3 s when first measured — but the host preparation figure is dominated by
 * the join fetch and that tracks the *node*, not the mechanism. Three handovers
 * on one evening: 1.0 s, 14.5 s and 16.0 s, the fast one on a different node
 * from the two slow ones. So the lead is built on the worst observed rather
 * than the first: ~4 s to negotiate plus ~16 s to prepare, and margin.
 *
 * **Bounded above by `look_ahead_ms`, and the bound is what makes leading long
 * safe.** A generation is created at the position the viewer will reach, so a
 * longer lead puts the join deeper into it — and past the node's look-ahead
 * the encoder has to run forward sequentially to get there, which is the 9 s
 * fault an earlier shape of this shipped. Inside the look-ahead the join is
 * already produced and costs nothing.
 *
 * **That bound inverts the bias, which is the thing to hold on to.** While the
 * frontier was unknown, over-leading risked seconds of encode and
 * under-leading cost a short wait, so short was safe. With the frontier read
 * per session, over-leading is capped by a number the node reports and
 * under-leading is a gap in front of a viewer. **Long, capped, is now the safe
 * direction** — and 10 s was wrong because it was chosen under the old bias.
 */
export const REPLACEMENT_LEAD_TIME_MS = 26_000;

/**
 * How far inside a node's stated look-ahead the arrival point is kept.
 *
 * The frontier is where a fragment stops being held and starts being refused,
 * so arriving *at* it is arriving at the edge of a cliff. The margin absorbs
 * the drift between a runway figure, the moment a negotiation completes, and
 * the segment boundary the node actually produced to.
 */
export const LOOK_AHEAD_MARGIN_MS = 4_000;

/**
 * How much runway a replacement needs before the buffer runs out.
 *
 * Three quantities meet here and only one of them is about time to spare:
 *
 * - `REPLACEMENT_LEAD_TIME_MS` is the ceiling, a judgement about how early is
 *   too early to start.
 * - The node's look-ahead is the frontier, and starting nearer to it than
 *   `LOOK_AHEAD_MARGIN_MS` risks arriving at a fragment the node has not
 *   produced.
 * - `attemptBudgetMs` is the floor, and it is not negotiable: **a replacement
 *   started with less runway than one attempt needs cannot finish in time, so
 *   leading by less than it guarantees the outcome the lead time exists to
 *   prevent.**
 *
 * The clamp and the floor can genuinely conflict, because the look-ahead is
 * derived from an unrelated quantity — the node's `max_ahead_segments` times
 * its segment duration. A node configured with four four-second segments
 * clamps to 12,000, under a single attempt against a node entitled to 15,000
 * plus transport. When they disagree the floor wins: arriving slightly past
 * the frontier is a retryable `500` that resolves as production advances,
 * while running dry is a black screen.
 */
export function replacementLeadTimeMs(
  lookAheadMs: number | null | undefined,
  attemptBudgetMs: number,
): number {
  if (typeof lookAheadMs !== 'number' || !Number.isFinite(lookAheadMs)) {
    return Math.max(REPLACEMENT_LEAD_TIME_MS, attemptBudgetMs);
  }
  const clamped = Math.min(REPLACEMENT_LEAD_TIME_MS, Math.max(0, lookAheadMs - LOOK_AHEAD_MARGIN_MS));
  return Math.max(clamped, attemptBudgetMs);
}
const UNCACHED_SEEK_DEBOUNCE_MS = 300;


/**
 * How long a player may report nothing, while a replacement is pending and the
 * viewer is playing, before core stops waiting for an event that may not come.
 *
 * Not a prediction of anything — see `armPendingReplacementGuard`. A playing
 * element reports several times a second, so this is silence of a kind that
 * means something has gone wrong rather than a buffer running low.
 */
const PLAYER_SILENCE_GUARD_MS = 15_000;

/**
 * Head-room over the node's own budgets before the recovery as a whole is
 * abandoned.
 *
 * **A supervising deadline exists because every limb of this recovery is
 * bounded and the composition was not.** On 2026-09-20 a viewer sat frozen for
 * minutes with `preparingSource` true, and the elimination afterwards closed
 * every branch: the close settled, the create is bounded and can never compute
 * a zero budget, `activateSession` is synchronous, nothing was disposed, one
 * copy of core was in the bundle, and the absence of further log lines was
 * read off three frames by eye rather than by a broken detector. **No named
 * mechanism survives all of that, and the viewer was still frozen.**
 *
 * So this does not bound a suspect. It bounds *the work item* — "build a
 * replacement" — which is what the retried-work discipline under Law 4 asks
 * for: backoff, a failure budget, a parked state and an operator action, for the retried
 * unit rather than for each of its limbs. It converts every unnamed mechanism,
 * including ones nobody has thought of, from an indefinite freeze into a
 * bounded wait followed by the failover that already exists.
 *
 * Deliberately generous: the close and the create may each legitimately spend
 * the node's full attempt budget, so anything under twice that would abort
 * recoveries that were going to succeed. A false positive here crosses to
 * another node and loses the stream copy, which is worse than waiting.
 */
const RECOVERY_SUPERVISION_MARGIN_MS = 10_000;

interface PendingMutation {
  update: PlaybackUpdate;
  reason: 'seek' | 'representation' | 'subtitle';
}

function awaitUnlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener('abort', aborted);
      reject(signal.reason);
    };
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      },
    );
  });
}

function clampPosition(positionMs: number, durationMs: number | undefined): number {
  const finite = Number.isFinite(positionMs) ? positionMs : 0;
  if (!durationMs || durationMs <= 0) return Math.max(0, finite);
  return Math.max(0, Math.min(durationMs, finite));
}

export function isPrematurePlaybackEnd(positionMs: number, durationMs: number): boolean {
  return durationMs > 0 && positionMs + PLAYBACK_END_TOLERANCE_MS < durationMs;
}

/**
 * No evidence about what failed: a bare `Error`, or a `PlaybackSourceError` of
 * kind `unknown`. The same test `source-failure-unclassified` reports on.
 */
function isUnclassifiedPlaybackFailure(error: unknown): boolean {
  return !(error instanceof PlaybackSourceError) || error.kind === 'unknown';
}

/** What a host may say about a move. See `PlaybackCoordinator.moveTo`. */
export interface PlaybackMoveOptions {
  /**
   * How far ahead of the viewer to ask the target node to start, in
   * milliseconds, in place of core's own estimate. The host's figure for this
   * move only: core does not keep it. Ignored unless the player declares
   * `holdsThroughLead`.
   */
  leadMs?: number;
}

export function generationLocalPosition(
  session: PlaybackSession,
  absolutePositionMs: number,
): number | undefined {
  if (session.mode === 'direct') return clampPosition(absolutePositionMs, session.durationMs);
  const generationStartMs = Math.max(0, session.seekMs);
  if (absolutePositionMs < generationStartMs) return undefined;
  return clampPosition(absolutePositionMs - generationStartMs, Math.max(0, session.durationMs - generationStartMs));
}

function rangeContainsPosition(
  ranges: readonly { startMs: number; endMs: number }[],
  positionMs: number,
): boolean {
  return ranges.some((range) => range.startMs <= positionMs && positionMs <= range.endMs);
}

/** What `facts` may return: one file's facts, or one entry per file of the item. */
export type PlaybackFacts = PlaybackDecisionFacts | readonly PlaybackMediaFacts[];

/** Nothing usable when the list is empty. */
function filesFrom(supplied: PlaybackFacts | undefined): readonly FileFacts[] | undefined {
  if (supplied === undefined) return undefined;
  const files = Array.isArray(supplied) ? supplied as readonly PlaybackMediaFacts[] : [supplied as PlaybackDecisionFacts];
  return files.length > 0 ? files : undefined;
}

function instructionPreferences(instruction: PlaybackInstruction): PlaybackPreferencesUpdate {
  return {
    mode: instruction.mode,
    video: instruction.video,
    audio: instruction.audio,
    container: instruction.container,
  };
}

/**
 * A node saying "I cannot perform this", as distinct from "not now" or "I am
 * unwell". 400 is the server's refusal of an instruction it understands and
 * cannot execute for this file on this build; 429 is capacity and 5xx is
 * health, both of which failover handles and neither of which a downgrade
 * should mask.
 */
function isExecutorRefusal(error: unknown): boolean {
  if (!error || typeof error !== 'object' || (error as { status?: unknown }).status !== 400) return false;
  // A choice left open, or one the node cannot honour, is a question about
  // the request, not a refusal to perform it: stepping down the mode would
  // answer a different question and hide the real one.
  const code = (error as { code?: unknown }).code;
  return code !== CHOICE_REQUIRED_CODE && code !== CHOICE_NOT_AVAILABLE_CODE;
}

function mergePreferences(
  current: PlaybackPreferencesUpdate | undefined,
  next: PlaybackPreferencesUpdate | undefined,
): PlaybackPreferencesUpdate | undefined {
  if (!current) return next ? { ...next } : undefined;
  if (!next) return { ...current };
  return { ...current, ...next };
}

export function mergePlaybackUpdate(current: PlaybackUpdate | undefined, next: PlaybackUpdate): PlaybackUpdate {
  if (!current) return {
    ...next,
    preferences: next.preferences ? { ...next.preferences } : undefined,
  };
  return {
    ...current,
    ...next,
    preferences: mergePreferences(current.preferences, next.preferences),
  };
}

export function isSubtitleOnlyPlaybackUpdate(update: PlaybackUpdate): boolean {
  if (update.seekMs !== undefined || update.mediaId !== undefined || !update.preferences) return false;
  const keys = Object.entries(update.preferences)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
  return keys.length > 0 && keys.every((key) => key === 'subtitleStream' || key === 'subtitleLanguage');
}

/**
 * A node saying it did not serve this media, as distinct from saying it is
 * unwell. See `PlaybackFailureKind` for why the two had to be separated and
 * what it cost while they were not.
 */
function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function isMissingSourceFailure(error: unknown): boolean {
  return error instanceof PlaybackSourceError && error.kind === 'not-found';
}

/**
 * Everything core knows about why recovery ran out of options, in one chain.
 *
 * **Core supplies context; the host decides what a viewer sees.** Presentation
 * is the host's — it knows the surface, the audience and how much detail is
 * appropriate — so nothing here composes viewer-facing prose or picks which
 * half of the story matters. What core owes is not to lose anything it holds,
 * and to put it somewhere a host can find without being told the shape.
 *
 * The chain leads with the failure that **started** the recovery, which is the
 * one worth defaulting to: a source failure on the node holding the session
 * sends the walk to every other candidate, and `create()` throws the last of
 * those to refuse — so leading with *that* names a node the session was never
 * on. Observed live on 2026-09-17: the session was on es-1, the walk ended on
 * fi-1, and the screen read `Macha endpoint http://10.35.1.50:7438 failed:
 * Failed to fetch` — fi-1's address, for a session fi-1 had never held. A day
 * of diagnosis went to the wrong node.
 *
 * **But "what ended it" is the other half and must survive**, because leading
 * with the originating failure alone tells a viewer the node lost the source
 * and never that nothing else could serve it either. A host wanting to say
 * both, or to say only the second, walks `cause`.
 *
 * The originating error object itself is returned rather than a copy of its
 * message, so a `PlaybackSourceError` reaches the host with its `kind` intact.
 *
 * **Appended at the tail rather than only onto an empty `cause`.** The earlier
 * form attached the ending failure only when `originating.cause` was unset,
 * which meant an originating error that already carried one — and
 * `PlaybackSourceError` takes a cause in its constructor — silently discarded
 * the ending. That is core deciding a host does not need something core is
 * holding, which is exactly the judgement that does not belong here.
 */
export function terminalRecoveryError(originating: Error, lastAttempt: unknown): Error {
  if (!(lastAttempt instanceof Error) || lastAttempt === originating) return originating;
  // Walking a chain that something upstream may have made cyclic must not hang
  // the failure path: a viewer waiting on a hung error report is strictly worse
  // than one told slightly less.
  const seen = new Set<Error>([originating]);
  let tail = originating;
  while (tail.cause instanceof Error && !seen.has(tail.cause)) {
    tail = tail.cause;
    seen.add(tail);
  }
  if (!seen.has(lastAttempt)) tail.cause = lastAttempt;
  return originating;
}

function sourceIdentity(session: PlaybackSession): string {
  return `${session.mode}|${session.source.url}|${session.source.mimeType ?? ''}|${session.mediaId}`;
}

function preservedSeekPreferences(session: PlaybackSession): PlaybackPreferencesUpdate {
  return {
    subtitleStream: session.selected.subtitleStream >= 0 ? session.selected.subtitleStream : null,
    subtitleLanguage: session.preferences.subtitleLanguage,
  };
}

function completePreferences(session: PlaybackSession): PlaybackPreferencesUpdate {
  return {
    mode: session.preferences.mode,
    maxHeight: session.preferences.maxHeight,
    maxBitrate: session.preferences.maxBitrate,
    videoStream: session.preferences.videoStream ?? undefined,
    audioStream: session.preferences.audioStream,
    subtitleStream: session.preferences.subtitleStream,
    audioLanguage: session.preferences.audioLanguage,
    subtitleLanguage: session.preferences.subtitleLanguage,
  };
}

/**
 * Restate what naming a `mode` throws away.
 *
 * From server 0.34.0 a PATCH carrying `mode` restates the whole transform:
 * `video`, `audio`, `max_height` and `max_bitrate` are cleared unless the
 * same request names them again. For the per-stream fields that is the point.
 * An override outliving the mode it belonged to is what made every session
 * the chooser started refuse a later bare `{"mode":"direct"}` as "direct
 * copies every stream" — judged against an instruction the client had not
 * sent in that request — so they are deliberately left to clear here.
 *
 * A quality ceiling is a different kind of thing. The viewer set it from
 * another control for another reason, and clearing it because they touched
 * the Mode picker hands them a full-height transcode nobody asked for. So it
 * is restated, but only into a transform that can carry one: copying passes
 * the encoded stream through untouched, so `direct` and `remux` have no step
 * at which a cap could apply (see `reconcileQualityCaps`) and clearing it
 * there is correct rather than lossy.
 *
 * The segment container is restated even though it does not need to be.
 * `container` is parsed apart from `mode` and is not in the cleared set —
 * confirmed against 0.34.0's code and a live node, where a session created as
 * MPEG-TS and then PATCHed with `mode` alone still serves MPEG-TS. It is sent
 * anyway because the two failure postures are not symmetric, and that
 * asymmetry does not go away because the server currently behaves: a
 * redundant field costs one line of JSON, while a device handed fragmented
 * MP4 where it asked for MPEG-TS shows a black picture and reports nothing.
 * The value is not a guess either — it is the container this generation
 * already asked for.
 *
 * Only fields the update leaves absent are filled, so a fresh cap or
 * container in the same request always wins — including one merged in from an
 * earlier queued mutation that never reached the wire.
 */
export function restatePreferencesClearedByMode(
  update: PlaybackUpdate,
  session: PlaybackSession,
  requestedContainer: SegmentContainer | undefined,
): PlaybackUpdate {
  const preferences = update.preferences;
  const mode = preferences?.mode;
  if (!preferences || mode === undefined || mode === 'choose') return update;

  const restated: PlaybackPreferencesUpdate = { ...preferences };
  // `video: 'copy'` inside a transcode is a per-stream instruction the caller
  // just made; capping the height of a stream being copied is the same
  // contradiction from the other side.
  if (mode === 'transcode' && preferences.video !== 'copy') {
    if (restated.maxHeight === undefined && session.preferences.maxHeight !== null) {
      restated.maxHeight = session.preferences.maxHeight;
    }
    if (restated.maxBitrate === undefined && session.preferences.maxBitrate !== null) {
      restated.maxBitrate = session.preferences.maxBitrate;
    }
  }
  return { ...update, preferences: withRestatedSegmentContainer(restated, requestedContainer) };
}

/**
 * Name the streams a PATCH would otherwise leave the node to choose.
 *
 * From server 0.58.0 a PATCH is held to the same choices as a create. A
 * session begun as `direct` named no stream, since the player picks its own
 * tracks there, so a change into a remux or transcode (the decode fallback,
 * or the viewer's own) must now name them: refused otherwise, with
 * `choice_required`, on every file with several audio streams. The same goes
 * for a language the viewer picks mid-play, which the node refuses outright
 * where the file lacks it. The streams come from the session's own source
 * streams, which the node reported for this very file; a stream the session
 * already plays is restated rather than chosen again.
 */
function namedStreamsForPatch(update: PlaybackUpdate, session: PlaybackSession): PlaybackUpdate {
  const preferences = update.preferences;
  if (!preferences || session.sourceInfo.streams.length === 0) return update;
  const mode = preferences.mode !== undefined && preferences.mode !== 'choose' ? preferences.mode : session.mode;
  const changesMode = preferences.mode !== undefined && preferences.mode !== 'choose';
  const changesLanguage = preferences.audioLanguage !== undefined || preferences.subtitleLanguage !== undefined;
  if (!changesMode && !changesLanguage) return update;
  const current = session.preferences;
  const kept = (index: number | null | undefined) => (index !== null && index !== undefined && index >= 0 ? index : undefined);
  const wanted = {
    videoStream: preferences.videoStream ?? kept(current.videoStream),
    // A language the viewer just picked replaces the stream it chose before.
    audioStream: preferences.audioStream ?? (preferences.audioLanguage !== undefined ? undefined : kept(current.audioStream)),
    subtitleStream: preferences.subtitleStream ?? (preferences.subtitleLanguage !== undefined ? undefined : kept(current.subtitleStream)),
    audioLanguage: preferences.audioLanguage ?? (current.audioLanguage || undefined),
    subtitleLanguage: preferences.subtitleLanguage ?? (current.subtitleLanguage || undefined),
  };
  const named = streamsToName(technicalProfileFromSession(session), mode, wanted);
  const restated: PlaybackPreferencesUpdate = { ...withoutLanguages(preferences) };
  // A subtitle-only change keeps the picture and sound as they are on the
  // node (its subtitle fast path), so nothing else is restated into it.
  if (changesMode || preferences.audioLanguage !== undefined) {
    if (wanted.videoStream !== undefined || named.videoStream !== undefined) restated.videoStream = wanted.videoStream ?? named.videoStream;
    if (wanted.audioStream !== undefined || named.audioStream !== undefined) restated.audioStream = wanted.audioStream ?? named.audioStream;
  }
  if (preferences.subtitleStream !== undefined || named.subtitleStream !== undefined || preferences.subtitleLanguage !== undefined) {
    // A subtitle language the file lacks is no subtitles.
    restated.subtitleStream = preferences.subtitleStream ?? named.subtitleStream ?? (preferences.subtitleLanguage !== undefined ? null : undefined);
  }
  return { ...update, preferences: restated };
}

/**
 * Restate the segment container on any transformed generation being created
 * or replaced.
 *
 * Shared by the update path above and by `currentPreferences` below, because
 * the two were not sharing it and the gap had a body count. A PATCH restated
 * the container; a *failover* did not — it rebuilt the generation from the
 * session's confirmed preferences, and `container` is not among them. So a
 * Samsung set that had asked for MPEG-TS was handed fragmented MP4 by every
 * replacement node, which is the one carriage it cannot play: black picture,
 * no error, nothing fetched. Each silent starvation was then charged to a
 * perfectly healthy node until the cluster ran out of candidates.
 *
 * Measured on the set 2026-09-09 — two replacements, two 20 s starvations at
 * `readyState: HAVE_NOTHING`, and instant playback from the *same* node the
 * moment a PATCH went through it. The asymmetry was the whole fault.
 *
 * Copying is the only transform with no step at which a container could be
 * chosen, so `direct` is left alone.
 */
function withRestatedSegmentContainer(
  preferences: PlaybackPreferencesUpdate,
  requestedContainer: SegmentContainer | undefined,
): PlaybackPreferencesUpdate {
  if (preferences.mode !== 'remux' && preferences.mode !== 'transcode') return preferences;
  if (preferences.container !== undefined || requestedContainer === undefined) return preferences;
  return { ...preferences, container: requestedContainer };
}

/**
 * Restate the per-stream transforms on a generation being rebuilt.
 *
 * The same server rule as the container above, one field further in, and this
 * side of it *does* need restating. From server 0.34.0 a request carrying
 * `mode` restates the whole transform, so a recovery that names `transcode`
 * and nothing else clears the `video: 'copy'` that made it a copy and the
 * replacement node plans video from scratch. Measured on the Android TV client
 * 2026-09-20: a generation passing HEVC 1920x1040 through untouched was reaped,
 * and its replacement re-encoded that stream to H264 — taking the node's only
 * `max_video_transcodes` slot to convert a picture the television was decoding
 * natively. The node was asked for it. Nothing was wrong with the node.
 *
 * **Restated from the instruction, not from the session's echo.** The two
 * differ after a server-side substitution, and `session.transform` is what the
 * node did rather than what was asked for. Restating that makes one bad plan
 * permanent — each recovery would rebuild from the last recovery's downgrade,
 * and the copy would never come back. It is also the only source that can
 * disagree with the `mode` sitting beside it: `mode` comes from the session's
 * *confirmed preferences* overlaid with anything the viewer has changed since,
 * so pairing it with the node's echo can state `remux` alongside a transcoded
 * video — an instruction nobody chose and the server is entitled to refuse.
 * `degradeInstruction` is the same coupling from the other side: giving up an
 * audio copy forces `remux` to become `transcode`, because a remux that does
 * not copy every stream is not a remux.
 *
 * So the mode and the transforms are restated from one place or not at all,
 * which is why a report for a *different* mode is left alone entirely: it
 * describes a transform that no longer applies, and pinning it to a mode it
 * did not belong to is the failure this whole item is about, inverted.
 *
 * Fields already present win, so a viewer's in-flight change is never
 * overwritten — the same precedence the container follows. `direct` copies
 * every stream by definition and has no per-stream step, so it is skipped.
 */
function withRestatedTransforms(
  preferences: PlaybackPreferencesUpdate,
  instruction: PlaybackInstructionReport | undefined,
): PlaybackPreferencesUpdate {
  if (preferences.mode !== 'remux' && preferences.mode !== 'transcode') return preferences;
  if (!instruction || instruction.mode !== preferences.mode) return preferences;
  const restated = { ...preferences };
  if (restated.video === undefined && instruction.video !== undefined) restated.video = instruction.video;
  if (restated.audio === undefined && instruction.audio !== undefined) restated.audio = instruction.audio;
  return restated;
}

export function equivalentDirectSources(primary: PlaybackSession, alternate: PlaybackSession): boolean {
  const primaryMime = (primary.source.mimeType ?? primary.mimeType).split(';', 1)[0]?.trim().toLowerCase();
  const alternateMime = (alternate.source.mimeType ?? alternate.mimeType).split(';', 1)[0]?.trim().toLowerCase();
  return primary.mode === 'direct'
    && alternate.mode === 'direct'
    && primary.mediaId === alternate.mediaId
    && !primary.mediaId.startsWith('path:')
    && Boolean(primary.source.sizeBytes && primary.source.sizeBytes > 0)
    && primary.source.sizeBytes === alternate.source.sizeBytes
    && primaryMime === alternateMime;
}

/**
 * PlaybackCoordinator is the sole owner of playback intent and source-generation
 * transitions. Transport commands are always local and immediate when the active
 * generation can represent them. Server work is restricted to creating/replacing
 * source generations and is coalesced behind the latest user intent.
 */
export class PlaybackCoordinator {
  private readonly log: ReturnType<typeof createClientLogger>;
  private readonly listeners = new Set<Listener>();
  private readonly unsubscribePlayer: () => void;
  private readonly unsubscribePlayerFailure?: () => void;
  private readonly unsubscribePlayerDegradation?: () => void;
  private disposed = false;
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private closeOptions: PlaybackStopOptions = {};
  private mutationLoop?: Promise<void>;
  private pendingMutation?: PendingMutation;
  private debouncedSeekMutation?: PendingMutation;
  private seekDebounceTimer?: ReturnType<typeof setTimeout>;
  private activeMutation?: { reason: PendingMutation['reason']; controller: AbortController; settled: Promise<void> };
  private lastSeekTransitionAt = 0;
  private mutationRevision = 0;
  private sourceActivationRevision = 0;
  private positionRevision = 0;
  private seekIntentActive = false;
  /**
   * The last position the player reported while `seekIntentActive` was held,
   * so that "the player is tracking again" can be recognised without it having
   * to land on a target it may never be asked to hit.
   */
  private seekIntentPositionMs?: number;
  /**
   * Whether the held transport target was pinned by a source actually being
   * presented, rather than by a viewer asking to go somewhere.
   *
   * The two want opposite treatment from a player that is reporting progress,
   * and conflating them has now caused a fault in each direction.
   */
  private seekIntentPinnedByPresentation = false;
  /** The last position the player itself reported, independent of optimistic seek intent. */
  private lastObservedPositionMs?: number;
  private failoverPromise?: Promise<void>;
  private readonly alternateSessions = new Map<string, PlaybackSession>();
  private readonly alternatePreparations = new Set<Promise<void>>();
  private readonly alternateExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private streamOffsetMs = 0;
  /** Latest server-side session state; may be ahead of the source currently visible. */
  private serverSession?: PlaybackSession;
  /**
   * Sessions a move has left behind and still owes a close, held until the
   * player stops presenting them.
   *
   * **Release after the cut, never before it.** A host that prepares the
   * replacement on a second element keeps the outgoing one playing -- and
   * fetching -- until the join is resident, measured at 36 s on the web client
   * on 2026-09-23. Closing at activation made every one of those fetches a
   * `404` against a session core had deleted itself, and the reap path read
   * them as the current generation dying. Flushed from `setSession`, which is
   * the cut, and by `close()`, which ends the need to wait for one.
   */
  private readonly releaseAfterCut = new Set<string>();
  /**
   * The Direct Play source actually loaded into the player right now, kept
   * distinct from `serverSession.source`. A silently promoted alternate
   * (see `promoteSilentDirectAlternate`) moves session bookkeeping forward
   * without ever touching the player, so the read-ahead worker's fallback
   * registration must keep addressing the URL genuinely loaded in the video
   * element — not whatever session is current for lifecycle purposes — or
   * it targets a source key the worker never configured.
   */
  private activeDirectPlaySource?: PlaybackSource;

  private regenerationPromise?: Promise<void>;
  /**
   * The viewer position the last regeneration was started from.
   *
   * The loop stop. A `404` means either a reaped session or a fragment past
   * the end of the plan, and only the first is fixed by regenerating — so a
   * player that keeps asking for something no plan will ever contain would
   * otherwise regenerate, ask again, regenerate, for as long as the viewer sat
   * there. Arriving here twice at the same position means the last
   * regeneration changed nothing, and the next step has to be a different one.
   */
  private lastRegenerationPositionMs?: number;
  /** Set once the decode fallback has been taken; see `fallBackFromUndecodable`. */
  private decodeFallbackTaken = false;
  /** Set by the viewer's own `update` with a mode; see `viewerChoseMode`. */
  private viewerModeChoice?: boolean;

  /**
   * A replacement generation that is built and waiting for the buffered
   * runway to run down. See `HELD_REPLACEMENT_SWAP_FLOOR_MS`.
   *
   * **It holds the node's video transcode slot for as long as it is held**,
   * and that is a deliberate decision rather than an oversight: the viewer
   * whose session was reaped is the same viewer the slot would be held for, so
   * nobody else is being kept out of something they were using. It does mean
   * this must be released on every path that abandons it — closing, seeking,
   * failing over — which is why it is torn down in `close()` alongside the
   * standbys rather than left to `serverSession`, which still points at the
   * source actually playing.
   */
  private pendingReplacement?: PlaybackSession;
  private pendingReplacementTimer?: ReturnType<typeof setTimeout>;

  /**
   * When the last player event landed, on the duration clock.
   *
   * The runway is a *measurement with an age*, and every decision that spends
   * it happens after at least one round trip. On the terminal path the player
   * has by definition stopped sending events, so the age is unbounded there.
   */
  private lastPlayerEventAt?: number;
  /**
   * The last element cover a player event gave core reason to trust, and when.
   *
   * Kept so a tearing-down element reporting an empty buffer cannot erase a
   * figure that was true a moment earlier. See `emptyBufferIsEvidence`.
   */
  private trustedElementRunway?: { ms: number; at: number };

  private snapshot: PlaybackCoordinatorSnapshot;

  constructor(private readonly options: PlaybackCoordinatorOptions) {
    this.log = createClientLogger('playback.coordinator', { mediaId: options.media.id });
    const initialPositionMs = Math.max(0, options.initialPositionMs);
    this.snapshot = {
      intent: { positionMs: initialPositionMs, paused: false },
      event: {
        positionMs: initialPositionMs,
        durationMs: options.media.durationMs ?? 0,
        paused: true,
        ended: false,
      },
      starting: true,
      preparingSource: false,
    };
    this.unsubscribePlayer = options.player.subscribe((event) => this.onPlayerEvent(event));
    this.unsubscribePlayerFailure = options.player.subscribeFailure?.((error) => this.fail(error));
    this.unsubscribePlayerDegradation = options.player.subscribeDegradation?.((error) => this.degrade(error));
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): PlaybackCoordinatorSnapshot {
    return {
      ...this.snapshot,
      intent: { ...this.snapshot.intent },
      event: { ...this.snapshot.event },
      pendingPreferences: this.snapshot.pendingPreferences
        ? { ...this.snapshot.pendingPreferences }
        : undefined,
    };
  }

  start(): Promise<void> {
    if (!this.startPromise) this.startPromise = this.startInternal();
    return this.startPromise;
  }

  /**
   * The viewer's preferences, with a concrete instruction filled in when they
   * have not chosen one.
   *
   * An explicit choice always wins: the Mode control must mean what it says,
   * including when it is wrong, because it is the operator's escape hatch.
   */
  private cachedFacts?: Promise<readonly FileFacts[] | undefined>;
  private factsError?: unknown;
  private factsAttempts = 0;
  private chosenInstruction?: PlaybackInstruction;
  private substitutionReportedFor?: string;
  private unclassifiedReportedFor?: string;

  private facts(): Promise<readonly FileFacts[] | undefined> {
    // Cached for this generation so a viewer can toggle the mode control
    // repeatedly without a round trip each time. The media's own facts are
    // immutable, so that part is always safe.
    //
    // `operations` is not: it describes the answering node's build, and
    // failover can move playback to a node with different abilities. The
    // cached value is then stale in the one direction that matters, and the
    // instruction it produced can be refused. That is deliberately left to
    // the 400 path in `resolveInstructed` rather than re-fetched on every
    // failover — a refusal is loud and recoverable, whereas re-probing on
    // each attempt would put a request on the viewer's critical path during
    // the exact moment playback is already struggling.
    //
    // **A failure is not cached.** Caching the *answer* is right; caching a
    // thrown lookup meant one transient fault — a node 500ing, a blip, a
    // request issued microseconds before the session existed — permanently
    // condemned this generation to the factless fallback, with no retry
    // possible for as long as playback lasted. That is what a viewer met: a
    // facts call that failed 18 ms after load, and a picture that never
    // recovered even once the cluster was answering perfectly.
    if (this.cachedFacts) return this.cachedFacts;
    const attempt = Promise.resolve(this.options.facts?.(this.options.media))
      .then(filesFrom)
      .catch((error: unknown) => {
        // Kept, not swallowed: a thrown lookup and an absent supplier both
        // yield undefined, and they are not the same thing at all.
        this.factsError = error;
        return undefined;
      });
    this.cachedFacts = attempt;
    void attempt.then((facts) => {
      // Bounded: a failed attempt is forgotten so the next caller may try
      // again, up to a budget. Unbounded retry would put a request on the
      // viewer's critical path every time they touched the mode control while
      // a node was down, which is the cost the caching was there to avoid.
      if (facts !== undefined) return;
      if (this.factsError === undefined) return;
      if (this.factsAttempts >= FACTS_ATTEMPT_BUDGET) return;
      this.factsAttempts += 1;
      if (this.cachedFacts === attempt) this.cachedFacts = undefined;
    });
    return attempt;
  }

  private async instructedPreferences(
    preferences: PlaybackPreferencesUpdate,
    capabilities: PlaybackCapabilities,
  ): Promise<PlaybackPreferencesUpdate> {
    this.capabilitiesSeen = capabilities;
    if (preferences.mode !== undefined && preferences.mode !== 'choose') {
      // The viewer chose how to play; which file is still core's to choose
      // (Tom, 2026-09-25: "on direct play, something still has to pick which
      // media to direct play"). The ranking's best file is the one that plays
      // with least conversion, so under the viewer's direct it is a file this
      // device plays directly, where the item has one. Facts are fetched only
      // for an item with several files; one file names itself.
      //
      // From server 0.58.0 the node chooses nothing else either: a remux or a
      // transcode names its container, and a file with several video or audio
      // streams names the one to play. The container is the device's; the
      // streams come from the file's facts where there are any, and a node
      // that still finds a choice open says which (`choice_required`), which
      // the resolver answers.
      const { mediaId, profile } = await this.fileForViewerMode(preferences.mode, preferences.mediaId, capabilities);
      const container = preferences.container
        ?? (preferences.mode === 'direct' ? undefined : segmentContainer(capabilities, this.options.policyOverrides).container);
      const streams = profile ? streamsToName(profile, preferences.mode, preferences) : undefined;
      this.patchSnapshot({ instruction: {
        mode: preferences.mode, video: preferences.video, audio: preferences.audio,
        container,
        reasons: [], assumed: [], chosenByViewer: true, withoutFacts: false,
        ...(mediaId ? { mediaId } : {}),
      } });
      // With facts the languages are resolved into `streams`, and sent as
      // indexes; without, they go as given and the resolver drops one the
      // node refuses.
      return { ...(streams ? withoutLanguages(preferences) : preferences), ...streams, ...(container ? { container } : {}), ...(mediaId ? { mediaId } : {}) };
    }

    const facts = await this.facts();
    if (!facts) {
      // Three different situations reach here and only one is expected, so
      // they are logged apart rather than as one warning: no supplier is a
      // configuration, a supplier returning undefined is a media without
      // facts, and a supplier throwing is a fault that has just cost this
      // viewer their picture quality.
      if (this.factsError !== undefined) {
        this.log.error('instruction-facts-failed', { mediaId: this.options.media.id, error: this.factsError });
      } else if (this.options.facts === undefined) {
        this.log.warn('instruction-without-facts-supplier', { mediaId: this.options.media.id });
      }
      // No facts to reason from. Transcode is the only instruction that is
      // always performable, so it is the safe answer — never a corrupt
      // picture, at the cost of quality nobody can verify was needed.
      //
      // The carriage is not part of that concession, and asking for none was
      // not a neutral omission. A host states a segment container because the
      // other one is broken on its device, which is true whether or not a
      // facts lookup answered: `segmentContainer` needs neither the profile
      // nor the node's operations to decide it. Left out, a Samsung host that
      // asked for MPEG-TS got whatever the node defaults to — fMP4 — and
      // failover then faithfully restated that wrong answer into every
      // replacement. Silent starvation, which is the class 0.6.3 already paid
      // for once.
      const { container } = segmentContainer(capabilities, this.options.policyOverrides);
      this.patchSnapshot({ instruction: {
        mode: 'transcode', video: 'transcode', audio: 'transcode', container,
        reasons: ['no-technical-facts'], assumed: [], chosenByViewer: false, withoutFacts: true,
        ...(this.factsError !== undefined ? { factsError: this.factsError } : {}),
      } });
      const fileId = preferences.mediaId ?? this.noFactsMediaId();
      this.log.warn('instruction-without-facts', { mediaId: this.options.media.id, container, fileId });
      return { ...preferences, mode: 'transcode', container, ...(fileId ? { mediaId: fileId } : {}) };
    }

    // Every file, and the one that plays best, ranked as the server itself
    // ranked them before the choice was the client's: direct, then remux, then
    // transcode, and stored order between equals.
    const choice = chooseAmongFiles(facts, capabilities, { overrides: this.options.policyOverrides }, this.options.media.mediaIds)!;
    const instruction = choice.instruction;
    const chosenMediaId = choice.mediaId ?? this.noFactsMediaId();
    const streams = streamsToName(facts[choice.index]!.profile, instruction.mode, preferences);
    this.log.info('instruction-chosen', {
      mediaId: this.options.media.id,
      assumed: instruction.assumed,
      mode: instruction.mode,
      video: instruction.video,
      audio: instruction.audio,
      container: instruction.container,
      reasons: instruction.reasons,
      chosenMediaId,
      files: facts.length,
      ...streams,
    });
    this.chosenInstruction = instruction;
    this.patchSnapshot({ instruction: {
      mode: instruction.mode, video: instruction.video, audio: instruction.audio,
      container: instruction.container,
      reasons: instruction.reasons, assumed: instruction.assumed,
      chosenByViewer: false, withoutFacts: false,
      ...(chosenMediaId ? { mediaId: chosenMediaId } : {}),
    } });
    return { ...withoutLanguages(preferences), ...instructionPreferences(instruction), ...streams, ...(chosenMediaId ? { mediaId: chosenMediaId } : {}) };
  }

  /**
   * Ask for the chosen instruction, and if the node refuses to perform it,
   * ask once for less.
   *
   * A refusal here is not a client bug. The chooser reasons about the media
   * and the device; whether *this* build can copy E-AC-3 into fragmented MP4
   * is a fact about the server that nothing currently reports before it is
   * asked. So a wholly correct instruction can be refused, and the viewer
   * gets nothing at all.
   *
   * Deliberately narrow, because a silent downgrade would hide server bugs:
   * once only, never over a mode the viewer chose themselves, and only for a
   * 400 — the node saying "I cannot do this", as distinct from 429 capacity
   * or 5xx health, which failover handles and which degrading would mask.
   * The downgrade is logged and surfaced as a notice rather than swallowed.
   */
  private async resolveInstructed(
    capabilities: PlaybackCapabilities,
    positionMs: number,
    preferences: PlaybackPreferencesUpdate,
  ): Promise<PlaybackSession> {
    try {
      return await this.options.resolver.resolve(this.options.media, capabilities, positionMs, preferences);
    } catch (error) {
      const degraded = this.degradedInstructionFor(error);
      if (!degraded) throw error;
      this.applyDegradedInstruction(degraded, error);
      return await this.options.resolver.resolve(
        this.options.media,
        capabilities,
        positionMs,
        { ...preferences, ...instructionPreferences(degraded) },
      );
    }
  }

  /**
   * The file to play under a mode the viewer chose, and its profile where
   * facts gave one; see `instructedPreferences`. Facts are fetched for an item
   * with several files, to rank them, and for any mode but direct, to name
   * streams; a direct play of an item's only file needs none.
   */
  private async fileForViewerMode(
    mode: PlaybackMode,
    named: string | undefined,
    capabilities: PlaybackCapabilities,
  ): Promise<{ mediaId?: string; profile?: MediaTechnicalProfile }> {
    const mediaIds = this.options.media.mediaIds;
    if (mode === 'direct' && (named !== undefined || mediaIds.length <= 1)) return { mediaId: named ?? mediaIds[0] };
    const facts = await this.facts();
    // Without facts there is nothing to rank, and the server no longer
    // chooses for us, so the first file stands in (see `noFactsMediaId`).
    if (!facts) return { mediaId: named ?? this.noFactsMediaId() };
    if (named !== undefined) return { mediaId: named, profile: facts.find((file) => file.mediaId === named)?.profile };
    const choice = chooseAmongFiles(facts, capabilities, { overrides: this.options.policyOverrides }, mediaIds);
    return { mediaId: choice?.mediaId ?? this.noFactsMediaId(), profile: choice ? facts[choice.index]?.profile : undefined };
  }

  /**
   * The file to name when there are no facts to choose from: the item's
   * first, in stored order. The server is to stop choosing among an item's
   * files and refuse a create that names none, so naming nothing is not an
   * option. With no facts the instruction is a transcode, which any file can
   * serve.
   */
  private noFactsMediaId(): string | undefined {
    return this.options.media.mediaIds[0];
  }

  /** The capabilities the last instruction was formed for; see `drainMutations`. */
  private capabilitiesSeen?: PlaybackCapabilities;

  /**
   * The viewer named the mode themselves, so nothing here may quietly change
   * it: at the start, or later through `update`, which overrides the start.
   */
  private get viewerChoseMode(): boolean {
    return this.viewerModeChoice ?? (this.options.initialPreferences?.mode ?? 'choose') !== 'choose';
  }

  /**
   * The one step down this failure allows, or nothing.
   *
   * Narrow on purpose, and the narrowness is the point: only a 400 — the node
   * saying it cannot perform this, as distinct from 429 capacity or 5xx health
   * — only against an instruction the chooser produced, and never over a mode
   * the viewer chose themselves.
   */
  private degradedInstructionFor(error: unknown): PlaybackInstruction | undefined {
    const instruction = this.chosenInstruction;
    if (this.viewerChoseMode || !instruction || !isExecutorRefusal(error)) return undefined;
    return degradeInstruction(instruction);
  }

  /**
   * Record a downgrade as the instruction this generation is now running on.
   *
   * The snapshot report is patched, not just the private field. It was not,
   * and the gap mattered twice over: a host's diagnostics went on showing
   * `video: 'copy'` for a generation the node had refused to copy, and — once
   * recoveries began restating the transforms — the value a replacement would
   * have been rebuilt from was the refused one, so every recovery re-asked for
   * the copy the first attempt had already given up on.
   */
  private applyDegradedInstruction(degraded: PlaybackInstruction, error: unknown, notice: PlaybackNotice = { code: 'copy-refused' }): void {
    const instruction = this.chosenInstruction;
    this.log.warn('instruction-degraded', {
      mediaId: this.options.media.id,
      from: { video: instruction?.video, audio: instruction?.audio, mode: instruction?.mode },
      to: { video: degraded.video, audio: degraded.audio, mode: degraded.mode },
      error,
    });
    this.chosenInstruction = degraded;
    this.patchSnapshot({
      instruction: {
        ...this.snapshot.instruction,
        mode: degraded.mode,
        video: degraded.video,
        audio: degraded.audio,
        container: degraded.container,
        reasons: degraded.reasons,
        assumed: degraded.assumed,
        chosenByViewer: false,
        withoutFacts: this.snapshot.instruction?.withoutFacts ?? false,
      },
      notice,
    });
  }

  /**
   * The player could not decode what a copied generation handed it, so ask the
   * same node for a transcode at the viewer's position, once.
   *
   * Tom's ruling, 2026-09-24. Found on the Android TV set: an AVI with MPEG-4
   * Part 2 video failed in the hardware decoder. The failure moved node, which
   * cannot help, because a decode failure follows the file to every node; a
   * transcode played it.
   *
   * - Only for `media` or `unsupported`, the kinds that are facts about the
   *   bytes and not about the node.
   * - Only for a generation that copied something. A transcode that will not
   *   decode is not fixed by another one.
   * - Never over a mode the viewer chose themselves. Then the failure ends
   *   playback as before, and the host may offer a transcode.
   * - Once per playback. A second decode failure ends it.
   */
  private fallBackFromUndecodable(session: PlaybackSession, error: Error): boolean {
    if (!(error instanceof PlaybackSourceError) || (error.kind !== 'media' && error.kind !== 'unsupported')) return false;
    const instruction = this.chosenInstruction;
    if (this.decodeFallbackTaken || this.viewerChoseMode || !instruction || !session.options.modes.includes('transcode')) return false;
    const degraded = transcodeUndecodable(instruction);
    if (!degraded) return false;
    this.decodeFallbackTaken = true;
    this.log.warn('decode-failed-transcoding', { sessionId: session.sessionId, mode: session.mode, kind: error.kind, error });
    this.applyUpdate({ preferences: instructionPreferences(degraded) });
    // After the update, which clears the notice when it queues a change.
    this.applyDegradedInstruction(degraded, error, { code: 'decode-fallback', error });
    return true;
  }

  /**
   * Build a replacement from the current preferences, and give up the copies
   * once if the node refuses them.
   *
   * Restating `video`/`audio` is what stops a recovery silently re-encoding a
   * stream that was being passed through — but it also asks a node that has
   * never agreed to that copy to perform it, and a 400 is **not** a retryable
   * endpoint failure: `create` throws it rather than walking to the next
   * candidate. Without this the fix would trade a silent full transcode for a
   * terminal failure, which is the worse of the two by a distance.
   *
   * So the fallback is exactly as wide as the restatement that needs it. It
   * fires only when this request actually asked a node to copy something; a
   * 400 for any other reason is rethrown untouched, leaving the behaviour of
   * every path that existed before this identical.
   *
   * **Standby preparation deliberately does not use it.** A downgrade here
   * rewrites the instruction the *live* generation will be rebuilt from, and a
   * weak node refusing a copy it was only ever offered speculatively must not
   * decide that for the session the viewer is watching. A standby that cannot
   * reproduce the generation is not a standby; it simply does not get made.
   */
  private async recoverWithPreferences<T>(
    session: PlaybackSession,
    run: (preferences: PlaybackPreferencesUpdate) => Promise<T>,
  ): Promise<T> {
    const preferences = this.currentPreferences(session);
    try {
      return await run(preferences);
    } catch (error) {
      if (preferences.video !== 'copy' && preferences.audio !== 'copy') throw error;
      const degraded = this.degradedInstructionFor(error);
      if (!degraded) throw error;
      this.applyDegradedInstruction(degraded, error);
      // The container is left as `currentPreferences` settled it. It was
      // decided by rules that have already run over the pending preferences,
      // and the instruction's copy of it is the older answer of the two.
      return await run({
        ...preferences,
        mode: degraded.mode,
        video: degraded.video,
        audio: degraded.audio,
      });
    }
  }

  private async startInternal(): Promise<void> {
    if (this.disposed) return;
    const startedAt = machaHost().now();
    try {
      const capabilities = await this.options.capabilities();
      if (this.disposed) return;
      const requestedPositionMs = this.snapshot.intent.positionMs;
      const requestedPositionRevision = this.positionRevision;
      const session = await this.resolveInstructed(
        capabilities,
        requestedPositionMs,
        await this.instructedPreferences(this.options.initialPreferences ?? {}, capabilities),
      );
      if (this.disposed) {
        await this.options.resolver.stop(session.sessionId, this.closeOptions).catch(() => undefined);
        return;
      }
      this.log.info('initial-generation-ready', {
        sessionId: session.sessionId,
        mode: session.mode,
        requestedPositionMs,
        serverSeekMs: session.seekMs,
        elapsedMs: Math.round((machaHost().now() - startedAt) * 10) / 10,
      });
      this.serverSession = session;

      const currentDesired = this.snapshot.intent.positionMs;
      const userMovedDuringResolve = requestedPositionRevision !== this.positionRevision;
      if (userMovedDuringResolve && this.activationPosition(session, currentDesired) === undefined) {
        this.scheduleSeekMutation({
          reason: 'seek',
          update: {
            seekMs: currentDesired,
            preferences: preservedSeekPreferences(session),
          },
        });
      } else {
        // A transformed generation rarely begins exactly where it was asked to.
        // Since server 0.46.0 a remux begins at the last keyframe at or
        // *before* the request and reports the remainder as `seek_offset_ms`,
        // so the requested position is inside the generation and activation
        // simply attaches at it. Older nodes aligned the other way, after the
        // request; `activationPosition` is where that difference is handled.
        this.activateSession(session, currentDesired, 'relocate');
      }
    } catch (error) {
      this.fail(error);
    } finally {
      if (!this.disposed) {
        this.patchSnapshot({ starting: false });
      }
    }
  }

  close(options: PlaybackStopOptions = {}): Promise<void> {
    if (options.keepalive) this.closeOptions = { ...this.closeOptions, keepalive: true };
    if (this.closePromise) return this.closePromise;

    this.disposed = true;
    this.mutationRevision += 1;
    this.sourceActivationRevision += 1;
    this.pendingMutation = undefined;
    this.debouncedSeekMutation = undefined;
    this.activeMutation?.controller.abort(abortError('Playback coordinator closed'));
    if (this.seekDebounceTimer !== undefined) clearTimeout(this.seekDebounceTimer);
    this.seekDebounceTimer = undefined;
    this.unsubscribePlayer();
    this.unsubscribePlayerFailure?.();
    this.unsubscribePlayerDegradation?.();
    // Coordinator teardown ends source acquisition immediately, but deliberately
    // leaves DOM-host ownership to PlaybackRuntime/PlayerHost.
    this.options.player.stop();
    const ownedAtClose = this.serverSession ?? this.snapshot.session;
    if (this.pendingReplacementTimer !== undefined) clearTimeout(this.pendingReplacementTimer);
    this.pendingReplacementTimer = undefined;
    // Only a decision, never a session — see `discardPendingReplacement`. The
    // shape this replaced had a live generation here holding the node's only
    // transcode slot, which had to be closed explicitly or leaked for thirty
    // minutes. Deferring creation removed the obligation rather than meeting
    // it better.
    this.pendingReplacement = undefined;

    this.closePromise = (async () => {
      await this.startPromise?.catch(() => undefined);
      await this.mutationLoop?.catch(() => undefined);
      // A recovery in flight is still negotiating a replacement session on
      // another node, and that session is created *after* this point. Both
      // paths stop what they built once they see `disposed`, so nothing is
      // orphaned — but that stop is the last thing this coordinator owes the
      // cluster, and without waiting for it `close()` resolves while it is
      // still outstanding. A host that tears down auth on the strength of
      // that resolution races its own `DELETE`.
      //
      // Nothing can start a new recovery from here: `close()` has already
      // unsubscribed the failure channel, and every entry point re-checks
      // `disposed` after each await, so these two promises are all there is.
      await this.failoverPromise?.catch(() => undefined);
      await this.regenerationPromise?.catch(() => undefined);
      await Promise.all([...this.alternatePreparations].map((preparation) => preparation.catch(() => undefined)));
      const session = this.serverSession ?? this.snapshot.session ?? ownedAtClose;
      // Waiting for a cut that will now never come. Released here rather than
      // at the cut, with the same options as the session below.
      const retired = [...this.releaseAfterCut].filter((id) => id !== session?.sessionId);
      this.releaseAfterCut.clear();
      await Promise.all(retired.map((id) => this.stopOnDisposal(id)));
      if (session) {
        try {
          await this.options.resolver.stop(session.sessionId, this.closeOptions);
        } catch (error) {
          this.log.warn('session-close-failed', { sessionId: session.sessionId, error });
        }
      }
      for (const alternate of this.alternateSessions.values()) {
        if (alternate.sessionId === session?.sessionId) continue;
        await this.options.resolver.stop(alternate.sessionId, this.closeOptions).catch((error) => {
          this.log.warn('alternate-session-close-failed', { sessionId: alternate.sessionId, error });
        });
      }
      this.alternateSessions.clear();
      for (const timer of this.alternateExpiryTimers.values()) clearTimeout(timer);
      this.alternateExpiryTimers.clear();
      this.listeners.clear();
    })();
    return this.closePromise;
  }

  ownedSessionId(): string | undefined {
    return (this.serverSession ?? this.snapshot.session)?.sessionId;
  }

  setPaused(paused: boolean): void {
    if (this.disposed) return;
    const intent = { ...this.snapshot.intent, paused };
    this.patchSnapshot({ intent });
    if (paused) this.options.player.pause();
    else this.options.player.resume();
    // A paused element reports nothing and owes nothing: its runway is not
    // being spent. Disarmed on pause, restarted on resume.
    this.armPendingReplacementGuard();
    this.log.info(paused ? 'pause-intent' : 'play-intent', {
      sessionId: this.snapshot.session?.sessionId,
      positionMs: intent.positionMs,
    });
  }

  seek(positionMs: number): boolean {
    if (this.disposed) return false;
    const session = this.snapshot.session;
    // Refused before anything is recorded. The intent used to move first, so
    // a refused seek left the coordinator waiting for a position the player
    // would never reach: real positions were ignored, `seekBy` built on the
    // phantom, and a failover asked the next node to start there.
    if (session && !session.options.canSeek) {
      this.patchSnapshot({ notice: { code: 'cannot-seek' } });
      return false;
    }
    // A pending replacement is built *now* rather than discarded, and both
    // reasons are load-bearing: a seek throws away the buffered runway the
    // deferral was protecting, so there is nothing left to wait for; and until
    // it is built `serverSession` still names the session the node reaped, so
    // the seek's own mutation would PATCH a session answering 404 and be read
    // as the replacement failing. Built after the intent moves below, so the
    // new generation is created at the position the viewer asked for.
    const pendingAtSeek = this.pendingReplacement;
    const durationMs = session?.durationMs || this.snapshot.event.durationMs || this.options.media.durationMs;
    const bounded = clampPosition(positionMs, durationMs);
    this.lastSeekTransitionAt = Date.now();
    this.positionRevision += 1;
    this.seekIntentActive = true;
    // Pinned by the viewer, not by a source appearing. Until the generation
    // they asked for is actually presented, nothing the outgoing source
    // reports may lower this — it is still playing, still moving, and still
    // somewhere else entirely.
    this.seekIntentPinnedByPresentation = false;
    this.seekIntentPositionMs = undefined;
    if (pendingAtSeek) {
      this.patchSnapshot({ intent: { ...this.snapshot.intent, positionMs: bounded } });
      void this.buildReplacement(pendingAtSeek, 'seek');
      return true;
    }
    const intent = { ...this.snapshot.intent, positionMs: bounded };
    this.patchSnapshot({
      intent,
      event: { ...this.snapshot.event, positionMs: bounded, ended: false },
      notice: undefined,
    });

    if (!session) {
      this.log.info('seek-intent-before-generation', { positionMs: bounded });
      return true;
    }

    const localPositionMs = this.activeLocalPosition(session, bounded);
    if (localPositionMs !== undefined) {
      this.cancelInFlightSeek();
      this.cancelDebouncedSeek();
      this.log.info('seek-local', {
        sessionId: session.sessionId,
        mode: session.mode,
        absolutePositionMs: bounded,
        localPositionMs,
      });
      this.options.player.seek(localPositionMs);
      return true;
    }

    this.log.info('seek-needs-generation', {
      sessionId: session.sessionId,
      mode: session.mode,
      absolutePositionMs: bounded,
      generationStartMs: session.seekMs,
      localCoverage: this.options.player.localSeekCoverage(),
    });
    this.cancelInFlightSeek();
    this.scheduleSeekMutation({
      reason: 'seek',
      update: {
        seekMs: bounded,
        preferences: preservedSeekPreferences(session),
      },
    });
    return true;
  }

  seekBy(deltaMs: number): boolean {
    const base = this.seekIntentActive ? this.snapshot.intent.positionMs : this.snapshot.event.positionMs;
    return this.seek(base + deltaMs);
  }

  private activeLocalPosition(session: PlaybackSession, absolutePositionMs: number): number | undefined {
    const localPositionMs = generationLocalPosition(session, absolutePositionMs);
    if (localPositionMs === undefined) return undefined;
    return rangeContainsPosition(this.options.player.localSeekCoverage(), localPositionMs)
      ? localPositionMs
      : undefined;
  }

  private activationPosition(
    session: PlaybackSession,
    desiredAbsoluteMs: number,
  ): number | undefined {
    const localPositionMs = generationLocalPosition(session, desiredAbsoluteMs);
    if (localPositionMs !== undefined) return localPositionMs;

    // Nothing in this generation corresponds to where the viewer is: it begins
    // after them. What to do about that depends entirely on *why*, and the two
    // reasons want opposite handling.
    //
    // **A node that reports `seekOffsetMs` cannot have overshot.** The 0.46.0
    // contract begins a remux generation at the last keyframe at or *before*
    // the request and carries the remainder as the offset, so the generation
    // always contains the position that was asked for. Reaching here against
    // such a node therefore means the viewer moved *backwards* while it was
    // being negotiated — a seek they made, not an alignment artefact. So
    // renegotiate, which is what returning `undefined` asks the callers to do.
    //
    // **That is only safe because the snap direction changed.** Rejecting was
    // tried before and livelocked: a node aligning *forward* is deterministic,
    // so asking again for the same position returned the same unusable
    // generation for ever. Measured — 147 negotiations in 33.3 s, every
    // `serverSeekMs` identical, nothing ever activated, the viewer's seek never
    // happening and the node taking four requests a second for its trouble.
    // Against a backward-snapping node the next answer contains the request, so
    // it converges in one round; against a forward-snapping one it cannot
    // converge at all.
    //
    // Hence the gate, rather than deleting the fallback outright: `undefined`
    // means the node predates 0.46.0 and may still snap forward, and for those
    // the only terminating behaviour is to take the generation's own origin.
    // Reporting that origin rather than the position asked for is what stops a
    // viewer who lands 8.9 s late losing 8.9 s of film invisibly.
    if (session.seekOffsetMs !== undefined) return undefined;
    return 0;
  }

  update(update: PlaybackUpdate): void {
    if (this.disposed) return;
    // The viewer's own word on the mode, which a fallback must not override.
    // Only here: core's own changes go through `applyUpdate` and say nothing
    // about what the viewer wants.
    if (this.snapshot.session && update.preferences?.mode !== undefined) {
      this.viewerModeChoice = update.preferences.mode !== 'choose';
      if (update.preferences.mode !== 'choose') this.reportViewerChoice(update.preferences);
    }
    this.applyUpdate(update);
  }

  /**
   * Report a mode the viewer chose partway through as theirs.
   *
   * The report was set only where the chooser ran, at the start or on
   * "decide for me", so a concrete mode chosen mid-playback left the
   * automatic decision in the snapshot. Measured on the Android TV set
   * 2026-09-24: Transcode chosen during playback, and the screen went on
   * saying the device played the file as it was. The container is kept when
   * the viewer did not name one, because later changes restate it from here.
   */
  private reportViewerChoice(preferences: PlaybackPreferencesUpdate): void {
    this.chosenInstruction = undefined;
    this.patchSnapshot({ instruction: {
      mode: preferences.mode as PlaybackMode,
      video: preferences.video,
      audio: preferences.audio,
      container: preferences.container ?? this.snapshot.instruction?.container,
      reasons: [], assumed: [], chosenByViewer: true, withoutFacts: false,
    } });
  }

  private applyUpdate(update: PlaybackUpdate): void {
    if (this.disposed) return;
    const session = this.snapshot.session;
    if (!session) {
      this.patchSnapshot({ notice: { code: 'not-ready' } });
      return;
    }

    // "Decide for me" must mean the same thing at any point in a session, not
    // only at the start. Without this the control appears to work — it
    // highlights — and changes nothing, because an absent mode leaves the
    // server on whatever it was already doing.
    if (update.preferences?.mode === 'choose') {
      void this.queueChosenInstruction(update);
      return;
    }

    const subtitleOnly = isSubtitleOnlyPlaybackUpdate(update);
    const prepared: PlaybackUpdate = subtitleOnly || !session.options.canSeek
      ? update
      : { ...update, seekMs: this.snapshot.intent.positionMs };
    this.queueMutation({
      reason: subtitleOnly ? 'subtitle' : 'representation',
      update: prepared,
    });
  }

  /**
   * Serve this title from a node the viewer chose, without stopping first.
   *
   * **Structurally a failover that nothing failed.** It is not an `update`:
   * `PlaybackUpdate` is `{preferences, seekMs, mediaId}` and a node is none of
   * those, and `resolver.update` is pinned to the node holding the generation
   * precisely because a session cannot move. The server settled that — the
   * session map is in-process and node-local, there is no replication and no
   * control-call forwarding, and a session owns node-local resources — so the
   * only possible shape is create there, promote, release here.
   *
   * **Acquire before release, which costs nothing.** `max_sessions_per_account`
   * is counted per node, so holding both generations across the swap does not
   * spend an account slot twice. A client that closed first and started after
   * measured a 13.2 s gap between fi-1 and gbni-1; this keeps the outgoing
   * generation presenting until the replacement is ready, which is what the
   * standby machinery was built for and could not be asked for deliberately.
   *
   * **The release cannot be skipped and is not the resolver's here.**
   * `resolver.failover()` releases the session it abandons, which is why the
   * failover path above closes nothing; `prepareOn` deliberately does not,
   * because the whole point is that the old generation is still serving. So
   * this owns the close, and it happens after activation rather than before —
   * a node left holding an abandoned transcode holds its slot for
   * `session_idle`, which is thirty minutes on the deployed cluster.
   *
   * Returns whether the move happened. `false` is an ordinary answer: already
   * on that node, no session yet, the endpoint unknown, or the node unwilling
   * to build an equivalent generation.
   *
   * **A lead, for a host that can hold through one.** A node produces a
   * generation sequentially from the position it is asked for, at no better
   * than realtime on the boxes that are slow to start, so a generation asked
   * for at the viewer's position begins one start-cost behind them and never
   * catches up. Measured on the web client on 2026-09-23: gbni-1 took 8.5 to
   * 12.3 s to a first fragment, the join lost the race both times, and the
   * picture froze for 15 to 19 s. So the move asks for the viewer's position
   * plus the lead, and the outgoing source plays on until the viewer reaches
   * the new generation, where the host cuts.
   *
   * The lead is `options.leadMs` where a host supplies one, otherwise core's
   * own estimate for that node and kind plus `MOVE_LEAD_MARGIN_MS`. No estimate
   * means no lead, which is the behaviour before estimates existed. **Only a
   * player declaring `holdsThroughLead` gets one**: any other host cannot keep
   * the outgoing source presenting until the viewer arrives, and a lead handed
   * to it is a skip forward.
   */
  async moveTo(endpointId: string, options: PlaybackMoveOptions = {}): Promise<boolean> {
    if (this.disposed) return false;
    const session = this.snapshot.session;
    if (!session) {
      this.patchSnapshot({ notice: { code: 'not-ready' } });
      return false;
    }
    if (session.endpoint?.id === endpointId) return false;
    if (!this.options.resolver.prepareOn) return false;

    const movingFrom = session.sessionId;
    const viewerPositionMs = this.snapshot.intent.positionMs;
    const leadMs = this.moveLeadMs(endpointId, session, viewerPositionMs, options);
    const requestedPositionMs = viewerPositionMs + leadMs;
    this.log.info('source-move-start', {
      fromEndpoint: session.endpoint,
      toEndpointId: endpointId,
      sessionId: movingFrom,
      positionMs: viewerPositionMs,
      leadMs,
      leadSource: leadMs === 0 ? 'none' : options.leadMs !== undefined ? 'host' : 'estimate',
    });
    this.patchSnapshot({ preparingSource: true, notice: undefined });
    try {
      const capabilities = await this.options.capabilities();
      // Everything below re-checks the world it was started against. A move is
      // a viewer's deliberate act and slower than one: they can seek, switch
      // mode or stop while the replacement is being built, and promoting onto
      // a session that is no longer the one being moved would swap the picture
      // for a generation of something else.
      if (this.disposed || this.snapshot.session?.sessionId !== movingFrom) return false;
      const moved = await this.options.resolver.prepareOn(
        endpointId,
        session,
        this.options.media,
        capabilities,
        requestedPositionMs,
        this.currentPreferences(session),
      );
      if (!moved) {
        this.patchSnapshot({ preparingSource: false });
        return false;
      }
      if (this.disposed || this.snapshot.session?.sessionId !== movingFrom) {
        await this.options.resolver.stop(moved.sessionId, this.closeOptions).catch(() => undefined);
        return false;
      }

      // A replacement decided for the generation being left is a decision
      // about a session this coordinator is about to stop owning. Same
      // reasoning as `beginSourceFailover`.
      this.discardPendingReplacement('move');
      // Released at the cut, not here: see `releaseAfterCut`. Its failure is
      // not the viewer's problem, and a node that will not answer reaps the
      // session on its own clock.
      this.releaseAfterCut.add(movingFrom);
      this.serverSession = moved;
      this.activateSession(moved, this.snapshot.intent.positionMs, 'continue', leadMs > 0);
      this.log.info('source-move-ready', {
        oldSessionId: movingFrom,
        newSessionId: moved.sessionId,
        endpoint: moved.endpoint,
        positionMs: this.snapshot.intent.positionMs,
      });
      this.patchSnapshot({ preparingSource: false, notice: undefined });
      return true;
    } catch (error) {
      // The outgoing generation was never touched, so there is nothing to
      // recover: the viewer is still watching what they were watching.
      this.log.warn('source-move-failed', { toEndpointId: endpointId, sessionId: movingFrom, error });
      this.patchSnapshot({ preparingSource: false });
      return false;
    }
  }

  /**
   * For a player that cannot ride a hold, wait until the node says this
   * generation has produced something. Every other player, and every source
   * the node gives no production reading for, goes straight through.
   */
  private waitsForProduction(session: PlaybackSession): boolean {
    return this.options.player.needsProducedSource === true
      && session.mode !== 'direct'
      && this.options.resolver.awaitProduced !== undefined
      && session.production !== undefined
      && !(session.production.producedMs > 0);
  }

  private async producedForPlayer(session: PlaybackSession): Promise<'produced' | 'gone' | 'unknown'> {
    const awaitProduced = this.options.resolver.awaitProduced?.bind(this.options.resolver);
    if (!awaitProduced) return 'unknown';
    const outcome = await awaitProduced(session).catch(() => 'unknown' as const);
    this.log.info('source-produced-wait', { sessionId: session.sessionId, outcome });
    return outcome;
  }

  /**
   * How far ahead of the viewer a move to this node should ask for.
   *
   * Zero unless the player can hold through a lead, and zero when the lead
   * would reach past the end of the title: there is nothing to ask for there,
   * and a move near the end is better made at the viewer's position than not
   * at all. Never remembered — re-read on every move, because a node's start
   * cost moves with its load.
   */
  private moveLeadMs(
    endpointId: string,
    session: PlaybackSession,
    viewerPositionMs: number,
    options: PlaybackMoveOptions,
  ): number {
    if (session.mode === 'direct') return 0;
    if (this.options.player.holdsThroughLead !== true) {
      if (options.leadMs !== undefined) {
        this.log.info('move-lead-ignored', { endpointId, leadMs: options.leadMs, reason: 'player-cannot-hold' });
      }
      return 0;
    }
    const estimate = this.options.resolver.startCostEstimate?.(endpointId, session);
    const requested = options.leadMs ?? (estimate === undefined ? 0 : estimate + MOVE_LEAD_MARGIN_MS);
    const leadMs = Number.isFinite(requested) ? Math.max(0, requested) : 0;
    if (leadMs === 0) return 0;
    const durationMs = session.durationMs;
    if (durationMs > 0 && viewerPositionMs + leadMs >= durationMs) return 0;
    return leadMs;
  }

  /**
   * Re-run the chooser with the same facts and policy as at creation, then
   * apply the result as an ordinary mutation. Re-entering `update` is
   * deliberate and cannot recurse: the resolved preferences carry a concrete
   * mode.
   */
  private async queueChosenInstruction(update: PlaybackUpdate): Promise<void> {
    try {
      const capabilities = await this.options.capabilities();
      if (this.disposed) return;
      const preferences = await this.instructedPreferences(
        { ...update.preferences, mode: undefined },
        capabilities,
      );
      if (this.disposed) return;
      this.applyUpdate({ ...update, preferences });
    } catch (error) {
      this.log.warn('instruction-rechoose-failed', { mediaId: this.options.media.id, error });
      this.patchSnapshot({ notice: { code: 'instruction-failed', error: asError(error) } });
    }
  }

  private queueMutation(next: PendingMutation): void {
    const existing = this.pendingMutation;
    this.pendingMutation = existing
      ? {
          reason: next.reason === 'representation' || existing.reason === 'representation'
            ? 'representation'
            : next.reason,
          update: mergePlaybackUpdate(existing.update, next.update),
        }
      : next;
    this.patchSnapshot({
      preparingSource: true,
      pendingPreferences: mergePreferences(this.snapshot.pendingPreferences, next.update.preferences),
      notice: next.reason === 'subtitle' ? { code: 'subtitles-loading' } : undefined,
    });
    this.mutationRevision += 1;
    this.startMutationLoop();
  }

  private startMutationLoop(): void {
    if (this.mutationLoop) return;
    this.mutationLoop = this.drainMutations().finally(() => {
      this.mutationLoop = undefined;
      // The loop returns when it finds nothing pending, and is only marked
      // stopped here, a microtask later. A change queued in between saw a loop
      // still "running", started none, and was never applied, while the line
      // below then cleared the flag that said it was coming. Seen as a
      // "decide for me" lost behind a fallback's update, 2026-09-24.
      if (!this.disposed && this.pendingMutation) {
        this.startMutationLoop();
        return;
      }
      if (!this.disposed && this.seekDebounceTimer === undefined && !this.debouncedSeekMutation) {
        this.patchSnapshot({ preparingSource: false, pendingPreferences: undefined });
      }
    });
  }

  private scheduleSeekMutation(next: PendingMutation): void {
    this.debouncedSeekMutation = this.debouncedSeekMutation
      ? {
          reason: 'seek',
          update: mergePlaybackUpdate(this.debouncedSeekMutation.update, next.update),
        }
      : next;
    if (this.seekDebounceTimer !== undefined) clearTimeout(this.seekDebounceTimer);
    this.patchSnapshot({ preparingSource: true, notice: undefined });
    const elapsedMs = Date.now() - this.lastSeekTransitionAt;
    const delayMs = Math.max(0, UNCACHED_SEEK_DEBOUNCE_MS - elapsedMs);
    this.seekDebounceTimer = setTimeout(() => {
      this.seekDebounceTimer = undefined;
      const pending = this.debouncedSeekMutation;
      this.debouncedSeekMutation = undefined;
      if (!pending || this.disposed) return;
      this.queueMutation(pending);
    }, delayMs);
  }

  private cancelDebouncedSeek(): void {
    if (this.seekDebounceTimer !== undefined) clearTimeout(this.seekDebounceTimer);
    this.seekDebounceTimer = undefined;
    this.debouncedSeekMutation = undefined;
    if (!this.mutationLoop && !this.pendingMutation) {
      this.patchSnapshot({ preparingSource: false });
    }
  }

  private cancelInFlightSeek(): void {
    const active = this.activeMutation;
    if (active?.reason !== 'seek' || active.controller.signal.aborted) return;
    active.controller.abort(abortError('Seek superseded by newer viewer intent'));
  }

  /**
   * `seek()` pins its target optimistically, and until the player reports
   * reaching it `onPlayerEvent` deliberately ignores real positions. A
   * mutation that never lands would otherwise leave that target pinned for
   * the rest of the session — the scrubber (`PlayerScreen` renders
   * `intent.positionMs`) frozen at a position playback never reached while it
   * plays on elsewhere, and resume requests derived from the same field.
   * Fall back to the last position the player actually reported, unless newer
   * seek intent is already queued to supersede this one anyway.
   */
  private rollbackUnfulfilledSeek(): void {
    if (!this.seekIntentActive || this.pendingMutation || this.debouncedSeekMutation) return;
    this.seekIntentActive = false;
    this.seekIntentPositionMs = undefined;
    const positionMs = this.lastObservedPositionMs;
    if (positionMs === undefined) return;
    this.patchSnapshot({
      intent: { ...this.snapshot.intent, positionMs },
      event: { ...this.snapshot.event, positionMs },
    });
  }

  private async drainMutations(): Promise<void> {
    while (!this.disposed) {
      const pending = this.pendingMutation;
      const current = this.serverSession ?? this.snapshot.session;
      if (!pending || !current) return;
      this.pendingMutation = undefined;
      const requestRevision = this.mutationRevision;
      // A queued generation mutation may have been formed before a newer local
      // transport intent arrived. Generation work is a correctness fallback, so
      // bind it to the latest position at dispatch time rather than preparing a
      // representation around stale transport state.
      const positioned = pending.reason === 'subtitle' || !current.options.canSeek
        ? pending.update
        : { ...pending.update, seekMs: this.snapshot.intent.positionMs };
      // A generation begun as direct asked for no container, and from server
      // 0.58.0 a remux or transcode must name one, so a change into either
      // names the device's own.
      const changedMode = positioned.preferences?.mode;
      const capabilities = this.capabilitiesSeen
        ?? ((changedMode === 'remux' || changedMode === 'transcode') && !this.snapshot.instruction?.container
          ? await this.options.capabilities() : undefined);
      const requestedContainer = this.snapshot.instruction?.container
        ?? ((changedMode === 'remux' || changedMode === 'transcode') && positioned.preferences?.container === undefined && capabilities
          ? segmentContainer(capabilities, this.options.policyOverrides).container
          : undefined);
      const update = namedStreamsForPatch(restatePreferencesClearedByMode(positioned, current, requestedContainer), current);
      const requestedPositionMs = update.seekMs ?? this.snapshot.intent.positionMs;
      const requestedPositionRevision = this.positionRevision;
      const startedAt = machaHost().now();
      const controller = new AbortController();
      let resolveSettled!: () => void;
      const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
      this.activeMutation = { reason: pending.reason, controller, settled };

      try {
        // AbortSignal cancels modern fetch implementations. The local race also
        // makes cancellation non-blocking on older TV engines whose fetch may
        // accept a signal but fail to terminate the underlying request.
        const next = await awaitUnlessAborted(
          this.options.resolver.update(current.sessionId, update, controller.signal),
          controller.signal,
        );
        if (this.disposed) return;
        this.serverSession = next;
        this.log.info('generation-update-ready', {
          sessionId: next.sessionId,
          mode: next.mode,
          reason: pending.reason,
          requestedPositionMs,
          serverSeekMs: next.seekMs,
          superseded: requestRevision !== this.mutationRevision,
          elapsedMs: Math.round((machaHost().now() - startedAt) * 10) / 10,
        });

        // Newer server-side intent is already queued. Do not churn the media
        // element through an intermediate representation that the user no
        // longer wants; the immutable current source can keep playing meanwhile.
        if (this.pendingMutation) continue;

        const currentDesired = this.snapshot.intent.positionMs;
        const userMovedDuringRequest = requestedPositionRevision !== this.positionRevision;
        if (userMovedDuringRequest && this.activationPosition(next, currentDesired) === undefined) {
          this.scheduleSeekMutation({
            reason: 'seek',
            update: {
              seekMs: currentDesired,
              preferences: preservedSeekPreferences(next),
            },
          });
          this.mutationRevision += 1;
          return;
        }

        if (pending.reason === 'subtitle' && sourceIdentity(current) === sourceIdentity(next) && this.options.player.setSubtitle) {
          await this.options.player.setSubtitle(next.source.subtitleUrl);
          if (!this.disposed) {
            this.setSession(next);
            this.patchSnapshot({ notice: undefined });
          }
          continue;
        }

        this.activateSession(next, currentDesired, pending.reason === 'seek' ? 'relocate' : 'continue');
        if (!this.disposed) this.patchSnapshot({ notice: undefined });
      } catch (error) {
        if (this.disposed) return;
        if (controller.signal.aborted) {
          this.log.debug('generation-update-superseded', {
            sessionId: current.sessionId,
            reason: pending.reason,
            update,
          });
          continue;
        }
        this.log.error('generation-update-failed', {
          sessionId: current.sessionId,
          reason: pending.reason,
          update,
          error,
        });
        const refusal = refusalOf(error);
        this.patchSnapshot({ notice: { code: 'update-failed', error: asError(error), ...(refusal ? { refusal } : {}) } });
        this.rollbackUnfulfilledSeek();
      } finally {
        if (this.activeMutation?.controller === controller) this.activeMutation = undefined;
        resolveSettled();
      }
    }
  }

  private activateSession(
    session: PlaybackSession,
    desiredAbsoluteMs: number,
    transition: PlaybackTransition,
    ahead = false,
  ): void {
    if (this.disposed) return;
    // Catalogue profiling may already have prepared the reusable player. The
    // session supplies the same facts authoritatively and completes that setup
    // without introducing another awaited step in source activation.
    this.options.player.prepare?.(technicalProfileFromSession(session));
    const activationRevision = ++this.sourceActivationRevision;
    this.releaseObsoleteAlternates(session.sessionId);
    // A generation asked for ahead of the viewer begins after them, on purpose.
    // The renegotiation below exists for a viewer who moved *backwards* while a
    // generation was being negotiated; applied here it would PATCH the lead
    // away and pay a second full start. So the position goes to the player as
    // it is -- negative, the viewer that far before this generation's start --
    // and a player that declared `holdsThroughLead` plays the outgoing source
    // up to it.
    const localPositionMs = ahead && session.mode !== 'direct' && desiredAbsoluteMs < Math.max(0, session.seekMs)
      ? desiredAbsoluteMs - Math.max(0, session.seekMs)
      : this.activationPosition(session, desiredAbsoluteMs);

    if (localPositionMs === undefined) {
      // The user moved behind the generation while it was being prepared. This
      // is genuine source-generation work, not a transport wait.
      this.scheduleSeekMutation({
        reason: 'seek',
        update: {
          seekMs: desiredAbsoluteMs,
          preferences: preservedSeekPreferences(session),
        },
      });
      return;
    }

    this.serverSession = session;
    const nextStreamOffsetMs = session.mode === 'direct' ? 0 : Math.max(0, session.seekMs);
    // Clamped at the generation's start for the one case that goes below it: a
    // lead, where the host cuts when the viewer *reaches* the start. Presenting
    // at the position the move began from would pin the readout a whole lead
    // behind the picture.
    const absoluteStartMs = session.mode === 'direct'
      ? localPositionMs
      : nextStreamOffsetMs + Math.max(0, localPositionMs);
    const startPaused = this.snapshot.intent.paused;

    /**
     * Switch what core *reports* only once the player has actually changed
     * source.
     *
     * **`play()` being called is not the source changing.** For a host that
     * tears its element down synchronously the two are the same instant, which
     * is why this survived until a host existed that prepares the replacement
     * on a second element and cuts to it only when the join is resident. That
     * opens a window — measured at nine seconds — in which the *outgoing*
     * element is still the one playing and reporting.
     *
     * Switching at call time mapped that element's ranges through the incoming
     * generation's origin. Measured: an outgoing buffer of `[0, 120.703]` drawn
     * at 2407.7 s, its own generation starting at 1772.8 s, so the block sat
     * **10.6 minutes to the right of the media it described** while the
     * incoming element had buffered nothing at all.
     *
     * **Deferring it matters more now than it did, not less.** Until the
     * position latch was fixed, `intent` was frozen through that window and the
     * error showed up as a gap between playhead and buffer. With the latch
     * releasing on progress, a call-time switch would instead report the
     * outgoing element's position through the incoming offset — playhead and
     * buffer wrong *together*, consistently, so the gap closes and the readout
     * states a position ten minutes out with no visible sign. A seek taken in
     * that window would start from it. The two fixes are not independent, and
     * this one is what stops the other making things quieter rather than
     * better.
     *
     * Ownership still moves at call time: core owns the new session from the
     * moment it asks for it, and teardown must close the right one. Only
     * presentation waits.
     */
    const present = (): void => {
      if (this.disposed || activationRevision !== this.sourceActivationRevision) return;
      this.setSession(session);
      this.activeDirectPlaySource = session.mode === 'direct' ? session.source : undefined;
      this.streamOffsetMs = nextStreamOffsetMs;
      // Source attachment emits transient zero/paused media events. Keep the
      // requested transport target authoritative until the active player
      // reports that it is tracking — see the release condition in
      // `onPlayerEvent`, which must not require an exact arrival.
      this.seekIntentActive = true;
      this.seekIntentPositionMs = undefined;
      this.seekIntentPinnedByPresentation = true;
      this.patchSnapshot({
        intent: { ...this.snapshot.intent, positionMs: absoluteStartMs },
        event: {
          ...this.snapshot.event,
          positionMs: absoluteStartMs,
          durationMs: session.durationMs,
          paused: this.snapshot.intent.paused,
          ended: false,
          // Buffer residency belongs to a source generation. Never carry the
          // old generation's ranges across a transformed source activation.
          bufferedRangesMs: [],
          forwardBufferMs: 0,
        },
      });
      this.log.info('source-presented', {
        sessionId: session.sessionId,
        generationStartMs: nextStreamOffsetMs,
        positionMs: absoluteStartMs,
      });
    };

    this.log.info('source-activate', {
      sessionId: session.sessionId,
      mode: session.mode,
      source: session.source.url,
      generationStartMs: nextStreamOffsetMs,
      desiredAbsoluteMs,
      localPositionMs,
      paused: startPaused,
    });

    const handOver = (): Promise<boolean> => this.options.player.play(session.source, localPositionMs, startPaused, transition);
    // Synchronous for every player that did not ask to wait: `play()` is called
    // in this turn, exactly as before, and only a player declaring
    // `needsProducedSource` takes the extra step.
    const playing = this.waitsForProduction(session)
      ? this.producedForPlayer(session).then((produced) => {
        if (this.disposed || activationRevision !== this.sourceActivationRevision) return undefined;
        if (produced === 'gone') {
          // The generation vanished before producing anything. The same answer
          // a 404 on its first fragment would have given, delivered through the
          // same door, so the reaped-session recovery takes it from here.
          throw new PlaybackSourceError(`Generation ${session.sessionId} is gone before producing media.`, 'not-found');
        }
        return handOver();
      })
      : handOver();
    void playing.then((started) => {
      if (started === undefined) return;
      if (this.disposed || activationRevision !== this.sourceActivationRevision) return;
      present();
      // User intent may have changed while the source was attaching. Reconcile
      // only the delta; source readiness is never a transport-state barrier.
      if (this.snapshot.intent.paused !== startPaused) {
        if (this.snapshot.intent.paused) this.options.player.pause();
        else this.options.player.resume();
      } else if (!startPaused && !started) {
        // Autoplay policy is not a source failure. The observed media event will
        // report paused=true and the always-enabled Play control can retry.
        this.log.info('source-attached-autoplay-not-started', { sessionId: session.sessionId });
      }
    }).catch((error) => {
      if (this.disposed || activationRevision !== this.sourceActivationRevision) return;
      this.fail(error);
    });
  }

  /**
   * The client-owned preferences to recreate a generation with: the last
   * server-confirmed session preferences, overridden by any representation
   * change the viewer has already requested but the server has not yet
   * confirmed. Both alternate preparation and failover must use this rather
   * than the bare session echo, or a preference change racing a node failure
   * would be silently dropped on recovery.
   *
   * The confirmed set does not carry everything a generation was created with.
   * `container` and the per-stream transforms are named in the instruction and
   * echoed nowhere a replacement can read them back, so both are restated from
   * the instruction report before this leaves — see
   * `withRestatedSegmentContainer` and `withRestatedTransforms` for why naming
   * a `mode` without them is not a smaller request but a different one.
   */
  private currentPreferences(session: PlaybackSession): PlaybackPreferencesUpdate {
    const instruction = this.snapshot.instruction;
    return withRestatedTransforms(
      withRestatedSegmentContainer(
        { ...completePreferences(session), ...this.snapshot.pendingPreferences },
        instruction?.container,
      ),
      instruction,
    );
  }

  /**
   * An adapter that reports a failure it never classified is charged for it,
   * and the charge is invisible.
   *
   * `isEndpointRetryablePlaybackFailure` treats a bare `Error` and a
   * `PlaybackSourceError` of kind `unknown` identically, because from core's
   * side they are identical: no evidence about what failed. They are not the
   * same event, though. One is a host that never wired classification, which
   * the `Player` contract expressly permits. The other is a host whose
   * classifier ran and could not tell -- or, as measured on the Android TV
   * client on 2026-09-20, a host whose classifier was meant to run and
   * silently did not: a reaped session arrived as `kind: 'unknown'` with
   * `Response code: 404` sitting in the message. Core charged a node that had
   * answered honestly, and walked a generation that `not-found` would have had
   * regenerated in place on the node already holding it.
   *
   * Core cannot fix that from here and must not try. Reading a status out of
   * an error message is the inference this repository keeps recording as a
   * fault class, and the message is the host's to format. What core can do is
   * stop the misattribution being silent -- the evidence was in the message,
   * and a line naming it is the difference between a hardware run and a grep.
   *
   * `debug`, once per session, for the reason `seek-invariant-not-stated` is:
   * an unclassified failure is permitted by the contract, so it is ordinary
   * rather than a fault, and one client renders warnings onto the television
   * for the whole of a film.
   */
  private noteUnclassifiedFailure(error: unknown, channel: 'degradation' | 'fatal'): void {
    const kind = error instanceof PlaybackSourceError ? error.kind : undefined;
    if (kind !== undefined && kind !== 'unknown') return;
    const session = this.snapshot.session ?? this.serverSession;
    const key = session?.sessionId ?? 'no-session';
    if (this.unclassifiedReportedFor === key) return;
    this.unclassifiedReportedFor = key;
    this.log.debug('source-failure-unclassified', {
      sessionId: session?.sessionId,
      endpoint: session?.endpoint,
      mediaId: session?.mediaId,
      channel,
      // Whether the host classified and could not tell, or never classified.
      // The contract permits both; only the first is the host having tried.
      classified: kind !== undefined,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  private degrade(error: Error): void {
    if (this.disposed) return;
    // Same superseded-source rule as `failNow`, with the opposite action.
    // Dropped rather than swapped in: hls.js reports one of these every few
    // seconds while it retries a dead source, and acting on the first would
    // collapse the deferral straight back into the buffer-flush it exists to
    // prevent. Nothing is lost by waiting — the replacement is already built,
    // and the ordinary runway and buffering triggers decide when it goes in.
    if (this.pendingReplacement || this.regenerationPromise) {
      this.log.debug('source-degradation-superseded-by-replacement', {
        sessionId: (this.snapshot.session ?? this.serverSession)?.sessionId,
        error,
      });
      return;
    }
    // Before the endpoint-evidence guard, which would otherwise drop this on
    // the floor now that `not-found` is not endpoint evidence — and before the
    // standby machinery below, which is the wrong answer to it.
    //
    // **This is the best moment core ever gets at this fault**, and it is
    // earlier than it looks. Measured 2026-09-17: hls.js topping up its buffer
    // during a pause hit the reaped session and reported the first `404`
    // **3.7 seconds before the viewer pressed play**, with 62.8 seconds of
    // buffer still in front of them. Recovering inside that cover is the
    // difference between a viewer seeing nothing at all and a viewer watching
    // their cache run out and a failure screen arrive.
    //
    // What happened instead, until this branch existed, was
    // `alternate-preparation-start`: the kind said `stream`, so a healthy node
    // that had merely forgotten one session was scored as failing and a
    // standby was built somewhere else.
    //
    // Deliberately not gated on paused state. A paused viewer is precisely who
    // this happens to, and the early warning is the whole value.
    if (isMissingSourceFailure(error)) {
      this.beginMissingSessionRecovery(error, false);
      return;
    }
    if (!isEndpointRetryablePlaybackFailure(error)) return;
    this.noteUnclassifiedFailure(error, 'degradation');
    this.degradeOnEndpointEvidence(error);
  }

  /**
   * Ordinary handling for degradation evidence core cannot act on more
   * specifically: promote a rescue that is already built, or build one.
   *
   * Named and separated so `recoverFromMissingSession` can fall back into it.
   * A `not-found` whose meaning could not be established is exactly this case
   * — evidence core cannot act on specifically — and the first version of that
   * method simply returned instead, which made the degradation channel *worse*
   * than before `not-found` existed.
   */
  private degradeOnEndpointEvidence(error: Error): void {
    const session = this.snapshot.session ?? this.serverSession;
    if (!session || this.alternatePreparations.size > 0) return;
    // A standby is already built and this node has failed again. There is
    // nothing left to wait for: continuing to sit on a validated rescue while
    // the primary works through its retry budget is what turns a sub-second
    // recovery into a minute of black screen.
    //
    // Measured, on a node stopped mid-playback: the standby was ready 267 ms
    // in, was discarded unused when its thirty-second window expired, and the
    // identical session was rebuilt from scratch 33 seconds after that — 63.6 s
    // of black screen for work that had been finished in under a second. The
    // two budgets were chosen independently and each is defensible; their
    // product is a rescue guaranteed to go stale, because a player's own retry
    // schedule outlasts the window and only a *fatal* failure consumed the
    // standby.
    //
    // Two failures inside the standby's own lifetime is the evidence threshold,
    // and it is the strongest one available — there is no positive "recovered"
    // signal to wait for. The first failure is what built the rescue; the
    // second is the node saying it meant it.
    if (this.alternateSessions.size > 0) {
      this.promoteReadyAlternate(session, error);
      return;
    }
    // A seek already outside local coverage is itself replacing this
    // generation via resolver.update() — the server tearing down the old
    // pipeline to honor that PATCH is expected, not independent failure
    // evidence. Without this, a stream error surfacing from that expected
    // teardown raced a second, fully redundant session into existence
    // alongside the seek's own legitimate replacement.
    if (this.activeMutation?.reason === 'seek') return;
    this.log.warn('source-degradation-evidence', {
      sessionId: session.sessionId,
      endpoint: session.endpoint,
      error,
    });
    this.prepareAlternate(session, this.sourceActivationRevision);
  }

  /**
   * Swap to a standby that is already built, validated and waiting.
   *
   * Unlike Direct Play — where `addDirectSourceAlternative` hands the fallback
   * to the read-ahead worker and the swap is invisible — a manifest source has
   * no in-band handoff, so this reloads the player against the new generation.
   * That costs a visible rebuffer of roughly a second, against a minute of
   * black screen for waiting out the primary's retry budget.
   *
   * Deliberately does nothing while a failover is already running or a seek is
   * in flight: both are already replacing this generation, and a promotion
   * racing either would produce two live replacements for one viewer.
   */
  private promoteReadyAlternate(session: PlaybackSession, error: Error): void {
    // A seek counts whether it is in flight, debounced, or queued behind
    // another mutation. `degrade()` checks only the active one, which is
    // enough when the consequence is a redundant standby; here the
    // consequence is a live replacement, so a seek still sitting on its
    // debounce timer has to count too.
    const seeking = this.activeMutation?.reason === 'seek'
      || this.debouncedSeekMutation !== undefined
      || this.pendingMutation?.reason === 'seek';
    if (this.failoverPromise || seeking) return;
    const alternate = [...this.alternateSessions.values()].find((candidate) => (
      candidate.mediaId === session.mediaId
      && candidate.mode === session.mode
      && candidate.endpoint?.id !== session.endpoint?.id
    ));
    if (!alternate) return;

    this.log.warn('alternate-promoted-on-degradation', {
      previousSessionId: session.sessionId,
      alternateSessionId: alternate.sessionId,
      endpoint: alternate.endpoint,
      error,
    });

    this.alternateSessions.delete(alternate.sessionId);
    const expiry = this.alternateExpiryTimers.get(alternate.sessionId);
    if (expiry !== undefined) clearTimeout(expiry);
    this.alternateExpiryTimers.delete(alternate.sessionId);

    this.serverSession = alternate;
    // The node never refused a session — it stopped serving bytes — so nothing
    // else would tell the registry it is unwell, and a later failover would
    // pick it back up as an apparently untried candidate.
    if (session.endpoint) this.options.resolver.recordEndpointFailure?.(session.endpoint.id);
    const desiredMs = this.snapshot.intent.positionMs;
    this.activateSession(alternate, desiredMs, 'continue');
    // Closed now rather than after buffered evidence on the replacement: the
    // standby was promoted because the primary stopped serving, so there is
    // nothing to fall back to and no reason to hold the slot. Fire and
    // forget, exactly as the silent direct promotion does — retrying belongs
    // to the resolver, which is the layer every client passes through.
    void this.options.resolver.stop(session.sessionId, { endpointAlreadyCharged: true }).catch((error) => {
      this.log.warn('superseded-primary-close-failed', { sessionId: session.sessionId, error });
    });
  }

  private prepareAlternate(session: PlaybackSession, activationRevision: number): void {
    const prepare = this.options.resolver.prepareAlternate?.bind(this.options.resolver);
    const preflight = this.options.player.preflightSource?.bind(this.options.player);
    if (!prepare) {
      this.log.info('alternate-preparation-unavailable', { sessionId: session.sessionId });
      return;
    }

    // A transport preflight hook improves the quality of a warm standby, but
    // must never gate creation of that standby. Application-scoped Player
    // instances can legitimately predate a hot module update, and third-party
    // platform players need not implement either optional hook. In both cases
    // the prepared generation remains immediately promotable by player.play().
    this.log.info('alternate-preparation-start', {
      sessionId: session.sessionId,
      mode: session.mode,
      transportPreflight: session.mode !== 'direct' && Boolean(preflight),
    });

    let preparation!: Promise<void>;
    preparation = (async () => {
      let alternate: PlaybackSession | undefined;
      try {
        const capabilities = await this.options.capabilities();
        alternate = await prepare(
          session,
          this.options.media,
          capabilities,
          this.snapshot.intent.positionMs,
          this.currentPreferences(session),
        );
        if (!alternate) return;
        if (this.disposed || activationRevision !== this.sourceActivationRevision || this.snapshot.session?.sessionId !== session.sessionId) {
          await this.options.resolver.stop(alternate.sessionId, this.closeOptions).catch(() => undefined);
          return;
        }
        if (session.mode === 'direct') {
          if (!equivalentDirectSources(session, alternate)) {
            await this.options.resolver.stop(alternate.sessionId).catch(() => undefined);
            return;
          }
          // Byte-identical Direct Play content on a different node can be
          // served under the same read-ahead cache key: register it as a
          // fallback source now so an in-flight range request fails over
          // silently the moment the primary node stops answering, with no
          // video reload or visible stall. Must address the source actually
          // loaded in the player, not `session.source` — a prior silent
          // promotion already moved session bookkeeping on without ever
          // touching the player, and the read-ahead worker only recognises
          // the key it was originally configured with.
          const activeSource = this.activeDirectPlaySource ?? session.source;
          const registered = this.options.player.addDirectSourceAlternative?.(activeSource, alternate.source);
          if (registered) {
            this.promoteSilentDirectAlternate(session, alternate);
            return;
          }
          // No read-ahead hook, or registration failed: fall through to the
          // slower, reactive standby path below.
        } else if (alternate.mediaId !== session.mediaId
          || alternate.mode !== session.mode
          || (preflight ? !await preflight(alternate.source) : false)) {
          await this.options.resolver.stop(alternate.sessionId).catch(() => undefined);
          return;
        }
        this.alternateSessions.set(alternate.sessionId, alternate);
        const expiry = setTimeout(() => {
          this.alternateExpiryTimers.delete(alternate!.sessionId);
          if (!this.alternateSessions.delete(alternate!.sessionId)) return;
          this.log.info('alternate-recovery-window-expired', { sessionId: alternate!.sessionId });
          void this.options.resolver.stop(alternate!.sessionId).catch((error) => {
            this.log.warn('expired-alternate-close-failed', { sessionId: alternate!.sessionId, error });
          });
        }, alternateRecoveryWindowMs(alternate));
        this.alternateExpiryTimers.set(alternate.sessionId, expiry);
        this.log.info('alternate-ready', {
          primarySessionId: session.sessionId,
          alternateSessionId: alternate.sessionId,
          endpoint: alternate.endpoint,
        });
      } catch (error) {
        if (alternate && !this.alternateSessions.has(alternate.sessionId)) {
          await this.options.resolver.stop(alternate.sessionId).catch(() => undefined);
        }
        this.log.warn('alternate-preparation-failed', { sessionId: session.sessionId, error });
      } finally {
        this.alternatePreparations.delete(preparation);
      }
    })();
    this.alternatePreparations.add(preparation);
  }

  /**
   * The read-ahead worker can start actually depending on a registered
   * fallback source at any moment, with no signal back to the coordinator.
   * Bookkeeping must move with it immediately rather than treating it as a
   * disposable, thirty-second standby: leaving it on that clock would let it
   * be stopped server-side while still in silent use, and would keep any
   * future failure evidence pointed at a session that is no longer really
   * the one in service. `activeDirectPlaySource` is deliberately left alone
   * — the player itself is never touched here.
   */
  private promoteSilentDirectAlternate(previous: PlaybackSession, alternate: PlaybackSession): void {
    this.serverSession = alternate;
    this.setSession(alternate);
    this.log.info('alternate-promoted-silently', {
      previousSessionId: previous.sessionId,
      alternateSessionId: alternate.sessionId,
      endpoint: alternate.endpoint,
    });
    // No session-negotiation failure ever surfaces for this endpoint — the
    // transport layer just quietly stopped using it — so nothing else would
    // ever tell the registry it is down. Without this, a later reactive
    // failover (for an unrelated cause) can still blindly pick this same
    // endpoint back up as an apparently-untried, apparently-healthy candidate.
    if (previous.endpoint) this.options.resolver.recordEndpointFailure?.(previous.endpoint.id);
    void this.options.resolver.stop(previous.sessionId, { endpointAlreadyCharged: true }).catch((error) => {
      this.log.warn('superseded-primary-close-failed', { sessionId: previous.sessionId, error });
    });
  }

  private releaseObsoleteAlternates(nextSessionId: string): void {
    for (const [sessionId] of this.alternateSessions) {
      if (sessionId === nextSessionId) continue;
      this.alternateSessions.delete(sessionId);
      const timer = this.alternateExpiryTimers.get(sessionId);
      if (timer !== undefined) clearTimeout(timer);
      this.alternateExpiryTimers.delete(sessionId);
      void this.options.resolver.stop(sessionId).catch((error) => {
        this.log.warn('obsolete-alternate-close-failed', { sessionId, error });
      });
    }
  }

  private setSession(session: PlaybackSession): void {
    this.patchSnapshot({ session, instruction: this.instructionWithServed(session) });
    for (const retired of [...this.releaseAfterCut]) {
      if (retired === session.sessionId || retired === this.serverSession?.sessionId) continue;
      this.releaseAfterCut.delete(retired);
      void this.options.resolver.stop(retired, this.closeOptions).catch((error: unknown) => {
        this.log.warn('moved-from-session-close-failed', { sessionId: retired, error });
      });
    }
  }

  /**
   * Record what the node actually served against what was asked for.
   *
   * Done once, here, rather than by each host comparing a policy against a
   * status string: the two sides use different vocabularies and the
   * comparison has exactly one correct answer, so leaving it to call sites
   * produces several.
   */
  private instructionWithServed(session: PlaybackSession): PlaybackInstructionReport | undefined {
    const instruction = this.snapshot.instruction;
    if (!instruction) return undefined;
    const served = session.output.container?.trim().toLowerCase() || undefined;
    const requested = instruction.container;
    const performedMode = session.mode;
    // The node's echo of what it was asked for, which is the only thing the
    // performed mode may be compared against — see `modeHonoured`.
    const requestedMode = session.preferences?.mode;
    const modeHonoured = requestedMode === undefined || performedMode === undefined
      ? undefined
      : performedMode === requestedMode;
    // Once per generation, not once per snapshot patch: `setSession` runs on
    // every session change and a substitution that reported itself repeatedly
    // would be noise on a diagnostics surface a viewer can see.
    if (modeHonoured === false && this.substitutionReportedFor !== session.sessionId) {
      this.substitutionReportedFor = session.sessionId;
      this.log.warn('generation-mode-substituted', {
        sessionId: session.sessionId,
        endpoint: session.endpoint,
        mediaId: session.mediaId,
        requestedMode,
        performedMode,
      });
    }
    return {
      ...instruction,
      servedContainer: served,
      containerHonoured: requested === undefined || served === undefined
        ? undefined
        : served === requested,
      performedMode,
      modeHonoured,
    };
  }

  private onPlayerEvent(next: PlaybackEvent): void {
    if (this.disposed) return;
    // Stamped before any branch, because both paths out of here patch the
    // snapshot and both figures are read long afterwards.
    this.lastPlayerEventAt = machaHost().now();
    const session = this.snapshot.session;
    const reportedPositionMs = next.positionMs + (session?.mode === 'direct' ? 0 : this.streamOffsetMs);
    // A source being replaced goes on rendering, and must: the tail it has
    // already buffered is the thing covering the gap, and stopping it to
    // silence it would produce exactly the black screen failover exists to
    // prevent (Law 2, `docs/principles-and-laws.md`). It has stopped being a
    // *witness*, though. As an element tears down it can report a position of
    // zero, and the replacement is activated from `intent.positionMs`, so one
    // reading from a source already given up on sends the viewer back to the
    // start of the film.
    //
    // Forward only, therefore. Real progress through the buffered tail should
    // move the resume point — the replacement ought to start after what the
    // viewer actually saw — but nothing a dying source says can move it back.
    // A viewer seek during a failover is exempt: that is a position the
    // viewer chose, not one the source reported.
    const replacingSource = this.failoverPromise !== undefined && !this.seekIntentActive;
    const absolutePositionMs = replacingSource && this.lastObservedPositionMs !== undefined
      ? Math.max(reportedPositionMs, this.lastObservedPositionMs)
      : reportedPositionMs;
    this.lastObservedPositionMs = absolutePositionMs;
    // Real progress past the point a regeneration was started from is the only
    // proof available that it worked. Once it has, the next outage is a new
    // outage and is entitled to the same one attempt this one had.
    if (this.lastRegenerationPositionMs !== undefined
      && absolutePositionMs > this.lastRegenerationPositionMs + REGENERATION_PROGRESS_MS) {
      this.lastRegenerationPositionMs = undefined;
    }
    const absolute: PlaybackEvent = {
      ...next,
      positionMs: absolutePositionMs,
      durationMs: session?.durationMs || next.durationMs,
      bufferedRangesMs: next.bufferedRangesMs?.map((range) => ({
        startMs: range.startMs + (session?.mode === 'direct' ? 0 : this.streamOffsetMs),
        endMs: range.endMs + (session?.mode === 'direct' ? 0 : this.streamOffsetMs),
      })),
    };

    // HTML media stacks may emit `ended` when a truncated TCP/HLS generation
    // runs out, even though the item itself is nowhere near complete. Treating
    // that observation as normal completion closes the player and navigates
    // away before cluster recovery has a chance to run.
    if (absolute.ended && isPrematurePlaybackEnd(absolute.positionMs, absolute.durationMs)) {
      const interrupted: PlaybackEvent = {
        ...absolute,
        paused: this.snapshot.intent.paused,
        ended: false,
        buffering: !this.snapshot.intent.paused,
      };
      const intent = this.seekIntentActive
        ? this.snapshot.intent
        : { ...this.snapshot.intent, positionMs: absolutePositionMs };
      this.patchSnapshot({ event: interrupted, intent });
      this.noteElementRunway();
      this.log.warn('premature-source-end', {
        sessionId: session?.sessionId,
        positionMs: absolute.positionMs,
        durationMs: absolute.durationMs,
        remainingMs: absolute.durationMs - absolute.positionMs,
      });
      // A source known to be reaped running out of buffer is not a failure —
      // it is the moment the replacement was being deferred for, and on some
      // hosts it arrives as a premature `ended` rather than as a stall.
      if (this.pendingReplacement) {
        void this.buildReplacement(this.pendingReplacement, 'source-ended');
        return;
      }
      this.fail(new PlaybackSourceError('Playback source ended before the media was complete', 'stream'));
      return;
    }

    const target = this.snapshot.intent.positionMs;
    if (this.seekIntentActive && !next.seeking) {
      // The fast path: the player reached what was asked for.
      if (Math.abs(absolutePositionMs - target) <= 1_500) {
        this.seekIntentActive = false;
        this.seekIntentPositionMs = undefined;
      } else {
        // **It may never reach it, and then this latch is the bug.** It exists
        // only to stop the transient zero/paused events a source emits while
        // attaching from overwriting a transport target — a job that is over
        // within a second or two. Waiting for an exact arrival makes it
        // permanent whenever the player settles somewhere else, and a host
        // that replaces a source seamlessly does exactly that: it cuts at the
        // point the outgoing element actually reached, not at the point core
        // nominated.
        //
        // Measured in the live client: after such a handover the reported
        // position froze at the new generation's origin and never recovered —
        // 11 consecutive samples identical to six decimal places while the
        // element advanced ten seconds, the buffer ran a further 80 s ahead,
        // and the drawn gap between playhead and buffer *grew* as hls.js
        // evicted behind a playhead that was not moving. A handover that
        // abandoned and fell back to the old teardown path tracked correctly,
        // which is what isolates it. It also silently poisons every later
        // seek, because each one is computed from the frozen value.
        //
        // So the release condition is the player demonstrating it is tracking
        // — two consecutive non-seeking reports that moved — rather than the
        // player confirming a number core chose.
        // **Only once the source core asked for is the one being reported.**
        // Movement alone is not evidence: during a seek that needs a new
        // generation the *outgoing* source is still playing and still
        // reporting progress, so releasing on movement discards the viewer's
        // target within a frame of them letting go of the scrubber. Measured:
        // released 65 ms after the request with the reported position and the
        // target 685 seconds apart, and the generation was then created at the
        // position the viewer was already at. The scrubber snapped back.
        //
        // That is the same fault as the freeze this replaced, in the other
        // direction — the latch driven by "is the player moving" when the
        // question is "has what core asked for been presented". Never released
        // became released instantly. `present()` is the answer to the real
        // question and it already exists.
        const previous = this.seekIntentPositionMs;
        if (this.seekIntentPinnedByPresentation && previous !== undefined && absolutePositionMs !== previous) {
          this.log.info('seek-intent-released-on-progress', {
            targetMs: target,
            positionMs: absolutePositionMs,
          });
          this.seekIntentActive = false;
          this.seekIntentPositionMs = undefined;
        } else {
          this.seekIntentPositionMs = absolutePositionMs;
        }
      }
    }

    // Media events are observations, not commands. In particular, source swaps
    // may transiently emit pause/play events and must never overwrite a Pause or
    // Play intent the user issued while that source was being prepared. Position
    // follows the player only once an outstanding seek/source target is reached.
    const intent = this.seekIntentActive
      ? this.snapshot.intent
      : { ...this.snapshot.intent, positionMs: absolutePositionMs };
    this.patchSnapshot({ event: absolute, intent });
    this.noteElementRunway();

    // Read after the patch, so the decision is made on the runway the player
    // has just reported rather than the previous one.
    const pending = this.pendingReplacement;
    if (pending) {
      // Every event is proof the player is still talking, so the silence guard
      // starts again from here rather than counting down against a healthy
      // source.
      this.armPendingReplacementGuard();
    }
    if (pending && !this.seekIntentActive) {
      if (absolute.buffering) {
        // Gone sooner than the arithmetic said. Whatever the figures, the
        // viewer is already waiting, so there is nothing left to defer for.
        void this.buildReplacement(pending, 'buffer-exhausted');
      } else if (this.runwayMs() <= this.leadTimeMs(pending)) {
        void this.buildReplacement(pending, 'lead-time-reached');
      }
    }
  }

  private fail(error: unknown): void {
    if (this.disposed || this.snapshot.fatalError) return;
    const fatalError = error instanceof Error ? error : new Error(String(error));
    const activeMutation = this.activeMutation;
    if (activeMutation?.reason === 'seek') {
      // Same expected-teardown race degrade() guards against: a stream error
      // can surface from the server tearing down this generation to honor an
      // in-flight seek PATCH, indistinguishable at the moment it arrives from
      // a genuine fatal failure. Unlike degrade(), a fatal error must always
      // end up recovered or shown — never silently dropped — so instead of a
      // bare early return, wait for the mutation to settle and judge from
      // what actually happened: if it replaced the source, this error was
      // about a generation already gone and is dropped as stale; otherwise
      // it's handled exactly as if this guard were never here.
      const failingSource = this.snapshot.session ?? this.serverSession;
      void activeMutation.settled.then(() => {
        if (this.disposed || this.snapshot.fatalError) return;
        const current = this.snapshot.session ?? this.serverSession;
        if (failingSource && current && sourceIdentity(failingSource) !== sourceIdentity(current)) {
          this.log.debug('stream-error-superseded-by-seek', { sessionId: failingSource.sessionId, error: fatalError });
          return;
        }
        this.failNow(fatalError);
      });
      return;
    }
    this.failNow(fatalError);
  }

  private failNow(fatalError: Error): void {
    const failedSession = this.snapshot.session ?? this.serverSession;
    // A replacement for this exact source is already built, or being built.
    // Nothing the dying source says now is news — and, more sharply, **there
    // is nobody left to ask about it**: `regenerate()` releases the old
    // session from the resolver, so the endpoint binding `sessionAlive()`
    // needs is gone the moment the replacement exists. A late fatal naming a
    // superseded source is unprobeable by construction.
    //
    // Measured 2026-09-17, and it cost a viewer 82 seconds of playable video:
    // hls.js went on retrying a reaped session for 29 s after the replacement
    // was built and waiting, then went fatal. That fatal reached the probe,
    // the probe threw `has no endpoint provenance`, "could not find out" sent
    // it to failover, and failover released the replacement on its way past.
    // Every step doing exactly what it was told. **Strictly worse than the
    // stall the hold exists to prevent** — the element was emptied and
    // playback moved to a node that had never served the title.
    //
    // This is not about the error's kind or the delivery path. Any player
    // that retries a dead source for longer than a replacement takes to build
    // arrives here, and hls.js always does.
    if (this.pendingReplacement) {
      // The player giving up is not the buffer running out. A fatal arrives
      // when the *loader* concedes — hls.js after about thirty seconds of
      // retries — while the element may still hold a minute of playable
      // video, and that video is the whole reason the replacement is being
      // held. Swapping here would discard it to fix a problem the viewer does
      // not have yet. So the failure is absorbed and the ordinary triggers go
      // on deciding, unless the runway is already spent, in which case there
      // is nothing left to protect.
      //
      // **This depends on the adapter's side of the `not-found` contract**,
      // documented on `Player.subscribeFailure`: a player reporting that kind
      // must not tear the presentation down on it. An adapter that destroys
      // its loader and pauses the element inside its terminal leaves nothing
      // to play out, and absorbing the failure would park the viewer on a
      // dead element. The web adapter did exactly that until this landed, and
      // the two changes are not separable — which is why they ship together.
      //
      // Safe for every adapter that has not opted in, because an adapter that
      // never reports `not-found` never builds a replacement and never
      // reaches this branch at all.
      this.log.warn('source-failure-superseded-by-replacement', {
        sessionId: failedSession?.sessionId,
        replacementSessionId: this.pendingReplacement.sessionId,
        runwayMs: this.runwayMs(),
        error: fatalError,
      });
      // Same rule as above: a failure from a source already given up on is not
      // a reason to spend the viewer's remaining media. Build only if there is
      // none left to spend.
      const pendingSession = this.pendingReplacement;
      const runwayMs = this.runwayMs();
      if (runwayMs > this.leadTimeMs(pendingSession)) return;
      void this.buildReplacement(pendingSession, 'source-failed');
      return;
    }
    if (this.regenerationPromise) {
      this.log.debug('source-failure-during-regeneration', {
        sessionId: failedSession?.sessionId,
        error: fatalError,
      });
      return;
    }
    // A dead source does not fall silent when recovery starts. It is neither
    // stopped nor unsubscribed while the replacement is negotiated, so it goes
    // on emitting: the element plays out whatever it had buffered and reports
    // `ended` short of duration, which `onPlayerEvent` correctly reads as a
    // premature end and sends back here as a second fatal failure — from the
    // same source, about the same outage, one to three seconds after the
    // first. Taken terminal it closes the coordinator and the replacement that
    // was seconds from ready is discarded by the disposed path, so the viewer
    // gets the fatal screen instead of the recovery that had already worked.
    //
    // Dropped rather than queued: recovery for this outage is already running
    // and will either produce a source or fail on its own terms. Same posture
    // `promoteReadyAlternate` takes when a degradation arrives mid-failover.
    if (this.failoverPromise && isEndpointRetryablePlaybackFailure(fatalError)) {
      this.log.debug('source-failure-during-failover', {
        sessionId: failedSession?.sessionId,
        error: fatalError,
      });
      return;
    }
    // A `404` that reached the fatal channel rather than the degradation one:
    // either the adapter has no degradation channel, or the cover ran out
    // before recovery finished. Same question, same answer, and still not a
    // reason to condemn the node.
    if (failedSession && this.fallBackFromUndecodable(failedSession, fatalError)) return;
    if (isMissingSourceFailure(fatalError) && this.beginMissingSessionRecovery(fatalError, true)) return;
    // **An unclassified fatal asks the same question before it charges
    // anyone.** A player that cannot see a status -- expo-video's terminal
    // error carries only a message -- reports a reaped session as `unknown`,
    // and until now that went straight to failover: measured on the Android TV
    // set on 2026-09-23, two reaps each charged a healthy local node and moved
    // the viewer across the internet. The session route can tell a reaped
    // session from a failing node without anyone reading the message, so ask
    // it. Gone: regenerate on the same node, uncharged. Alive, or no answer:
    // the stream really failed, and failover and the charge go ahead as before.
    if (failedSession
      && isUnclassifiedPlaybackFailure(fatalError)
      && isEndpointRetryablePlaybackFailure(fatalError)
      && this.beginMissingSessionRecovery(fatalError, true)) {
      this.noteUnclassifiedFailure(fatalError, 'fatal');
      return;
    }
    if (failedSession && this.options.resolver.failover && isEndpointRetryablePlaybackFailure(fatalError)) {
      this.noteUnclassifiedFailure(fatalError, 'fatal');
      this.beginSourceFailover(failedSession, fatalError);
      return;
    }
    this.failTerminal(fatalError);
  }

  private beginSourceFailover(failedSession: PlaybackSession, error: Error): void {
    if (this.failoverPromise) return;
    // Whatever is about to be built will be on a different node, so a pending
    // replacement for this one is a decision that no longer applies.
    this.discardPendingReplacement('failover');
    this.failoverPromise = this.recoverFromSourceFailure(failedSession, error).finally(() => {
      this.failoverPromise = undefined;
    });
  }

  /**
   * Start recovery from a node reporting `404` for the media it was serving,
   * if this coordinator is in a position to.
   *
   * Returns whether it took ownership of the error. A `false` on the terminal
   * path means the caller must carry on to its ordinary handling — this is the
   * one place a missing resolver capability or an in-flight recovery has to be
   * distinguishable from "handled", because the alternative is a viewer left
   * looking at a stalled player with nothing running.
   */
  private beginMissingSessionRecovery(error: Error, terminal: boolean): boolean {
    // **Ask about the session core owns, not the one on screen.** A player
    // report carries no session id, so it is attributed to whatever is
    // presented -- and between an activation and the cut that is the
    // *outgoing* generation, still fetching. Probing it asks whether a session
    // core has already replaced is alive, and "no" then rebuilt the replaced
    // one over the top of the live one: measured on the web client on
    // 2026-09-23, a clean move followed twenty seconds later by the viewer
    // yanked back to the node they had left, and the new node's only
    // transcode slot leaked.
    const presented = this.snapshot.session ?? this.serverSession;
    const session = this.serverSession ?? presented;
    const outgoing = presented && session && presented.sessionId !== session.sessionId ? presented : undefined;
    const resolver = this.options.resolver;
    if (!session || !resolver.sessionAlive || !resolver.regenerate) return false;
    // Something is already replacing this generation. A second replacement for
    // one outage is the two-owners problem, and every one of these paths ends
    // in an activation. `pendingReplacement` counts: it is a replacement that has
    // already been built and is waiting, and the session it replaces can no
    // longer be probed at all.
    if (this.failoverPromise || this.regenerationPromise || this.pendingReplacement) return true;
    this.regenerationPromise = this.recoverFromMissingSession(session, error, terminal, outgoing).finally(() => {
      this.regenerationPromise = undefined;
    });
    return true;
  }

  /**
   * Ask whether the session still exists, and act on the answer.
   *
   * The `404` itself cannot say which of two things happened — a reaped
   * session and a fragment past the end of the plan are the same status and
   * the same `not_found` code, measured on one node in one run — so this asks
   * the only question that separates them and treats the three possible
   * answers as three different situations rather than collapsing them:
   *
   * - **Gone.** Regenerate on the same node at the viewer's position. The node
   *   is fine and is the right place to ask; see
   *   `ClusterPlaybackResolver.regenerate`.
   * - **Alive.** The `404` was a genuine miss against a live plan, so
   *   replacing the session would fix nothing. Say so and leave the source
   *   alone, unless this was already fatal, in which case ordinary failover is
   *   the remaining option.
   * - **Could not tell.** Not evidence of anything. A probe that failed must
   *   never be read as a session that is gone, or a node that was briefly
   *   unreachable gets its live sessions torn down and rebuilt.
   */
  private async recoverFromMissingSession(
    session: PlaybackSession,
    error: Error,
    terminal: boolean,
    outgoing?: PlaybackSession,
  ): Promise<void> {
    const giveUpOnThisSource = (): void => {
      if (this.disposed || this.snapshot.fatalError) return;
      if (this.options.resolver.failover) this.beginSourceFailover(session, error);
      else this.failTerminal(error);
    };

    /**
     * The node's state could not be established: the probe did not complete,
     * or a replacement has already been tried here and changed nothing.
     *
     * **Not an answer, and it must not be treated as one.** On the terminal
     * channel there is nothing left to protect and failover is the remaining
     * option. On the degradation channel the source may still be playing, so
     * this is evidence core cannot act on specifically — which is what the
     * standby machinery is for, and what this same evidence used to get before
     * `not-found` existed, when it arrived as `stream`.
     *
     * The first version returned on the degradation path, which made the
     * channel *worse* than before the fix: a node that had gone away between
     * answering a `404` and being asked about it produced an early warning
     * core then swallowed.
     */
    const unresolved = (): void => {
      if (this.disposed || this.snapshot.fatalError) return;
      if (terminal) {
        giveUpOnThisSource();
        return;
      }
      this.degradeOnEndpointEvidence(error);
    };

    let alive: boolean;
    try {
      alive = await this.options.resolver.sessionAlive!(session.sessionId);
    } catch (probeError) {
      if (this.disposed) return;
      this.log.warn('session-liveness-unknown', {
        sessionId: session.sessionId,
        endpoint: session.endpoint,
        error: probeError,
      });
      unresolved();
      return;
    }
    if (this.disposed) return;

    if (alive && outgoing) {
      // The generation core owns is alive, so the `404` came from the one
      // being cut away from -- which is expected to be gone, and is not a
      // reason to do anything on either channel. The cut is already coming.
      this.log.info('source-not-found-on-outgoing-session', {
        sessionId: session.sessionId,
        outgoingSessionId: outgoing.sessionId,
        terminal,
      });
      return;
    }
    if (alive) {
      // An answer, and it clears the node: the `404` was a fragment past the
      // end of a live plan. Replacing the session would fix nothing and
      // building a standby for it is the churn `not-found` exists to stop, so
      // the degradation path deliberately stops here. A fatal one still needs
      // somewhere to go.
      // Named for what arrived: a `not-found` against a live session is a miss
      // in the plan, while an unclassified failure against one is the stream
      // failing on a node whose session is fine -- the failover below charges it.
      this.log.warn(isMissingSourceFailure(error) ? 'source-not-found-on-live-session' : 'unclassified-failure-on-live-session', {
        sessionId: session.sessionId,
        endpoint: session.endpoint,
        positionMs: this.snapshot.intent.positionMs,
        error,
      });
      if (terminal) giveUpOnThisSource();
      return;
    }

    // The session is gone and this source is finished. Nothing is built yet —
    // see `REPLACEMENT_LEAD_TIME_MS` for why building now would be worse than
    // useless — so the decision is recorded and the runway decides when.
    const runwayMs = this.runwayMs();
    const leadTimeMs = this.leadTimeMs(session);
    this.log.warn('source-reaped', {
      sessionId: session.sessionId,
      endpoint: session.endpoint,
      positionMs: this.snapshot.intent.positionMs,
      paused: this.snapshot.intent.paused,
      runwayMs,
      leadTimeMs,
      lookAheadMs: session.lookAheadMs ?? null,
      terminal,
      error,
    });
    // **The channel does not decide this; the runway does.** An earlier
    // version deferred only on the degradation channel, because a fatal used
    // to mean the presentation had already been torn down and there was
    // nothing left to play out. Under the `not-found` contract on
    // `Player.subscribeFailure` that is no longer true: an adapter reporting
    // this kind leaves the element alone, so a fatal arrives with the viewer's
    // buffer intact and is worth deferring for exactly like any other notice.
    //
    // Left as it was, a player that concedes before the lead is reached — hls
    // gives up around 28 s, against a lead of 10 — would force an immediate
    // build every time and the deferral would never happen at all.
    if (runwayMs > leadTimeMs) {
      this.startPendingReplacement(session, runwayMs, leadTimeMs);
      return;
    }
    await this.buildReplacement(session, terminal ? 'no-cover' : 'lead-time-reached', error);
  }

  /**
   * Build the replacement for a dead source and attach it.
   *
   * Created at the viewer's position **now**, not where the failure was
   * noticed, so the node produces from its own frontier instead of catching up
   * to a target that moved while it waited. Then warmed, so the pipeline is
   * running before the viewer arrives rather than after.
   *
   * Bounded at every step, which the review gates in
   * `docs/principles-and-laws.md` ask for directly: the negotiation carries
   * the resolver's own attempt budget, the warm is raced against what is left
   * of the runway, and a failure to negotiate falls through to failover rather
   * than waiting.
   */
  /**
   * Bound a whole recovery, and let a late one clean up after itself.
   *
   * Never cancels the work: a cancelled create tells the node nothing about
   * whether to keep the session, which is the same reason
   * `awaitWithEndpointDeadline` observes rather than aborts. If the
   * negotiation lands after this has given up, the session it produced is
   * released rather than leaked — a success nobody is waiting for is a
   * generation nobody will ever close, and on a node whose
   * `max_video_transcodes` is 1 that is the next viewer's refusal.
   *
   * The late handlers are attached unconditionally so an abandoned rejection
   * cannot surface as an unhandled one.
   */
  private superviseRecovery(build: Promise<PlaybackSession>, budgetMs: number): Promise<PlaybackSession> {
    let supervised = true;
    build.then(
      (late) => {
        if (supervised) return;
        this.log.warn('replacement-arrived-after-supervision', {
          sessionId: late.sessionId,
          endpoint: late.endpoint,
        });
        void this.stopOnDisposal(late.sessionId);
      },
      () => undefined,
    );
    return new Promise<PlaybackSession>((resolve, reject) => {
      const timer = setTimeout(() => {
        supervised = false;
        reject(Object.assign(
          new Error(`Replacement build exceeded ${budgetMs} ms with no result and no failure.`),
          { status: 504, code: 'client_recovery_deadline' },
        ));
      }, budgetMs);
      build.then(
        (session) => { if (supervised) { clearTimeout(timer); resolve(session); } },
        (error: unknown) => { if (supervised) { clearTimeout(timer); reject(error); } },
      );
    });
  }

  private async buildReplacement(dead: PlaybackSession, reason: string, originating?: Error): Promise<void> {
    this.pendingReplacement = undefined;
    if (this.pendingReplacementTimer !== undefined) clearTimeout(this.pendingReplacementTimer);
    this.pendingReplacementTimer = undefined;
    // A replacement is only ever for the generation core owns. Anything else
    // has already been replaced, and rebuilding it would put a second
    // generation over the live one and orphan whichever lost.
    if (this.serverSession && dead.sessionId !== this.serverSession.sessionId) {
      this.log.warn('replacement-for-superseded-session-dropped', {
        sessionId: dead.sessionId,
        currentSessionId: this.serverSession.sessionId,
        reason,
      });
      return;
    }
    const requestedPositionMs = this.snapshot.intent.positionMs;
    if (this.lastRegenerationPositionMs !== undefined
      && Math.round(this.lastRegenerationPositionMs) === Math.round(requestedPositionMs)) {
      this.log.error('session-regeneration-made-no-progress', {
        sessionId: dead.sessionId,
        endpoint: dead.endpoint,
        positionMs: requestedPositionMs,
      });
      if (this.options.resolver.failover) this.beginSourceFailover(dead, new Error('Replacement made no progress'));
      else this.failTerminal(new Error('Replacement made no progress'));
      return;
    }
    this.lastRegenerationPositionMs = requestedPositionMs;
    this.log.warn('session-reaped-regenerating', {
      sessionId: dead.sessionId,
      endpoint: dead.endpoint,
      positionMs: requestedPositionMs,
      runwayMs: this.runwayMs(),
      reason,
    });
    this.patchSnapshot({ preparingSource: true, notice: undefined });
    // Twice the node's own attempt budget plus head-room: the close and the
    // create may each legitimately spend all of it, and aborting a recovery
    // that was going to succeed costs the viewer a cross-node failover and the
    // stream copy with it.
    const attemptBudgetMs = dead.source.budgets?.deadlineMs ?? generationAttemptBudgetMs();
    try {
      const next = await this.superviseRecovery((async () => {
        const capabilities = await this.options.capabilities();
        return await this.recoverWithPreferences(dead, (preferences) => this.options.resolver.regenerate!(
          dead,
          this.options.media,
          capabilities,
          requestedPositionMs,
          preferences,
        ));
      })(), attemptBudgetMs * 2 + RECOVERY_SUPERVISION_MARGIN_MS);
      if (this.disposed) {
        await this.stopOnDisposal(next.sessionId);
        return;
      }
      if (this.serverSession && this.serverSession.sessionId !== dead.sessionId) {
        // Something else took ownership while this was negotiating -- a move,
        // a failover. Theirs is live; this one is released, not adopted.
        this.log.warn('replacement-arrived-for-superseded-session', {
          sessionId: next.sessionId,
          replacedSessionId: dead.sessionId,
          currentSessionId: this.serverSession.sessionId,
        });
        this.patchSnapshot({ preparingSource: false });
        await this.stopOnDisposal(next.sessionId);
        return;
      }
      // `warn` rather than `info`: see `generation-regenerate`. This is the
      // line that says the negotiation came back, and it was the only one
      // missing from a capture of a recovery that hung.
      this.log.warn('session-regenerated', {
        previousSessionId: dead.sessionId,
        sessionId: next.sessionId,
        endpoint: next.endpoint,
        positionMs: requestedPositionMs,
      });
      this.serverSession = next;
      // Starts paused when the viewer is paused, so a source swapped in under
      // a stopped player simply works when they press play.
      this.activateSession(next, this.snapshot.intent.positionMs, 'continue');
      this.patchSnapshot({ preparingSource: false, notice: undefined });
    } catch (regenerationError) {
      if (this.disposed) return;
      // The node refused fresh work. That is a claim about the node, unlike
      // the `404` that started this, and `regenerate` has already recorded it.
      this.log.error('session-regeneration-failed', {
        sessionId: dead.sessionId,
        endpoint: dead.endpoint,
        error: regenerationError,
      });
      this.patchSnapshot({ preparingSource: false });
      if (this.options.resolver.failover) {
        this.beginSourceFailover(dead, terminalRecoveryError(originating ?? asError(regenerationError), regenerationError));
      } else {
        this.failTerminal(terminalRecoveryError(originating ?? asError(regenerationError), regenerationError));
      }
    }
  }



  /**
   * Release a session built by a recovery that finished after `close()`.
   *
   * It carries the close options, and `keepalive` is the reason this is not
   * an inline `stop()`. A page-unload teardown sets it because a `DELETE`
   * issued as the document goes away is cancelled otherwise — and a session
   * created during the unload is the one most likely to be cancelled, since
   * it is negotiated at the last possible moment. Without the flag that node
   * holds the transcode entitlement until `session_idle`, thirty minutes,
   * with nothing pointing at the client responsible.
   *
   * Logged rather than swallowed: this is the one release nobody is waiting
   * on a return value for, so a silent failure here is a leak with no trace.
   */
  private async stopOnDisposal(sessionId: string): Promise<void> {
    await this.options.resolver.stop(sessionId, this.closeOptions).catch((error: unknown) => {
      this.log.warn('recovered-session-close-failed', { sessionId, error });
    });
  }

  private async recoverFromSourceFailure(failedSession: PlaybackSession, error: Error): Promise<void> {
    const requestedPositionMs = this.snapshot.intent.positionMs;
    const requestedPositionRevision = this.positionRevision;
    this.log.warn('source-failover-start', {
      sessionId: failedSession.sessionId,
      endpoint: failedSession.endpoint,
      requestedPositionMs,
      error,
    });
    this.patchSnapshot({ preparingSource: true, notice: undefined });
    try {
      await Promise.all([...this.alternatePreparations].map((preparation) => preparation.catch(() => undefined)));
      const preparedAlternate = [...this.alternateSessions.values()].find((alternate) => (
          alternate.mediaId === failedSession.mediaId
          && alternate.mode === failedSession.mode
          && alternate.endpoint?.id !== failedSession.endpoint?.id
        ));
      const capabilities = await this.options.capabilities();
      if (this.disposed) return;
      const next = await this.recoverWithPreferences(failedSession, (preferences) => this.options.resolver.failover!(
        failedSession,
        this.options.media,
        capabilities,
        requestedPositionMs,
        preferences,
        preparedAlternate,
      ));
      if (this.disposed) {
        await this.stopOnDisposal(next.sessionId);
        return;
      }
      this.serverSession = next;
      this.alternateSessions.delete(next.sessionId);
      const alternateExpiry = this.alternateExpiryTimers.get(next.sessionId);
      if (alternateExpiry !== undefined) clearTimeout(alternateExpiry);
      this.alternateExpiryTimers.delete(next.sessionId);
      const currentDesired = this.snapshot.intent.positionMs;
      const userMovedDuringRequest = requestedPositionRevision !== this.positionRevision;
      if (userMovedDuringRequest && this.activationPosition(next, currentDesired) === undefined) {
        this.queueMutation({
          reason: 'seek',
          update: { seekMs: currentDesired, preferences: preservedSeekPreferences(next) },
        });
      } else {
        this.activateSession(next, currentDesired, 'continue');
      }
      // The failed session is not closed here. `resolver.failover()` released
      // it as it abandoned it, which is the only layer every client passes
      // through — two of the four never build a coordinator at all — and a
      // second owner here would DELETE a session already gone and charge the
      // registry for the node failing to answer about it.
      this.log.info('source-failover-ready', {
        oldSessionId: failedSession.sessionId,
        newSessionId: next.sessionId,
        endpoint: next.endpoint,
        positionMs: currentDesired,
      });
      this.patchSnapshot({ preparingSource: false, notice: undefined });
    } catch (failoverError) {
      if (this.disposed) return;
      this.log.error('source-failover-exhausted', {
        failedSessionId: failedSession.sessionId,
        failedEndpoint: failedSession.endpoint,
        originatingError: error,
        error: failoverError,
      });
      this.failTerminal(terminalRecoveryError(error, failoverError));
    }
  }

  /**
   * Buffered runway ahead of the viewer, or zero when the player does not say.
   *
   * **Silence reads as none, deliberately.** `forwardBufferMs` is optional on
   * `PlaybackEvent` and an adapter that reports no buffer figure is not an
   * adapter with an empty buffer — but a replacement held against a runway
   * nobody is measuring is a replacement that is never swapped in, and the
   * viewer's source is already dead. Treating the absence as "swap now" costs
   * a buffer flush; treating it as "wait" costs the session.
   */
  /**
   * Playable cover ahead of the viewer, in milliseconds.
   *
   * The element's own buffer plus, where the host has one, whatever its
   * read-ahead is holding in front of the element. Those are two different
   * caches and only the first is in `forwardBufferMs`; on Direct Play the
   * second can be the larger, which had core swapping earlier than it needed
   * to on the path most likely to be serving a big file.
   */
  /**
   * How much media must remain before the replacement for `session` is built.
   *
   * `REPLACEMENT_LEAD_TIME_MS` is what the negotiation needs; the node's
   * look-ahead is what the arrival point must stay inside. The smaller wins,
   * because overshooting the frontier is the nine-second fault and arriving a
   * little late is a short wait the viewer would have had anyway.
   *
   * **Taken from the session being replaced**, which is the only one that
   * exists when this is decided. It is the same node and the same
   * configuration as the replacement will be created on, so it is the right
   * proxy — and if the node is reconfigured between the two, the replacement
   * reports the new figure and the next decision uses it.
   *
   * Absent means the node is too old to say, and the default is already
   * chosen to sit under any plausible configuration. `null` means direct play,
   * which has no pipeline and no frontier to overshoot, so nothing bounds it.
   */
  private leadTimeMs(session: PlaybackSession): number {
    return replacementLeadTimeMs(
      session.lookAheadMs,
      session.source.budgets?.deadlineMs ?? generationAttemptBudgetMs(),
    );
  }

  private runwayMs(): number {
    return this.elementRunwayMs() + this.readAheadRunwayMs();
  }

  /**
   * Host read-ahead expressed as time, through the bitrate of the source
   * actually being served.
   *
   * Bytes are what a read-ahead honestly knows; a duration is what the swap
   * decision needs. The conversion belongs here rather than in the adapter
   * because the session carries the bitrate and the adapter does not
   * necessarily. Zero whenever anything in the chain is unknown — an
   * unconvertible figure must not become a confident one.
   */
  private readAheadRunwayMs(): number {
    const bytes = this.snapshot.event.readAheadBytes;
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return 0;
    const session = this.snapshot.session ?? this.serverSession;
    const bitrate = session?.mode === 'direct'
      ? session.sourceInfo?.bitrate
      : session?.output?.bitrate ?? session?.sourceInfo?.bitrate;
    if (typeof bitrate !== 'number' || !Number.isFinite(bitrate) || bitrate <= 0) return 0;
    // Aged like the element half: this cache drains against the same playhead.
    return this.spentSince(bytes * 8 / bitrate * 1_000, this.lastPlayerEventAt);
  }

  /** The element's own cover, exactly as the last event reported it. */
  private reportedElementRunwayMs(): number {
    const { forwardBufferMs, bufferedRangesMs, positionMs } = this.snapshot.event;
    if (typeof forwardBufferMs === 'number' && Number.isFinite(forwardBufferMs)) {
      return Math.max(0, forwardBufferMs);
    }
    // `forwardBufferMs` is optional and an adapter may report only the ranges.
    // The contiguous run ahead of the viewer is the same quantity, so derive
    // it rather than treating a reported buffer as no buffer.
    const containing = bufferedRangesMs?.find(
      (range) => range.startMs <= positionMs && positionMs <= range.endMs,
    );
    if (containing) return Math.max(0, containing.endMs - positionMs);
    return 0;
  }

  private noteElementRunway(): void {
    const reported = this.reportedElementRunwayMs();
    if (reported > 0) this.trustedElementRunway = { ms: reported, at: machaHost().now() };
  }

  /**
   * What is left of a cover figure measured at `at`.
   *
   * **A buffer drains only while the viewer is playing**, which is why this is
   * not simply elapsed time. The fault this whole path exists for begins with
   * a pause long enough to have the session reaped, so the paused case is the
   * common one rather than the corner — and charging a paused viewer for the
   * probe would build a replacement against cover they still have. Measured
   * once already, on the timer this replaced: a 63.3 s span covered 59.4 s of
   * playback across one 3.9 s pause.
   *
   * A pause *between* the measurement and now is not tracked, so this
   * under-counts in that case. It is the safe direction only because nothing
   * decides on the runway while paused: the silence guard is disarmed and
   * `startPendingReplacement` returns early.
   */
  private spentSince(ms: number, at: number | undefined): number {
    if (at === undefined || this.snapshot.intent.paused) return Math.max(0, ms);
    return Math.max(0, ms - Math.max(0, machaHost().now() - at));
  }

  /**
   * Whether an empty buffer report is a fact about the media or about a player
   * on its way down.
   *
   * `positionMs` already has a guard for this: an element tearing down can
   * report zero, and `lastObservedPositionMs` keeps it forward-only so one
   * reading from a source already given up on cannot send the viewer back to
   * the start of the film. **`forwardBufferMs` rides through the same spread
   * with no such guard**, and it feeds a decision that is not reversible — a
   * spurious zero spends the cover the deferral exists to protect.
   *
   * The test is a contradiction rather than a heuristic: an element that is
   * *playing*, not buffering and not ended, with no cover ahead of the viewer,
   * is describing a state that cannot occur. `buffering` is the honest signal
   * for real exhaustion and is handled on its own, so distrusting the zero
   * here cannot hide a viewer who is actually waiting.
   *
   * Only while a recovery is in flight. Outside one there is nothing about to
   * spend the figure, and believing the player is the right default.
   */
  private emptyBufferIsEvidence(): boolean {
    const recovering = this.pendingReplacement !== undefined
      || this.regenerationPromise !== undefined
      || this.failoverPromise !== undefined;
    if (!recovering) return true;
    const { buffering, ended } = this.snapshot.event;
    return Boolean(buffering) || Boolean(ended) || this.snapshot.intent.paused;
  }

  private elementRunwayMs(): number {
    const reported = this.reportedElementRunwayMs();
    if (reported > 0) return this.spentSince(reported, this.lastPlayerEventAt);
    if (this.emptyBufferIsEvidence()) return 0;
    const trusted = this.trustedElementRunway;
    return trusted ? this.spentSince(trusted.ms, trusted.at) : 0;
  }

  /**
   * Give up a held replacement without using it, closing it on the node.
   *
   * Every path that abandons one has to come through here, because it is
   * holding a transcode slot. Tom's call to hold the slot at all rests on the
   * viewer who lost their session being the same viewer it is held for — which
   * stops being true the moment they close the player or seek somewhere the
   * generation cannot serve.
   */
  /**
   * Give up on replacing a source, without having built anything.
   *
   * **Cheap by construction, and that is the point of deferring.** The earlier
   * shape created the session immediately, so abandoning one meant closing it
   * on the node or leaking its transcode slot until `session_idle`. Nothing is
   * created until it is nearly needed now, so there is no session to close and
   * no slot to leak — only a decision to forget.
   */
  /**
   * Record that this source must be replaced, and guarantee it will be.
   *
   * **The timer is not the mechanism, it is the proof that there is one.**
   * Player events normally decide: the runway falls to the lead, or the
   * element reports it is buffering, or it ends short. All three are ordinary
   * and all three arrive first. But the client that reports `not-found` no
   * longer tears its presentation down, which means core is now the only thing
   * that will ever end this playback — and a recovery that depends on an event
   * arriving is a recovery that hangs when one does not.
   *
   * So the wait is bounded by what the viewer actually has. Worst case it
   * fires early against a paused viewer and builds a generation sooner than
   * needed, which costs a session; the alternative costs a viewer staring at a
   * frozen picture with nothing coming.
   */
  private startPendingReplacement(session: PlaybackSession, runwayMs: number, leadTimeMs: number): void {
    this.pendingReplacement = session;
    this.patchSnapshot({ preparingSource: false, notice: undefined });
    this.log.info('replacement-pending', {
      sessionId: session.sessionId,
      runwayMs,
      leadTimeMs,
    });
    this.armPendingReplacementGuard();
  }

  /**
   * Guard a pending replacement against the player going silent, without
   * trying to predict when the runway will run out.
   *
   * **The first version predicted, and could not.** It armed a timer for
   * `runway - lead` on the reasoning that a buffer drains a second per second.
   * It does not: it drains only while the viewer is *playing*, and this whole
   * fault begins with a pause long enough to have the session reaped. Measured
   * — a 63.3 s timer spanned 59.4 s of playback across one 3.9 s pause, and
   * drained 59.2 s of buffer. Exact, and exactly wrong. Every run built on the
   * timer rather than the runway, so the mechanism never once decided.
   *
   * A margin cannot fix that. A margin large enough to survive an arbitrary
   * pause is large enough never to fire.
   *
   * So the runway decides, from player events, which were measured tracking
   * the element to the millisecond. This only asks whether those events have
   * stopped arriving at all — and it is disarmed while the viewer is paused,
   * because a paused element reports nothing and has nothing to report.
   */
  private armPendingReplacementGuard(): void {
    if (this.pendingReplacementTimer !== undefined) clearTimeout(this.pendingReplacementTimer);
    this.pendingReplacementTimer = undefined;
    if (!this.pendingReplacement || this.snapshot.intent.paused) return;
    this.pendingReplacementTimer = setTimeout(() => {
      this.pendingReplacementTimer = undefined;
      const pending = this.pendingReplacement;
      if (!pending || this.disposed) return;
      this.log.warn('pending-replacement-player-silent', {
        sessionId: pending.sessionId,
        silenceMs: PLAYER_SILENCE_GUARD_MS,
        runwayMs: this.runwayMs(),
      });
      void this.buildReplacement(pending, 'player-silent');
    }, PLAYER_SILENCE_GUARD_MS);
  }

  private discardPendingReplacement(reason: string): void {
    if (this.pendingReplacementTimer !== undefined) clearTimeout(this.pendingReplacementTimer);
    this.pendingReplacementTimer = undefined;
    const pending = this.pendingReplacement;
    if (!pending) return;
    this.pendingReplacement = undefined;
    this.log.info('pending-replacement-discarded', {
      sessionId: pending.sessionId,
      endpoint: pending.endpoint,
      reason,
    });
  }

  private failTerminal(fatalError: Error): void {
    if (this.disposed || this.snapshot.fatalError) return;
    this.discardPendingReplacement('terminal-failure');
    this.log.error('fatal', fatalError);
    this.patchSnapshot({ fatalError, notice: undefined, starting: false, preparingSource: false });
  }

  private patchSnapshot(patch: Partial<PlaybackCoordinatorSnapshot>): void {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener(this.getSnapshot());
  }
}

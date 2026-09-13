import { createClientLogger } from '../diagnostics/ClientLog.js';
import { isEndpointRetryablePlaybackFailure, PlaybackSourceError, type Player } from '../platform/Platform.js';
import type { MediaSummary, PlaybackCapabilities, PlaybackEvent, PlaybackSource, PlaybackMode } from '../types.js';
import type {
  PlaybackPreferencesUpdate,
  PlaybackResolver,
  PlaybackSession,
  PlaybackStopOptions,
  PlaybackUpdate,
} from './PlaybackResolver.js';
import { technicalProfileFromSession } from './MediaTechnicalProfile.js';
import type { PlaybackDecisionFacts } from '../api/PlaybackFactsApi.js';
import { choosePlaybackInstruction, degradeInstruction, segmentContainer, type PlaybackChoiceAssumption, type PlaybackDecisionReason, type PlaybackInstruction, type PlaybackPolicyOverrides, type SegmentContainer } from './choosePlaybackInstruction.js';
import { machaHost } from '../runtime/host.js';
import { abortError } from '../errors.js';

export interface PlaybackIntent {
  positionMs: number;
  paused: boolean;
}

export interface PlaybackCoordinatorSnapshot {
  intent: PlaybackIntent;
  event: PlaybackEvent;
  session?: PlaybackSession;
  starting: boolean;
  preparingSource: boolean;
  pendingPreferences?: PlaybackPreferencesUpdate;
  fatalError?: Error;
  notice?: string;
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
  /** The viewer chose this mode themselves; the chooser was not consulted. */
  chosenByViewer: boolean;
  /**
   * True when the instruction is a fallback rather than a decision — the
   * facts were unavailable, so nothing could be reasoned from.
   */
  withoutFacts: boolean;
}

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
   */
  facts?: (media: MediaSummary) => Promise<PlaybackDecisionFacts | undefined>;
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
const ALTERNATE_RECOVERY_WINDOW_MS = 30_000;
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
const ALTERNATE_TRANSCODE_RECOVERY_WINDOW_MS = 8_000;
const PLAYBACK_END_TOLERANCE_MS = 5_000;
const UNCACHED_SEEK_DEBOUNCE_MS = 300;

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
  return !!error && typeof error === 'object' && (error as { status?: unknown }).status === 400;
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
   * The Direct Play source actually loaded into the player right now, kept
   * distinct from `serverSession.source`. A silently promoted alternate
   * (see `promoteSilentDirectAlternate`) moves session bookkeeping forward
   * without ever touching the player, so the read-ahead worker's fallback
   * registration must keep addressing the URL genuinely loaded in the video
   * element — not whatever session is current for lifecycle purposes — or
   * it targets a source key the worker never configured.
   */
  private activeDirectPlaySource?: PlaybackSource;

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
  private cachedFacts?: Promise<PlaybackDecisionFacts | undefined>;
  private factsError?: unknown;
  private chosenInstruction?: PlaybackInstruction;

  private facts(): Promise<PlaybackDecisionFacts | undefined> {
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
    this.cachedFacts ??= Promise.resolve(this.options.facts?.(this.options.media))
      .catch((error: unknown) => {
        // Kept, not swallowed: a thrown lookup and an absent supplier both
        // yield undefined, and they are not the same thing at all.
        this.factsError = error;
        return undefined;
      });
    return this.cachedFacts;
  }

  private async instructedPreferences(
    preferences: PlaybackPreferencesUpdate,
    capabilities: PlaybackCapabilities,
  ): Promise<PlaybackPreferencesUpdate> {
    if (preferences.mode !== undefined && preferences.mode !== 'choose') {
      this.patchSnapshot({ instruction: {
        mode: preferences.mode, video: preferences.video, audio: preferences.audio,
        container: preferences.container,
        reasons: [], assumed: [], chosenByViewer: true, withoutFacts: false,
      } });
      return preferences;
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
      } });
      this.log.warn('instruction-without-facts', { mediaId: this.options.media.id, container });
      return { ...preferences, mode: 'transcode', container };
    }

    const instruction = choosePlaybackInstruction(facts.profile, capabilities, {
      overrides: this.options.policyOverrides,
      operations: facts.operations,
    });
    this.log.info('instruction-chosen', {
      mediaId: this.options.media.id,
      assumed: instruction.assumed,
      mode: instruction.mode,
      video: instruction.video,
      audio: instruction.audio,
      container: instruction.container,
      reasons: instruction.reasons,
    });
    this.chosenInstruction = instruction;
    this.patchSnapshot({ instruction: {
      mode: instruction.mode, video: instruction.video, audio: instruction.audio,
      container: instruction.container,
      reasons: instruction.reasons, assumed: instruction.assumed,
      chosenByViewer: false, withoutFacts: false,
    } });
    return { ...preferences, ...instructionPreferences(instruction) };
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
    const viewerChose = (this.options.initialPreferences?.mode ?? 'choose') !== 'choose';
    try {
      return await this.options.resolver.resolve(this.options.media, capabilities, positionMs, preferences);
    } catch (error) {
      const instruction = this.chosenInstruction;
      if (viewerChose || !instruction || !isExecutorRefusal(error)) throw error;
      const degraded = degradeInstruction(instruction);
      if (!degraded) throw error;

      this.log.warn('instruction-degraded', {
        mediaId: this.options.media.id,
        from: { video: instruction.video, audio: instruction.audio, mode: instruction.mode },
        to: { video: degraded.video, audio: degraded.audio, mode: degraded.mode },
        error,
      });
      this.chosenInstruction = degraded;
      this.patchSnapshot({ notice: 'This node could not copy the original streams, so they are being converted.' });
      return await this.options.resolver.resolve(
        this.options.media,
        capabilities,
        positionMs,
        { ...preferences, ...instructionPreferences(degraded) },
      );
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
      if (userMovedDuringResolve && this.activationPosition(session, currentDesired, requestedPositionMs) === undefined) {
        this.scheduleSeekMutation({
          reason: 'seek',
          update: {
            seekMs: currentDesired,
            preferences: preservedSeekPreferences(session),
          },
        });
      } else {
        // A transformed server may keyframe-align the requested generation after
        // the exact requested point. When this is the generation we explicitly
        // requested, accept that alignment rather than creating a retry loop.
        this.activateSession(session, currentDesired, requestedPositionMs);
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

    this.closePromise = (async () => {
      await this.startPromise?.catch(() => undefined);
      await this.mutationLoop?.catch(() => undefined);
      await Promise.all([...this.alternatePreparations].map((preparation) => preparation.catch(() => undefined)));
      const session = this.serverSession ?? this.snapshot.session ?? ownedAtClose;
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
      this.patchSnapshot({ notice: 'This stream cannot seek.' });
      return false;
    }
    const durationMs = session?.durationMs || this.snapshot.event.durationMs || this.options.media.durationMs;
    const bounded = clampPosition(positionMs, durationMs);
    this.lastSeekTransitionAt = Date.now();
    this.positionRevision += 1;
    this.seekIntentActive = true;
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
    preparedAbsoluteMs: number,
  ): number | undefined {
    const localPositionMs = generationLocalPosition(session, desiredAbsoluteMs);
    if (localPositionMs !== undefined) return localPositionMs;
    // A transformed server may align the exact requested point to a later
    // keyframe. Accept that explicit result at its local origin. If playback
    // merely advanced while the request was in flight, localPositionMs above
    // catches the new source up without negotiating another generation.
    return Math.round(preparedAbsoluteMs) === Math.round(desiredAbsoluteMs) ? 0 : undefined;
  }

  update(update: PlaybackUpdate): void {
    if (this.disposed) return;
    const session = this.snapshot.session;
    if (!session) {
      this.patchSnapshot({ notice: 'Playback options are still loading.' });
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
      this.update({ ...update, preferences });
    } catch (error) {
      this.log.warn('instruction-rechoose-failed', { mediaId: this.options.media.id, error });
      this.patchSnapshot({ notice: 'Could not work out how to play this here.' });
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
      notice: next.reason === 'subtitle' ? 'Loading subtitles…' : undefined,
    });
    this.mutationRevision += 1;
    if (!this.mutationLoop) {
      this.mutationLoop = this.drainMutations().finally(() => {
        this.mutationLoop = undefined;
        if (!this.disposed && this.seekDebounceTimer === undefined && !this.debouncedSeekMutation) {
          this.patchSnapshot({ preparingSource: false, pendingPreferences: undefined });
        }
      });
    }
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
      const update = restatePreferencesClearedByMode(
        positioned,
        current,
        this.snapshot.instruction?.container,
      );
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
        if (userMovedDuringRequest && this.activationPosition(next, currentDesired, requestedPositionMs) === undefined) {
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

        this.activateSession(next, currentDesired, requestedPositionMs);
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
        this.patchSnapshot({ notice: error instanceof Error ? error.message : String(error) });
        this.rollbackUnfulfilledSeek();
      } finally {
        if (this.activeMutation?.controller === controller) this.activeMutation = undefined;
        resolveSettled();
      }
    }
  }

  private activateSession(session: PlaybackSession, desiredAbsoluteMs: number, preparedAbsoluteMs: number): void {
    if (this.disposed) return;
    // Catalogue profiling may already have prepared the reusable player. The
    // session supplies the same facts authoritatively and completes that setup
    // without introducing another awaited step in source activation.
    this.options.player.prepare?.(technicalProfileFromSession(session));
    const activationRevision = ++this.sourceActivationRevision;
    this.releaseObsoleteAlternates(session.sessionId);
    const localPositionMs = this.activationPosition(session, desiredAbsoluteMs, preparedAbsoluteMs);

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
    this.setSession(session);
    this.activeDirectPlaySource = session.mode === 'direct' ? session.source : undefined;
    this.streamOffsetMs = session.mode === 'direct' ? 0 : Math.max(0, session.seekMs);
    const absoluteStartMs = session.mode === 'direct'
      ? localPositionMs
      : this.streamOffsetMs + localPositionMs;
    // Source attachment emits transient zero/paused media events. Keep the
    // requested transport target authoritative until the active player reports
    // that it has actually reached this source-generation position.
    this.seekIntentActive = true;
    this.patchSnapshot({
      intent: { ...this.snapshot.intent, positionMs: absoluteStartMs },
      event: {
        ...this.snapshot.event,
        positionMs: absoluteStartMs,
        durationMs: session.durationMs,
        paused: this.snapshot.intent.paused,
        ended: false,
        // Buffer residency belongs to a source generation. Never carry the old
        // generation's ranges across a transformed source activation.
        bufferedRangesMs: [],
        forwardBufferMs: 0,
      },
    });

    this.log.info('source-activate', {
      sessionId: session.sessionId,
      mode: session.mode,
      source: session.source.url,
      generationStartMs: this.streamOffsetMs,
      desiredAbsoluteMs,
      localPositionMs,
      paused: this.snapshot.intent.paused,
    });

    const startPaused = this.snapshot.intent.paused;
    void this.options.player.play(session.source, localPositionMs, startPaused).then((started) => {
      if (this.disposed || activationRevision !== this.sourceActivationRevision) return;
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
   */
  private currentPreferences(session: PlaybackSession): PlaybackPreferencesUpdate {
    return withRestatedSegmentContainer(
      { ...completePreferences(session), ...this.snapshot.pendingPreferences },
      this.snapshot.instruction?.container,
    );
  }

  private degrade(error: Error): void {
    if (this.disposed || !isEndpointRetryablePlaybackFailure(error)) return;
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
    this.activateSession(alternate, desiredMs, alternate.seekMs);
    // Closed now rather than after buffered evidence on the replacement: the
    // standby was promoted because the primary stopped serving, so there is
    // nothing to fall back to and no reason to hold the slot. Fire and
    // forget, exactly as the silent direct promotion does — retrying belongs
    // to the resolver, which is the layer every client passes through.
    void this.options.resolver.stop(session.sessionId).catch((error) => {
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
        }, alternate.mode === 'transcode'
          ? ALTERNATE_TRANSCODE_RECOVERY_WINDOW_MS
          : ALTERNATE_RECOVERY_WINDOW_MS);
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
    void this.options.resolver.stop(previous.sessionId).catch((error) => {
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
    return {
      ...instruction,
      servedContainer: served,
      containerHonoured: requested === undefined || served === undefined
        ? undefined
        : served === requested,
    };
  }

  private onPlayerEvent(next: PlaybackEvent): void {
    if (this.disposed) return;
    const session = this.snapshot.session;
    const absolutePositionMs = next.positionMs + (session?.mode === 'direct' ? 0 : this.streamOffsetMs);
    this.lastObservedPositionMs = absolutePositionMs;
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
      this.log.warn('premature-source-end', {
        sessionId: session?.sessionId,
        positionMs: absolute.positionMs,
        durationMs: absolute.durationMs,
        remainingMs: absolute.durationMs - absolute.positionMs,
      });
      this.fail(new PlaybackSourceError('Playback source ended before the media was complete', 'stream'));
      return;
    }

    const target = this.snapshot.intent.positionMs;
    if (this.seekIntentActive && !next.seeking && Math.abs(absolutePositionMs - target) <= 1_500) {
      this.seekIntentActive = false;
    }

    // Media events are observations, not commands. In particular, source swaps
    // may transiently emit pause/play events and must never overwrite a Pause or
    // Play intent the user issued while that source was being prepared. Position
    // follows the player only once an outstanding seek/source target is reached.
    const intent = this.seekIntentActive
      ? this.snapshot.intent
      : { ...this.snapshot.intent, positionMs: absolutePositionMs };
    this.patchSnapshot({ event: absolute, intent });
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
    if (failedSession && this.options.resolver.failover && isEndpointRetryablePlaybackFailure(fatalError)) {
      this.failoverPromise = this.recoverFromSourceFailure(failedSession, fatalError).finally(() => {
        this.failoverPromise = undefined;
      });
      return;
    }
    this.failTerminal(fatalError);
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
      const next = await this.options.resolver.failover!(
        failedSession,
        this.options.media,
        capabilities,
        requestedPositionMs,
        this.currentPreferences(failedSession),
        preparedAlternate,
      );
      if (this.disposed) {
        await this.options.resolver.stop(next.sessionId).catch(() => undefined);
        return;
      }
      this.serverSession = next;
      this.alternateSessions.delete(next.sessionId);
      const alternateExpiry = this.alternateExpiryTimers.get(next.sessionId);
      if (alternateExpiry !== undefined) clearTimeout(alternateExpiry);
      this.alternateExpiryTimers.delete(next.sessionId);
      const currentDesired = this.snapshot.intent.positionMs;
      const userMovedDuringRequest = requestedPositionRevision !== this.positionRevision;
      if (userMovedDuringRequest && this.activationPosition(next, currentDesired, requestedPositionMs) === undefined) {
        this.queueMutation({
          reason: 'seek',
          update: { seekMs: currentDesired, preferences: preservedSeekPreferences(next) },
        });
      } else {
        this.activateSession(next, currentDesired, requestedPositionMs);
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
      this.log.error('source-failover-exhausted', { failedSessionId: failedSession.sessionId, error: failoverError });
      this.failTerminal(failoverError instanceof Error ? failoverError : error);
    }
  }

  private failTerminal(fatalError: Error): void {
    if (this.disposed || this.snapshot.fatalError) return;
    this.log.error('fatal', fatalError);
    this.patchSnapshot({ fatalError, notice: undefined, starting: false, preparingSource: false });
  }

  private patchSnapshot(patch: Partial<PlaybackCoordinatorSnapshot>): void {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener(this.getSnapshot());
  }
}

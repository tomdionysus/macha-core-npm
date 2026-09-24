import type { MediaSummary, PlaybackCapabilities, PlaybackMode, PlaybackSource } from '../types.js';
import { SERVER_SEGMENT_HOLD_MS, SERVER_STARTUP_TIMEOUT_MS, type PlaybackProduction } from './streamProtocol.js';

export type PlaybackStreamType = 'video' | 'audio' | 'subtitle' | 'other';
export type PlaybackTransform = 'copy' | 'transcode' | 'omit';

export interface PlaybackStreamInfo {
  index: number;
  type: PlaybackStreamType;
  codec: string;
  profile: string;
  language: string;
  default: boolean;
  forced: boolean;
  width?: number;
  height?: number;
  channels?: number;
  sampleRate?: number;
  bitDepth?: number;
  bitrate?: number;
  /** Encoded level (H.264/HEVC), when the server reports one. */
  level?: number;
  /**
   * Transfer characteristics by their ffmpeg/H.273 name — `smpte2084` (PQ),
   * `arib-std-b67` (HLG), or an SDR name. Reported per stream on both the
   * source and, after negotiation, whatever the server decided to serve, so
   * a client can tell whether it was actually given the HDR it asked for.
   */
  colorTransfer?: string;
  /** Dolby Vision profile of the source stream, when it carries one. */
  dolbyVisionProfile?: number;
  /** Base-layer compatibility id, which decides what a non-DV decoder sees. */
  dolbyVisionCompatibility?: number;
}

export interface PlaybackSourceInfo {
  path: string;
  /** Raw demuxer list. Use `container` for capability matching. */
  format: string;
  /** Resolved container family, when the server reports one. */
  container?: string;
  size: number;
  bitrate: number;
  streams: PlaybackStreamInfo[];
}

export interface PlaybackOutputVideoInfo {
  sourceStream: number;
  transform: PlaybackTransform;
  codec?: string;
  profile?: string;
  width?: number;
  height?: number;
  bitrate?: number;
  /**
   * What is actually served, which is the only way to tell a successful
   * downconvert from a gate that did nothing. A copied stream reports the
   * source's values; a transcode reports the encoder's — so a PQ source
   * transcoded for an SDR client shows `smpte2084` on the source stream and
   * `bt709` here.
   */
  bitDepth?: number;
  level?: number;
  colorTransfer?: string;
}

export interface PlaybackOutputAudioInfo {
  sourceStream: number;
  transform: PlaybackTransform;
  codec?: string;
  profile?: string;
  channels?: number;
  sampleRate?: number;
  bitDepth?: number;
  bitrate?: number;
}

export interface PlaybackOutputInfo {
  format?: string;
  /**
   * The container actually served — `fmp4` or `mpegts` for HLS, the source
   * file's own container for a direct session.
   *
   * The instruction says which segment container to package into; this says
   * which one came back, and until the server reported it there was no way to
   * tell a preference that took effect from one that was ignored. Absent when
   * the node predates the field: read that as unknown, never as a default,
   * because a default is indistinguishable on screen from an answer.
   */
  container?: string;
  bitrate?: number;
  video?: PlaybackOutputVideoInfo;
  audio?: PlaybackOutputAudioInfo;
}

export interface PlaybackSelection {
  videoStream: number;
  audioStream: number;
  subtitleStream: number;
}

export interface PlaybackOptions {
  modes: PlaybackMode[];
  qualityHeights: number[];
  mediaIds: string[];
  audioStreams: PlaybackStreamInfo[];
  subtitleStreams: PlaybackStreamInfo[];
  canSeek: boolean;
  canChangeQuality: boolean;
  canSwitchMedia: boolean;
}

export interface PlaybackPreferences {
  mode: PlaybackMode;
  maxHeight: number | null;
  maxBitrate: number | null;
  /** Echoed from server 0.58.0; absent from an older node, which does not take it. */
  videoStream?: number | null;
  audioStream: number | null;
  subtitleStream: number | null;
  audioLanguage: string;
  subtitleLanguage: string;
}

export interface PlaybackSession {
  sessionId: string;
  /** Node/API provenance for this disposable playback generation. */
  endpoint?: { id: string; baseUrl: string };
  itemId?: string;
  mediaId: string;
  mode: PlaybackMode;
  mimeType: string;
  source: PlaybackSource;
  durationMs: number;
  /**
   * How far past the last fragment requested this node will have produced,
   * from `stream.look_ahead_ms`.
   *
   * **The line between a fragment request that is held and one refused.** A
   * node produces to `highest_requested + max_ahead_segments` and parks, and
   * the hold window is deliberately the same distance — so a viewer arriving
   * beyond this finds the encoder still working towards them, answering
   * `500 segment_not_ready` until it arrives. That is not a fault and must not
   * be read as one; production is sequential, so asking for a distant index
   * does not skip the fragments before it.
   *
   * **Three states, and none may be collapsed.** `undefined` — the node
   * predates server 0.45.0 and cannot say, so a client must bound itself
   * conservatively rather than assume a default. `null` — direct play, which
   * has no pipeline and therefore no frontier at all. A number — the answer,
   * in milliseconds.
   *
   * **Per session, not per node.** It follows the node's `reconfigure()`, so
   * it is read from the session that reports it and never cached against an
   * endpoint.
   *
   * Nothing on the wire carried this before, so a client had only the defaults
   * to reason from. One that assumed 8 segments of 4 s against a node
   * configured for 4 believed it had 32 s of authorised production when it had
   * 16, and sat refused at the frontier for the difference — measured as a
   * 12.7 s viewer freeze on 2026-09-17.
   */
  lookAheadMs?: number | null;
  /**
   * How fast this generation is producing, from `stream.production`.
   *
   * **Absent means the node cannot say** — direct play, which has no
   * pipeline, or a node older than server 0.47.0. Never read absence as zero
   * and never substitute a default; the same convention `lookAheadMs` and the
   * per-node budgets already use, which is what makes it safe in a
   * mixed-version cluster.
   *
   * **Per generation, and it resets.** A PATCH that changes mode, quality,
   * seek or media builds a new generation with a new segment store, so the
   * block on that response is the first reading of a *different* pipeline,
   * not a fresh reading of the same one. **A rate carried across a generation
   * change is a rate for a pipeline that no longer exists** — discard it
   * rather than decaying it. For a current reading on a running generation,
   * re-read the session.
   */
  production?: PlaybackProduction;
  /**
   * Where this generation's media begins on the title's timeline.
   *
   * **The baseline, not the position that was asked for.** A remux generation
   * begins at the last keyframe at or before the request; `seekOffsetMs`
   * carries the remainder. A consumer that treats this as "where the viewer
   * is" reports every position in such a generation too early by the offset.
   */
  seekMs: number;
  /**
   * How far into this generation the requested position sits, where the node
   * reports it.
   *
   * `seekMs + seekOffsetMs === seekRequestedMs`, exactly. Never negative, so
   * the generation always contains the position asked for. Zero exactly when
   * the mode can be frame-accurate.
   *
   * **Undefined means the node predates server 0.46.0 and cannot say** — not
   * that the offset is zero. An older node snapped a remux seek *forward* to
   * the next keyframe instead, by up to 9.3 s measured, so on those nodes the
   * generation may begin after the request rather than before it.
   */
  seekOffsetMs?: number;
  /** The position the node honoured, after clamping to the title's duration. */
  seekRequestedMs?: number;
  preferences: PlaybackPreferences;
  sourceInfo: PlaybackSourceInfo;
  output: PlaybackOutputInfo;
  selected: PlaybackSelection;
  transform: {
    video: PlaybackTransform;
    audio: PlaybackTransform;
  };
  options: PlaybackOptions;
}

export interface PlaybackPreferencesUpdate {
  /**
   * Required on session creation, optional on update.
   *
   * There is no `auto`. The server reports what the media is and performs
   * what it is told; deciding is the client's job, and
   * `choosePlaybackInstruction` is how the core does it from source facts
   * plus honest host capabilities.
   *
   * `'choose'` is a **client-side sentinel and never reaches the server**. It
   * means "decide for me now", and the coordinator replaces it with a
   * concrete instruction before anything is sent. It is not the old `auto`
   * under a new name: `auto` asked the server to decide, this asks the core
   * to, from facts the server does not have. It shares the `mode` field
   * because choosing and naming a mode are mutually exclusive — as two
   * fields they could contradict each other, and something would have to
   * decide which wins.
   */
  mode?: PlaybackMode | 'choose';
  /**
   * Which of the item's files to play, sent as the session's `media_id` when
   * a session is created. The client chooses among an item's files, not the
   * server (Tom, 2026-09-24): `PlaybackCoordinator` sets it from the chooser,
   * and replacement generations restate the file being served. Ignored by an
   * update; switching file mid-session is `PlaybackUpdate.mediaId`.
   */
  mediaId?: string;
  /**
   * Which video stream, when the file has several. From server 0.58.0 a node
   * chooses no stream: with several video or audio streams and none named it
   * refuses with `choice_required`. The coordinator names them; see
   * `streamsToName`. A 0.57.0 node ignores this field.
   */
  videoStream?: number;
  /** Per-stream instruction, overriding the `mode` shorthand when given. */
  video?: 'copy' | 'transcode';
  audio?: 'copy' | 'transcode';
  /** Which HLS segment container to package into. */
  container?: 'fmp4' | 'mpegts';
  maxHeight?: number | null;
  maxBitrate?: number | null;
  audioStream?: number | null;
  subtitleStream?: number | null;
  audioLanguage?: string;
  subtitleLanguage?: string;
}

export interface PlaybackUpdate {
  preferences?: PlaybackPreferencesUpdate;
  seekMs?: number;
  mediaId?: string;
}

export interface PlaybackStopOptions {
  /** Keep the teardown request alive while the browser is navigating away. */
  keepalive?: boolean;
  /**
   * This node has already been charged for the outage that made this close
   * necessary, so the close itself must not charge it again.
   *
   * A promotion records the endpoint's failure — nothing else would, because
   * the node never refused anything, it stopped serving bytes — and then
   * closes the session it was serving. That DELETE goes to the same node,
   * which is by now unwell, so it frequently throws; without this the throw
   * records a *second* failure for one observation, and a session closed on
   * every retry walks the cooldown ladder (500 ms, 2 s, 10 s, 30 s) for a node
   * that failed once. It is the same double-charge `releaseFailedSession`
   * exists to avoid, reached from the layer above it.
   *
   * It also means the generation is abandoned: an implementation holding
   * per-session provenance drops it whether or not the node ever acknowledges
   * the close, so a later cleanup path cannot find it and charge a third time.
   */
  endpointAlreadyCharged?: boolean;
}

/**
 * How much longer than a node's own startup budget core waits, to cover
 * getting the request there and the response back.
 *
 * **A node's `startup_timeout_ms` bounds what the node spends, not what core
 * observes.** It starts when the node begins work and stops when the node
 * gives up on itself; the request travelling out and the response travelling
 * back are outside it by definition. So budgeting exactly the stated figure
 * kills a node that met its own deadline: one producing a first fragment at
 * 14.9 s, comfortably inside a 15 s entitlement, arrives here later than that
 * and is abandoned for being punctual.
 *
 * Measured once, on 2026-09-18 against `tmdb:episode:7203311`: a
 * `session-update` round trip of 13,433 ms against a node-side first fragment
 * at 11,672 ms, so about 1,761 ms of transport. **One sample, and it is worth
 * knowing that is all it is** — 4,000 is a guess with roughly 2.3x headroom
 * over that reading, chosen to work in most situations rather than derived
 * from a distribution nobody has.
 *
 * **What it is not.** It is not slack for a slow node and not a margin on the
 * server's policy. A node that overruns its own `startup_timeout_ms` has
 * failed by its own rule, and this does not extend that — it only stops core
 * charging a node for the distance between them.
 *
 * **It is meant to stop being a constant.** Core already holds per-endpoint
 * round-trip samples (`EndpointRegistry.recordLatency`) and per-endpoint
 * throughput (`EndpointBandwidth`), which is the evidence a real figure comes
 * from, and the distance to a node is the one term in this arithmetic that no
 * node can report about itself. Until that heuristic exists, one number for
 * every endpoint is the honest placeholder rather than a settled answer.
 */
export const ENDPOINT_TRANSPORT_ALLOWANCE_MS = 4_000;

/**
 * What a node says about itself, as far as a deadline is concerned. Structural
 * only, so this module does not depend on the cluster layer that supplies it.
 */
export interface StatedNodeBudgets {
  startupTimeoutMs?: number;
  segmentTimeoutMs?: number;
}

/**
 * How long one attempt against **this** node may take.
 *
 * `startup_timeout_ms` is law for the node that stated it: it is that node's
 * own rule for when it stops trying, and core has no standing to second-guess
 * it in either direction. Core adds only the distance between them, which is
 * the one term the node cannot know about itself.
 *
 * **Absence falls back to the published default and never to something
 * shorter.** A node that cannot say is not a node that needs less time, and
 * the failure this exists to stop — abandoning a working node inside its own
 * entitlement — is caused precisely by budgeting under the real figure.
 */
export function generationAttemptBudgetMs(stated?: StatedNodeBudgets): number {
  const startupMs = stated?.startupTimeoutMs ?? SERVER_STARTUP_TIMEOUT_MS;
  return Math.max(0, startupMs) + ENDPOINT_TRANSPORT_ALLOWANCE_MS;
}

/**
 * How long **this** node holds a fragment it has not produced yet.
 *
 * No transport allowance: this one describes the node's behaviour to a host
 * deciding whether a refusal was expected, not a deadline core enforces, and
 * padding it would misreport what the node does.
 */
export function segmentHoldMs(stated?: StatedNodeBudgets): number {
  return Math.max(0, stated?.segmentTimeoutMs ?? SERVER_SEGMENT_HOLD_MS);
}

/** Server-side playback negotiation and session-control seam. */
export interface PlaybackResolver {
  readonly available: boolean;
  resolve(
    media: MediaSummary,
    capabilities: PlaybackCapabilities,
    seekMs?: number,
    preferences?: PlaybackPreferencesUpdate,
  ): Promise<PlaybackSession>;
  update(sessionId: string, update: PlaybackUpdate, signal?: AbortSignal): Promise<PlaybackSession>;
  stop(sessionId: string, options?: PlaybackStopOptions): Promise<void>;
  /** Recreate client-owned playback intent on another node after source failure. */
  failover?(
    failedSession: PlaybackSession,
    media: MediaSummary,
    capabilities: PlaybackCapabilities,
    seekMs: number,
    preferences: PlaybackPreferencesUpdate,
    preparedAlternate?: PlaybackSession,
  ): Promise<PlaybackSession>;
  /**
   * Whether the node that issued this generation still holds it.
   *
   * The question that resolves a `PlaybackFailureKind` of `not-found`, which a
   * player cannot resolve for itself: a reaped session and a fragment past the
   * end of the plan are the same status and the same error code on the wire.
   *
   * Resolves `false` only on a definitive `404` from the owning node. It
   * throws when the answer could not be obtained, and callers must keep those
   * apart — "I could not find out" is not "it is gone", and acting on the
   * second when you have the first condemns a node for being briefly
   * unreachable.
   *
   * Never call it on a timer. See `SERVER_SESSION_IDLE_MS` for why a keepalive
   * is the wrong shape here.
   */
  sessionAlive?(sessionId: string): Promise<boolean>;
  /**
   * Replace a generation on the node already serving it, without holding that
   * node responsible for it.
   *
   * Distinct from `failover`, which means "this node failed" and records it.
   * A node answering `404 not_found` for a session it has reaped is making a
   * statement about that session, not about itself, and is the right place to
   * ask again. See `ClusterPlaybackResolver.regenerate` for the whole of why.
   *
   * Rejects when the endpoint is unknown or no longer configured; deciding to
   * failover instead is the caller's.
   */
  regenerate?(
    failedSession: PlaybackSession,
    media: MediaSummary,
    capabilities: PlaybackCapabilities,
    seekMs: number,
    preferences: PlaybackPreferencesUpdate,
  ): Promise<PlaybackSession>;
  /**
   * Build a generation on a named node, for a viewer who chose it.
   *
   * Optional because it is the one operation that is not a recovery: every
   * other route into another node is entered on failure, which is why "serve
   * this from that node instead" had no expression until it existed. A
   * resolver that cannot target a node simply omits it, and
   * `PlaybackCoordinator.moveTo` answers `false`.
   *
   * **Never stops the outgoing generation.** The caller still has a viewer
   * watching it, and the account cap is counted per node, so holding both
   * across the swap is free. Releasing the old one is the caller's, after it
   * has promoted the new one — unlike `failover`, which releases what it
   * abandons because nothing is watching it by then.
   *
   * Resolves `undefined` when the target is already serving, is not a known
   * candidate, or would come back in a different mode: a viewer asking for a
   * different node has not asked for a different transform.
   */
  /**
   * Wait until the node says this generation has produced something, for a
   * player that cannot ride out a `segment_not_ready` hold.
   *
   * Read from the session route's `production.produced_ms`, which the node
   * advances only when a whole segment is published -- never by touching the
   * media. `produced` once it is above zero; `gone` when the node no longer
   * holds the session; `unknown` when the node does not report production
   * (direct play, a node older than 0.47.0) or said nothing within its own
   * attempt budget. `unknown` means hand the source over as before.
   */
  awaitProduced?(session: PlaybackSession, signal?: AbortSignal): Promise<'produced' | 'gone' | 'unknown'>;
  /**
   * What starting a generation equivalent to `activeSession` would cost on this
   * node, in milliseconds, from the resolver's own recent measurements.
   * Undefined means unknown, never zero. See `EndpointRegistry.generationStartEstimate`.
   */
  startCostEstimate?(endpointId: string, activeSession: PlaybackSession): number | undefined;
  prepareOn?(
    endpointId: string,
    activeSession: PlaybackSession,
    media: MediaSummary,
    capabilities: PlaybackCapabilities,
    seekMs: number,
    preferences: PlaybackPreferencesUpdate,
  ): Promise<PlaybackSession | undefined>;
  /** Prepare one bounded standby generation without delaying active playback. */
  prepareAlternate?(
    activeSession: PlaybackSession,
    media: MediaSummary,
    capabilities: PlaybackCapabilities,
    seekMs: number,
    preferences: PlaybackPreferencesUpdate,
  ): Promise<PlaybackSession | undefined>;
  /**
   * Record that a specific endpoint has failed without negotiating any new
   * session. Needed when the transport layer has already moved off an
   * endpoint silently (see `PlaybackCoordinator`'s direct-source-alternative
   * promotion) — endpoint health/cooldown tracking must still learn about
   * the failure, or a later failover can blindly retry a node already known
   * to be dead.
   */
  recordEndpointFailure?(endpointId: string): void;
}

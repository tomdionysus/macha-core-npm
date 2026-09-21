import type { PlaybackFailureKind } from '../platform/Platform.js';

/**
 * How long a node will hold a request for a fragment it has not produced yet,
 * before answering `500 segment_not_ready`.
 *
 * This is the server's `streaming.segment_timeout`, and it belongs here because
 * **every client that plays anything is calibrated against it**: a stall budget
 * must exceed it, a fragment read timeout must exceed it, a hold-retry backoff
 * derives from it. Before this existed the same number lived in a comment here,
 * a literal in a test, and a private constant in a client — three declarations
 * of one server fact, none able to see the others.
 *
 * A held request sends no bytes, so any client deadline shorter than this
 * expires before the answer arrives: the client aborts, takes its timeout path,
 * and a node behaving correctly is recorded as a network fault. That has nearly
 * shipped three times, each time because two numbers were chosen independently
 * and each was defensible alone.
 *
 * **It is the server's default, and the node now states its own.**
 * `segment_timeout_ms` is in the per-node playback block of `/api/v1/status`,
 * and `EndpointRegistry.playbackBudgets` carries it for every node the health
 * monitor has heard from — including one this client has never created a
 * session on, which is the case that matters before a failover. Read that
 * where there is one.
 *
 * This constant is what remains when there is not: a node not yet heard from,
 * or a figure it declines to state. Treat it as a floor to stay above rather
 * than a number to match exactly, and keep a margin.
 */
export const SERVER_SEGMENT_HOLD_MS = 6_000;

/**
 * How long a node keeps a playback session whose client has stopped asking for
 * media, before the reaper erases it.
 *
 * This is the server's `streaming.session_idle_ms`, and it is here for the same
 * reason the segment hold is: it is a server fact every client is calibrated
 * against, and calibrating against it independently is how it goes wrong.
 *
 * **A pause is the case this exists for.** Both of the server's clocks run from
 * `touched`, so a client still asking for fragments is never evicted — but a
 * paused client is precisely one that has stopped. hls.js fills its bounded
 * forward buffer, hits `maxBufferLength` and stops requesting; a Direct Play
 * read-ahead worker is bounded the same way. The session therefore survives
 * only while the buffer is still filling, about a minute, after which this
 * clock runs unopposed. **A pause longer than this is a certainty, not a risk.**
 *
 * **Do not answer it with a keepalive.** The transcode entitlement is held by
 * the session rather than the pipeline, so polling to hold a paused session
 * open pins the node's video transcode slot — its only one, where
 * `max_video_transcodes` is 1 — for as long as the tab is open. The reaping is
 * correct behaviour. What a client owes is to notice on the way back.
 *
 * **It is the server's default, and the node states its own** as
 * `session_idle_ms` on `/api/v1/status`. Core does not read it, deliberately:
 * nothing here should be timing against a session's erasure, and the
 * dependency that did was deleted rather than re-pointed at the wire.
 *
 * Same rule as the segment hold, in the other direction: treat it as a ceiling
 * to stay well under rather than a number to match, and never let correctness
 * depend on it. Anything derived from this is a latency optimisation; the
 * handling of a `404` on a playback route is what has to be right when this
 * number is wrong.
 *
 * Measured on fi-1, 2026-09-17: `/etc/macha/macha.yaml:176` runs the default.
 */
export const SERVER_SESSION_IDLE_MS = 1_800_000;

/**
 * How long a node may take to bring a transformed stream up before it is
 * reasonable to call it broken.
 *
 * The server's `streaming.startup_timeout_ms`, read off a deployed
 * `/etc/macha/macha.yaml` on 2026-09-17 rather than from source. **It is the
 * node's own statement of what it is entitled to**, and a client budget
 * shorter than it calls a working node broken for doing what it is allowed to
 * do.
 *
 * That had already happened. A standby generation is a freshly created
 * transcode session, so its pipeline is cold, and the web adapter's preflight
 * gated it on a 5 s budget — a third of the node's entitlement. Healthy nodes
 * were rejected and good rescues discarded, silently, because a failed
 * standby is opportunistic and swallowed by design. A cold first fragment was
 * measured at 9.0 s, comfortably inside the entitlement and nowhere near the
 * budget.
 *
 * **Derive from this rather than from a measurement.** 9.0 s is one node on
 * one day; this is the contract. And the same rule as its neighbours: the node
 * states `startup_timeout_ms` on `/api/v1/status` and
 * `EndpointRegistry.playbackBudgets` carries it, so this is the answer for a
 * node that has not said, not the answer in general.
 */
export const SERVER_STARTUP_TIMEOUT_MS = 15_000;

/**
 * The statuses the rules above are written in terms of.
 *
 * **Exported because an adapter needs them and will otherwise write its own.**
 * A player that fetches its own fragments has to make decisions before it can
 * call `playbackFailureKindForStatus` — whether to spend a retry, whether a
 * park is appropriate — and those decisions are about these exact numbers. Two
 * shipped adapters each restated `500` privately with its own comment
 * explaining why it is not `503`, which is how the same server fact came to
 * exist in four places, and it was named here as a client's private copy
 * before anyone checked that there was anything to import. There was not.
 *
 * They are the server's, not a negotiation, and carry the same caveat as
 * `SERVER_SEGMENT_HOLD_MS`: a node could in principle answer differently and
 * no status endpoint reports what it will do.
 */
export const SEGMENT_NOT_READY_STATUS = 500;
export const BROKEN_GENERATION_STATUS = 503;
export const SOURCE_NOT_FOUND_STATUS = 404;
/**
 * A generation this node has superseded.
 *
 * **Tolerated before any node emits it, which is the whole point of the
 * constant existing now.** The server holds `410 generation_superseded`
 * pending exactly this, because an unrecognised status falls to `unknown`,
 * `unknown` is endpoint evidence, and a node moving ahead of its clients would
 * therefore **charge itself for answering honestly** and have a standby built
 * somewhere that cannot help. Core ships tolerance first; nodes move second.
 */
export const SOURCE_SUPERSEDED_STATUS = 410;

/**
 * What an HTTP status on a fragment or manifest request means about the source.
 *
 * The mapping is protocol, not platform, and was previously specified in prose
 * and implemented once per player — against hls.js, against media3's
 * `InvalidResponseCodeException`, and again for each new host. That put wire
 * knowledge inside platform adapters, which is the wrong place for it: an
 * adapter should report the status it saw and let this decide what it means.
 *
 * The statuses are deliberately split as they are, and the reasoning lives in
 * `docs/writing-a-player.md` because it is the part worth reading:
 *
 * - **`500` — a hold.** The node has not produced this fragment yet and is
 *   working correctly. Retry the same node; the next one is producing a
 *   different generation and does not have it either.
 *
 *   **Stated by the server, not inferred from behaviour** (0.45.0): a fragment
 *   beyond the look-ahead is *refused, not missing* — `500 segment_not_ready`
 *   with `Retry-After: 1` and `Cache-Control: no-store`, and deliberately
 *   **never a `404`**, because the playlist has already promised the object
 *   exists and a `404` would invite an intermediary to cache the absence.
 *   Retrying is correct and succeeds as production advances. Production is
 *   sequential, so asking for a distant index does not skip the fragments
 *   before it — it authorises them and then waits while each one encodes.
 *   `PlaybackSession.lookAheadMs` is where that boundary is.
 * - **`410` — a generation this node has superseded.** Reported as `not-found`,
 *   for the same reason and with the same recovery: the object is gone, the
 *   node is fine, and the session route says whether anything is left to
 *   rebuild. Usually core's own doing — a PATCH that changes mode, quality,
 *   seek or media builds a new generation — in which case the late failure
 *   naming the old source is already dropped by the superseded-source guards
 *   before it reaches classification at all.
 * - **`503` — a broken generation.** Terminal for this source.
 * - **`404` — this node did not serve it.** Either the session is gone or the
 *   fragment is past the end of the plan, and **the status cannot tell you
 *   which**: measured against one node in one run on 2026-09-17, a reaped
 *   session and a segment past the end of a live plan both answered `404` with
 *   the identical code `not_found`. So this reports `not-found`, which claims
 *   only what happened, and core asks the session route which case it is.
 *   Note the mistake a hold-aware caller makes in the other direction: having
 *   learned that a 5xx can mean "wait", it is easy to sit patiently on
 *   something that will never arrive. Nine blind retries over 62 seconds is
 *   what that looked like in the field.
 *
 * Anything else is reported as `unknown`, which the coordinator treats as
 * possible endpoint evidence — the safe default for a status this package has
 * no rule for.
 *
 * **Returning `stream` for `404` is what this function used to do**, and it is
 * how a node that had merely forgotten a paused viewer's session came to be
 * marked unhealthy and dropped from the candidate list.
 */
export function playbackFailureKindForStatus(status: number): PlaybackFailureKind {
  if (status === SEGMENT_NOT_READY_STATUS) return 'not-ready';
  if (status === SOURCE_NOT_FOUND_STATUS) return 'not-found';
  // A superseded generation is `not-found` rather than a kind of its own, and
  // that is a decision rather than a shortcut. What a caller must do is
  // identical — the object is gone, the node is fine, ask the session route
  // which case it is — and `not-found` already carries the obligation on
  // `Player.subscribeFailure` that an adapter must not tear the presentation
  // down. A seventh kind would put that obligation behind a value every
  // existing host would meet as `default`, which is the expensive direction:
  // a host that has not been updated would read `410` as unhandled and
  // condemn a node, which is the exact failure this tolerance exists to stop.
  if (status === SOURCE_SUPERSEDED_STATUS) return 'not-found';
  if (status === BROKEN_GENERATION_STATUS) return 'stream';
  return 'unknown';
}

/**
 * How fast a generation is producing, as the serving node reports it.
 *
 * **Absent on a `PlaybackSession` means the node cannot say** — direct play
 * has no pipeline, and a node older than server 0.47.0 does not carry the
 * field. Absence is never zero and never a default.
 */
export interface PlaybackProduction {
  /**
   * Media produced, in media time.
   *
   * **Also the production frontier**, so this is the `produced` term in a
   * reachability calculation directly, with no conversion. One field, both
   * jobs — stated that way by the server rather than inferred here.
   */
  producedMs: number;
  /**
   * Encoder time spent producing it.
   *
   * **Excludes time parked on the look-ahead gate and nothing else.** Demux,
   * decode, filter, encode, mux, disk, a busy GPU and contention with another
   * session's pipeline are all inside it, so the rate means *how fast this
   * node will actually produce for this viewer* rather than an upper bound on
   * the encoder. A node under contention reports a genuinely lower figure,
   * which is the correct input to a reachability decision.
   */
  producingMs: number;
  /**
   * How long since the last fragment was published, **measured on the node**.
   *
   * An age rather than a timestamp deliberately: a `produced_at` would make a
   * client's confidence decay depend on the two clocks agreeing, and they do
   * not have to.
   *
   * **Meaningless alone.** A large age means either a wedged pipeline or one
   * comfortably ahead and waiting for this viewer, and only `producerParked`
   * separates them.
   */
  producedAgeMs: number;
  /**
   * Whether the producer is blocked on the look-ahead gate.
   *
   * **Parked and old is the normal resting state** of a generation nobody is
   * pulling from. Not parked and old is the encoder mid-fragment or stuck.
   */
  producerParked: boolean;
}

/**
 * The production rate, as a multiple of realtime: `producedMs / producingMs`.
 *
 * **Never reconstruct this from elapsed wall time, and this is the one line in
 * this module that costs a viewer if it is ignored.** The producer runs to
 * `max_ahead_segments` beyond demand and then parks, so a viewer watching at
 * normal speed keeps it parked for most of a generation's life. Wall clock
 * therefore measures the parking, not the encoding.
 *
 * Measured on es-1 on 2026-09-20, on one live 480p transcode left running
 * with nobody pulling fragments: `producedMs` froze at 34,031 and
 * `producingMs` at 10,832 while `producedAgeMs` climbed 15.9 s → 27.9 s →
 * 39.9 s. Against roughly 45 s of wall clock that is **0.76x** — below
 * realtime, so a handover would be refused — **on a node whose actual rate
 * was 3.14x.** The wrong implementation needs no new field, looks like
 * "re-derive rather than assert", and silently refuses exactly the handovers
 * that would have worked.
 *
 * Returns `undefined` when there is no reading rather than a number that
 * would be believed:
 * - no `production` at all, so the node cannot say;
 * - `producingMs` of zero, which is **"no fragment yet", not an infinite
 *   rate** — the state every new generation starts in, and the one a PATCH
 *   response almost always shows;
 * - anything non-finite or negative, which no node should send and which
 *   would otherwise propagate into a deadline.
 *
 * **The reading runs low early and settles.** Both fields cover the same
 * fragments including the first, so pipeline start-up is charged to the rate
 * — 2.59x on the first fragment against 3.14x settled, on that same es-1
 * measurement. The server chose that over excluding the first fragment, which
 * would time `n-1` fragments while counting the media of `n`: a 2x
 * overstatement arriving exactly at the second fragment, which is when a
 * handover call gets made. Understating defers a handover and costs a round
 * trip; overstating stalls a viewer on a promise the node cannot keep. So a
 * young generation's low reading must not be allowed to condemn a handover
 * permanently — re-read it rather than remembering it.
 */
export function productionRate(production: PlaybackProduction | undefined): number | undefined {
  if (!production) return undefined;
  const { producedMs, producingMs } = production;
  if (!Number.isFinite(producedMs) || !Number.isFinite(producingMs)) return undefined;
  if (producingMs <= 0 || producedMs < 0) return undefined;
  return producedMs / producingMs;
}

/**
 * Is this generation keeping up with a viewer watching it?
 *
 * `false` only on a reading that exists and is at or below realtime. An
 * absent reading answers `undefined`, because "the node cannot say" is not
 * "the node cannot keep up" — collapsing those two refuses every handover on
 * a direct-play source and on every node older than 0.47.0.
 */
export function outpacesPlayback(production: PlaybackProduction | undefined): boolean | undefined {
  const rate = productionRate(production);
  return rate === undefined ? undefined : rate > 1;
}

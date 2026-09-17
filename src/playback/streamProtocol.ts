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
 * **It is the server's default, not a negotiated value.** A node may be
 * configured otherwise and does not report this on any status endpoint today,
 * so a client cannot read the real figure at runtime. Treat it as a floor to
 * stay above rather than a number to match exactly, and keep a margin.
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
 * **It is the server's default, not a negotiated value**, and no status
 * endpoint reports the real figure, so a client cannot read it at runtime. Same
 * rule as the segment hold, in the other direction: treat it as a ceiling to
 * stay well under rather than a number to match, and never let correctness
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
 * one day; this is the contract. The same caveat as its neighbours applies —
 * it is a default, no status endpoint reports the real figure, and a client
 * cannot read it at runtime.
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
  if (status === BROKEN_GENERATION_STATUS) return 'stream';
  return 'unknown';
}

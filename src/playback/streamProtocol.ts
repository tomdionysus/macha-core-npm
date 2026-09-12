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
 * - **`503` — a broken generation.** Terminal for this source.
 * - **`404` — past the end of the plan.** A genuine miss, and the mistake a
 *   hold-aware caller makes in the other direction: having learned that a 5xx
 *   can mean "wait", it is easy to sit patiently on something that will never
 *   arrive.
 *
 * Anything else is reported as `unknown`, which the coordinator treats as
 * possible endpoint evidence — the safe default for a status this package has
 * no rule for.
 */
export function playbackFailureKindForStatus(status: number): PlaybackFailureKind {
  if (status === 500) return 'not-ready';
  if (status === 503 || status === 404) return 'stream';
  return 'unknown';
}

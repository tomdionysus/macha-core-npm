/**
 * A position or duration on a scrubber: `0:00`, `7:05`, `1:23:45`.
 *
 * All three clients had a copy of this, and they agreed on the visual contract
 * — minutes unpadded below an hour and padded above it, hours simply growing
 * past 24 rather than wrapping, negatives clamped. That agreement is why it can
 * move here without changing what anyone sees.
 *
 * **They disagreed on one case, and it is the one that reaches a screen.**
 * A naive implementation renders `NaN:NaN` for a duration that is not a number
 * and `Infinity:NaN:NaN` for one that is unbounded. Both are real inputs:
 * duration is `0` before the first player event and `NaN` when a source reports
 * none, and an unbounded one arrives from a live or unknown-length source.
 *
 * The web client's copy had the naive behaviour and had never been seen to
 * produce it — not because the formatter was protected, but because its call
 * site read `session?.durationMs || event.durationMs || media.durationMs || 1`,
 * and `||` treats `NaN` as falsy. A truthiness chain written for "missing"
 * happened to also swallow "not a number". `Infinity` is truthy and would have
 * passed straight through. So the guard belongs here, where it is deliberate,
 * rather than being inherited from an accident at one call site.
 *
 * Anything not a finite, positive number renders `0:00` — the same answer as
 * "not started", because both mean the same thing to a viewer looking at a
 * scrubber: there is no position to show yet. A caller that needs to
 * *distinguish* a live source should test the duration itself rather than the
 * string this returns.
 *
 * **That is a placeholder, not a decision.** Nobody has ever seen an unbounded
 * duration reach a screen here — the old behaviour was as unobserved as the
 * new one — so this closes a path nothing was guarding rather than fixing
 * something anyone reported. If a live or unknown-length source should render
 * as a dash, or as nothing at all, that design decision is still open and
 * `0:00` should not be inherited as intent.
 *
 * This is the scrubber contract only. "How long is this thing" — `1h 23m` on a
 * detail page, or an elapsed age on a status screen — is a different shape with
 * different rounding, and does not belong behind the same function.
 */
export function formatPlaybackTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

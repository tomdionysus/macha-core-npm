import { describe, expect, it, vi } from 'vitest';
import { MEDIA_STALL_TIMEOUT_MS, MediaStallWatchdog, MediaStartWatchdog, type MediaWatchdogEnvironment } from './MediaWatchdog.js';

/**
 * A fully driven environment: no real timers and no DOM, so every test states
 * the exact clock and visibility sequence it means rather than approximating
 * one. The watchdog's whole contract is about elapsed *visible* time, which is
 * unreadable from a test that cannot separate the two.
 */
function controllable(): {
  environment: MediaWatchdogEnvironment;
  advance(ms: number): void;
  setVisible(visible: boolean): void;
  readonly armed: boolean;
  readonly visibilityListeners: number;
} {
  let now = 0;
  let visible = true;
  const listeners = new Set<() => void>();
  let pending: { callback: () => void; dueAt: number } | undefined;
  return {
    environment: {
      now: () => now,
      visible: () => visible,
      onVisibilityChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      schedule: (callback, delayMs) => {
        const entry = { callback, dueAt: now + delayMs };
        pending = entry;
        return () => { if (pending === entry) pending = undefined; };
      },
    },
    advance(ms) {
      now += ms;
      while (pending && pending.dueAt <= now) {
        const due = pending;
        pending = undefined;
        due.callback();
      }
    },
    setVisible(next) {
      visible = next;
      for (const listener of [...listeners]) listener();
    },
    get armed() { return pending !== undefined; },
    get visibilityListeners() { return listeners.size; },
  };
}

describe('media start watchdog', () => {
  it('reports a source that has delivered nothing by the deadline', () => {
    const host = controllable();
    const starved = vi.fn();
    new MediaStartWatchdog(host.environment, 20_000).start(starved);

    host.advance(19_999);
    expect(starved).not.toHaveBeenCalled();
    host.advance(1);
    expect(starved).toHaveBeenCalledWith(20_000);
  });

  it('never reports a source that delivered any bytes at all', () => {
    const host = controllable();
    const starved = vi.fn();
    const watchdog = new MediaStartWatchdog(host.environment, 20_000);
    watchdog.start(starved);

    // One `progress` event is the whole discriminator: a merely slow link
    // still produces these long before readyState leaves HAVE_NOTHING, so it
    // must never be judged however long it then takes.
    host.advance(5_000);
    watchdog.noteProgress();
    host.advance(600_000);

    expect(starved).not.toHaveBeenCalled();
    expect(host.armed).toBe(false);
    expect(host.visibilityListeners).toBe(0);
  });

  it('does not count time while the page is hidden', () => {
    const host = controllable();
    const starved = vi.fn();
    new MediaStartWatchdog(host.environment, 20_000).start(starved);

    host.advance(8_000);
    host.setVisible(false);
    // Chromium throttles media loading in a backgrounded or occluded tab, so
    // this span is the browser working correctly rather than a node failing.
    // Counting it would condemn a healthy node for a tab nobody was looking
    // at — the exact confound that invalidated an evening of investigation.
    host.advance(3_600_000);
    expect(starved).not.toHaveBeenCalled();

    host.setVisible(true);
    host.advance(11_999);
    expect(starved).not.toHaveBeenCalled();
    host.advance(1);
    expect(starved).toHaveBeenCalledTimes(1);
    expect(starved).toHaveBeenCalledWith(20_000);
  });

  it('stays disarmed while the page has never been visible', () => {
    const host = controllable();
    const starved = vi.fn();
    host.setVisible(false);
    new MediaStartWatchdog(host.environment, 20_000).start(starved);

    host.advance(600_000);
    expect(starved).not.toHaveBeenCalled();
    expect(host.armed).toBe(false);
  });

  it('reports once and releases everything it held', () => {
    const host = controllable();
    const starved = vi.fn();
    new MediaStartWatchdog(host.environment, 20_000).start(starved);

    host.advance(20_000);
    host.advance(600_000);

    expect(starved).toHaveBeenCalledTimes(1);
    expect(host.armed).toBe(false);
    expect(host.visibilityListeners).toBe(0);
  });

  it('gives each source generation a fresh deadline', () => {
    const host = controllable();
    const first = vi.fn();
    const second = vi.fn();
    const watchdog = new MediaStartWatchdog(host.environment, 20_000);

    watchdog.start(first);
    host.advance(19_000);
    watchdog.start(second);
    // The replaced watch is fully released rather than left subscribed
    // alongside its successor.
    expect(host.visibilityListeners).toBe(1);
    host.advance(19_000);

    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    host.advance(1_000);
    expect(second).toHaveBeenCalledWith(20_000);
    expect(first).not.toHaveBeenCalled();
  });

  it('stops cleanly without reporting', () => {
    const host = controllable();
    const starved = vi.fn();
    const watchdog = new MediaStartWatchdog(host.environment, 20_000);

    watchdog.start(starved);
    watchdog.stop();
    host.advance(600_000);

    expect(starved).not.toHaveBeenCalled();
    expect(host.visibilityListeners).toBe(0);
  });
});

describe('media stall watchdog', () => {
  it('reports a frozen picture with nothing arriving', () => {
    const host = controllable();
    const stalled = vi.fn();
    const watchdog = new MediaStallWatchdog(host.environment, 15_000);
    watchdog.watch(stalled);

    // Playing normally, then frozen. The first report is only a baseline.
    watchdog.note(28_000, 44_000);
    watchdog.note(30_000, 45_000);
    host.advance(14_999);
    expect(stalled).not.toHaveBeenCalled();
    host.advance(1);

    expect(stalled).toHaveBeenCalledTimes(1);
    expect(stalled.mock.calls[0][0]).toMatchObject({ visibleMs: 15_000, positionMs: 30_000, bufferedEndMs: 45_000 });
  });

  it('does not judge a node that is merely slow', () => {
    const host = controllable();
    const stalled = vi.fn();
    const watchdog = new MediaStallWatchdog(host.environment, 15_000);
    watchdog.watch(stalled);

    // Measured on 2026-09-08: a healthy node producing a transcode below
    // realtime delivered in bursts separated by seven seconds of no progress
    // at all. The picture freezes; the buffer keeps growing. Judging on the
    // stopped clock alone would evict the node doing the work.
    let buffered = 20_000;
    for (let burst = 0; burst < 6; burst += 1) {
      watchdog.note(10_000, buffered);   // playback frozen at the same position
      host.advance(7_000);
      buffered += 11_700;                 // ...but bytes keep landing
      watchdog.note(10_000, buffered);
    }

    expect(stalled).not.toHaveBeenCalled();
  });

  it('fires when the buffer stops growing even though it grew before', () => {
    const host = controllable();
    const stalled = vi.fn();
    const watchdog = new MediaStallWatchdog(host.environment, 15_000);
    watchdog.watch(stalled);

    watchdog.note(10_000, 20_000);
    host.advance(5_000);
    watchdog.note(10_000, 31_000);   // still arriving: countdown restarts
    host.advance(14_999);
    expect(stalled).not.toHaveBeenCalled();
    host.advance(1);                  // now neither has moved for the full window

    expect(stalled).toHaveBeenCalledTimes(1);
  });

  it('does not count time while the app is not on screen', () => {
    const host = controllable();
    const stalled = vi.fn();
    const watchdog = new MediaStallWatchdog(host.environment, 15_000);
    watchdog.watch(stalled);

    watchdog.note(9_000, 19_000);
    watchdog.note(10_000, 20_000);
    host.advance(5_000);
    host.setVisible(false);
    host.advance(3_600_000);
    expect(stalled).not.toHaveBeenCalled();
    host.setVisible(true);
    host.advance(10_000);

    expect(stalled).toHaveBeenCalledTimes(1);
  });

  it('treats a paused viewer as not stalled', () => {
    const host = controllable();
    const stalled = vi.fn();
    const watchdog = new MediaStallWatchdog(host.environment, 15_000);
    watchdog.watch(stalled);

    watchdog.note(10_000, 20_000);
    watchdog.suspend();
    host.advance(600_000);

    expect(stalled).not.toHaveBeenCalled();
  });

  it('arms nothing until playback has actually reported once', () => {
    const host = controllable();
    const stalled = vi.fn();
    new MediaStallWatchdog(host.environment, 15_000).watch(stalled);

    // A source still loading belongs to the start watchdog; judging it here
    // too would fail the same generation twice on different deadlines.
    host.advance(600_000);
    expect(stalled).not.toHaveBeenCalled();
  });

  it('outlasts the server-side fragment hold, and stays a viewer budget', () => {
    // The rule, not the number: a node holds a request for a fragment it has
    // not produced for `streaming.segment_timeout` — 6000 ms — before
    // answering `500 segment_not_ready`. Expiring inside that window judges a
    // node that was about to deliver; expiring at exactly that window decides
    // nothing. Above it, firing means the node failed to answer its own hold.
    expect(MEDIA_STALL_TIMEOUT_MS).toBeGreaterThan(6_000);
    // And it is still what a viewer stares at a frozen frame for on a platform
    // whose player reports nothing, so it does not get to drift back toward
    // the fifteen seconds this started at.
    expect(MEDIA_STALL_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  it('never judges a generation that has not started, however long it takes', () => {
    const host = controllable();
    const stalled = vi.fn();
    const watchdog = new MediaStallWatchdog(host.environment, 15_000);
    watchdog.watch(stalled);

    // A freshly promoted source reports position 0 with nothing buffered while
    // the node builds the generation. Arming on that first sight killed every
    // replacement after 15 s on a real Samsung set: recover onto a healthy
    // node, kill it before it delivered a frame, recover again, and exhaust
    // the cluster — "No untried Macha playback endpoint remains", with three
    // working nodes. A source that never started has not stalled.
    for (let tick = 0; tick < 40; tick += 1) {
      watchdog.note(0, 0);
      host.advance(1_000);
    }

    expect(stalled).not.toHaveBeenCalled();
  });
});

describe('a platform that cannot measure buffering', () => {
  it('still moves off a node the viewer is waiting on', () => {
    // expo-video publishes a position and nothing trustworthy about buffered
    // ranges. Without a buffer figure this cannot tell slow from dead — but a
    // frozen picture is a viewer waiting either way, and waiting is what the
    // budget answers.
    const host = controllable();
    const watchdog = new MediaStallWatchdog(host.environment, MEDIA_STALL_TIMEOUT_MS);
    const stalled = vi.fn();
    watchdog.watch(stalled);

    watchdog.note(1_000);
    watchdog.note(2_000);
    watchdog.note(2_000);
    host.advance(MEDIA_STALL_TIMEOUT_MS);

    expect(stalled).toHaveBeenCalledTimes(1);
  });

  it('reports no buffer figure it was never given', () => {
    // Absent must stay absent all the way to the caller: a stall carrying a
    // fabricated zero would read as evidence about the node, and there is
    // none — only evidence that a viewer was waiting.
    const host = controllable();
    const watchdog = new MediaStallWatchdog(host.environment, MEDIA_STALL_TIMEOUT_MS);
    const stalled = vi.fn();
    watchdog.watch(stalled);

    watchdog.note(1_000);
    watchdog.note(2_000);
    watchdog.note(2_000);
    host.advance(MEDIA_STALL_TIMEOUT_MS);

    expect(stalled.mock.calls[0][0].bufferedEndMs).toBeUndefined();
  });

  it('does not let an omitted figure erase one the platform did report', () => {
    // A player that reports buffering intermittently must not have its last
    // known extent forgotten by a report that omits it, or the next
    // comparison is against nothing.
    const host = controllable();
    const watchdog = new MediaStallWatchdog(host.environment, MEDIA_STALL_TIMEOUT_MS);
    const stalled = vi.fn();
    watchdog.watch(stalled);

    watchdog.note(1_000, 5_000);
    watchdog.note(2_000, 9_000);
    watchdog.note(2_000);
    host.advance(MEDIA_STALL_TIMEOUT_MS);

    expect(stalled.mock.calls[0][0].bufferedEndMs).toBe(9_000);
  });
});

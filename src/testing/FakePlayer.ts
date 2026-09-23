import type {
  PlaybackTransition,
  Player,
  PlaybackDegradationListener,
  PlaybackFailureListener,
  PlaybackListener,
} from '../platform/Platform.js';
import type { MediaTechnicalProfile, PlaybackEvent, PlaybackSource, PlaybackTimeRange } from '../types.js';

export interface FakePlayerPlayCall {
  source: PlaybackSource;
  positionMs: number;
  startPaused: boolean;
  transition?: PlaybackTransition;
}

/**
 * Shared deterministic `Player` test double. Implements every optional hook
 * on the interface (subtitle, direct-source alternates, preflight, failure
 * and degradation channels) so one fixture covers both the ownership-level
 * (`PlaybackRuntime`) and generation-level (`PlaybackCoordinator`) suites,
 * plus any full-stack integration test that needs a real node-to-node
 * failover story without a browser.
 */
/**
 * **The only fake player in this repository, as of 2026-09-20.** There were
 * three: this one, and a local one in each of `PlaybackCoordinator.test.ts`
 * and `PlaybackRuntime.test.ts`. Editing this file to change a coordinator
 * test's behaviour then changed nothing, silently — which cost a full round of
 * "prove the test fails against the broken code", green every time because the
 * code it was meant to break was never the code under test, and a good test
 * was deleted on the strength of it. A test that has never been seen red is an
 * assertion about intentions rather than behaviour.
 *
 * **Keep it one.** A local double is quicker to write than to reconcile, and
 * the three had already drifted in ways no test named: two of them counted
 * `detach()` without destroying anything, and one recorded `play()` as a bare
 * source so its assertions could not see the position or the transition.
 */
export class FakePlayer implements Player {
  listener?: PlaybackListener;
  failureListener?: PlaybackFailureListener;
  degradationListener?: PlaybackDegradationListener;

  attachCalls = 0;
  detachHostCalls = 0;
  detachCalls = 0;
  stopCalls = 0;
  pauseCalls = 0;
  resumeCalls = 0;
  /** Set by a test to stand in for a host that can hold through a lead. */
  holdsThroughLead?: boolean;
  playCalls: FakePlayerPlayCall[] = [];
  prepareCalls: MediaTechnicalProfile[] = [];
  seekCalls: number[] = [];
  subtitleCalls: Array<string | undefined> = [];
  directAlternatives: Array<{ active: PlaybackSource; alternate: PlaybackSource }> = [];
  preflightCalls: PlaybackSource[] = [];
  localSeekRanges: PlaybackTimeRange[] = [];
  playResult: Promise<boolean> = Promise.resolve(true);

  attach(): void { this.attachCalls += 1; }
  detachHost(): void { this.detachHostCalls += 1; }
  /**
   * Destructive, because the interface says it is: *"Final player destruction.
   * This is resource-destructive."* A double whose `detach()` only counts lets
   * a test pass where the real player would have torn the source down, so it
   * stops as well — which is what the runtime's own local double always did,
   * and the divergence the merge resolved in favour of the contract.
   */
  detach(): void { this.detachCalls += 1; this.stop(); }
  play(source: PlaybackSource, positionMs = 0, startPaused = false, transition?: PlaybackTransition): Promise<boolean> {
    this.playCalls.push({ source, positionMs, startPaused, transition });
    return this.playResult;
  }
  prepare(profile: MediaTechnicalProfile): void { this.prepareCalls.push(profile); }
  pause(): void { this.pauseCalls += 1; }
  resume(): void { this.resumeCalls += 1; }
  seek(positionMs: number): void { this.seekCalls.push(positionMs); }
  localSeekCoverage(): readonly PlaybackTimeRange[] {
    const source = this.playCalls.at(-1)?.source;
    return source?.mode === 'direct'
      ? [{ startMs: 0, endMs: Number.POSITIVE_INFINITY }]
      : this.localSeekRanges;
  }
  setVolume(): void {}
  setSubtitle(subtitleUrl?: string): void { this.subtitleCalls.push(subtitleUrl); }
  addDirectSourceAlternative(active: PlaybackSource, alternate: PlaybackSource): boolean {
    this.directAlternatives.push({ active, alternate });
    return true;
  }
  preflightSource(source: PlaybackSource): Promise<boolean> {
    this.preflightCalls.push(source);
    return Promise.resolve(true);
  }
  stop(): void { this.stopCalls += 1; }
  subscribe(listener: PlaybackListener): () => void {
    this.listener = listener;
    return () => { if (this.listener === listener) this.listener = undefined; };
  }
  subscribeFailure(listener: PlaybackFailureListener): () => void {
    this.failureListener = listener;
    return () => { if (this.failureListener === listener) this.failureListener = undefined; };
  }
  subscribeDegradation(listener: PlaybackDegradationListener): () => void {
    this.degradationListener = listener;
    return () => { if (this.degradationListener === listener) this.degradationListener = undefined; };
  }
  emit(event: PlaybackEvent): void { this.listener?.(event); }
  fail(error: Error): void { this.failureListener?.(error); }
  degrade(error: Error): void { this.degradationListener?.(error); }
}

export function createFakePlayer(): FakePlayer {
  return new FakePlayer();
}

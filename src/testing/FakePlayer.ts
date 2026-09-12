import type {
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
 * **Not the only fake player in this repository.** `PlaybackCoordinator.test.ts`
 * defines its own, locally, and does not import this one.
 *
 * Worth knowing before you edit this file to change a coordinator test's
 * behaviour: doing so changes nothing, silently. That cost a full round of
 * "prove the test fails against the broken code" — the check ran green every
 * time because the code it was meant to break was never the code under test,
 * and a good test was deleted on the strength of it. A test that has never
 * been seen red is an assertion about intentions rather than behaviour.
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
  detach(): void { this.detachCalls += 1; }
  play(source: PlaybackSource, positionMs = 0, startPaused = false): Promise<boolean> {
    this.playCalls.push({ source, positionMs, startPaused });
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

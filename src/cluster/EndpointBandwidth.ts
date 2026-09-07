import { machaHost } from '../runtime/host.js';
import type { StorageLike } from '../state/storage.js';

const PREFIX = 'macha-client-bandwidth:';

/**
 * Below this, a transfer measures round-trip time and server handler cost, not
 * throughput. Sampling everything is precisely the mistake that made the
 * server's own peer-latency metric read a 35 KB commit as network distance.
 */
const MIN_SAMPLE_BYTES = 32 * 1024;

/** Weight of each new sample against the running estimate. */
const SMOOTHING = 0.35;

/**
 * A restored estimate is a starting point, not evidence. It is worth carrying
 * across a reload — a cold client otherwise ranks every endpoint identically
 * until the first large transfer lands — but the link may have changed while
 * we were away, so live samples must overtake it quickly.
 */
const RESTORE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** In-memory updates are free; writes are not, least of all on a TV. */
const PERSIST_INTERVAL_MS = 5_000;

interface BandwidthRecord {
  bytesPerSecond: number;
  samples: number;
  updatedAt: number;
}

/**
 * Per-endpoint throughput, measured from transfers the client was making
 * anyway.
 *
 * This deliberately measures bytes moved per second of *body transfer*, not
 * request latency. They are different facts about a link and can disagree
 * completely: a satellite-like path can answer a ping quickly and still fail
 * to sustain a stream, and a node behind a congested wireless hop can sit
 * close in round-trip terms while being the worst choice to actually read
 * media from. A media client cares about the second number.
 *
 * The registry owns no timer here either: callers report finished transfers,
 * and ask for the estimate when they need to rank endpoints.
 */
export class EndpointBandwidth {
  private readonly records = new Map<string, BandwidthRecord>();
  private lastPersistAt?: number;
  private restored = false;

  constructor(
    private readonly clientId: string,
    private readonly storage: StorageLike | undefined = machaHost().storage,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Record one completed transfer. `durationMs` must cover reading the body,
   * not just receiving the response headers — a `fetch()` that has resolved
   * has not yet moved the bytes we are trying to measure.
   */
  record(endpointIdValue: string, bytes: number, durationMs: number): void {
    this.restore();
    if (!Number.isFinite(bytes) || !Number.isFinite(durationMs)) return;
    if (bytes < MIN_SAMPLE_BYTES || durationMs <= 0) return;

    const sample = (bytes / durationMs) * 1000;
    const previous = this.records.get(endpointIdValue);
    this.records.set(endpointIdValue, {
      bytesPerSecond: previous ? previous.bytesPerSecond + SMOOTHING * (sample - previous.bytesPerSecond) : sample,
      samples: (previous?.samples ?? 0) + 1,
      updatedAt: this.now(),
    });
    this.persist();
  }

  /** The current estimate in bytes per second, or undefined with no evidence yet. */
  bytesPerSecond(endpointIdValue: string): number | undefined {
    this.restore();
    return this.records.get(endpointIdValue)?.bytesPerSecond;
  }

  /** How many transfers back this estimate — a one-sample figure is not yet worth acting on. */
  samples(endpointIdValue: string): number {
    this.restore();
    return this.records.get(endpointIdValue)?.samples ?? 0;
  }

  /** Drop estimates for endpoints that are no longer configured. */
  retain(endpointIds: ReadonlySet<string>): void {
    this.restore();
    let changed = false;
    for (const id of [...this.records.keys()]) {
      if (endpointIds.has(id)) continue;
      this.records.delete(id);
      changed = true;
    }
    if (changed) this.write();
  }

  /** Write immediately, ignoring the interval — for page-hide, where there is no later. */
  flush(): void {
    if (this.restored) this.write();
  }

  private persist(): void {
    const now = this.now();
    // The first sample always lands: a session that records one transfer and
    // then goes away would otherwise persist nothing at all.
    if (this.lastPersistAt !== undefined && now - this.lastPersistAt < PERSIST_INTERVAL_MS) return;
    this.lastPersistAt = now;
    this.write();
  }

  private restore(): void {
    if (this.restored) return;
    this.restored = true;
    const raw = this.readStored();
    if (!raw) return;
    const cutoff = this.now() - RESTORE_MAX_AGE_MS;
    for (const [id, record] of Object.entries(raw)) {
      if (!isBandwidthRecord(record) || record.updatedAt < cutoff) continue;
      // Restored evidence re-enters as a single sample whatever it was worth
      // before, so a handful of live transfers outweigh a stale reading.
      this.records.set(id, { ...record, samples: 1 });
    }
  }

  private readStored(): Record<string, unknown> | undefined {
    try {
      const value = this.storage?.getItem(this.key());
      if (!value) return undefined;
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : undefined;
    } catch {
      return undefined;
    }
  }

  private write(): void {
    try {
      this.storage?.setItem(this.key(), JSON.stringify(Object.fromEntries(this.records)));
    } catch {
      // A full or unavailable store must never break a request path. The
      // in-memory estimate stays authoritative for this session either way.
    }
  }

  private key(): string {
    return `${PREFIX}${this.clientId}`;
  }
}

function isBandwidthRecord(value: unknown): value is BandwidthRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<BandwidthRecord>;
  return typeof record.bytesPerSecond === 'number' && Number.isFinite(record.bytesPerSecond) && record.bytesPerSecond > 0
    && typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt);
}

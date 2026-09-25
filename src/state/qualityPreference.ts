import { machaHost } from '../runtime/host.js';
import { QUALITY_CLASSES, type QualityClass, type QualityPreference } from '../playback/playbackVersions.js';
import { readValidatedJson, writeJson, type StorageLike } from './storage.js';

/**
 * The viewer's quality ceilings on this device (Tom, 2026-09-25: per device).
 * One key, so every client keeps the setting in one shape.
 */
export const QUALITY_PREFERENCE_KEY = 'macha.qualityPreference.v1';

function isQualityClass(value: unknown): value is QualityClass {
  return typeof value === 'number' && (QUALITY_CLASSES as readonly number[]).includes(value);
}

function validPreference(value: unknown): value is QualityPreference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { wifi, cellular } = value as Record<string, unknown>;
  return (wifi === undefined || isQualityClass(wifi)) && (cellular === undefined || isQualityClass(cellular));
}

/**
 * Where a host keeps the viewer's quality setting, for `qualityCeiling`. An
 * absent ceiling is no setting: automatic play then caps at the display, or
 * on mobile data at the mobile default.
 */
export class QualityPreferenceStore {
  private readonly listeners = new Set<() => void>();
  private cached: QualityPreference | undefined;

  constructor(private readonly storage: StorageLike = machaHost().storage) {}

  /** Stable between changes, as `useSyncExternalStore` requires. */
  getSnapshot = (): QualityPreference => {
    this.cached ??= this.get();
    return this.cached;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get(): QualityPreference {
    return readValidatedJson(this.storage, QUALITY_PREFERENCE_KEY, validPreference) ?? {};
  }

  /** Set or clear one ceiling; `undefined` clears it back to no setting. */
  set(connection: keyof QualityPreference, quality: QualityClass | undefined): QualityPreference {
    const { [connection]: _previous, ...rest } = this.get();
    const next: QualityPreference = quality === undefined ? rest : { ...rest, [connection]: quality };
    writeJson(this.storage, QUALITY_PREFERENCE_KEY, next);
    this.cached = undefined;
    for (const listener of this.listeners) listener();
    return next;
  }
}

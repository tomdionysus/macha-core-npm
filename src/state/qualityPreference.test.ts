import { describe, expect, it } from 'vitest';
import { QUALITY_PREFERENCE_KEY, QualityPreferenceStore } from './qualityPreference.js';
import { isMachaStorageKey } from '../runtime/storageKeys.js';

function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    values,
  };
}

describe('QualityPreferenceStore', () => {
  it('keeps each ceiling apart, and clears one back to no setting', () => {
    const storage = memory();
    const store = new QualityPreferenceStore(storage);
    expect(store.get()).toEqual({});
    store.set('wifi', 1080);
    store.set('cellular', 480);
    expect(new QualityPreferenceStore(storage).get()).toEqual({ wifi: 1080, cellular: 480 });
    store.set('wifi', undefined);
    expect(store.get()).toEqual({ cellular: 480 });
  });

  it('reads a value that is not a class as no setting', () => {
    const storage = memory();
    storage.setItem(QUALITY_PREFERENCE_KEY, JSON.stringify({ wifi: 1000 }));
    expect(new QualityPreferenceStore(storage).get()).toEqual({});
  });

  it('tells subscribers, with a new snapshot', () => {
    const store = new QualityPreferenceStore(memory());
    const before = store.getSnapshot();
    let calls = 0;
    store.subscribe(() => { calls += 1; });
    store.set('wifi', 720);
    expect(calls).toBe(1);
    expect(store.getSnapshot()).not.toBe(before);
    expect(store.getSnapshot()).toEqual({ wifi: 720 });
  });

  it("is one of core's keys", () => {
    expect(isMachaStorageKey(QUALITY_PREFERENCE_KEY)).toBe(true);
  });
});

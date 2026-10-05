export interface ReadWriteStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface StorageLike extends ReadWriteStorageLike {
  removeItem(key: string): void;
}

export function readValidatedJson<T>(
  storage: StorageLike,
  key: string,
  validate: (value: unknown) => value is T,
): T | undefined {
  const raw = storage.getItem(key);
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (validate(parsed)) return parsed;
  } catch {
    // Invalid persisted state is discarded below.
  }
  storage.removeItem(key);
  return undefined;
}

export function writeJson<T>(storage: StorageLike, key: string, value: T): T {
  storage.setItem(key, JSON.stringify(value));
  return value;
}

/**
 * The value at `key`, adopting it from the first of `legacyKeys` that holds
 * one when `key` holds nothing: the value moves to `key`, and the legacy key
 * is removed. At read time, so no caller has to remember a migration step,
 * and so a store built before its host hydrated reads the current state
 * whenever it next reads, rather than whatever was there at construction.
 */
export function readAdopted(storage: StorageLike, key: string, legacyKeys: readonly string[]): string | null {
  const current = storage.getItem(key);
  if (current !== null) return current;
  for (const legacy of legacyKeys) {
    const value = storage.getItem(legacy);
    if (value === null) continue;
    storage.setItem(key, value);
    storage.removeItem(legacy);
    return value;
  }
  return null;
}

/** `readValidatedJson`, adopting the key first; see `readAdopted`. */
export function readAdoptedJson<T>(
  storage: StorageLike,
  key: string,
  legacyKeys: readonly string[],
  validate: (value: unknown) => value is T,
): T | undefined {
  readAdopted(storage, key, legacyKeys);
  return readValidatedJson(storage, key, validate);
}

/**
 * Remove `key` and every legacy name it is adopted from, so a deliberate
 * clear is not undone by the next read adopting the old key.
 */
export function removeAdopted(storage: StorageLike, key: string, legacyKeys: readonly string[]): void {
  storage.removeItem(key);
  for (const legacy of legacyKeys) storage.removeItem(legacy);
}

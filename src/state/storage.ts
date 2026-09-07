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

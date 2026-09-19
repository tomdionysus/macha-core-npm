# Async storage on a synchronous interface

The core's `StorageLike` is **synchronous** — `getItem` / `setItem` / `removeItem`, no promises. On the web that is `localStorage`. React Native's `AsyncStorage` is not, so a native host bridges the two.

The interface will not change: making it async would push `await` into every state read in the core, most of which sit on paths that must not yield. The bridge belongs in the host, and it is small.

## The shape

1. **One module-level store**, holding a `Map`.
2. **`await hydrate()` at startup** reads every `macha.`-prefixed key via `AsyncStorage.multiGet` into that Map. Nothing renders until it resolves.
3. **`getItem` is then synchronous** off the Map.
4. **`setItem` updates the Map immediately** and enqueues the persist on a **serialized promise chain**, so two writes to one key cannot land out of order.
5. A failed write costs the next cold start, never the current session.

```ts
let cache = new Map<string, string>();
let writes: Promise<unknown> = Promise.resolve();

export async function hydrate(): Promise<void> {
  const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith('macha.'));
  cache = new Map(await AsyncStorage.multiGet(keys) as [string, string][]);
}

export const nativeStorage: StorageLike = {
  getItem: (key) => cache.get(key) ?? null,
  setItem: (key, value) => {
    cache.set(key, value);
    // Serialized: concurrent writes to one key must not race to the device.
    writes = writes.then(() => AsyncStorage.setItem(key, value)).catch(() => undefined);
  },
  removeItem: (key) => {
    cache.delete(key);
    writes = writes.then(() => AsyncStorage.removeItem(key)).catch(() => undefined);
  },
};
```

Then, before any service is constructed:

```ts
await hydrate();
configureMachaHost({ storage: nativeStorage, ephemeralStorage: memoryStorage() });
```

Every store in the core ports as-is on top of this.

## Two things that will bite

**The serialized write chain matters more than it looks.** Without it, two writes to the same key can land in the wrong order and the losing value survives the restart.

**Reads are cheap; writes are not free.** A read is a `Map` lookup; a write schedules device I/O. Anything updating at media or network frequency — a download progress callback, a playback position tick — must stay in memory and persist on a boundary such as pause, completion or backgrounding. Writing through this interface per chunk is enough to starve a multi-megabyte transfer into stalling.

## Ephemeral storage

`ephemeralStorage` only has to survive one run, so `memoryStorage()` is the right answer on native. There is no session-storage equivalent to bridge, and persisting it would defeat its purpose.

## Key prefixes

The core's persisted keys are enumerated in `MACHA_STORAGE_KEY_PREFIXES`. A host that hydrates selectively, or caches by prefix, reads that list rather than hardcoding `macha.` — a key that is never hydrated is indistinguishable from one that was never written, and read-time migrations silently carry nothing across.

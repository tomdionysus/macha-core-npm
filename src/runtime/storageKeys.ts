/**
 * Every storage key this package owns, named in one place.
 *
 * **This exists because a host cannot be expected to grep a dependency.** The
 * phone client namespaces its own keys `macha.` and hydrated its store with a
 * `startsWith('macha.')` filter, which matched one of core's two old
 * conventions and missed the other, the session included. The token was
 * written on every launch and never read back, and the only symptom was a
 * person signed out on every cold start.
 *
 * **One convention, from 2026-10-05** (Tom: "There will be a lot of version
 * churn, it can't be brittle."):
 *
 * - Everything core owns is under `macha.core.`, so no client key can
 *   collide with one of core's, whatever either names next.
 * - A key that belongs to one client id is `macha.core.client.<clientId>.<store>`,
 *   with any row of the store after a further dot. The id sits at a fixed
 *   place, and `machaStorageKeyClientId` reads it, so no host parses keys.
 * - **A key never carries a version.** A store's schema version is in its
 *   value (`version`, absent meaning 1), and a store migrates on read. A
 *   schema change renames nothing, and no host filter has to learn it.
 *
 * The keys before it are listed below as legacy: each store adopts its old
 * key on first read, moving the value to the new key and removing the old.
 * A host that hydrates a cache by prefix must still load them until every
 * device has run this once.
 */

/** Everything this package writes from 2026-10-05 is under this prefix. */
export const MACHA_CORE_KEY_PREFIX = 'macha.core.';

const MACHA_CORE_CLIENT_PREFIX = `${MACHA_CORE_KEY_PREFIX}client.`;

/** A key core owns that belongs to no client id. */
export function machaCoreKey(name: string): string {
  return `${MACHA_CORE_KEY_PREFIX}${name}`;
}

/** A key core owns for one client id: `macha.core.client.<clientId>.<store>`. */
export function machaClientKey(clientId: string, store: string): string {
  return `${MACHA_CORE_CLIENT_PREFIX}${clientId}.${store}`;
}

/**
 * The client id a key of core's belongs to, or `undefined` for a key that
 * belongs to none or is not core's. Reads the current convention and the
 * legacy per-client prefixes alike, a row after the id included, so a host
 * recovering an orphaned client id never parses keys itself.
 */
export function machaStorageKeyClientId(key: string): string | undefined {
  if (key.startsWith(MACHA_CORE_CLIENT_PREFIX)) {
    const id = key.slice(MACHA_CORE_CLIENT_PREFIX.length).split('.')[0];
    return id ? id : undefined;
  }
  const prefix = MACHA_LEGACY_CLIENT_KEY_PREFIXES.find((candidate) => key.startsWith(candidate));
  if (!prefix) return undefined;
  const id = key.slice(prefix.length).split('.')[0];
  return id ? id : undefined;
}

/**
 * Retired and deliberately absent: `macha.volume.v1.`. `0.11.0` removed
 * `VolumeStore`, so core neither writes nor reads it, and this list means the
 * keys core owns *today*. An older build's value is orphaned on devices that
 * ran one, which costs nothing, because every install is a tester's.
 * Contrast `macha-client-progress:` below, which stays because core still
 * **reads** it.
 */

/** Core's keys that belong to no client id. */
export const MACHA_STORAGE_KEYS = [
  machaCoreKey('session'),
  machaCoreKey('clientId'),
  machaCoreKey('bootstrapEndpoints'),
  machaCoreKey('discoveredEndpoints'),
  machaCoreKey('qualityPreference'),
  machaCoreKey('artworkHost'),
] as const;

/**
 * Keys before 2026-10-05, each adopted into its `macha.core.` key on first
 * read and then removed. `macha-server-url` and `macha-server-endpoints-v1`
 * are older still, adopted into the bootstrap endpoints.
 */
export const MACHA_LEGACY_STORAGE_KEYS = [
  'macha.session.v1',
  'macha-client-id',
  'macha-server-url',
  'macha-server-endpoints-v1',
  'macha-bootstrap-endpoints-v1',
  'macha-discovered-endpoints-v1',
  'macha.qualityPreference.v1',
  'macha.artworkHost.v1',
] as const;

/** The per-client keys before 2026-10-05, each followed by a client id. */
const MACHA_LEGACY_CLIENT_KEY_PREFIXES = [
  'macha.continueWatching.v1.',
  'macha.playbackQueue.v1.',
  'macha.playlists.v1.',
  'macha.musicPlaylist.v1.',
  'macha-client-bandwidth:',
  /** Continue Watching's pre-`0.10.0` key, adopted the same way. */
  'macha-client-progress:',
] as const;

/**
 * Prefixes a host matching core's keys must match by: the current one and
 * the legacy per-client ones.
 */
export const MACHA_STORAGE_KEY_PREFIXES = [
  MACHA_CORE_KEY_PREFIX,
  ...MACHA_LEGACY_CLIENT_KEY_PREFIXES,
] as const;

/**
 * Written and deleted immediately at startup to find out whether a store
 * accepts writes at all: Safari in private mode and a WebView with site data
 * disabled both expose the object and throw on write. Listed so a host that
 * enumerates keys is not surprised by it; it never persists.
 */
export const MACHA_STORAGE_PROBE_KEY = 'macha-storage-probe';

/**
 * Whether a key belongs to **this package**.
 *
 * Use this rather than a prefix test of your own *for core's keys*: both
 * conventions are covered, the probe key is included, and a key added here in
 * a later release starts being recognised without the host changing anything.
 *
 * **It does not answer "is this key Macha's".** It cannot; it knows only what
 * core owns, and a host owns more. **Never substitute it for the filter that
 * decides which keys your own application restores at startup.** The phone
 * client checked what that would cost by making the change rather than
 * reasoning about it: its `owned()` set is strictly larger, and this function
 * returns false for every one of `macha.clientId.v1`, `macha.endpoints.v1`,
 * `macha.discoveredEndpoints.v1`, `macha.downloads.v1.`, `macha.musicLibrary.v1.`
 * and `macha.progress.v1:`, none of which are core's.
 *
 * The worst of those is `macha.clientId.v1`, because it is the namespace the
 * per-client stores are keyed under: drop it and the client id is fresh on
 * every cold start, orphaning Continue Watching, the queue, the playlists and
 * the music library at once. Silent, and the same shape as the sign-out
 * incident described at the top of this file, which is the point. This
 * function exists because of that incident and could, read as a blanket
 * instruction, cause a larger version of it.
 *
 * What it is for: a host clearing or auditing **core's** data, where the
 * question really is "is this one of yours".
 *
 * **And one use that is not about clearing at all.** A host that backs
 * `MachaHost.storage` with a cache hydrated by prefix, rather than reading
 * straight through, must load every key here *before* core reads anything,
 * retired keys included. Core cannot distinguish "your cache never loaded
 * this" from "this key is absent", so a read-time migration against such a
 * host silently carries nothing across. A coupling rather than a live risk
 * (this package has no users), but it holds for migrations not yet written.
 * See the note on `MachaHost.storage`.
 */
export function isMachaStorageKey(key: string): boolean {
  if (key === MACHA_STORAGE_PROBE_KEY) return true;
  if ((MACHA_STORAGE_KEYS as readonly string[]).includes(key)) return true;
  if ((MACHA_LEGACY_STORAGE_KEYS as readonly string[]).includes(key)) return true;
  return MACHA_STORAGE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

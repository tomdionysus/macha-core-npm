/**
 * Every storage key this package owns, named in one place.
 *
 * **This exists because a host cannot be expected to grep a dependency.** The
 * phone client namespaces its own keys `macha.` and hydrated its store with a
 * `startsWith('macha.')` filter — which matches one of the two conventions
 * below exactly and misses the other, including the session. The token was
 * written faithfully on every launch and never read back, nothing errored,
 * nothing logged, and because a session re-mints in milliseconds the only
 * symptom was *a person* being signed out on every cold start. Nobody notices
 * that until an account actually matters.
 *
 * That was not a careless filter. It was a foreseeable consequence of core
 * shipping two conventions and naming neither.
 *
 * **There are two conventions, and that is a defect rather than a design.**
 * The state stores use dotted `macha.<name>.v<n>.<clientId>`; the runtime and
 * cluster layers use hyphenated `macha-<name>`. New keys take the dotted form.
 * The hyphenated ones are listed here as what they are — legacy — and each
 * costs a forced re-read or a lost value to rename, so they move when
 * something else already forces that cost. `macha-session` was retired to
 * `macha.session.v1` in `0.10.0` for exactly that reason: moving the session
 * out of tab-lifetime storage already forced one fresh mint everywhere, so the
 * rename rode along for nothing.
 */

/** Keys that are complete in themselves. */
export const MACHA_STORAGE_KEYS = [
  'macha.session.v1',
  'macha-client-id',
  'macha-server-url',
  'macha-server-endpoints-v1',
  'macha-bootstrap-endpoints-v1',
  'macha-discovered-endpoints-v1',
] as const;

/**
 * Keys completed at runtime by appending a client id (or, for bandwidth, an
 * endpoint-scoped record). A host matching these must match by prefix.
 */
export const MACHA_STORAGE_KEY_PREFIXES = [
  'macha.continueWatching.v1.',
  'macha.playbackQueue.v1.',
  'macha.playlists.v1.',
  'macha.musicPlaylist.v1.',
  'macha.volume.v1.',
  'macha-client-bandwidth:',
  /**
   * Continue Watching's pre-`0.10.0` key. Still read when the current key holds
   * nothing, and deliberately never deleted — see `state/continueWatching.ts`,
   * which keeps it as the way back from a rollback.
   *
   * Listed because this package still owns it. A host clearing Macha's data on
   * `isMachaStorageKey` would otherwise leave it behind, and a host auditing
   * what is in its store would read it as some other application's.
   */
  'macha-client-progress:',
] as const;

/**
 * Written and deleted immediately at startup to find out whether a store
 * accepts writes at all — Safari in private mode and a WebView with site data
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
 * **It does not answer "is this key Macha's".** It cannot — it knows only what
 * core owns, and a host owns more. **Never substitute it for the filter that
 * decides which keys your own application restores at startup.** The phone
 * client checked what that would cost by making the change rather than
 * reasoning about it: its `owned()` set is strictly larger, and this function
 * returns false for every one of `macha.clientId.v1`, `macha.endpoints.v1`,
 * `macha.discoveredEndpoints.v1`, `macha.downloads.v1.`, `macha.musicLibrary.v1.`
 * and `macha.progress.v1:` — none of which are core's.
 *
 * The worst of those is `macha.clientId.v1`, because it is the namespace the
 * per-client stores are keyed under: drop it and the client id is fresh on
 * every cold start, orphaning Continue Watching, the queue, the playlists and
 * the music library at once. Silent, and the same shape as the sign-out
 * incident described at the top of this file — which is the point. This
 * function exists because of that incident and could, read as a blanket
 * instruction, cause a larger version of it.
 *
 * What it is for: a host clearing or auditing **core's** data, where the
 * question really is "is this one of yours".
 *
 * **And one use that is not about clearing at all.** A host that backs
 * `MachaHost.storage` with a cache hydrated by prefix — rather than reading
 * straight through — must load every key here *before* core reads anything,
 * retired keys included. Core cannot distinguish "your cache never loaded
 * this" from "this key is absent", and the difference is a viewer's entire
 * Continue Watching list. See the note on `MachaHost.storage`.
 */
export function isMachaStorageKey(key: string): boolean {
  if (key === MACHA_STORAGE_PROBE_KEY) return true;
  if ((MACHA_STORAGE_KEYS as readonly string[]).includes(key)) return true;
  return MACHA_STORAGE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

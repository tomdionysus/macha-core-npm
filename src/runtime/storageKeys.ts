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
 * Whether a key belongs to this package.
 *
 * Use this rather than a prefix test of your own. Both conventions are
 * covered, the probe key is included, and a key added here in a later release
 * starts being recognised without the host changing anything.
 */
export function isMachaStorageKey(key: string): boolean {
  if (key === MACHA_STORAGE_PROBE_KEY) return true;
  if ((MACHA_STORAGE_KEYS as readonly string[]).includes(key)) return true;
  return MACHA_STORAGE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

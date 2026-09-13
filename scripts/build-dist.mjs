/**
 * Compile to a staging directory and swap it into place atomically.
 *
 * **Because something is always reading `dist` while this runs.** Every client
 * resolves this package through a `file:` link, so their suites and typechecks
 * read `dist` directly, live, with no version boundary to hide behind. A build
 * that writes into `dist` in place is a build that publishes a half-written
 * tree to four consumers.
 *
 * This has now failed in both available directions, hours apart:
 *
 * - `tsc` emitting straight into `dist` left **orphans** — output whose source
 *   had been deleted, since `tsc` removes nothing. A client found
 *   `dist/state/volume.js` still resolvable after `VolumeStore` was deleted,
 *   which is exactly the artefact that makes someone believe a deletion did
 *   not happen. `dist:check` cannot catch it: it compares mtimes of files that
 *   *exist*, so a vanished source is the one case it is structurally blind to.
 * - Fixing that by emptying `dist` first made the window **worse**, not
 *   better. Before, a client building mid-rebuild got something stale but
 *   complete — importable, suite runs, probably passes. After, it got a
 *   directory that was absent or partial, and every import failed at once. One
 *   client watched its whole suite collapse to "45 files failed / no tests"
 *   and went looking for a breakage in its own tree first, which is the cost
 *   of a loud failure in someone else's repo.
 *
 * So: compile into `dist.staging`, then move it in. `rename` is atomic within
 * a filesystem, so a reader sees the old tree or the new one and never a tree
 * mid-write. Staging starts empty, so orphans cannot survive either. Both
 * problems close, rather than one being traded for the other.
 *
 * A failed compile leaves `dist` untouched, which is the other half of the
 * point — a broken build must not be able to break every client with it.
 */
import { rmSync, renameSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const OUT = 'dist';
const STAGING = 'dist.staging';
const PREVIOUS = 'dist.previous';

for (const path of [STAGING, PREVIOUS]) rmSync(path, { recursive: true, force: true });

const compile = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['tsc', '-p', 'tsconfig.build.json', '--outDir', STAGING],
  { stdio: 'inherit' },
);

if (compile.status !== 0) {
  // Deliberately leave `dist` exactly as it was. A client reading it right now
  // keeps a working tree rather than inheriting this failure.
  rmSync(STAGING, { recursive: true, force: true });
  process.exit(compile.status ?? 1);
}

// Two renames rather than a remove-then-rename: `rename` will not replace a
// non-empty directory, so the old tree has to move aside first — and doing it
// this way leaves a gap of microseconds between two atomic operations instead
// of a gap spanning a directory deletion.
if (existsSync(OUT)) renameSync(OUT, PREVIOUS);
renameSync(STAGING, OUT);
rmSync(PREVIOUS, { recursive: true, force: true });

console.log('build: dist replaced atomically.');

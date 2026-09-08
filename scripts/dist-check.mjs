#!/usr/bin/env node
/**
 * Fail if `dist` is older than `src`.
 *
 * Consumers that depend on this package by path (`file:../macha-ts`) get a
 * symlink, not a build. Their typecheck reads fresh `src` through the source
 * maps while their runtime loads whatever `dist` happens to hold, so a stale
 * build typechecks green and then behaves like the code nobody is looking at.
 * That failure has no symptom at the point it is introduced, which is why it
 * needs a check rather than a habit.
 *
 * The comparison is per file and by mtime. Mtimes are a weak signal in general
 * — a checkout or a copy can reorder them — but they are the right one here,
 * because the thing being detected is precisely "someone edited a source file
 * and did not rebuild", which is the one case mtimes report reliably.
 *
 * Deliberately not wired into `test` or `build`: `build` is what makes dist
 * fresh, so a build that refused to start on a stale dist would be refusing to
 * do its job. Run it from a consumer's `pretest`, where a stale dist is
 * genuinely about to produce a wrong answer.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Not `import.meta.dirname`: that landed in 20.11 and package.json says >=20.
const root = fileURLToPath(new URL('..', import.meta.url));
const srcRoot = join(root, 'src');
const distRoot = join(root, 'dist');

/** Mirrors tsconfig.build.json's `exclude`: tests are never emitted. */
const emitted = (path) => path.endsWith('.ts') && !path.endsWith('.d.ts') && !path.endsWith('.test.ts');

function sources(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (path === join(srcRoot, 'test')) continue;
      found.push(...sources(path));
    } else if (emitted(path)) {
      found.push(path);
    }
  }
  return found;
}

let distStat;
try {
  distStat = statSync(distRoot);
} catch {
  console.error('dist-check: no dist/ at all — run `npm run build` in @macha/core.');
  process.exit(1);
}
if (!distStat.isDirectory()) {
  console.error('dist-check: dist/ is not a directory.');
  process.exit(1);
}

const stale = [];
const missing = [];
for (const source of sources(srcRoot)) {
  const output = join(distRoot, relative(srcRoot, source)).replace(/\.ts$/, '.js');
  let outputStat;
  try {
    outputStat = statSync(output);
  } catch {
    missing.push(relative(root, source));
    continue;
  }
  if (statSync(source).mtimeMs > outputStat.mtimeMs) stale.push(relative(root, source));
}

if (!stale.length && !missing.length) {
  console.log('dist-check: dist is current.');
  process.exit(0);
}

// Name the files rather than just the count: the usual cause is one forgotten
// rebuild after one edit, and seeing which edit says whether it mattered.
console.error('dist-check: dist is behind src — run `npm run build` in @macha/core.');
for (const path of missing) console.error(`  never built  ${path}`);
for (const path of stale) console.error(`  stale        ${path}`);
process.exit(1);

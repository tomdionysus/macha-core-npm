// Writes the package version under the README's title, as `*vX.Y.Z*`.
//
// Run by npm's `version` lifecycle, so `npm version` updates the README in
// the same commit as the bump. `--check` changes nothing and fails if the two
// disagree; `npm run build` runs it, and so does `prepublishOnly` through the
// build, so a bump made any other way cannot be published with a stale README.
import { readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const path = new URL('../README.md', import.meta.url);
const lines = readFileSync(path, 'utf8').split('\n');
const title = lines.findIndex((line) => line.startsWith('# '));
if (title === -1) throw new Error('README.md has no title line.');
const stamp = `*v${version}*`;
if (process.argv.includes('--check')) {
  if (lines[title + 2] !== stamp) {
    console.error(`README.md states ${lines[title + 2] ?? 'no version'} under its title; package.json is ${version}. Run node scripts/readme-version.mjs.`);
    process.exit(1);
  }
  process.exit(0);
}
if (/^\*v\d+\.\d+\.\d+[^*]*\*$/.test(lines[title + 2] ?? '')) lines[title + 2] = stamp;
else lines.splice(title + 1, 0, '', stamp);
writeFileSync(path, lines.join('\n'));

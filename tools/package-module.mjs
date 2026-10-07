#!/usr/bin/env node
// Packs packages/module/dist/** (the self-contained, built Foundry module) into module.zip,
// ready as a GitHub release asset. Run in CI after a v* tag.
import { createWriteStream, existsSync } from 'node:fs';
import { join } from 'node:path';
// archiver@8 changed its API relative to older versions in the online documentation:
// instead of the archiver('zip', opts) factory it now exports a ZipArchive class.
import { ZipArchive } from 'archiver';

const REPO_ROOT = join(import.meta.dirname, '..');
const DIST = join(REPO_ROOT, 'packages', 'module', 'dist');
const OUT_ZIP = join(REPO_ROOT, 'module.zip');

if (!existsSync(DIST)) {
  console.error(`package-module: ${DIST} not found — run "npm run build" first.`);
  process.exit(1);
}

const output = createWriteStream(OUT_ZIP);
const archive = new ZipArchive({ zlib: { level: 9 } });

output.on('close', () => {
  console.log(`package-module: ${OUT_ZIP} (${archive.pointer()} bytes)`);
});
archive.on('error', (err) => {
  throw err;
});

archive.pipe(output);
archive.directory(DIST, false);
await archive.finalize();

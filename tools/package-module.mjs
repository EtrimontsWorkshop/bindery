#!/usr/bin/env node
// Pakuje packages/module/dist/** (samodzielny, zbudowany modul Foundry) do module.zip
// gotowego jako asset wydania GitHub. Uruchamiane w CI po tagu v* (Z8).
import { createWriteStream, existsSync } from 'node:fs';
import { join } from 'node:path';
// archiver@8 zmienil API wzgledem starszych wersji w dokumentacji online:
// zamiast fabryki archiver('zip', opts) eksportuje teraz klase ZipArchive.
import { ZipArchive } from 'archiver';

const REPO_ROOT = join(import.meta.dirname, '..');
const DIST = join(REPO_ROOT, 'packages', 'module', 'dist');
const OUT_ZIP = join(REPO_ROOT, 'module.zip');

if (!existsSync(DIST)) {
  console.error(`package-module: nie znaleziono ${DIST} — uruchom najpierw "npm run build".`);
  process.exit(1);
}

const output = createWriteStream(OUT_ZIP);
const archive = new ZipArchive({ zlib: { level: 9 } });

output.on('close', () => {
  console.log(`package-module: ${OUT_ZIP} (${archive.pointer()} bajtow)`);
});
archive.on('error', (err) => {
  throw err;
});

archive.pipe(output);
archive.directory(DIST, false);
await archive.finalize();

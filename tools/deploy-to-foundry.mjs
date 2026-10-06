#!/usr/bin/env node
// Copies the BUILT module (packages/module/dist) into a separate module folder
// of a Foundry install, for when the repo is NOT that folder (so `sync:local`
// is not enough). Copies EVERY module entry, including lib/ (the built core
// lives there — skipping it leaves Foundry running stale logic).
// Usage: BINDERY_FOUNDRY_MODULE_DIR="<.../Data/modules/bindery-pdf-importer>" npm run deploy:foundry
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');
const DIST = join(REPO_ROOT, 'packages', 'module', 'dist');
const DEST = process.env.BINDERY_FOUNDRY_MODULE_DIR;
const ENTRIES = ['module.json', 'scripts', 'styles', 'lang', 'templates', 'lib', 'fonts'];

if (!DEST) {
  console.error('deploy-to-foundry: set BINDERY_FOUNDRY_MODULE_DIR to the module folder inside your Foundry data directory.');
  process.exit(1);
}
const distId = JSON.parse(readFileSync(join(DIST, 'module.json'), 'utf8')).id;
const destManifest = join(DEST, 'module.json');
if (!existsSync(destManifest) || JSON.parse(readFileSync(destManifest, 'utf8')).id !== distId) {
  console.error(`deploy-to-foundry: ${DEST} does not look like the folder of module "${distId}" — aborting.`);
  process.exit(1);
}

for (const entry of ENTRIES) {
  if (!existsSync(join(DIST, entry))) continue;
  rmSync(join(DEST, entry), { recursive: true, force: true });
  cpSync(join(DIST, entry), join(DEST, entry), { recursive: true });
}
console.log(`deploy-to-foundry: copied ${ENTRIES.join(', ')} -> ${DEST}`);

#!/usr/bin/env node
// For local development: when this repository IS the module folder of a local
// Foundry install (Data/modules/<module id>), Foundry can only load the BUILT
// module from the repository root. `packages/module/dist/` is that self-contained
// module (module.json, scripts/, styles/, lang/, templates/, lib/); this script
// copies it to the repository root. CI packages `packages/module/dist/**`
// directly into module.zip and does not use this step. When the repository is
// NOT the module folder, use `npm run deploy:foundry` instead.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');
const DIST = join(REPO_ROOT, 'packages', 'module', 'dist');

const DEPLOYED_ENTRIES = ['module.json', 'scripts', 'styles', 'lang', 'templates', 'lib', 'fonts'];

for (const entry of DEPLOYED_ENTRIES) {
  const dest = join(REPO_ROOT, entry);
  rmSync(dest, { recursive: true, force: true });
}

// Only the entries listed above are copied. `dist/` also holds README.md and LICENSE (shipped inside the module): the
// repo root has its own, tracked copies of those, and a build must not rewrite tracked files.
for (const entry of DEPLOYED_ENTRIES) {
  const source = join(DIST, entry);
  if (existsSync(source)) cpSync(source, join(REPO_ROOT, entry), { recursive: true });
}

console.log(`sync-local-module: copied ${DIST} -> ${REPO_ROOT}`);

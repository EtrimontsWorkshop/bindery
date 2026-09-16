#!/usr/bin/env node
// Ten katalog repo JEST folderem modulu w lokalnej instalacji Foundry
// (Data/modules/bindery). packages/module/dist/ to samodzielny, zbudowany
// modul (module.json, scripts/, styles/, lang/, templates/, lib/). Ten skrypt
// kopiuje go do korzenia repo, zeby Foundry mogl go zaladowac bez dodatkowej
// konfiguracji. Wylacznie do lokalnego developmentu/testow (Z7) — CI pakuje
// packages/module/dist/** bezposrednio do module.zip, bez tego kroku.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');
const DIST = join(REPO_ROOT, 'packages', 'module', 'dist');

const DEPLOYED_ENTRIES = ['module.json', 'scripts', 'styles', 'lang', 'templates', 'lib', 'fonts'];

for (const entry of DEPLOYED_ENTRIES) {
  const dest = join(REPO_ROOT, entry);
  rmSync(dest, { recursive: true, force: true });
}

mkdirSync(REPO_ROOT, { recursive: true });
cpSync(DIST, REPO_ROOT, { recursive: true });

console.log(`sync-local-module: skopiowano ${DIST} -> ${REPO_ROOT}`);

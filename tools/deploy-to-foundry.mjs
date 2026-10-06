#!/usr/bin/env node
// Kopiuje ZBUDOWANY modul (packages/module/dist) do osobnego folderu modulu w
// instalacji Foundry, gdy repo NIE jest tym folderem (wtedy `sync:local`
// nie wystarcza). Kopiuje WSZYSTKIE wpisy modulu, lacznie z lib/ (tam zyje
// zbudowany core — pominiecie go zostawia Foundry ze starym kodem logiki).
// Uzycie: BINDERY_FOUNDRY_MODULE_DIR="<.../Data/modules/bindery-pdf-importer>" npm run deploy:foundry
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');
const DIST = join(REPO_ROOT, 'packages', 'module', 'dist');
const DEST = process.env.BINDERY_FOUNDRY_MODULE_DIR;
const ENTRIES = ['module.json', 'scripts', 'styles', 'lang', 'templates', 'lib', 'fonts'];

if (!DEST) {
  console.error('deploy-to-foundry: ustaw BINDERY_FOUNDRY_MODULE_DIR na folder modulu w Foundry.');
  process.exit(1);
}
const distId = JSON.parse(readFileSync(join(DIST, 'module.json'), 'utf8')).id;
const destManifest = join(DEST, 'module.json');
if (!existsSync(destManifest) || JSON.parse(readFileSync(destManifest, 'utf8')).id !== distId) {
  console.error(`deploy-to-foundry: ${DEST} nie wyglada na folder modulu "${distId}" — przerywam.`);
  process.exit(1);
}

for (const entry of ENTRIES) {
  if (!existsSync(join(DIST, entry))) continue;
  rmSync(join(DEST, entry), { recursive: true, force: true });
  cpSync(join(DIST, entry), join(DEST, entry), { recursive: true });
}
console.log(`deploy-to-foundry: skopiowano ${ENTRIES.join(', ')} -> ${DEST}`);

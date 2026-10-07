#!/usr/bin/env node
// Guards the files that end up in a release: the manifest (`module.json`) must
// point at files that really exist, and the manifest uploaded next to
// `module.zip` must be the same one that is inside it.
//
// Why: the build rewrites the file names in `dist/module.json` to carry the
// version (`scripts/bindery-<version>.js`, so browsers and hosting providers
// never serve a stale cached script), while the source `module.json` keeps the
// plain names. Uploading the source file by mistake gives a manifest that names
// files the zip does not contain.
//
// Checks:
//   1. every `esmodules` / `styles` / `languages` path of `dist/module.json`
//      exists in `dist`;
//   2. its version equals the version in the source `packages/module/module.json`;
//   3. when `module.zip` exists: it contains all of those files, and the
//      `module.json` inside it is identical to `dist/module.json`.
//   4. (default dist only) the module id in the source is used consistently: every
//      `modules/<id>/...` path in `packages/module/{src,templates}` and every
//      settings/flag key declared in `src/global.d.ts` carries the manifest's id,
//      so a leftover of a former id cannot sneak back in.
// Options: `--dist <dir>` and `--zip <file>` (mainly for testing).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { join, resolve } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? resolve(args[index + 1]) : fallback;
};
const DIST = option('--dist', join(REPO_ROOT, 'packages', 'module', 'dist'));
const ZIP = option('--zip', join(REPO_ROOT, 'module.zip'));
const usesDefaultDist = !args.includes('--dist');

const problems = [];
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

const manifestPath = join(DIST, 'module.json');
if (!existsSync(manifestPath)) {
  console.error(`check:manifest: ${manifestPath} not found — run "npm run build" first.`);
  process.exit(1);
}
const manifest = readJson(manifestPath);
const referenced = [...(manifest.esmodules ?? []), ...(manifest.styles ?? []), ...(manifest.languages ?? []).map((l) => l.path)];

for (const path of referenced) {
  if (!existsSync(join(DIST, path))) problems.push(`dist/module.json refers to "${path}", which does not exist in dist`);
}

if (usesDefaultDist) {
  const source = readJson(join(REPO_ROOT, 'packages', 'module', 'module.json'));
  if (source.version !== manifest.version) problems.push(`version mismatch: source module.json is ${source.version}, dist/module.json is ${manifest.version}`);
}

if (usesDefaultDist) {
  const moduleRoot = join(REPO_ROOT, 'packages', 'module');
  const walk = (dir) => readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
  for (const file of [...walk(join(moduleRoot, 'src')), ...walk(join(moduleRoot, 'templates'))]) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/modules\/([A-Za-z0-9_-]+)\//g)) {
      if (match[1] !== manifest.id) problems.push(`${file.slice(REPO_ROOT.length + 1)} uses the module id "${match[1]}" in a path (expected "${manifest.id}")`);
    }
  }
  const globalTypes = readFileSync(join(moduleRoot, 'src', 'global.d.ts'), 'utf8');
  for (const match of globalTypes.matchAll(/^\s*'([a-z0-9-]+)(?:\.\w+)?'\s*:/gm)) {
    if (match[1] !== manifest.id) problems.push(`packages/module/src/global.d.ts declares a key under "${match[1]}" (expected "${manifest.id}")`);
  }
}

if (existsSync(ZIP)) {
  const unzip = (...zipArgs) => execFileSync('unzip', zipArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const entries = new Set(unzip('-Z1', ZIP).split('\n').filter(Boolean));
  for (const path of referenced) {
    if (!entries.has(path)) problems.push(`module.zip does not contain "${path}", which the manifest refers to`);
  }
  if (!entries.has('module.json')) {
    problems.push('module.zip has no module.json at its top level');
  } else if (!isDeepStrictEqual(JSON.parse(unzip('-p', ZIP, 'module.json')), manifest)) {
    problems.push('the module.json inside module.zip differs from dist/module.json (the file uploaded next to the zip)');
  }
}

if (problems.length > 0) {
  console.error('check:manifest: FAILED');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`check:manifest: OK — ${manifest.id} ${manifest.version}: ${referenced.length} referenced files present${existsSync(ZIP) ? ', module.zip matches the manifest' : ' (no module.zip to compare)'}.`);

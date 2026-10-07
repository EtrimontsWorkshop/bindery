#!/usr/bin/env node
// A hand-edited key in lang/pl.json/en.json once got inserted WITHOUT restoring the closing "}"
// of the "wizard" section — the file was nested incorrectly (another section landed INSIDE
// "wizard"). `npm run build` doesn't catch this: Vite copies these files as static assets and
// never parses them. `npm run lint`/`tsc` don't either — they aren't TS code. Foundry itself
// throws no error on a bad language JSON — it silently doesn't load the TRANSLATIONS at all,
// so the whole Settings window shows raw keys ("BINDERY.settings.openWizardMenuLabel")
// instead of text, with no error in the console pointing at the CAUSE. This script is the
// only place that actually PARSES both language files and compares their key sets.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');
const LANG_DIR = join(REPO_ROOT, 'packages', 'module', 'lang');
const FILES = ['pl.json', 'en.json'];

function flattenKeys(obj, prefix = '') {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) keys.push(...flattenKeys(v, path));
    else keys.push(path);
  }
  return keys;
}

let failed = false;
const keySets = new Map();

for (const file of FILES) {
  const full = join(LANG_DIR, file);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(full, 'utf-8'));
  } catch (err) {
    console.error(`check:lang: SYNTAX ERROR in ${file}: ${err.message}`);
    failed = true;
    continue;
  }
  keySets.set(file, new Set(flattenKeys(parsed)));
}

if (!failed) {
  const [a, b] = FILES;
  const setA = keySets.get(a);
  const setB = keySets.get(b);
  const onlyInA = [...setA].filter((k) => !setB.has(k));
  const onlyInB = [...setB].filter((k) => !setA.has(k));
  if (onlyInA.length > 0) {
    console.error(`check:lang: keys present ONLY in ${a} (missing from ${b}):\n  ${onlyInA.join('\n  ')}`);
    failed = true;
  }
  if (onlyInB.length > 0) {
    console.error(`check:lang: keys present ONLY in ${b} (missing from ${a}):\n  ${onlyInB.join('\n  ')}`);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}
console.log('check:lang: OK — both language files are valid JSON and have the same set of keys.');

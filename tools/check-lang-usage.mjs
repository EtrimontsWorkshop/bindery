#!/usr/bin/env node
// [Statblock import, Task 7] Rule 7's "wszystkie stringi UI w plikach
// lokalizacji" only helps if the keys actually LINE UP with what the code
// references — `check-lang.mjs` already confirms en/pl carry the SAME set
// of keys, but neither file is checked against what the CODE actually asks
// for. Two failure modes this catches that `check-lang.mjs` cannot:
//   1. MISSING — code references `BINDERY.foo.bar`, but neither lang file
//      defines it. Foundry doesn't error on this; it silently shows the raw
//      key string to the user (see `check-lang.mjs`'s own header for a past
//      incident of exactly this class of silent failure). Fails the build.
//   2. UNUSED — a lang file defines a key nothing in the scanned source
//      statically references. Reported as a WARNING, not a failure: some
//      keys are legitimately assembled at runtime from a dynamic piece (e.g.
//      a `Diagnostic.code` interpolated into `BINDERY.diagnostic.${code}`)
//      that this regex-based scan can't reconstruct — a human call, not
//      something to auto-fail CI over. Reporting them is still useful: this
//      run found the ENTIRE `diagnostic.*` section (43 keys) is unused this
//      way — a real product gap for the "error messages have context" work
//      (Task 7 point 3), not a bug in this script.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');
const LANG_FILE = join(REPO_ROOT, 'packages', 'module', 'lang', 'en.json');
const SCAN_DIRS = [join(REPO_ROOT, 'packages', 'module', 'src'), join(REPO_ROOT, 'packages', 'module', 'templates')];

function flattenKeys(obj, prefix = '') {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) keys.push(...flattenKeys(v, path));
    else keys.push(path);
  }
  return keys;
}

function findSourceFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) results.push(...findSourceFiles(full));
    else if (entry.endsWith('.ts') || entry.endsWith('.hbs')) results.push(full);
  }
  return results;
}

const KEY_REF_RE = /BINDERY\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+/g;

const definedKeys = new Set(flattenKeys(JSON.parse(readFileSync(LANG_FILE, 'utf8'))));

const referencedKeys = new Set();
for (const dir of SCAN_DIRS) {
  for (const file of findSourceFiles(dir)) {
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(KEY_REF_RE)) referencedKeys.add(match[0]);
  }
}

const missing = [...referencedKeys].filter((k) => !definedKeys.has(k)).sort();
const unused = [...definedKeys].filter((k) => !referencedKeys.has(k)).sort();

if (unused.length > 0) {
  console.warn(`check:lang-usage: ${unused.length} klucz(e) zdefiniowane, ale nieznalezione w zeskanowanym kodzie (mogą być budowane dynamicznie — sprawdź ręcznie):\n  ${unused.join('\n  ')}`);
}

if (missing.length > 0) {
  console.error(`check:lang-usage: BRAKUJĄCE klucze — kod się do nich odwołuje, ale nie istnieją w en.json:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

console.log(`check:lang-usage: OK — 0 brakujących kluczy (${referencedKeys.size} odwołań sprawdzonych, ${unused.length} nieużytych zgłoszonych powyżej jako ostrzeżenie).`);

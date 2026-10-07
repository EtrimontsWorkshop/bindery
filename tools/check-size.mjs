#!/usr/bin/env node
// Budget: < 40 KB for code loaded EAGERLY at world START (without opening any window).
// module.json points ONLY at packages/module/dist/scripts/bindery-<version>.js as "esmodules" —
// but that file can itself STATICALLY import other local chunks (`import ... from
// "./api-XXXX.js"`), and the browser loads the WHOLE graph of static ES module imports
// synchronously before the module starts executing. Measuring ONLY the entry file would miss
// the question the budget actually asks — and that was NOT hypothetical: a first (wrong)
// version of a window's registration in `settings.ts` (a static import of the whole class
// instead of a lazy "launcher") did NOT change the entry file's size, but bloated the SHARED
// chunk `api-*.js` that the entry file statically imports — the real world-start budget would
// have grown by ~26 KB while a script measuring only the entry file would still have said "OK".
//
// This script parses the entry file for its OWN, STATIC `import ... from "./local.js"`
// (relative — it skips `@bindery/core`/`pdfjs-dist`, which are `external` in vite.config.ts and
// legitimately loaded ONLY through dynamic `import()` inside methods, never as a top-level
// `import ... from`), follows them recursively through the WHOLE local graph of static imports
// (windows such as `ReviewScreen` are imported dynamically INSIDE functions, not as a top-level
// `import ... from` — the parser will NOT find them, as intended: that confirms they were
// separated correctly), and sums the size of ALL files found — the real eager cost of this build.
//
// We measure raw (uncompressed) bytes — a worse case than gzip transfer, a safer and stricter
// gate than measuring after gzip.
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const BUDGET_BYTES = 40 * 1024;
const DIST_DIR = join(import.meta.dirname, '..', 'packages', 'module', 'dist');
const SCRIPTS_DIR = join(DIST_DIR, 'scripts');
// The entry file name is NOT a fixed literal "bindery.js" anymore — since the fix for Foundry's
// manifest validation (the server rejected a query parameter in `esmodules` as a nonexistent
// file) the version goes into the FILE NAME ITSELF (`bindery-<version>.js`, see
// `vite.config.ts`). We read the real name from the ALREADY BUILT `dist/module.json`, so this
// script keeps working unchanged on every version bump.
let manifest;
try {
  manifest = JSON.parse(readFileSync(join(DIST_DIR, 'module.json'), 'utf8'));
} catch {
  console.error(`check:size: could not read ${join(DIST_DIR, 'module.json')} — run the build first.`);
  process.exit(1);
}
const ENTRY = join(DIST_DIR, manifest.esmodules[0]);

// Matches ONLY `import ... from "./something.js"` / `'../something.js'` — static declarations
// at the top of an ES module. Deliberately does NOT catch `import(...)` (a function call, a
// dynamic import) or specifiers without `./`/`../` (packages, e.g. `@bindery/core` — the only
// path THIS analysis counts as "eager" is a real file under `dist/scripts/` reachable
// EXCLUSIVELY through static imports).
const STATIC_IMPORT_RE = /import\s+(?:[^'"]*?\sfrom\s+)?['"](\.\.?\/[^'"]+)['"]/g;

function findStaticImports(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const specifiers = [];
  for (const match of text.matchAll(STATIC_IMPORT_RE)) specifiers.push(match[1]);
  return specifiers;
}

function collectEagerClosure(entryPath) {
  const visited = new Map(); // an absolute path -> the size
  const queue = [entryPath];
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    let size;
    try {
      size = statSync(current).size;
    } catch {
      console.error(`check:size: a static import points at a nonexistent file: ${current} — run the build first.`);
      process.exit(1);
    }
    visited.set(current, size);
    for (const spec of findStaticImports(current)) {
      queue.push(resolve(dirname(current), spec));
    }
  }
  return visited;
}

const closure = collectEagerClosure(ENTRY);
const totalSize = [...closure.values()].reduce((a, b) => a + b, 0);

console.log('check:size: the closure of static imports (loaded eagerly at world start):');
for (const [path, size] of closure) console.log(`  ${path.replace(SCRIPTS_DIR, '.')} = ${size} bytes`);
console.log(`check:size: TOTAL = ${totalSize} bytes (budget: ${BUDGET_BYTES} bytes)`);

if (totalSize >= BUDGET_BYTES) {
  console.error(`check:size: the startup budget EXCEEDED — ${totalSize} >= ${BUDGET_BYTES} bytes.`);
  process.exit(1);
}

console.log('check:size: OK — the closure of static imports fits within the budget of < 40 KB.');

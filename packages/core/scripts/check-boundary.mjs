#!/usr/bin/env node
// packages/core MUST NOT know Foundry.
// ESLint (no-restricted-globals/imports) catches this at the source level, but a linter can be
// bypassed (e.g. globalThis['game'], eval, an eslint-disable comment). This script scans the
// BUILT bundle — the last word, impossible to bypass without changing the output code.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIST_FILE = join(import.meta.dirname, '..', 'dist', 'index.js');
const RESTRICTED = ['game', 'ui', 'canvas', 'Hooks', 'foundry', 'CONFIG'];

let bundle;
try {
  bundle = readFileSync(DIST_FILE, 'utf8');
} catch {
  console.error(`check:boundary: ${DIST_FILE} not found — run the build first.`);
  process.exit(1);
}

// Matching just the word (without a property access) turned out to be a FALSE ALARM: esbuild
// shortens INTERNAL identifiers by position/frequency in scope, NOT by the content of the
// original name — measured directly: a completely unrelated function (`isReferenceReportGreen`
// in referenceInvariants.ts) was mapped to the shortened name "ui" (a collision with
// `function ui(n) {...}` / the export `ui as isReferenceReportGreen`), entirely independent of
// its own source name. Terser with `mangle.reserved` (the only sure way to make the minifier
// NEVER use those six words as shortened names) turned out not to cooperate with this
// Vite/lib-mode (mangling didn't switch on at all, regardless of options); turning minification
// of identifiers off entirely reveals a DIFFERENT, worse false alarm (genuine, innocent local
// variables with the same names, e.g. `canvas` in `encodeImage.ts`, which minification would
// normally hide). Instead: a REAL use of a Foundry global object always looks like `word.something`
// (property access — `ui.notifications`, `game.settings`, `canvas.scene`, `Hooks.on`,
// `foundry.utils`, `CONFIG.Actor` — none of the six is ever called directly as a function in
// real Foundry use). Requiring a dot AFTER the word rejects declarations/exports of coinciding
// identifiers (`function ui(`, `ui as x`) without losing sensitivity to actual references to the
// globals.
// Requiring a dot after the word (the comment above) rejects declarations/exports, but did NOT
// tell `ui.notifications` (a real Foundry property) apart from `ui.test(x)`/`ui.exec(x)` (a
// method call ON A REGEXP that happened to get a shortened name coinciding with one of the six
// restricted words). None of the six real Foundry globals has its OWN first-level method named
// `test`/`exec` (`ui.test`, `game.exec` etc. don't exist in the Foundry API) — excluding THESE
// TWO specific, directly measured collisions loses sensitivity to no real use.
const FALSE_POSITIVE_METHOD_CALL = /^(test|exec)\(/;
const violations = [];
for (const word of RESTRICTED) {
  const re = new RegExp(`\\b${word}\\b\\s*\\.(.{0,6})`, 'g');
  const matches = [...bundle.matchAll(re)].filter((m) => !FALSE_POSITIVE_METHOD_CALL.test(m[1] ?? ''));
  if (matches.length > 0) {
    violations.push({ word, count: matches.length });
  }
}

if (violations.length > 0) {
  console.error('check:boundary: FOUND references to Foundry in packages/core/dist/index.js:');
  for (const v of violations) {
    console.error(`  - "${v.word}": ${v.count}x`);
  }
  console.error('\nBoundary violated: packages/core must be a pure TS library with no Foundry.');
  process.exit(1);
}

console.log('check:boundary: OK — no references to Foundry in the built core bundle.');

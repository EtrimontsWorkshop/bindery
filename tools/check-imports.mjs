#!/usr/bin/env node
// Rollup/Vite with `external` sometimes leaves a BARE module specifier in the built file (e.g.
// "pdfjs-dist/legacy/build/pdf.mjs"). Node resolves that without a problem (via node_modules),
// but in a browser it is invalid ESM — "Failed to resolve module specifier". The error is NOT
// visible in Node/Vitest, only in a real browser — it was first found by accident while testing
// in a live Foundry.
//
// This script scans the built files packages/*/dist/**/*.js for imports/exports (static and
// dynamic with a string literal) whose specifier does NOT start with "/", "./" or "../" — i.e.
// a bare package specifier, impossible to resolve in a browser without an import map.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');
const PACKAGES_DIR = join(REPO_ROOT, 'packages');

function findJsFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...findJsFiles(full));
    } else if (entry.endsWith('.js') || entry.endsWith('.mjs')) {
      results.push(full);
    }
  }
  return results;
}

function findDistDirs() {
  const dirs = [];
  for (const pkg of readdirSync(PACKAGES_DIR)) {
    const distDir = join(PACKAGES_DIR, pkg, 'dist');
    try {
      if (statSync(distDir).isDirectory()) dirs.push(distDir);
    } catch {
      // no dist/ for this package (not built) — skip
    }
  }
  return dirs;
}

// ONLY Rollup/Vite's OWN output — not vendored/copied third-party assets (pdf.js etc. in
// dist/lib/), which we don't build and which cannot have this error from OUR `external`
// configuration.
function isVendoredAsset(filePath) {
  return filePath.split(/[\\/]/).includes('lib');
}

// Matching is PER LINE (no \n in character classes), so it doesn't stretch across unrelated
// pieces of code in Rollup's multi-line, unminified output.
// import ... from "spec" / export ... from "spec" — requires "from" directly before the quote.
const STATIC_IMPORT_RE = /\b(?:import|export)\b[^'"\n]*?\bfrom\s*["']([^"'\n]+)["']/g;
// import("spec") — dynamic, requires "import(" directly (whitespace only) before the quote.
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g;

function isBareSpecifier(spec) {
  return !(spec.startsWith('/') || spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('data:'));
}

const violations = [];
for (const distDir of findDistDirs()) {
  for (const file of findJsFiles(distDir)) {
    if (isVendoredAsset(file)) continue;
    const content = readFileSync(file, 'utf8');
    for (const re of [STATIC_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
      for (const match of content.matchAll(re)) {
        const spec = match[1];
        if (isBareSpecifier(spec)) {
          violations.push({ file, spec });
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error('check:imports: FOUND bare module specifiers in the built files:');
  for (const v of violations) {
    console.error(`  - "${v.spec}" w ${v.file}`);
  }
  console.error(
    '\nA bare specifier works in Node (through node_modules), but NOT in a browser ' +
      '(there is no import map). Fix it with rollupOptions.output.paths in the relevant vite.config.ts.',
  );
  process.exit(1);
}

console.log('check:imports: OK — no bare module specifiers in the built files.');

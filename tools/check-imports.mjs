#!/usr/bin/env node
// Dlug z fazy 1 (RAPORT-FAZA-1.md): Rollup/Vite z `external` zostawia czasem
// GOLY specyfikator modulu w zbudowanym pliku (np. "pdfjs-dist/legacy/build/pdf.mjs").
// W Node dziala to bez problemu (rozwiazanie przez node_modules), ale w przegladarce
// to nieprawidlowa skladnia ESM — "Failed to resolve module specifier". Bledu NIE
// widac w Node/Vitest, tylko w prawdziwej przegladarce — zostal znaleziony
// przypadkiem podczas testu na zywym Foundry (Z7 faza 1).
//
// Ten skrypt skanuje zbudowane pliki packages/*/dist/**/*.js pod katem importow/
// eksportow (statycznych i dynamicznych z literalem string) ze specyfikatorem,
// ktory NIE zaczyna sie od "/", "./" ani "../" — czyli goly specyfikator pakietu,
// niemozliwy do rozwiazania w przegladarce bez import map.
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
      // brak dist/ dla tego pakietu (nie zbudowany) — pomijamy
    }
  }
  return dirs;
}

// Tylko WLASNY output Rollupa/Vite — nie vendorowane/kopiowane assety trzecich
// stron (pdf.js itp. w dist/lib/), ktorych nie budujemy i ktore nie moga miec
// tego bledu z NASZEJ konfiguracji `external`.
function isVendoredAsset(filePath) {
  return filePath.split(/[\\/]/).includes('lib');
}

// Dopasowanie PER LINIA (bez \n w klasach znakow), zeby nie rozciagac sie na
// niepowiazane fragmenty kodu w wielolinijkowym, nieminifikowanym output Rollupa.
// import ... from "spec" / export ... from "spec" — wymaga "from" bezposrednio przed cudzyslowem.
const STATIC_IMPORT_RE = /\b(?:import|export)\b[^'"\n]*?\bfrom\s*["']([^"'\n]+)["']/g;
// import("spec") — dynamiczny, wymaga "import(" bezposrednio (tylko biale znaki) przed cudzyslowem.
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
  console.error('check:imports: ZNALEZIONO gole specyfikatory modulow w zbudowanych plikach:');
  for (const v of violations) {
    console.error(`  - "${v.spec}" w ${v.file}`);
  }
  console.error(
    '\nGoly specyfikator dziala w Node (przez node_modules), ale NIE w przegladarce ' +
      '(brak import map). Napraw przez rollupOptions.output.paths w odpowiednim vite.config.ts.',
  );
  process.exit(1);
}

console.log('check:imports: OK — brak golych specyfikatorow modulow w zbudowanych plikach.');

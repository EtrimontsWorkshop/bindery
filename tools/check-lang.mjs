#!/usr/bin/env node
// [zgloszenie na zywo] Recznie edytowany klucz w lang/pl.json/en.json zostal
// wstawiony BEZ przywrocenia zamykajacego "}" sekcji "wizard" — plik zostal
// zagniezdzony niepoprawnie (sekcja "studio" trafila WEWNATRZ "wizard").
// `npm run build` tego nie lapie: Vite kopiuje te pliki jako statyczne assety,
// nigdy ich nie parsuje. `npm run lint`/`tsc` tez nie — to nie kod TS. Foundry
// SAM w sobie nie rzuca bledu przy zlym JSON-ie jezyka — po cichu nie laduje
// TLUMACZEN wcale, wiec cale okno Ustawien pokazuje surowe klucze
// ("BINDERY.settings.openWizardMenuLabel") zamiast tekstu, bez zadnego bledu
// w konsoli wskazujacego na PRZYCZYNE. Ten skrypt jest jedynym miejscem, ktore
// faktycznie PARSUJE oba pliki jezykowe i porownuje ich zestawy kluczy.
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
    console.error(`check:lang: BLAD SKLADNI w ${file}: ${err.message}`);
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
    console.error(`check:lang: klucze obecne TYLKO w ${a} (brak w ${b}):\n  ${onlyInA.join('\n  ')}`);
    failed = true;
  }
  if (onlyInB.length > 0) {
    console.error(`check:lang: klucze obecne TYLKO w ${b} (brak w ${a}):\n  ${onlyInB.join('\n  ')}`);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}
console.log('check:lang: OK — oba pliki jezykowe sa poprawnym JSON-em i maja ten sam zestaw kluczy.');

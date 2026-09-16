#!/usr/bin/env node
// Ryzyko I3: budzet < 40 KB dla kodu ladowanego EAGERLY przy STARCIE swiata
// (bez otwierania zadnego okna). module.json wskazuje WYLACZNIE
// packages/module/dist/scripts/bindery.js jako "esmodules" — ale ten plik
// sam moze STATYCZNIE importowac inne lokalne chunki (`import ... from
// "./api-XXXX.js"`), a przegladarka laduje CALY graf statycznych importow
// ES module synchronicznie, zanim modul zacznie sie wykonywac. Mierzenie
// WYLACZNIE `bindery.js` (jak ten skrypt robil pierwotnie) mija sie z
// pytaniem, ktore I3 faktycznie zadaje — [KROK-22, znaleziony przy budowie
// Profile Studio] to NIE bylo hipotetyczne: pierwsza (bledna) wersja
// rejestracji Studio w `settings.ts` (statyczny import calej klasy zamiast
// leniwego "launchera") NIE zmienila rozmiaru `bindery.js` (zostal 614 B),
// ale rozdmuchala WSPOLDZIELONY chunk `api-*.js`, ktory `bindery.js`
// statycznie importuje — prawdziwy budzet startu swiata by wtedy urosl
// (614 B + ~26 KB), mimo ze STARA wersja tego skryptu pokazywalaby "OK".
//
// Ten skrypt parsuje `bindery.js` na WLASNE, STATYCZNE `import ... from
// "./local.js"` (relative — pomija `@bindery/core`/`pdfjs-dist`, ktore w
// vite.config.ts sa `external` i legalnie ladowane WYLACZNIE dynamicznym
// `import()` wewnatrz metod, nigdy jako `import ... from` na szczycie pliku),
// rekurencyjnie podaza za nimi PO CALYM lokalnym grafie statycznych
// importow (`ProfileStudio`/`ReviewScreen` sa dynamicznie importowane
// WEWNATRZ funkcji, nie jako `import ... from` na szczycie pliku — parser
// ich NIE znajdzie, zgodnie z zamierzeniem: to WLASNIE potwierdza, ze
// zostaly poprawnie oddzielone), i sumuje rozmiar WSZYSTKICH znalezionych
// plikow — to jest prawdziwy koszt eager tego builda.
//
// Mierzymy surowe bajty (nieskompresowane) — gorszy przypadek niz transfer
// gzip, bezpieczniejszy/bardziej rygorystyczny gate niz mierzenie po gzip.
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const BUDGET_BYTES = 40 * 1024;
const DIST_DIR = join(import.meta.dirname, '..', 'packages', 'module', 'dist');
const SCRIPTS_DIR = join(DIST_DIR, 'scripts');
// [KROK-39] Nazwa pliku wejsciowego NIE jest juz stalym literalem
// "bindery.js" — od naprawy walidacji manifestu Foundry (serwer odrzucal
// parametr zapytania w `esmodules` jako nieistniejacy plik) wersja trafia
// do SAMEJ NAZWY PLIKU (`bindery-<version>.js`, patrz `vite.config.ts`).
// Czytamy prawdziwa nazwe z JUZ zbudowanego `dist/module.json`, zeby ten
// skrypt dzialal bez zmian przy kazdym kolejnym podbiciu wersji.
let manifest;
try {
  manifest = JSON.parse(readFileSync(join(DIST_DIR, 'module.json'), 'utf8'));
} catch {
  console.error(`check:size: nie udalo sie odczytac ${join(DIST_DIR, 'module.json')} — uruchom najpierw build.`);
  process.exit(1);
}
const ENTRY = join(DIST_DIR, manifest.esmodules[0]);

// Dopasowuje WYLACZNIE `import ... from "./cos.js"` / `'../cos.js'` — statyczne
// deklaracje na szczycie modulu ES. Celowo NIE lapie `import(...)` (wywolanie
// funkcji, dynamiczny import) ani specyfikatorow bez `./`/`../` (pakiety, np.
// `@bindery/core` — jedyna droga, ktora TA analiza uznaje za "eager", to
// realny plik pod `dist/scripts/` osiagalny WYLACZNIE statycznymi importami).
const STATIC_IMPORT_RE = /import\s+(?:[^'"]*?\sfrom\s+)?['"](\.\.?\/[^'"]+)['"]/g;

function findStaticImports(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const specifiers = [];
  for (const match of text.matchAll(STATIC_IMPORT_RE)) specifiers.push(match[1]);
  return specifiers;
}

function collectEagerClosure(entryPath) {
  const visited = new Map(); // sciezka bezwzgledna -> rozmiar
  const queue = [entryPath];
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    let size;
    try {
      size = statSync(current).size;
    } catch {
      console.error(`check:size: statyczny import wskazuje na nieistniejacy plik: ${current} — uruchom najpierw build.`);
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

console.log('check:size: zamkniecie statycznych importow (eager przy starcie swiata):');
for (const [path, size] of closure) console.log(`  ${path.replace(SCRIPTS_DIR, '.')} = ${size} bajtow`);
console.log(`check:size: RAZEM = ${totalSize} bajtow (budzet: ${BUDGET_BYTES} bajtow)`);

if (totalSize >= BUDGET_BYTES) {
  console.error(`check:size: PRZEKROCZONO budzet startowy — ${totalSize} >= ${BUDGET_BYTES} bajtow (ryzyko I3).`);
  process.exit(1);
}

console.log('check:size: OK — zamkniecie statycznych importow miesci sie w budzecie < 40 KB.');

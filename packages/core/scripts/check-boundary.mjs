#!/usr/bin/env node
// Ryzyko I2 / zalozenie A1: packages/core NIE MOZE znac Foundry.
// ESLint (no-restricted-globals/imports) lapie to na poziomie zrodel, ale linter
// mozna obejsc (np. globalThis['game'], eval, komentarz eslint-disable). Ten skrypt
// skanuje ZBUDOWANY bundle — ostatnie slowo, nie do obejscia bez zmiany kodu wynikowego.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIST_FILE = join(import.meta.dirname, '..', 'dist', 'index.js');
const RESTRICTED = ['game', 'ui', 'canvas', 'Hooks', 'foundry', 'CONFIG'];

let bundle;
try {
  bundle = readFileSync(DIST_FILE, 'utf8');
} catch {
  console.error(`check:boundary: nie znaleziono ${DIST_FILE} — uruchom najpierw build.`);
  process.exit(1);
}

// [KROK-17, odkrycie] Dopasowanie samego slowa (bez dostepu do wlasciwosci)
// zdarzylo sie byc FALSZYWYM alarmem: esbuild skraca WEWNETRZNE identyfikatory
// wedlug pozycji/czestosci w zasiegu, NIE wedlug tresci oryginalnej nazwy —
// zmierzone wprost, ze zupelnie niepowiazana funkcja (`isReferenceReportGreen`
// w referenceInvariants.ts) zostala zmapowana na skrocona nazwe "ui" (kolizja
// z `function ui(n) {...}` / eksportem `ui as isReferenceReportGreen`),
// calkowicie niezaleznie od jej wlasnej nazwy zrodlowej. Terser z
// `mangle.reserved` (jedyny pewny sposob, zeby minifikator NIGDY nie uzyl
// tych szesciu slow jako skroconych nazw) okazal sie niewspolpracujacy z
// tym Vite/lib-mode (mangling sie w ogole nie wlaczal, niezaleznie od opcji);
// wylaczenie identyfikatora minifikacji calkowicie ujawnia INNY, gorszy
// falszywy alarm (prawdziwe, niewinne lokalne zmienne o tych samych nazwach,
// np. `canvas` w `encodeImage.ts`, ktore normalnie minifikacja i tak by
// ukryla). Zamiast tego: PRAWDZIWE uzycie globalnego obiektu Foundry zawsze
// wyglada jak `word.cos` (dostep do wlasciwosci — `ui.notifications`,
// `game.settings`, `canvas.scene`, `Hooks.on`, `foundry.utils`, `CONFIG.Actor`
// — zaden z szesciu nigdy nie jest wywolywany bezposrednio jako funkcja w
// realnym uzyciu Foundry). Wymog kropki PO slowie odrzuca deklaracje/eksporty
// zbieznych identyfikatorow (`function ui(`, `ui as x`) bez utraty czulosci
// na faktyczne odwolania do globali.
// [KROK-34, drugie wystapienie TEGO SAMEGO falszywego alarmu co krok 17 —
// tym razem `LOWERCASE_START_RE.test(...)` z `layout/lineCluster.ts`
// przemianowane przez esbuild na "ui", zupelnie niezalezne od zrodlowej
// nazwy] Wymog kropki PO slowie (komentarz wyzej) odrzuca deklaracje/eksporty,
// ale NIE odrozniał `ui.notifications` (prawdziwa wlasciwosc Foundry) od
// `ui.test(x)`/`ui.exec(x)` (wywolanie metody NA REGEXPIE, ktory przypadkiem
// dostal skrocona nazwe pokrywajaca sie z jednym z szesciu restricted words).
// Zaden z szesciu prawdziwych globali Foundry nie ma WLASNEJ metody o nazwie
// `test`/`exec` na pierwszym poziomie (`ui.test`, `game.exec` itp. nie
// istnieja w API Foundry) — wykluczenie TYCH DWOCH konkretnych, zmierzonych
// wprost kolizji nie traci czulosci na zadne realne uzycie.
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
  console.error('check:boundary: ZNALEZIONO odwolania do Foundry w packages/core/dist/index.js:');
  for (const v of violations) {
    console.error(`  - "${v.word}": ${v.count}x`);
  }
  console.error('\nZalozenie A1 zlamane: packages/core musi byc czysta biblioteka TS bez Foundry.');
  process.exit(1);
}

console.log('check:boundary: OK — brak odwolan do Foundry w zbudowanym bundlu core.');

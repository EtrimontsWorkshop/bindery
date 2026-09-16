import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

/**
 * [KROK-37 Z1, zgloszenie uzytkownika: "nadal zle" mimo wdrozonych i
 * zweryfikowanych poprawek — dwie rundy, obie okazaly sie cache'em
 * przegladarki] `scripts/bindery.js` (jedyny wpis `esmodules` w `module.json`)
 * ma STALA nazwe MIEDZY buildami — Rollup hashuje wylacznie zaleznie
 * ladowane chunki (`ReviewScreen-*.js` itp.), nie ten glowny plik wejsciowy.
 * Zwykle odswiezenie przegladarki NIE zawsze wymusza ponowne pobranie pliku
 * o tej samej nazwie — po aktualizacji modulu uzytkownik dostaje stara
 * wersje z cache'u, bez zadnego bledu/ostrzezenia.
 *
 * [KROK-39, zgloszenie uzytkownika na zywo: "Metadata validation failed...
 * scripts/bindery.js?v=0.9.0 does not exist"] Pierwsza wersja tej naprawy
 * (parametr zapytania w `esmodules`, Krok 37) zweryfikowala WYLACZNIE
 * sciezke klienta (`<script src>` w `main.hbs`) — ale `esmodules` jest TEZ
 * walidowane po stronie SERWERA, PRZED jakimkolwiek renderowaniem HTML.
 * Zmierzone wprost w `dist/packages/package.mjs` (zainstalowany Foundry
 * v14): `PackageAssetField.initialize` sprawdza istnienie pliku na dysku
 * dla KAZDEGO wpisu `esmodules` (`mustExist: true` domyslnie), `URL.parse`
 * na wzgledna sciezke z parametrem zapytania zwraca `null` (nie jest
 * absolutnym URL-em), wiec caly string (WLACZNIE z `?v=...`) trafia jako
 * LITERALNA nazwa pliku do `Files.resolveClientPaths` — zaden plik o takiej
 * nazwie nie istnieje, stad "does not exist" przy KAZDYM starcie/liscie
 * modulow, nie tylko w przegladarce. Parametr zapytania w `esmodules` jest
 * wiec fundamentalnie niekompatybilny z walidacja Foundry, niezaleznie od
 * implementacji — nie da sie tego naprawic inaczej niz zmieniajac PODEJSCIE.
 *
 * Naprawa: wersja trafia do SAMEJ NAZWY PLIKU (`bindery-<version>.js`), nie
 * do parametru zapytania — plik o tej nazwie FAKTYCZNIE istnieje na dysku,
 * wiec walidacja serwera przechodzi, a przegladarka i tak pobiera go na
 * nowo przy kazdej zmianie wersji (inny URL, nie ten sam plik z innym
 * zapytaniem). Wersja WYLACZNIE z pola `version` w `packages/module/module.json`
 * (jedno zrodlo prawdy, bez zmian wobec Kroku 37) — czytana RAZ tutaj,
 * uzywana zarowno do nazwy pliku wyjsciowego (`build.lib.fileName` nizej),
 * jak i do przepisania wpisu `esmodules` w juz skopiowanym `dist/module.json`
 * (zrodlowy `packages/module/module.json` ma tam WCIAZ literalne
 * "scripts/bindery.js" — nietkniety, poprawiany dopiero PO viteStaticCopy).
 *
 * Hak `closeBundle`, WYLACZNIE po `viteStaticCopy` w tablicy `plugins`
 * ponizej — Rollup wywoluje `closeBundle` KAZDEGO pluginu sekwencyjnie, w
 * kolejnosci rejestracji, wiec kopia `module.json` (`viteStaticCopy`, hak
 * `writeBundle`, wewnetrznie zaimplementowany jako `closeBundle` — sprawdzone
 * w `node_modules/vite-plugin-static-copy/dist/index.js`) jest juz na dysku,
 * zanim ten kod probuje ja odczytac.
 *
 * [tools/check-size.mjs] Ta nazwa pliku NIE jest juz stala literalnie
 * "bindery.js" — `check-size.mjs` czyta prawdziwa nazwe z `dist/module.json`'s
 * `esmodules[0]` zamiast zakladac konkretny string, wiec ten sam mechanizm
 * dziala bez zmian przy kolejnych podbiciach wersji.
 */
const manifestVersion = (JSON.parse(readFileSync(join(import.meta.dirname, 'module.json'), 'utf8')) as { version: string }).version;
const esmoduleFileName = `scripts/bindery-${manifestVersion}.js`;
// [ZGŁOSZENIE na zywo po Kroku 39, "TO SELECTED nadal slabo widoczne" mimo
// DWOCH kolejnych, zweryfikowanych w kodzie poprawek koloru] `esmodules`
// dostal wersjonowana nazwe pliku w Kroku 37/39 (patrz komentarz nizej) —
// ale `styles/bindery.css` NIGDY nie dostal tego samego traktowania, mimo ze
// to DOKLADNIE ten sam mechanizm cache'u przegladarki (stala nazwa pliku
// miedzy buildami = przegladarka moze go NIGDY nie pobrac ponownie). Kazda
// zmiana w tym pliku CSS od tamtej pory mogla wygladac na "nie dziala",
// mimo ze kod na dysku byl juz poprawny — dokladnie ten sam blad co
// "scripts/bindery.js" przed Krokiem 37, tylko nigdy nie naprawiony dla CSS.
const stylesFileName = `bindery-${manifestVersion}.css`;

function fixManifestAssetPaths(): Plugin {
  return {
    name: 'bindery-fix-manifest-asset-paths',
    closeBundle() {
      const manifestPath = join(import.meta.dirname, 'dist', 'module.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { esmodules: string[]; styles: string[] };
      manifest.esmodules = manifest.esmodules.map(() => esmoduleFileName);
      manifest.styles = manifest.styles.map(() => `styles/${stylesFileName}`);
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    },
  };
}

// Wynik buildu (dist/) to samodzielny, gotowy do wdrozenia folder modulu Foundry:
// module.json na szczycie, scripts/, styles/, lang/, templates/, lib/ (assety pdf.js).
// CI pakuje dist/** wprost do module.zip (Z8). Do lokalnych testow (Z7) dist/
// jest synchronizowany do korzenia repo skryptem scripts/sync-local-module.mjs,
// bo ten wlasnie katalog repo JEST folderem modulu w lokalnej instalacji Foundry.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: 'src/main.ts',
      formats: ['es'],
      fileName: () => esmoduleFileName,
    },
    rollupOptions: {
      // pdf.js NIGDY nie jest bundlowany tutaj — @bindery/core go importuje
      // dynamicznie w runtime (ryzyko I3). Musi zostac zewnetrzny takze tutaj,
      // inaczej Vite wciagnie go do glownego chunka i zniweczy leniwe ladowanie.
      external: ['pdfjs-dist/legacy/build/pdf.mjs', '@bindery/core'],
      output: {
        // @bindery/core jest external, ale w runtime Foundry laduje go przez
        // dynamiczny import('@bindery/core') w ImportWizard/api.ts — musimy
        // przekierowac ta specyfikacje modulu na realna sciezke w dist/lib/core/.
        paths: {
          // Relatywnie do dist/scripts/bindery-<version>.js (miejsca, gdzie ten kod faktycznie
          // ladu je w przegladarce) — NIE relatywnie do zrodel. dist/lib/core/index.js
          // jest kopiowany tam przez viteStaticCopy ponizej.
          '@bindery/core': '../lib/core/index.js',
        },
        // [KROK-11, odkrycie] `ReviewScreen` (Z2) jest dynamicznie importowany
        // (I3, budzet <40KB), wiec Rollup domyslnie tworzy DODATKOWE pliki
        // chunkow w KORZENIU `dist/` (nie `dist/scripts/`) — `sync-local-module.mjs`
        // kopiuje CALY `dist/` do korzenia repo, wiec te chunki ladowaly tam
        // BEZ pokrycia ignorow ESLint (`scripts/**` itp. zaklada, ze caly kod
        // JS ląduje pod `scripts/`) — zlapane przez `npm run lint` (nie
        // `check:size`/`check:imports`, ktore mierza/skanuja co innego).
        // Wymuszenie WSZYSTKICH chunkow pod `scripts/` naprawia to u zrodla,
        // zamiast dodawac kolejny ignore wzorzec w eslint.config.js.
        chunkFileNames: 'scripts/[name]-[hash].js',
      },
    },
  },
  plugins: [
    viteStaticCopy({
      // Plugin domyslnie zachowuje pelna sciezke wzgledna globa pod dest
      // (np. dist/lang/lang/en.json) — `rename: { stripBase: true }` daje plaska kopie.
      targets: [
        { src: 'module.json', dest: '.', rename: { stripBase: true } },
        { src: 'lang/*.json', dest: 'lang', rename: { stripBase: true } },
        { src: 'styles/bindery.css', dest: 'styles', rename: { stripBase: true, name: stylesFileName } },
        { src: 'templates/*.hbs', dest: 'templates', rename: { stripBase: true } },
        // [redesign 2a] Fonty zwendorowane lokalnie (Caprasimo/Figtree/JetBrains
        // Mono) — okno musi dzialac offline, zero twardej zaleznosci od Google
        // Fonts w runtime (patrz komentarz w bindery.css przy @font-face).
        { src: 'fonts/*.woff2', dest: 'fonts', rename: { stripBase: true } },
        // [KROK-44 Z2, "jesli katalog wchodzi, licencje tez"] Teksty licencji
        // SIL OFL 1.1 dla powyzszych trzech rodzin fontow — MUSZA plynac przez
        // TEN SAM krok kopiowania co same pliki .woff2, inaczej
        // `tools/sync-local-module.mjs` (kasuje i odtwarza `fonts/` z `dist/`
        // przy kazdym lokalnym buildzie) je cicho gubi, bo nie sa czescia
        // zbudowanego wyjscia.
        { src: 'fonts/OFL-*.txt', dest: 'fonts', rename: { stripBase: true } },
        // [KROK-44 Z2, odkrycie przy koncowej weryfikacji przed publikacja]
        // `module.json`'s `license`/`readme` odwoluja sie do plikow "LICENSE"/
        // "README.md" WZGLEDEM korzenia zainstalowanego modulu (czyli
        // `packages/module/dist/**`, to samo co trafia do `module.zip`) — bez
        // tego kopiowania te odniesienia wskazywalyby donikad po instalacji.
        // `dest: '.'` z `src` WYCHODZACYM poza korzen vite (`../../LICENSE`)
        // ladowal plik obok `packages/module/` (JEDEN poziom za wysoko), NIE
        // do `dist/` — zmierzone wprost. Naprawa: kopie zrodlowe TUTAJ (ten
        // sam wzorzec co `fonts/` — zwendorowane lokalnie, nie odwolanie w gore).
        { src: 'LICENSE', dest: '.', rename: { stripBase: true } },
        { src: 'README.md', dest: '.', rename: { stripBase: true } },
        {
          src: '../../packages/core/dist/*',
          dest: 'lib/core',
          rename: { stripBase: true },
        },
        {
          src: '../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
          dest: 'lib',
          rename: { stripBase: true },
        },
        {
          // pdf.mjs samo (biblioteka glowna) — @bindery/core importuje ja
          // dynamicznie pod przepisana sciezka '../pdf.mjs' (patrz packages/core/vite.config.ts).
          src: '../../node_modules/pdfjs-dist/legacy/build/pdf.mjs',
          dest: 'lib',
          rename: { stripBase: true },
        },
        {
          src: '../../node_modules/pdfjs-dist/wasm/{openjpeg,jbig2,qcms_bg}.wasm',
          dest: 'lib/wasm',
          rename: { stripBase: true },
        },
        {
          src: '../../node_modules/pdfjs-dist/standard_fonts/*',
          dest: 'lib/standard_fonts',
          rename: { stripBase: true },
        },
      ],
    }),
    fixManifestAssetPaths(),
  ],
});

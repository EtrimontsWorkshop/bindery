import type { TextLine, LineRun } from './lineCluster.js';

/**
 * [KROK-11 Z1] Dzieli JEDNA linie na kilka "linii", gdy jej POCZATEK i/lub
 * KONIEC jest naglowkiem-etykieta srodakapitowa ("DOM MLOTOW rozpoczyna
 * akapit..." lub "...jego pozycja jestZAGROzeNIE buntu" na jednym wierszu,
 * MDD §5.2). Bez tego cala linia dostaje JEDEN `dominantFont` (ten o
 * najwiekszej liczbie znakow) i konstruktor blokow nigdy nie zobaczy granicy.
 *
 * ZASTĘPUJE dyskryminator z KROK-9 (Z1b, para rol heading<->body, zyl w
 * `semantic/blockBuilder.ts`) — na prawdziwych plikach etykieta srodakapitowa
 * czesto ma role fontu `accent`, nie `heading` (reguła Z1a z kroku 9 nadaje
 * `heading` wylacznie blokom JEDNOLINIJKOWYM i IZOLOWANYM pionowo, a etykieta
 * wewnatrz akapitu z definicji izolowana nie jest) — para rol nigdy sie nie
 * odpalala (KROK-10 kontrola reczna, Cienie str. 20 / Za_lini_wroga str. 24,
 * 68 / Wrath & Glory "drocZEniE buntu"). Nowy dyskryminator jest POZYCYJNY,
 * nie zalezy od `fontRoles` w ogole.
 *
 * [KROK-11, odkrycie — brief mowil tylko o PREFIKSIE, dane pokazaly potrzebe
 * SYMETRII] Pierwsza wersja (tylko `runs[0]`, dokladnie wg briefu) poprawnie
 * rozcinala Cienie str. 20 i Za_lini_wroga str. 24/68, ale NIE `Wrath & Glory`
 * "drocZEniE buntu" — bezposrednia inspekcja `runs` pokazala, ze ten
 * KONKRETNY przypadek ma etykiete na KONCU linii (`['CaxtonStd-Book@7.5':
 * body 52 znaki, 'CaxtonStd-Bold-SC700@19': "o" 1 znak,
 * 'CaxtonStd-Bold-SC700@13.5': "drocZEniE buntu" 15 znakow]`) — SUFIKS, nie
 * prefiks. Dyskryminator zostal wiec uogolniony symetrycznie: liczony jest
 * NAJPIERW dominujacy font CALEJ linii (po laczej liczbie znakow wsrod
 * WSZYSTKICH przebiegow), a nastepnie odcinany jest maksymalny przebieg
 * BRZEGOWY (od poczatku LUB od konca) o INNYM kluczu niz ten dominujacy, pod
 * warunkiem ze jest KROTSZY niz reszta linii. Uzycie dominanty CALEJ linii
 * (nie osobno liczonej "reszty po jednej stronie") jest kluczowe — naiwna
 * wersja liczaca dominante osobno dla kazdej strony myli sie, gdy DRUGA
 * strona linii SAMA zawiera anomalie (np. body-akcent-body: liczac dominante
 * "reszty" dla sufiksu bez wylaczenia prefiksu, akcent moze przypadkiem
 * "wygrac" z body i sprowokowac falszywe ciecie) — zweryfikowane bezposrednio
 * w testach (patrz `lineEdgeSplit.test.ts`).
 *
 * Wyroznienie w PRAWDZIWYM SRODKU zdania (otoczone dominujacym fontem z OBU
 * stron) nie jest ani prefiksem, ani sufiksem, wiec warunku nie spelnia —
 * kursywa w srodku akapitu nie rozbije bloku. Wyroznienie NA SAMYM POCZATKU
 * lub NA SAMYM KONCU linii MOZE zostac uznane za etykiete (ten sam,
 * udokumentowany i zaakceptowany kompromis co przy oryginalnym,
 * jednostronnym dyskryminatorze z briefu — realny tekst zaczynajacy/konczacy
 * sie krotkim wyroznieniem jest rzadszy niz wyroznienie w srodku, a false
 * positive tutaj to wciaz PODZIAL na dwa poprawne bloki, nie utrata tresci).
 *
 * [KROK-11, odkrycie] MUSI dzialac PRZED `splitSpanningLines`/`detectColumns`/
 * `gutterRepair.ts`, nie w `blockBuilder.ts` jak pierwotna wersja z KROK-9 —
 * na prawdziwych plikach linia z naglowkiem srodakapitowym jest CZESTO
 * jednoczesnie zaklasyfikowana jako `spanning` (szeroki bbox, wiele
 * przebiegow roznych fontow) i PRZECINA wykryta rynne (KROK-10).
 * `gutterRepair.ts` uruchomione jako pierwsze rozcina taka linie na fragmenty
 * NA PODSTAWIE `tokens` (nie `runs`) i celowo zeruje `runs` na kazdym
 * fragmencie (dokumentacja `gutterRepair.ts`: "inherited runs may be
 * invalid") — do czasu, gdy `blockBuilder.ts` probowal rozciac linie po
 * `runs`, ta informacja juz nie istniala, wiec dyskryminator nigdy sie nie
 * odpalal (zweryfikowane bezposrednio: `Za_lini_wroga.pdf` str. 24, linia
 * `p24-0-74` -> fragment `p24-0-74-gutter0` z `runs.length === 0`). Rozciecie
 * WCZESNIEJ (na surowych liniach z `lineCluster.ts`, zanim cokolwiek inne je
 * zobaczy) produkuje WEZSZE fragmenty, z ktorych ZADEN zwykle juz nie
 * przecina rynny — `gutterRepair.ts` w ogole nie musi ich dotykac.
 *
 * Kazdy fragment dostaje wlasny `dominantFont`/`fonts` (z run'u), wiec
 * nastepujacy `shouldBreak` w `blockBuilder.ts` (zmiana `fontKey`) SAM juz
 * rozdzieli fragmenty na osobne bloki — nie trzeba osobnego mechanizmu.
 *
 * [KROK-11, ZNANE OGRANICZENIE, zweryfikowane na `Cienie_posrod_mgie.pdf`
 * str. 20] "DOM MLOTOW" i "DOSKONALI DOSTAWCY" (oba z briefu) NIE sa prostymi
 * 2-3-biegowymi przypadkami brzegowymi jak Za_lini_wroga str. 24/68 czy
 * Wrath & Glory — bezposrednia inspekcja pokazala 4 (DOM MLOTOW) i 3
 * (DOSKONALI DOSTAWCY) przebiegi, gdzie etykieta lezy w SRODKU tablicy
 * `runs`, a przebiegi PO OBU jej stronach naleza do TEJ SAMEJ rodziny fontu
 * body (`MinionPro-Regular`, tylko z drobna roznica rozmiaru: @10.5 vs @10) —
 * a przy tym leza na WYRAZNIE roznych pasmach Y (nie jedna fizyczna linia,
 * tylko kilka linii/kolumn scalonych w jedna przez wczesniejszy etap
 * klastrowania). To dyskryminator BRZEGOWY z zalozenia NIE lapie (etykieta w
 * prawdziwym srodku, otoczona ta sama rodzina fontu z obu stron — dokladnie
 * przypadek, ktory ten dyskryminator ma NIE ruszac, zeby nie rozbijac
 * prawdziwych wyroznien srodzdaniowych). Naprawa wymagalaby innego sygnalu
 * (np. przerwy w pasmie Y miedzy sasiednimi przebiegami tej samej "rodziny"
 * fontu) — swiadomie NIE dodane w tym kroku (ryzyko nowych falszywych ciec),
 * pozostawione jako otwarte zadanie dla przyszlego kroku. Patrz
 * RAPORT-KROK-11.md.
 */
export function splitLineByEdgeRun(line: TextLine): TextLine[] {
  const runs = line.runs ?? [];
  if (runs.length < 2) return [line];

  const totalLength = runs.reduce((sum, r) => sum + r.text.length, 0);
  const dominantKey = dominantRunFontKey(runs);

  let prefixEnd = 0;
  while (prefixEnd < runs.length && runs[prefixEnd]!.fontKey !== dominantKey) prefixEnd++;
  const prefixLength = runs.slice(0, prefixEnd).reduce((sum, r) => sum + r.text.length, 0);
  const hasPrefix = prefixEnd > 0 && prefixEnd < runs.length && prefixLength < totalLength - prefixLength;

  let suffixStart = runs.length;
  while (suffixStart > prefixEnd && runs[suffixStart - 1]!.fontKey !== dominantKey) suffixStart--;
  const suffixLength = runs.slice(suffixStart).reduce((sum, r) => sum + r.text.length, 0);
  const hasSuffix = suffixStart < runs.length && suffixStart > 0 && suffixLength < totalLength - suffixLength;

  if (!hasPrefix && !hasSuffix) return [line];

  // Kazdy przebieg w strefie brzegowej (prefiks/sufiks) dostaje WLASNY
  // fragment (nie jeden zbiorczy) — na prawdziwych danych strefa brzegowa
  // bywa niejednorodna (Za_lini_wroga str. 24: tytul-oblique + etykieta-inny-
  // font, DWA rozne fonty w samym prefiksie) i musi zostac rozbita dalej,
  // zeby `blockBuilder.ts`'s `shouldBreak` (zmiana fontKey) zobaczyl KAZDA
  // granice. Strefa SRODKOWA (dominujaca) zostaje jednym fragmentem.
  const effectivePrefixEnd = hasPrefix ? prefixEnd : 0;
  const effectiveSuffixStart = hasSuffix ? suffixStart : runs.length;

  const groups: LineRun[][] = [];
  for (let i = 0; i < effectivePrefixEnd; i++) groups.push([runs[i]!]);
  if (effectiveSuffixStart > effectivePrefixEnd) groups.push(runs.slice(effectivePrefixEnd, effectiveSuffixStart));
  for (let i = effectiveSuffixStart; i < runs.length; i++) groups.push([runs[i]!]);

  return groups.map((group, i) => {
    const text = group.map((r) => r.text).join('');
    const bbox = group.reduce(
      (acc, r) => ({
        minX: Math.min(acc.minX, r.bbox.minX),
        minY: Math.min(acc.minY, r.bbox.minY),
        maxX: Math.max(acc.maxX, r.bbox.maxX),
        maxY: Math.max(acc.maxY, r.bbox.maxY),
      }),
      group[0]!.bbox,
    );
    const groupDominantKey = dominantRunFontKey(group);
    const fontEntry = line.fonts.find((f) => f.key === groupDominantKey) ?? line.dominantFont;
    return {
      id: `${line.id}-run${i}`,
      text,
      bbox,
      columnIndex: line.columnIndex,
      crossAxisPosition: line.crossAxisPosition,
      fonts: [fontEntry],
      dominantFont: fontEntry,
      syntheticBold: line.syntheticBold,
      runs: group,
    };
  });
}

/** Klucz fontu z najwieksza laczna liczba znakow wsrod danych przebiegow. */
function dominantRunFontKey(runs: readonly LineRun[]): string {
  const counts = new Map<string, number>();
  for (const r of runs) counts.set(r.fontKey, (counts.get(r.fontKey) ?? 0) + r.text.length);
  let best = runs[0]?.fontKey ?? '';
  let bestCount = -1;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

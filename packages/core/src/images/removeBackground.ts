import type { DecodedImage } from './normalizeDecodedImage.js';
import { featherAlpha } from './featherAlpha.js';

/**
 * [KROK-42 Z1, "token bez przezroczystosci lezy NA mapie, nie W niej"]
 * Usuwa teksturowane tlo strony wokol ilustracji przeznaczonej na token —
 * klasyczne "wypelnianie od rogow z tolerancja" z edytorow obrazu: zaklada,
 * ze WSZYSTKIE 4 rogi obrazu naleza do tla (prawie zawsze prawda dla
 * ilustracji osadzonej na stronie podrecznika — sama tresc rzadko dotyka
 * WSZYSTKICH czterech rogow naraz), rozlewa sie (BFS, nie rekurencja — zero
 * ryzyka przepelnienia stosu na duzych obrazach) po sasiednich pikselach o
 * kolorze w promieniu `tolerance` od WLASNEGO ziarna KAZDEGO rogu (cztery
 * niezalezne zrodla, nie jeden globalny kolor — tlo bywa gradientowe/z
 * winieta, jeden referencyjny kolor z jednego rogu nie pasowalby do
 * pozostalych, ten sam duch co `cropUniformMargins.ts`'s "wlasna srednia
 * linii, nie jeden globalny kolor").
 */

export interface RemoveBackgroundOptions {
  /** Maks. odchylenie kanalu RGB od koloru-ziarna (tego rogu, z ktorego rozlewa sie dany piksel), zeby piksel liczyl sie jako "to samo tlo". */
  tolerance: number;
  /** Promien wygladzenia granicy usunietego tla (patrz `featherAlpha.ts`) w pikselach. */
  featherPx: number;
  /** [zabezpieczenie] Jesli wypelnienie objeloby WIECEJ niz ten udzial calkowitej powierzchni (0-1), przerwij i NIC nie usuwaj — znaczy to, ze tlo NIE jest jednolite (obraz w wiekszosci "tlem" wg tolerancji = falszywe rozpoznanie), a nie ze token faktycznie ma tak duzo tla do usuniecia. */
  maxAreaFraction: number;
  /**
   * [ZGLOSZENIE-doklikniecie-tla Z1, "kapelusz laczacy sie z cialem tworzy
   * zamknieta kieszen tla"] Dodatkowe punkty startowe rozlewu, PONAD 4 rogi —
   * wskazane recznie przez uzytkownika piksele w obszarach tla
   * NIEPOLACZONYCH z brzegiem obrazu. Klasyczne ograniczenie kazdego
   * "wypelniania od rogow" (magic wand): obszar tla odciety od brzegu przez
   * tresc (kieszen pod rondem kapelusza, miedzy ramieniem a tulowiem) jest
   * nieosiagalny z ZADNEGO rogu, niezaleznie od tolerancji — to nie usterka
   * implementacji, tylko geometria problemu. Kazdy dodatkowy punkt rozlewa
   * sie TYM SAMYM mechanizmem/tolerancja co rogi, do WSPOLNEGO `visited` —
   * `maxAreaFraction` liczone NARASTAJACO nad SUMA wszystkich rozlan (rogi +
   * wszystkie dodatkowe punkty), nie osobno per punkt, zeby wielokrotne
   * dokliknieia nie mogly w sumie "przeciekowo" usunac wiecej niz limit
   * pozwala. Wspolrzedne poza obrazem sa pomijane (bezpieczny brak efektu, nie blad).
   * Domyslnie puste — bez zmiany dotychczasowego zachowania.
   */
  extraSeeds?: ReadonlyArray<{ x: number; y: number }>;
}

export interface RemoveBackgroundResult {
  /** Oryginal (`aborted: true`) albo obraz z usunietym tlem (alfa=0 w tle, wygladzona granica). */
  image: DecodedImage;
  /** Udzial powierzchni (0-1) faktycznie usuniety — miarodajny NAWET gdy `aborted` (pokazuje, o ile przekroczono limit). */
  removedFraction: number;
  /** `true` = `maxAreaFraction` przekroczone, `image` to NIEZMIENIONY oryginal. */
  aborted: boolean;
}

/**
 * [Skalibrowane na prawdziwym portrecie z `sample/ZewCthulhu-WRAK.pdf` (str.
 * 26, "Isaac Klein"), patrz `RAPORT-KROK-42.md` po metode] Ilustracje
 * malarskie/szkicowe (typowy styl portretow NPC w podrecznikach) czesto maja
 * MIEKKIE, stopniowo cieniowane przejscie od tla do tresci (brak ostrej
 * krawedzi) — na tym konkretnym obrazie kazda tolerancja >=16 lapala sie
 * lancuchowo przez cale zdjecie (removedFraction skakalo z ~0.40 przy
 * tolerance=12 do ~0.97 przy tolerance=16, patrz historia kalibracji ponizej)
 * i usuwala WIEKSZOSC portretu, nie tylko tlo. Plaskie/jasne tlo stron
 * podrecznika (cel tej funkcji) potrzebuje duzo mniejszej tolerancji niz
 * zakladano pierwotnie (32) — 8-12 dawalo czysty wynik (tlo usuniete, szorstka
 * malarska ramka portretu zachowana) na tym obrazie, z wyraznym urwiskiem tuz
 * powyzej. `tolerance: 10` wybrane jako srodek tego bezpiecznego plateau, z
 * zapasem po obu stronach (4 zostawialo widoczny cienki rabek tla, 16 juz
 * katastroficznie nadpisywalo tresc). `maxAreaFraction: 0.6` (bez zmian) jest
 * WLASNIE zabezpieczeniem NA WYPADEK takiego "przeciekniecia" — gdyby
 * lancuchowe rozlanie na jakims obrazie przekroczylo 60% powierzchni, funkcja
 * PRZERYWA i zwraca oryginal (patrz test "jednolite tlo... PRZERYWA").
 */
export const DEFAULT_REMOVE_BACKGROUND: RemoveBackgroundOptions = { tolerance: 10, featherPx: 2, maxAreaFraction: 0.6 };

function colorDistance(rgba: Uint8ClampedArray, idxA: number, idxB: number): number {
  const dr = rgba[idxA]! - rgba[idxB]!;
  const dg = rgba[idxA + 1]! - rgba[idxB + 1]!;
  const db = rgba[idxA + 2]! - rgba[idxB + 2]!;
  return Math.max(Math.abs(dr), Math.abs(dg), Math.abs(db));
}

/**
 * [decyzja projektowa] Tolerancja liczona wzgledem BEZPOSREDNIEGO sasiada,
 * ktory "odkryl" dany piksel (ostatni juz zaakceptowany piksel w lancuchu),
 * NIE wzgledem stalego koloru-ziarna rogu — standardowe zachowanie "magic
 * wand"/"contiguous flood" z edytorow obrazu. Tlo strony podrecznika czesto
 * ma DELIKATNY gradient/winiete (cieniowanie ku krawedziom, tekstura
 * "postarzanego papieru") — porownanie do STALEGO rogu zatrzymywaloby
 * rozlew przedwczesnie na granicy gradientu, mimo ze caly obszar to WCIAZ
 * jednolite tlo; lancuchowe porownanie pozwala na STOPNIOWY dryf koloru na
 * duzym obszarze (kazdy pojedynczy krok maly), a jednoczesnie wciaz
 * odrzuca OSTRY skok (prawdziwa krawedz ilustracji).
 */

export function removeBackground(image: DecodedImage, opts: RemoveBackgroundOptions = DEFAULT_REMOVE_BACKGROUND): RemoveBackgroundResult {
  const { width, height, rgba } = image;
  const totalPixels = width * height;
  if (totalPixels === 0) return { image, removedFraction: 0, aborted: false };

  const visited = new Uint8Array(totalPixels);
  const queue = new Int32Array(totalPixels);
  let queueHead = 0;
  let queueTail = 0;
  let removedCount = 0;

  const corners: Array<[number, number]> = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ];
  const extraSeeds = opts.extraSeeds ?? [];
  const seeds: Array<[number, number]> = [...corners, ...extraSeeds.map((s): [number, number] => [Math.round(s.x), Math.round(s.y)])];
  for (const [cx, cy] of seeds) {
    if (cx < 0 || cx >= width || cy < 0 || cy >= height) continue; // [ZGLOSZENIE-doklikniecie-tla Z1] wspolrzedna dokliknieta poza obrazem — bezpieczny brak efektu
    const seedPos = cy * width + cx;
    if (visited[seedPos]) continue; // ten sam rog/punkt moze byc juz odwiedzony przez rozlew z INNEGO ziarna (male obrazy: width lub height == 1; dokliknieie w juz-usuniety obszar)
    visited[seedPos] = 1;
    queue[queueTail++] = seedPos;
    removedCount++;
    while (queueHead < queueTail) {
      const pos = queue[queueHead++]!;
      const posIdx = pos * 4;
      const x = pos % width;
      const y = (pos - x) / width;
      const neighbors: Array<[number, number]> = [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ];
      for (const [nx, ny] of neighbors) {
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const npos = ny * width + nx;
        if (visited[npos]) continue;
        const nIdx = npos * 4;
        if (colorDistance(rgba, posIdx, nIdx) <= opts.tolerance) {
          visited[npos] = 1;
          queue[queueTail++] = npos;
          removedCount++;
        }
      }
    }
  }

  const removedFraction = removedCount / totalPixels;
  if (removedFraction > opts.maxAreaFraction) {
    return { image, removedFraction, aborted: true };
  }

  const out = new Uint8ClampedArray(rgba.length);
  out.set(rgba);
  for (let pos = 0; pos < totalPixels; pos++) {
    if (visited[pos]) out[pos * 4 + 3] = 0;
  }
  const feathered = featherAlpha({ width, height, rgba: out }, opts.featherPx);
  return { image: feathered, removedFraction, aborted: false };
}

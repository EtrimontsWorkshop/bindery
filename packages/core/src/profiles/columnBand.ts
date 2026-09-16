import type { Rect } from '../geometry.js';

/**
 * [Zmierzony na zywo blad, str. 23 "Zew Cthulhu 7ed. Wrak.pdf"] Granica sekcji
 * (przeciagana lub wyszukiwana geometrycznie po Y) nie znala kolumn — na
 * dwulamowej stronie kandydat "geometrycznie najblizszy" wybranej wysokosci
 * bywa tokenem PROZY Z SASIEDNIEJ KOLUMNY, nie naglowkiem konczacym sekcje we
 * WLASNEJ kolumnie. Zglaszajacy potwierdzil wprost, ze to NIE jest waski
 * przypadek "dwie postacie obok siebie" (odlozony jako O5 w kroku 29) — dotyczy
 * KAZDEJ strony dwulamowej, czyli normy w podrecznikach RPG.
 *
 * `findColumnBand` wyznacza pasmo X (WYLACZNIE os pozioma — kolumny w tych
 * ukladach biegna przez cala wysokosc strony, wiec Y jest nieistotny) kolumny
 * zawierajacej dany token, metoda scalania przedzialow: kazdy token to
 * przedzial `[minX, maxX]`, przedzialy stykajace sie lub nakladajace sa
 * scalane w grupy — "kolumna" to grupa zawierajaca cel. Na stronie
 * JEDNOLAMOWEJ caly tekst scala sie w JEDNA grupe (pelna szerokosc tresci) —
 * zero zmiany zachowania dla ukladow jednolamowych (oba profile referencyjne
 * tego projektu).
 *
 * Zalozenie, ktore czyni te heurystyke wiarygodna (potwierdzone na realnej
 * probce): w kazdej realnej kolumnie istnieje PRZYNAJMNIEJ jeden token
 * (typowo dlugi wiersz prozy — opis ataku, lista umiejetnosci, opis potwora)
 * na tyle szeroki, ze POKRYWA wieksze przerwy miedzy waskimi tokenami tej samej
 * kolumny (np. pojedyncze etykiety siatki cech "S ... KON ... BC" maja miedzy
 * soba przerwy szersze niz odstep miedzywyrazowy) — bez takiego "mostu" ta
 * sama kolumna moglaby sie blednie rozpasc na kilka grup. Statbloki RPG niemal
 * zawsze maja przynajmniej jeden taki wiersz (opis ataku/umiejetnosci) w tej
 * samej kolumnie co siatka, wiec zalozenie trzyma sie w praktyce.
 */
export interface ColumnBandToken {
  bbox: Rect;
}

export interface ColumnBand {
  minX: number;
  maxX: number;
}

export function findColumnBand(tokens: readonly ColumnBandToken[], targetBbox: Rect): ColumnBand | null {
  if (tokens.length === 0) return null;
  const intervals = tokens.map((t) => ({ minX: t.bbox.minX, maxX: t.bbox.maxX })).sort((a, b) => a.minX - b.minX);

  const groups: ColumnBand[] = [];
  for (const iv of intervals) {
    const last = groups.at(-1);
    if (last && iv.minX <= last.maxX) {
      last.maxX = Math.max(last.maxX, iv.maxX);
    } else {
      groups.push({ minX: iv.minX, maxX: iv.maxX });
    }
  }

  const targetCenter = (targetBbox.minX + targetBbox.maxX) / 2;
  return groups.find((g) => targetCenter >= g.minX && targetCenter <= g.maxX) ?? null;
}

/** Czy `bbox` lezy (srodkiem) wewnatrz pasma `band` — `null` band (np. brak tokenow na stronie) NIGDY nie odrzuca, bezpieczny brak dzialania zamiast falszywego odrzucenia. */
export function isWithinColumnBand(bbox: Rect, band: ColumnBand | null): boolean {
  if (!band) return true;
  const center = (bbox.minX + bbox.maxX) / 2;
  return center >= band.minX && center <= band.maxX;
}

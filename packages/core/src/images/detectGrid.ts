import type { DecodedImage } from './normalizeDecodedImage.js';

/**
 * [KROK-17, zgloszona na zywo prosba] Automatyczne wykrywanie siatki z pikseli
 * mapy — SUGESTIA do wstepnego ustawienia `GridPicker` (packages/module), NIE
 * zastapienie recznej kalibracji. MDD/krok 8 (patrz martwy `CIFScene.suggestedGrid`
 * w `cif/types.ts`) swiadomie odlozyl PELNA auto-detekcje poza MVP — to NIE jest
 * to samo: tutaj wynik to zawsze best-effort + jawna `confidence`, a decyzja
 * "czy pokazac jako wstepne wypelnienie, czy zignorowac" nalezy do wolajacego
 * (`packages/module`, polityka UI), nie do tej funkcji (fakty, nie decyzje —
 * ten sam podzial odpowiedzialnosci co `classify.ts`/`ReviewScreen`).
 *
 * Metoda: siatka VTT to REGULARNA, OKRESOWA struktura linii — nie trzeba
 * dopasowywac pojedynczych krawedzi (Hough itp.), wystarczy znalezc okresowosc
 * w PROFILU siły krawędzi. Dla kazdej osi osobno:
 * 1) policz gradient luminancji (rożnica sasiednich pikseli) i zsumuj go
 *    WZDLUZ drugiej osi -> 1D "profil" (kolumna x -> suma po y dla pionowych
 *    linii siatki, wiersz y -> suma po x dla poziomych),
 * 2) dla kazdego kandydata na okres p przeszukaj WSZYSTKIE fazy o w [0,p) i
 *    wez te, ktora maksymalizuje SREDNIA wartosc profilu w probkach
 *    o, o+p, o+2p, ... — to jednoczesnie daje okres I faze (offset) w jednym
 *    przebiegu, bez oddzielnego kroku na "znajdz przesuniecie".
 * 3) [odkrycie] probkowanie fazowe naturalnie faworyzuje WIELOKROTNOSCI
 *    prawdziwego okresu (2p, 3p... tez trafiaja co druga/trzecia linie) —
 *    zamiast brac globalne maksimum, bierzemy NAJMNIEJSZY okres, ktorego
 *    wynik jest wystarczajaco bliski maksimum (`HARMONIC_TOLERANCE`).
 *
 * Pewnosc (`confidence`) kalibrowana WSTEPNIE (brak jeszcze zestawu
 * referencyjnego realnych map ze znana siatka, w odroznieniu od progow w
 * `classify.ts`/`finalize.ts`) — do zweryfikowania na `samples/` w kolejnym
 * kroku, jesli sugestie okaza sie systematycznie za pewne/niepewne siebie.
 */

export interface GridDetectionResult {
  size: number;
  offsetX: number;
  offsetY: number;
  /** 0-1, best-effort — patrz komentarz funkcji. */
  confidence: number;
}

export interface DetectGridOptions {
  minSize?: number;
  maxSize?: number;
}

const DEFAULT_MIN_SIZE_PX = 15;
const DEFAULT_MAX_SIZE_PX = 800;

/** Ponizej tej krawedzi obrazu nie ma sensu szukac okresowosci — zbyt malo danych. */
const MIN_IMAGE_EDGE_PX = 40;

/**
 * Kandydat na okres uznajemy za "wystarczajaco dobry jak najlepszy", jesli
 * jego wynik jest >= tego ulamka najlepszego znalezionego wyniku — patrz p.3
 * komentarza funkcji `detectGrid` (odrzucanie falszywych wielokrotnosci okresu).
 */
const HARMONIC_TOLERANCE = 0.92;

interface AxisCandidate {
  period: number;
  phase: number;
  confidence: number;
}

/**
 * Znajduje najlepszy okres+faze w 1D profilu sily krawedzi. Zlozonosc: dla
 * KAZDEGO kandydata na okres `p`, suma pracy po wszystkich fazach `o` w [0,p)
 * to dokladnie `n` probek (p faz razy n/p probek kazda) — wiec CALKOWITA praca
 * to `n * (maxP-minP)`, niezalezna od tego, jak duze jest `p` samo w sobie.
 */
function findAxisPeriod(profile: Float64Array, minP: number, maxP: number): AxisCandidate | null {
  const n = profile.length;
  if (maxP <= minP || maxP >= n) return null;

  let profileMean = 0;
  for (let i = 0; i < n; i++) profileMean += profile[i]!;
  profileMean /= n;
  if (profileMean <= 0) return null; // brak jakiejkolwiek krawedzi w calym profilu — brak sygnalu

  const rangeLen = maxP - minP + 1;
  const scores = new Float64Array(rangeLen);
  const phases = new Int32Array(rangeLen);
  let bestScore = -Infinity;

  for (let p = minP; p <= maxP; p++) {
    let periodBestScore = -Infinity;
    let periodBestPhase = 0;
    for (let o = 0; o < p; o++) {
      let sum = 0;
      let count = 0;
      for (let i = o; i < n; i += p) {
        sum += profile[i]!;
        count++;
      }
      const score = sum / count;
      if (score > periodBestScore) {
        periodBestScore = score;
        periodBestPhase = o;
      }
    }
    const idx = p - minP;
    scores[idx] = periodBestScore;
    phases[idx] = periodBestPhase;
    if (periodBestScore > bestScore) bestScore = periodBestScore;
  }

  let chosenIdx = -1;
  for (let idx = 0; idx < rangeLen; idx++) {
    if (scores[idx]! >= bestScore * HARMONIC_TOLERANCE) {
      chosenIdx = idx;
      break;
    }
  }
  if (chosenIdx < 0) return null;

  // Pewnosc: jak bardzo wybrany wynik wyroznia sie na tle SREDNIEJ calego
  // profilu (poziom "szumu" krawedzi) — NIE na tle innych okresow (te sa juz
  // wykorzystane do wyboru okresu, nie do pewnosci).
  const ratio = scores[chosenIdx]! / profileMean;
  const confidence = Math.max(0, Math.min(1, (ratio - 1) / 3));

  return { period: minP + chosenIdx, phase: phases[chosenIdx]!, confidence };
}

export function detectGrid(image: DecodedImage, opts: DetectGridOptions = {}): GridDetectionResult | null {
  const { width, height, rgba } = image;
  if (width < MIN_IMAGE_EDGE_PX || height < MIN_IMAGE_EDGE_PX) return null;

  const minSize = Math.max(4, opts.minSize ?? DEFAULT_MIN_SIZE_PX);
  const maxSize = Math.min(opts.maxSize ?? DEFAULT_MAX_SIZE_PX, Math.floor(Math.min(width, height) / 3));
  if (maxSize <= minSize) return null;

  const n = width * height;
  const lum = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    // Te same wspolczynniki co `computeLuminanceStdDev` w finalize.ts — spojnosc w calym pliku.
    lum[p] = 0.3 * rgba[i]! + 0.59 * rgba[i + 1]! + 0.11 * rgba[i + 2]!;
  }

  // colProfile: sila PIONOWYCH linii siatki (gradient POZIOMY, sumowany po y).
  // rowProfile: sila POZIOMYCH linii siatki (gradient PIONOWY, sumowany po x).
  // Jeden przebieg po pikselach liczy obie na raz.
  const colProfile = new Float64Array(width);
  const rowProfile = new Float64Array(height);
  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    const prevRowOff = rowOff - width;
    for (let x = 0; x < width; x++) {
      const idx = rowOff + x;
      if (x > 0) colProfile[x]! += Math.abs(lum[idx]! - lum[idx - 1]!);
      if (y > 0) rowProfile[y]! += Math.abs(lum[idx]! - lum[prevRowOff + x]!);
    }
  }

  // [odkrycie, blad zlapany testem] `colProfile[0]`/`rowProfile[0]` sa Z DEFINICJI
  // zawsze 0 (brak sasiada z lewej/gory do odjecia) — stala "falszywa dolina"
  // w probce 0. Bez wyciecia jej faworyzuje to okresy/fazy, ktore "przez
  // przypadek" omijaja probkowanie indeksu 0 (np. falszywa WIELOKROTNOSC
  // prawdziwego okresu) nad tymi, ktore go trafiaja i przez to sa nieuczciwie
  // "kara". Przesuniecie o 1 (i dodanie 1 do zwroconej fazy) usuwa ten
  // artefakt brzegowy calkowicie.
  const colResult = findAxisPeriod(colProfile.subarray(1), minSize, Math.min(maxSize, width - 2));
  const rowResult = findAxisPeriod(rowProfile.subarray(1), minSize, Math.min(maxSize, height - 2));
  if (colResult) colResult.phase += 1;
  if (rowResult) rowResult.phase += 1;
  if (!colResult && !rowResult) return null;

  if (colResult && rowResult) {
    const larger = Math.max(colResult.period, rowResult.period);
    const smaller = Math.min(colResult.period, rowResult.period);
    const agreement = smaller / larger; // 1 = identyczne okresy na obu osiach, <1 = rozjazd
    return {
      size: Math.round((colResult.period + rowResult.period) / 2),
      offsetX: colResult.phase,
      offsetY: rowResult.phase,
      confidence: Math.min(colResult.confidence, rowResult.confidence) * agreement,
    };
  }

  // Tylko JEDNA os znalazla okresowosc — zakladamy siatke kwadratowa (typowe
  // dla map VTT) dla rozmiaru, ale brak niezaleznego potwierdzenia obnize
  // pewnosc. Offset drugiej osi zostaje 0 (neutralny, nie zgadywany z
  // niepowiazanej fazy drugiej osi).
  const only = colResult ?? rowResult!;
  return colResult
    ? { size: only.period, offsetX: only.phase, offsetY: 0, confidence: only.confidence * 0.7 }
    : { size: only.period, offsetX: 0, offsetY: only.phase, confidence: only.confidence * 0.7 };
}

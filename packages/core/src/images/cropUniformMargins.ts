import type { DecodedImage } from './normalizeDecodedImage.js';

/**
 * [na zyczenie uzytkownika, po naprawie "Wrak"] Niekt(re publikacje eksportuja
 * KAZDA strone jako JEDEN plaski raster (tlo + ilustracja + wszystko), bez
 * osobnego zasobu PDF dla samej ilustracji — potwierdzone wprost na Wrak.pdf
 * (`buildInventory`: dokladnie JEDEN `ImageEntry` na taka strone, bbox ~caly
 * MediaBox). `treatFullBleedAsContent` (classify.ts) poprawnie ujawnia taki
 * obraz jako `content`, ale samo "cale plotno" moze byc w wiekszosci pustym
 * marginesem/papierem wokol malej ilustracji (np. portret NPC w rogu) — nie da
 * sie tego rozdzielic ze STRUKTURY PDF-a (to jeden zasob, nie dwa), wiec
 * jedyna droga to analiza PIKSELI juz zdekodowanego obrazu.
 *
 * Zamierzenie EKSPERYMENTALNE i opt-in (`images.autoCropUniformMargins`,
 * patrz `schema.ts`) — to heurystyka, nie parsowanie struktury: strony gdzie
 * ilustracja wypelnia niemal cale plotno (np. rozkladowka statku, Wrak.pdf
 * str. 11) MAJA celowo NIE zostac przycięte, bo ich brzegi same w sobie sa juz
 * czescia tresci (tekstura, ramka), nie pustym marginesem — algorytm ponizej
 * jest swiadomie KONSERWATYWNY (woli NIE przycinac przy niepewnosci) z
 * dokladnie tego powodu.
 *
 * Algorytm: kazdy wiersz/kolumna dostaje wlasny wspolczynnik "nudy" (udzial
 * pikseli w promieniu `COLOR_TOLERANCE` od WLASNEJ sredniej barwy — NIE od
 * jednego globalnego koloru tla; realna ramka tej ksiazki jest
 * ROZNOKOLOROWA: ciemny "skorzany" pasek z lewej, jasny "papier" w srodku,
 * zaokraglony "zagiety rog" — pojedynczy referencyjny kolor z rogu nie
 * pasowalby do papieru gdzie indziej na tej samej krawedzi). Od kazdej
 * krawedzi przycinamy, dopoki SREDNIA KROCZACA (`WINDOW_PX` sasiednich
 * wierszy/kolumn) tego wspolczynnika trzyma sie >= `WINDOW_COVERAGE_THRESHOLD`.
 *
 * [Skalibrowane na prawdziwym Wrak.pdf, str. 25 — kluczowe odkrycie] Pojedyncze
 * ostre progowanie (wczesniejsza wersja, BEZ okna) zawodzilo na realnych
 * danych: cienkie dekoracyjne pasy dotykajace krawedzi (gorna wstazka z
 * tytulem, dolna z numerem strony, zagiety rog) maja WLASNA, choc "nudna"
 * kolorystyke, ale z widocznym tekstem/teksturą — ich WLASNE pokrycie
 * potrafi chwilowo spasc ponizej progu (np. 0.23 dokladnie na wierszu z
 * literami), mimo ze to WCIAZ dekoracja, nie prawdziwa ilustracja. Ostre
 * progowanie zatrzymywalo przycinanie na PIERWSZYM takim dolku, kilkanascie
 * pikseli od krawedzi — w praktyce prawie nic sie nie przycinalo. Portret
 * (prawdziwa tresc) daje NATOMIAST setki KOLEJNYCH wierszy/kolumn z pokryciem
 * blizej zera — usredniona w oknie wartosc odroznia "chwilowy dolek w
 * dekoracji" od "dlugi, sredni-niski odcinek prawdziwej tresci" znacznie
 * pewniej niz pojedynczy wiersz/kolumna z osobna.
 */

export interface PixelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Maks. odchylenie kanalu RGB od sredniej wiersza/kolumny, zeby piksel liczyl
 * sie jako "ten sam, nudny kolor" — toleruje szum papieru/tekstury, nie
 * toleruje krawedzi ilustracji. [Skalibrowane na prawdziwym Wrak.pdf, str. 25]
 * Pierwsza proba (18) byla drastycznie za ostra dla prawdziwego "postarzanego
 * papieru" z widocznym ziarnem/tekstura — zmierzone wprost: nawet czysto
 * dekoracyjne wiersze (skorzany pasek, pusty papier) osiagaly ledwie 22-66%
 * pokrycia przy tolerancji 18-30, a dopiero przy 45 konsekwentnie >=92%.
 * Wiersze WEWNATRZ portretu (prawdziwa tresc) zostaja mimo to WYRAZNIE nizej
 * (<=23% nawet przy tolerancji 45) — margines rozdzielczosci nadal duzy.
 */
const COLOR_TOLERANCE = 45;
/**
 * Rozmiar okna (w wierszach/kolumnach) usredniajacego wspolczynnik "nudy" —
 * patrz uzasadnienie w naglowku pliku. [Skalibrowane na Wrak.pdf str. 27/28,
 * druga iteracja] Pierwsza proba (80px) okazala sie ZA DUZA: gdy prawdziwa
 * tresc (portret) zaczyna sie wkrotce po koncu wstazki (~140px dekoracji),
 * okno 80px zaczyna "widziec" nadchodzacy krach juz DALEKO przed prawdziwa
 * granica — nawet niewielki (~15%) udzial pikseli tresci (pokrycie ~0.03,
 * niemal zero) w oknie wystarcza, zeby zaciagnac srednia ponizej progu,
 * zatrzymujac przycinanie kilkadziesiat pikseli za wczesnie (zmierzone wprost:
 * str. 27/28 zatrzymywalo sie na wierszu 108 z 1759, zamiast doprowadzic do
 * ~150-172, zostawiajac czytelny tekst wstazki w kadrze). Mniejsze okno (30px)
 * jest CIASNIEJSZE wokol biezacej pozycji — potrzebuje znacznie mniej "zapasu"
 * dobrych wierszy, zeby przetrwac chwilowy dolek (glify liter), ALE rowniez
 * duzo mniej podatne na przedwczesne zaciagniecie przez odlegly, jeszcze nie
 * dominujacy fragment prawdziwej tresci — pozwala przycinac az do ~10-25px od
 * faktycznej granicy zamiast ~65-70px za wczesnie.
 */
const WINDOW_PX = 30;
/** Prog sredniej kroczacej — patrz kalibracja przy `WINDOW_PX`. Nizszy niz pojedynczy-wiersz `ROW_UNIFORM_COVERAGE` z pierwszej (nieudanej) wersji celowo: usrednianie samo w sobie juz odfiltrowuje szum, dodatkowy zapas nie jest tu potrzebny. */
const WINDOW_COVERAGE_THRESHOLD = 0.75;
/**
 * Margines bezpieczenstwa dodany z powrotem wokol wykrytej tresci, zeby nie
 * obciac krawedzi ilustracji "na styk".
 *
 * [Zmierzone wprost na realnym zgloszeniu, Wrak.pdf str. 20 (`img_p19_1`)]
 * Pierwotna wartosc (12) byla NIEKALIBROWANA na prawdziwych danych (w
 * odroznieniu od `COLOR_TOLERANCE`/`WINDOW_PX` powyzej) — na tym obrazie
 * `topTrim` (przed doliczeniem marginesu) wychodzil na y=134, a per-wierszowe
 * pokrycie pokazuje, ze prawdziwa krawedz wstazki tytulowej "ZEW CTHULHU"
 * (razem z podwojna linia i tekstem) konczy sie okolo y=125 (ostatni wiersz
 * ponizej progu 0.75). Margines 12px cofal granice do y=122 — WCIAZ
 * WEWNATRZ wstazki — zostawiajac widoczny skrawek tekstu w eksportowanym
 * obrazie (zgloszenie: "widze tekst na obrazie"). Zmniejszone do 4px: nadal
 * chroni przed obcieciem "na styk" (cel komentarza wyzej), ale nie cofa
 * granicy tak daleko, zeby wrocic w obreb juz poprawnie wykrytej dekoracji.
 */
const PADDING_PX = 4;
/**
 * [odkrycie podczas implementacji] MUSI zgadzac sie z `MIN_ABSOLUTE_PX` w
 * `finalize.ts` (celowo NIE importowane stamtad — `finalize.ts` importuje z
 * `classify.ts`/`extract.ts`, nie odwrotnie, zeby uniknac cyklu). Bez tego
 * dolnego ograniczenia legalnie mala (ale prawdziwa) ilustracja po przycieciu
 * (np. maly portret NPC) moglaby wypasc ponizej progu, ktory `finalizeImages`
 * uzywa do odrzucania PRZYPADKOWO malych fragmentow jako 'decoration' —
 * dokladnie ten sam mechanizm, ktory MA chronic przed smieciowymi ikonami,
 * przypadkiem odrzucalby wlasnie to, co ta flaga mial ujawnic. Zmierzone
 * wprost: portret ~70x78px po samym `PADDING_PX` wypadal ponizej 100px na
 * szerokosci i wracal do 'decoration'.
 */
const MIN_OUTPUT_SIZE_PX = 100;
/** Jesli wykryta tresc to mniej niz ten udzial calkowitej powierzchni, prawdopodobnie caly obraz jest "nudny" (blad wykrywania albo faktycznie pusta strona) — bezpieczniej NIC nie przycinac niz zwrocic bezsensownie maly wycinek. */
const MIN_KEPT_FRACTION = 0.02;
/** Jesli przyciecie usunelo mniej niz ten udzial powierzchni, nie warto — prawdopodobnie strona jest wypelniona trescia niemal do krawedzi (np. rozkladowka), NIE margines do usuniecia. */
const MIN_TRIMMED_FRACTION = 0.01;

/**
 * Udzial pikseli wzdluz linii (wiersza LUB kolumny — `indexOf(i)` dostarcza
 * bajtowy offset RGBA i-tego piksela na tej linii, `count` to jej dlugosc) w
 * promieniu `COLOR_TOLERANCE` od WLASNEJ sredniej barwy TEJ linii (0..1).
 * Wspolna implementacja dla `rowCoverage`/`colCoverage` — jedyna roznica
 * miedzy wierszem a kolumna to jak przechodzi sie po pikselach.
 */
function coverageAlongLine(rgba: Uint8ClampedArray, count: number, indexOf: (i: number) => number): number {
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < count; i++) {
    const idx = indexOf(i);
    r += rgba[idx]!;
    g += rgba[idx + 1]!;
    b += rgba[idx + 2]!;
  }
  const mr = r / count;
  const mg = g / count;
  const mb = b / count;
  let matches = 0;
  for (let i = 0; i < count; i++) {
    const idx = indexOf(i);
    if (Math.abs(rgba[idx]! - mr) <= COLOR_TOLERANCE && Math.abs(rgba[idx + 1]! - mg) <= COLOR_TOLERANCE && Math.abs(rgba[idx + 2]! - mb) <= COLOR_TOLERANCE) {
      matches++;
    }
  }
  return matches / count;
}

/** Udzial pikseli wiersza `y` w promieniu `COLOR_TOLERANCE` od WLASNEJ sredniej barwy tego wiersza (0..1). */
function rowCoverage(rgba: Uint8ClampedArray, width: number, y: number): number {
  return coverageAlongLine(rgba, width, (x) => (y * width + x) * 4);
}

/** Udzial pikseli kolumny `x` w promieniu `COLOR_TOLERANCE` od WLASNEJ sredniej barwy tej kolumny (0..1). */
function colCoverage(rgba: Uint8ClampedArray, width: number, height: number, x: number): number {
  return coverageAlongLine(rgba, height, (y) => (y * width + x) * 4);
}

/**
 * Liczba poczatkowych elementow `coverages`, ktore mozna odciac — kroczy w
 * przod dopoki SREDNIA KROCZACA okna `windowSize` zaczynajacego sie w
 * biezacym miejscu nie spadnie ponizej `threshold` (patrz naglowek pliku).
 * Wywolane RAZ normalnie (przycinanie od poczatku) i RAZ na ODWROCONEJ
 * tablicy (przycinanie od konca) — jeden mechanizm zamiast dwoch symetrycznych
 * kopii.
 */
function countTrimmableFromStart(coverages: Float64Array, windowSize: number, threshold: number): number {
  const n = coverages.length;
  const w = Math.min(windowSize, n);
  if (w === 0) return 0;
  let sum = 0;
  for (let i = 0; i < w; i++) sum += coverages[i]!;
  let trimmed = 0;
  for (let i = 0; i + w <= n; i++) {
    if (sum / w < threshold) break;
    trimmed = i + 1;
    if (i + w < n) sum += coverages[i + w]! - coverages[i]!;
  }
  return trimmed;
}

function reverseArray(arr: Float64Array): Float64Array {
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[arr.length - 1 - i]!;
  return out;
}

/** Rozszerza [lo,hi] symetrycznie do co najmniej `minSize` dlugosci, clampowane do [0,totalSize-1]. */
function expandToMinSize(lo: number, hi: number, totalSize: number, minSize: number): [number, number] {
  const len = hi - lo + 1;
  if (len >= minSize) return [lo, hi];
  const growEach = Math.ceil((minSize - len) / 2);
  let newLo = lo - growEach;
  let newHi = hi + growEach;
  if (newLo < 0) {
    newHi += -newLo;
    newLo = 0;
  }
  if (newHi > totalSize - 1) {
    newLo -= newHi - (totalSize - 1);
    newHi = totalSize - 1;
  }
  return [Math.max(0, newLo), Math.min(totalSize - 1, newHi)];
}

/**
 * Wykrywa prostokat "faktycznej tresci" wewnatrz `image`, przycinajac nudne
 * (jednolite) marginesy od kazdej krawedzi. Zwraca `null`, gdy przyciecie NIE
 * jest wskazane (patrz `MIN_KEPT_FRACTION`/`MIN_TRIMMED_FRACTION` powyzej) —
 * wolajacy w tym wypadku uzywa oryginalnego obrazu bez zmian.
 */
export function detectContentBounds(image: DecodedImage): PixelBounds | null {
  const { width, height, rgba } = image;
  if (width < 8 || height < 8) return null;

  const rowCoverages = new Float64Array(height);
  for (let y = 0; y < height; y++) rowCoverages[y] = rowCoverage(rgba, width, y);
  const colCoverages = new Float64Array(width);
  for (let x = 0; x < width; x++) colCoverages[x] = colCoverage(rgba, width, height, x);

  const topTrim = countTrimmableFromStart(rowCoverages, WINDOW_PX, WINDOW_COVERAGE_THRESHOLD);
  const bottomTrim = countTrimmableFromStart(reverseArray(rowCoverages), WINDOW_PX, WINDOW_COVERAGE_THRESHOLD);
  const leftTrim = countTrimmableFromStart(colCoverages, WINDOW_PX, WINDOW_COVERAGE_THRESHOLD);
  const rightTrim = countTrimmableFromStart(reverseArray(colCoverages), WINDOW_PX, WINDOW_COVERAGE_THRESHOLD);

  let top = topTrim;
  let bottom = height - 1 - bottomTrim;
  let left = leftTrim;
  let right = width - 1 - rightTrim;

  // [bezpiecznik] Jesli przycinanie "zjadlo" caly wymiar (nic nie przetrwalo
  // jako odrebna tresc — cale plotno jednolite), NIE stosuj ponizej
  // `expandToMinSize`: rozciagnieciem zdegenerowanego punktu do
  // `MIN_OUTPUT_SIZE_PX` "znalezlibysmy" trescs tam, gdzie jej NAPRAWDE nie
  // ma. Zwroc `null` od razu, zanim padding/expansion zdazy to zamaskowac.
  if (top >= bottom || left >= right) return null;

  top = Math.max(0, top - PADDING_PX);
  left = Math.max(0, left - PADDING_PX);
  bottom = Math.min(height - 1, bottom + PADDING_PX);
  right = Math.min(width - 1, right + PADDING_PX);

  [top, bottom] = expandToMinSize(top, bottom, height, MIN_OUTPUT_SIZE_PX);
  [left, right] = expandToMinSize(left, right, width, MIN_OUTPUT_SIZE_PX);

  const w = right - left + 1;
  const h = bottom - top + 1;
  const totalArea = width * height;
  const keptFraction = (w * h) / totalArea;
  if (keptFraction < MIN_KEPT_FRACTION) return null;
  if (1 - keptFraction < MIN_TRIMMED_FRACTION) return null;

  return { x: left, y: top, width: w, height: h };
}

/** Wycina `bounds` z `image` do NOWEGO bufora RGBA (nie modyfikuje `image` w miejscu). */
export function cropDecodedImage(image: DecodedImage, bounds: PixelBounds): DecodedImage {
  const out = new Uint8ClampedArray(bounds.width * bounds.height * 4);
  for (let row = 0; row < bounds.height; row++) {
    const srcStart = ((bounds.y + row) * image.width + bounds.x) * 4;
    const destStart = row * bounds.width * 4;
    out.set(image.rgba.subarray(srcStart, srcStart + bounds.width * 4), destStart);
  }
  return { width: bounds.width, height: bounds.height, rgba: out };
}

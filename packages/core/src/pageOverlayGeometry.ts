import type { Rect } from './geometry.js';

/**
 * [KROK-11 Z3] Konwersja bboksa PDF (Y w gore) -> wspolrzedne ekranu/nakladki
 * SVG nad wyrenderowanym podgladem strony (Y w dol) — brief wprost: "napisz
 * JEDNA funkcje konwersji, przetestuj ja jednostkowo, uzywaj WYLACZNIE jej".
 * To CZWARTY wystapienie tej samej klasy bledu w projekcie (krok 4: ksztalt
 * argumentow `cm`; krok 5: `constructPath`; krok 6: `item.width` juz w
 * przestrzeni urzadzenia) — stad w `packages/core`, nie `packages/module`
 * (gdzie NIE MA infrastruktury testowej, patrz CLAUDE.md/package.json), zeby
 * dalo sie ja realnie zweryfikowac testem jednostkowym, nie tylko "na oko" w
 * przegladarce.
 */

export type PageRotation = 0 | 90 | 180 | 270;

export interface RenderedPageGeometry {
  /** Box strony w przestrzeni PDF (np. `PreviewPageHandle.box`/`Provenance` strony) — PRZED rotacja. */
  pageBox: Rect;
  /** Piksele FAKTYCZNIE wyrenderowanej bitmapy (PO uwzglednieniu rotacji, np. `EncodedImage`/`DecodedImage` z `renderPagePreview`). */
  imageWidthPx: number;
  imageHeightPx: number;
  /** `PreviewPageHandle.rotation`/`page.rotate` — 0 w OGROMNEJ wiekszosci prawdziwych PDF-ow (wszystkie 9 plikow `samples/` tego projektu). */
  rotation: PageRotation;
}

/**
 * Pojedynczy punkt PDF -> piksel ekranu (0,0 = lewy-gorny róg wyrenderowanej
 * bitmapy, Y rosnie w DOL — konwencja DOM/canvas/SVG).
 *
 * [WERYFIKACJA] Przypadek `rotation === 0` jest w pelni pokryty testami
 * jednostkowymi (`pageOverlayGeometry.test.ts`) na wprost policzonych
 * przykladach. Przypadki `90`/`180`/`270` maja formuly wyprowadzone z tego
 * samego modelu (odbicie Y, potem obrot zgodny z konwencja `page.rotate`
 * pdf.js — obrot TRESCI zgodnie z ruchem wskazowek zegara), ale ze wzgledu na
 * brak w `samples/` (gitignored, R1) ani jednego realnego pliku z rotacja !=
 * 0 NIE zostaly zweryfikowane wizualnie na prawdziwej stronie — oznaczone
 * jako "do potwierdzenia przy pierwszym realnym przypadku" w RAPORT-KROK-11.md.
 */
export function pdfPointToScreen(x: number, y: number, page: RenderedPageGeometry): [number, number] {
  const { pageBox, imageWidthPx, imageHeightPx, rotation } = page;
  const pageWidth = pageBox.maxX - pageBox.minX;
  const pageHeight = pageBox.maxY - pageBox.minY;
  if (pageWidth <= 0 || pageHeight <= 0) return [0, 0];

  // Normalizacja wzgledem lewego-DOLNEGO rogu strony, wciaz w ukladzie PDF (Y w gore).
  const nx = x - pageBox.minX;
  const nyUp = y - pageBox.minY;
  // JEDYNE miejsce odbicia osi Y w calym module — PDF Y-w-gore -> ekran Y-w-dol, PRZED rotacja.
  const nyDown = pageHeight - nyUp;

  let rx: number;
  let ry: number;
  let outW: number;
  let outH: number;
  switch (rotation) {
    case 0:
      rx = nx;
      ry = nyDown;
      outW = pageWidth;
      outH = pageHeight;
      break;
    case 90:
      rx = pageHeight - nyDown;
      ry = nx;
      outW = pageHeight;
      outH = pageWidth;
      break;
    case 180:
      rx = pageWidth - nx;
      ry = pageHeight - nyDown;
      outW = pageWidth;
      outH = pageHeight;
      break;
    case 270:
      rx = nyDown;
      ry = pageWidth - nx;
      outW = pageHeight;
      outH = pageWidth;
      break;
  }

  const scaleX = outW > 0 ? imageWidthPx / outW : 0;
  const scaleY = outH > 0 ? imageHeightPx / outH : 0;
  return [rx * scaleX, ry * scaleY];
}

/** Bbox PDF -> bbox ekranu — bierze WSZYSTKIE 4 rogi przez `pdfPointToScreen` i liczy otoczke, wiec dziala poprawnie niezaleznie od rotacji (bez osobnej formuly min/max per przypadek). */
export function pdfRectToScreen(rect: Rect, page: RenderedPageGeometry): Rect {
  const corners: Array<[number, number]> = [
    [rect.minX, rect.minY],
    [rect.maxX, rect.minY],
    [rect.minX, rect.maxY],
    [rect.maxX, rect.maxY],
  ];
  const screenCorners = corners.map(([x, y]) => pdfPointToScreen(x, y, page));
  const xs = screenCorners.map((p) => p[0]);
  const ys = screenCorners.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/**
 * [KROK-18, "Zaznacz i wytnij"] ODWROTNOSC `pdfPointToScreen` — piksel ekranu
 * (nakladki nad wyrenderowanym podgladem strony) -> punkt PDF. Potrzebne, gdy
 * uzytkownik SAM rysuje bbox myszka (nie odczytujemy juz istniejacego
 * `provenance.bbox`, jak `pdfRectToScreen`, tylko idziemy w druga strone).
 * Wyprowadzone algebraicznie z `pdfPointToScreen` (odwrocenie kolejnosci:
 * naprzod skalowanie -> rotacja -> odbicie Y -> przesuniecie, tutaj w
 * odwrotnej kolejnosci) — TA SAMA funkcja uzywana w obie strony (naglowek
 * pliku: "napisz JEDNA funkcje konwersji... uzywaj WYLACZNIE jej", tu
 * analogicznie jedna funkcja per kierunek, nie duplikat logiki rotacji).
 */
export function screenPointToPdf(screenX: number, screenY: number, page: RenderedPageGeometry): [number, number] {
  const { pageBox, imageWidthPx, imageHeightPx, rotation } = page;
  const pageWidth = pageBox.maxX - pageBox.minX;
  const pageHeight = pageBox.maxY - pageBox.minY;
  if (pageWidth <= 0 || pageHeight <= 0) return [pageBox.minX, pageBox.minY];

  const outW = rotation === 90 || rotation === 270 ? pageHeight : pageWidth;
  const outH = rotation === 90 || rotation === 270 ? pageWidth : pageHeight;
  const rx = imageWidthPx > 0 ? screenX * (outW / imageWidthPx) : 0;
  const ry = imageHeightPx > 0 ? screenY * (outH / imageHeightPx) : 0;

  let nx: number;
  let nyDown: number;
  switch (rotation) {
    case 0:
      nx = rx;
      nyDown = ry;
      break;
    case 90:
      nyDown = pageHeight - rx;
      nx = ry;
      break;
    case 180:
      nx = pageWidth - rx;
      nyDown = pageHeight - ry;
      break;
    case 270:
      nyDown = rx;
      nx = pageWidth - ry;
      break;
  }

  const nyUp = pageHeight - nyDown;
  return [nx + pageBox.minX, nyUp + pageBox.minY];
}

/** Bbox ekranu -> bbox PDF — mirror `pdfRectToScreen` (4 rogi przez `screenPointToPdf`, otoczka), robuste niezaleznie od rotacji. */
export function screenRectToPdf(rect: Rect, page: RenderedPageGeometry): Rect {
  const corners: Array<[number, number]> = [
    [rect.minX, rect.minY],
    [rect.maxX, rect.minY],
    [rect.minX, rect.maxY],
    [rect.maxX, rect.maxY],
  ];
  const pdfCorners = corners.map(([x, y]) => screenPointToPdf(x, y, page));
  const xs = pdfCorners.map((p) => p[0]);
  const ys = pdfCorners.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/**
 * [zgloszenie uzytkownika, "Zaznacz i wytnij" — mozliwosc obrocenia
 * zaznaczonego obszaru] Prostokat, ktory NIE jest rownolegly do osi —
 * srodek + wymiary WLASNE (przed obrotem) + kat. `rotationRad` to kat OSI
 * "szerokosci" (lokalny +X) wzgledem dodatniej osi X danego ukladu
 * wspolrzednych, W KONWENCJI TEGO ukladu (Y w dol dla `screen`, radiany).
 */
export interface RotatedRect {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  rotationRad: number;
}

/**
 * [zgloszenie uzytkownika] Prostokat obrocony (ekran) -> prostokat obrocony
 * (PDF) — NIE robi WLASNEJ, osobnej algebry na kacie (zaden nowy powod do
 * pomylenia znaku/kierunku obrotu): liczy 4 rogi prostokata w PRZESTRZENI
 * EKRANU (zwykla geometria), przepuszcza KAZDY z osobna przez JUZ dowiedziony
 * `screenPointToPdf` (ta sama funkcja co `screenRectToPdf` powyzej — dziala
 * poprawnie niezaleznie od rotacji STRONY), a srodek/wymiary/kat w przestrzeni
 * PDF wyprowadza z POZYCJI przeksztalconych rogow (srodek = srednia rogow,
 * szerokosc/wysokosc = odleglosci miedzy sasiednimi rogami, kat = `atan2`
 * wektora jednej z krawedzi) — DOKLADNIE ten sam wzorzec, co juz dowiedziony
 * `rotateAndCropImage` (`rotateCrop.ts`) uzywa PO stronie ekstrakcji pikseli:
 * "wyprowadz kat z PRAWDZIWYCH, juz przeksztalconych punktow", nigdy z
 * osobnej, recznie odwracanej formuly na sam kat.
 *
 * Zaklada JEDNORODNA skale (ten sam wspolczynnik piksele/punkt w X i Y) —
 * prawdziwe dla KAZDEGO podgladu strony w tym projekcie (nigdy nie
 * rozciagamy podgladu anizotropowo) — inaczej obrocony prostokat w ekranie
 * mapowalby sie na rownolegloscian (nie prostokat) w przestrzeni PDF.
 */
export function screenRotatedRectToPdf(rect: RotatedRect, page: RenderedPageGeometry): RotatedRect {
  const hw = rect.width / 2;
  const hh = rect.height / 2;
  const cos = Math.cos(rect.rotationRad);
  const sin = Math.sin(rect.rotationRad);
  const localCorners: Array<[number, number]> = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
  const screenCorners = localCorners.map(([lx, ly]): [number, number] => [rect.centerX + lx * cos - ly * sin, rect.centerY + lx * sin + ly * cos]);
  const pdfCorners = screenCorners.map(([x, y]) => screenPointToPdf(x, y, page));

  const centerX = pdfCorners.reduce((sum, p) => sum + p[0], 0) / 4;
  const centerY = pdfCorners.reduce((sum, p) => sum + p[1], 0) / 4;
  const [p0, p1, p2] = pdfCorners as [[number, number], [number, number], [number, number], [number, number]];
  const width = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  const height = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  const rotationRad = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);

  return { centerX, centerY, width, height, rotationRad };
}

/**
 * Otoczka (bbox rownolegly do osi) obroconego prostokata — CZYSTA geometria,
 * niezalezna od ukladu (dziala identycznie dla `screen` i `pdf`, jedyna
 * roznica miedzy nimi to kierunek osi Y, ktory nie wplywa na sama otoczke).
 * Uzywana przez `ReviewScreen.ts`, zeby zapisac `CIFImage.provenance.bbox`
 * (ZAWSZE rownolegle do osi w calym projekcie) dla recznie obroconego
 * wyciecia — jedno miejsce na wzorzec "4 rogi z lokalnych wspolrzednych
 * przez obrot, potem min/max", zamiast n-tej kopii tej samej algebry (patrz
 * `renderRotatedRegion.ts`, gdzie ten sam wzorzec juz wystepuje).
 */
export function rotatedRectBounds(rect: RotatedRect): Rect {
  const hw = rect.width / 2;
  const hh = rect.height / 2;
  const cos = Math.cos(rect.rotationRad);
  const sin = Math.sin(rect.rotationRad);
  const localCorners: Array<[number, number]> = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
  const worldCorners = localCorners.map(([lx, ly]): [number, number] => [rect.centerX + lx * cos - ly * sin, rect.centerY + lx * sin + ly * cos]);
  const xs = worldCorners.map((p) => p[0]);
  const ys = worldCorners.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

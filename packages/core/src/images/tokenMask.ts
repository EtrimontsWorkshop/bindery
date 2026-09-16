import type { DecodedImage } from './normalizeDecodedImage.js';
import { featherAlpha } from './featherAlpha.js';

/**
 * [KROK-42 Z2, "maska: kolo, kwadrat, zaokraglony kwadrat, heks"] Ksztalty
 * wyznaczone jako CZYSTA geometria (test "czy punkt jest w srodku" na
 * znormalizowanych wspolrzednych `[-1,1] x [-1,1]`, srodek plotna = (0,0)),
 * NIE canvas clip-path — ta sama filozofia co reszta `packages/core`
 * ("zero-DOM", testowalne bez przegladarki/Node canvasu). `square` to
 * swiadomie "brak maskowania" (cale kwadratowe plotno) — jeden z czterech
 * rownorzednych wyborow z tabeli briefu, nie przypadek szczegolny.
 */
export type TokenMaskShape = 'circle' | 'square' | 'roundedSquare' | 'hex';

/** Promien naroza `roundedSquare`, wzgledem polowy boku (1.0) — 22% daje wyraznie zaokraglony, ale wciaz "kwadratowy" ksztalt (nie zblizajacy sie do kola). */
const ROUNDED_SQUARE_CORNER_RADIUS = 0.22;

function isInsideRoundedSquare(nx: number, ny: number): boolean {
  const r = ROUNDED_SQUARE_CORNER_RADIUS;
  const dx = Math.max(Math.abs(nx) - (1 - r), 0);
  const dy = Math.max(Math.abs(ny) - (1 - r), 0);
  return dx * dx + dy * dy <= r * r;
}

/**
 * Szesciokat foremny "flat-top" (plaskie krawedzie gora/dol, ostre
 * wierzcholki lewo/prawo), promien opisany (do wierzcholkow) = 1 — dotyka
 * lewej/prawej krawedzi plotna, zostawia margines gora/dol (naturalne
 * proporcje szesciokata, nie da sie dotknac wszystkich 4 krawedzi kwadratu
 * naraz regularnym szesciokatem).
 *
 * Standardowy test polplaszczyznowy: punkt jest w szesciokacie foremnym
 * (promien opisany R, N=6 bokow) dokladnie wtedy, gdy dla KAZDEJ z 6
 * krawedzi jego rzut na kierunek normalnej tej krawedzi nie przekracza
 * apotemu (promienia wpisanego, `R*cos(pi/N)`). Z symetrii wystarcza
 * sprawdzic 3 z 6 normalnych (przeciwlegle krawedzie daja ten sam warunek
 * po `Math.abs`).
 */
function isInsideHexagon(nx: number, ny: number): boolean {
  const circumradius = 1;
  const apothem = circumradius * Math.cos(Math.PI / 6);
  for (let k = 0; k < 3; k++) {
    const theta = (k + 0.5) * (Math.PI / 3); // 30°, 90°, 150°
    const proj = nx * Math.cos(theta) + ny * Math.sin(theta);
    if (Math.abs(proj) > apothem) return false;
  }
  return true;
}

/** Czy znormalizowany punkt `(nx, ny)` (srodek plotna = (0,0), krawedzie plotna = ±1) lezy wewnatrz `shape`. */
export function isInsideShape(shape: TokenMaskShape, nx: number, ny: number): boolean {
  switch (shape) {
    case 'square':
      return true;
    case 'circle':
      return nx * nx + ny * ny <= 1;
    case 'roundedSquare':
      return isInsideRoundedSquare(nx, ny);
    case 'hex':
      return isInsideHexagon(nx, ny);
  }
}

/**
 * Nakłada `shape` na KWADRATOWY `image` (wolajacy odpowiada za wczesniejsze
 * przyciecie/przeskalowanie do kwadratu — `applyTokenMask` samo NIE kadruje)
 * — mnozy alfa kazdego piksela przez 0 (poza ksztaltem) albo 1 (wewnatrz),
 * potem wygladza granice `featherAlpha` (WSPOLNA funkcja z `removeBackground.ts`
 * — ten sam powod: rozmycie jednolitego obszaru nie zmienia go, wiec efekt
 * jest widoczny WYLACZNIE w waskim pasmie granicy ksztaltu).
 */
export function applyTokenMask(image: DecodedImage, shape: TokenMaskShape, featherPx: number): DecodedImage {
  const { width, height, rgba } = image;
  const out = new Uint8ClampedArray(rgba.length);
  out.set(rgba);
  const halfW = width / 2;
  const halfH = height / 2;
  for (let y = 0; y < height; y++) {
    // Srodek PIKSELA (y+0.5), nie jego rog — spojne z konwencja "calkowita
    // wspolrzedna = srodek piksela" uzywana wszedzie indziej w tym projekcie
    // (`sampleBilinear` w `rotateCrop.ts`).
    const ny = (y + 0.5 - halfH) / halfH;
    for (let x = 0; x < width; x++) {
      const nx = (x + 0.5 - halfW) / halfW;
      if (!isInsideShape(shape, nx, ny)) {
        out[(y * width + x) * 4 + 3] = 0;
      }
    }
  }
  return featherAlpha({ width, height, rgba: out }, featherPx);
}

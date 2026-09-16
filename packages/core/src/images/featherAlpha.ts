import type { DecodedImage } from './normalizeDecodedImage.js';

/**
 * [KROK-42 Z1/Z2, "wygladzenie krawedzi, zeby nie bylo postrzepionej sylwetki"]
 * Rozmycie WYLACZNIE kanalu alfa (RGB bez zmian) — separowalny box blur
 * (przebieg poziomy, potem pionowy na wyniku pierwszego) zamiast pelnego
 * kwadratowego jadra: O(width*height*radius) zamiast O(width*height*radius^2),
 * bezpieczne dla obrazow liczonych w milionach pikseli.
 *
 * Wspolna dla DWOCH miejsc, ktore inaczej duplikowalyby TEN SAM box-blur:
 * `removeBackground.ts` (Z1, wygladza granice miedzy usunietym tlem a
 * zachowana trescia) i `tokenMask.ts` (Z2, wygladza twardy geometryczny brzeg
 * maski koła/kwadratu-zaokraglonego/heksu).
 *
 * Daleko od jakiejkolwiek granicy alfa jest juz jednolita (0 albo 255) —
 * rozmycie jednolitego obszaru samo w sobie nie zmienia wartosci (srednia z
 * samych zer to zero, srednia z samych 255 to 255), wiec efekt jest
 * WYLACZNIE widoczny w waskim pasmie wokol faktycznych krawedzi, bez potrzeby
 * osobnego wykrywania "gdzie jest granica".
 */
export function featherAlpha(image: DecodedImage, radiusPx: number): DecodedImage {
  const r = Math.round(radiusPx);
  if (r <= 0) return { width: image.width, height: image.height, rgba: image.rgba.slice() };
  const { width, height, rgba } = image;

  const alpha = new Float64Array(width * height);
  for (let i = 0; i < width * height; i++) alpha[i] = rgba[i * 4 + 3]!;

  const horizontal = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let dx = -r; dx <= r; dx++) {
        const xi = x + dx;
        if (xi < 0 || xi >= width) continue;
        sum += alpha[rowStart + xi]!;
        count++;
      }
      horizontal[rowStart + x] = sum / count;
    }
  }

  const out = new Uint8ClampedArray(rgba.length);
  out.set(rgba);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let sum = 0;
      let count = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yi = y + dy;
        if (yi < 0 || yi >= height) continue;
        sum += horizontal[yi * width + x]!;
        count++;
      }
      const idx = (y * width + x) * 4 + 3;
      out[idx] = Math.round(sum / count);
    }
  }

  return { width, height, rgba: out };
}

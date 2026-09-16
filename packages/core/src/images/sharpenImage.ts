import type { DecodedImage } from './normalizeDecodedImage.js';

/**
 * [KROK-42 Z4, "wyostrzanie — tanie, dorzucone przy okazji"] Standardowa maska
 * wyostrzajaca (unsharp mask): rozmyj obraz (box blur, maly promien —
 * wylapuje TYLKO wysokie czestotliwosci/detale, nie ogolna kompozycje),
 * odejmij rozmyty od oryginalu (to, co rozmycie "zgubilo" = detal), dodaj z
 * powrotem do oryginalu wazone `amount`. Dziala WYLACZNIE na R/G/B — alfa
 * (przezroczystosc z maski/usunietego tla) bez zmian, tak jak `brightenImage.ts`.
 *
 * [kalibracja, patrz RAPORT-KROK-42.md] Najbardziej widoczne na mapach
 * bitmapowych przeskalowanych w gore (brief) — parametry dobrane na
 * portretach/ilustracjach z `sample/ZewCthulhu-WRAK.pdf`.
 */

export interface SharpenOptions {
  /** Promien box-bluru uzytego do wykrycia detalu (px). Wiekszy = "grubszy" wyostrzony detal. */
  radiusPx: number;
  /** Sila wzmocnienia — 0 brak zmiany, typowo 0.3-1.0. Wyzej = mocniejszy efekt, ale i mocniejsze halo/szum. */
  amount: number;
}

export const DEFAULT_SHARPEN: SharpenOptions = { radiusPx: 1, amount: 0.5 };

/** Separowalny box blur (poziomy przebieg, potem pionowy) NA KANALACH R/G/B — alfa pomijana. */
function boxBlurRgb(rgba: Uint8ClampedArray, width: number, height: number, radius: number): Float64Array {
  const channels = 3;
  const src = new Float64Array(width * height * channels);
  for (let i = 0; i < width * height; i++) {
    src[i * channels] = rgba[i * 4]!;
    src[i * channels + 1] = rgba[i * 4 + 1]!;
    src[i * channels + 2] = rgba[i * 4 + 2]!;
  }

  const horizontal = new Float64Array(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let count = 0;
      for (let dx = -radius; dx <= radius; dx++) {
        const xi = x + dx;
        if (xi < 0 || xi >= width) continue;
        const idx = (y * width + xi) * channels;
        sumR += src[idx]!;
        sumG += src[idx + 1]!;
        sumB += src[idx + 2]!;
        count++;
      }
      const outIdx = (y * width + x) * channels;
      horizontal[outIdx] = sumR / count;
      horizontal[outIdx + 1] = sumG / count;
      horizontal[outIdx + 2] = sumB / count;
    }
  }

  const out = new Float64Array(src.length);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let count = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const yi = y + dy;
        if (yi < 0 || yi >= height) continue;
        const idx = (yi * width + x) * channels;
        sumR += horizontal[idx]!;
        sumG += horizontal[idx + 1]!;
        sumB += horizontal[idx + 2]!;
        count++;
      }
      const outIdx = (y * width + x) * channels;
      out[outIdx] = sumR / count;
      out[outIdx + 1] = sumG / count;
      out[outIdx + 2] = sumB / count;
    }
  }
  return out;
}

export function sharpenImage(image: DecodedImage, opts: SharpenOptions = DEFAULT_SHARPEN): DecodedImage {
  const { width, height, rgba } = image;
  if (opts.radiusPx <= 0 || opts.amount <= 0) return { width, height, rgba: rgba.slice() };

  const blurred = boxBlurRgb(rgba, width, height, Math.round(opts.radiusPx));
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < 3; c++) {
      const original = rgba[i * 4 + c]!;
      const blur = blurred[i * 3 + c]!;
      out[i * 4 + c] = Math.max(0, Math.min(255, Math.round(original + opts.amount * (original - blur))));
    }
    out[i * 4 + 3] = rgba[i * 4 + 3]!;
  }
  return { width, height, rgba: out };
}

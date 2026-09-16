import type { DecodedImage } from './normalizeDecodedImage.js';
import { isInsideShape, type TokenMaskShape } from './tokenMask.js';

/**
 * [KROK-42 Z3, "ramki"] Dwie sciezki: wbudowany jednolity pierscien (kilka
 * grubosci, kolor konfigurowalny — "nie buduj biblioteki ozdobnych ramek, to
 * praca graficzna" z briefu), oraz zlozenie z wlasna, wgrana ramka
 * (przezroczysty PNG/WebP tego samego rozmiaru co token).
 */

export interface BuiltInFrameOptions {
  shape: TokenMaskShape;
  /** Grubosc pierscienia jako udzial promienia/polowy boku plotna (0-1). */
  thicknessNorm: number;
  color: readonly [number, number, number];
}

/**
 * Pierscien narysowany TUZ WEWNATRZ granicy `shape` — pasmo miedzy zewnetrzna
 * granica ksztaltu (skala 1) a jej WEWNETRZNA kopia (skala `1-thicknessNorm`).
 * Testowanie "czy punkt jest w skurczonym ksztalcie" bez osobnej geometrii per
 * ksztalt: przeskalowanie PUNKTU o `1/(1-thicknessNorm)` przed testem
 * `isInsideShape` jest matematycznie rownowazne przeskalowaniu SAMEGO
 * ksztaltu w dol (jednorodne skalowanie) — dziala jednakowo dla wszystkich
 * czterech ksztaltow z `tokenMask.ts` bez zadnej dodatkowej algebry.
 * Nadpisuje WYLACZNIE RGB w pasmie (alfa nietkniete — pierscien pojawia sie
 * tylko tam, gdzie maska juz uczynila piksel widocznym).
 */
export function applyBuiltInFrame(image: DecodedImage, opts: BuiltInFrameOptions): DecodedImage {
  const { width, height, rgba } = image;
  const out = new Uint8ClampedArray(rgba.length);
  out.set(rgba);
  const halfW = width / 2;
  const halfH = height / 2;
  const innerScale = 1 - opts.thicknessNorm;
  const [r, g, b] = opts.color;
  for (let y = 0; y < height; y++) {
    const ny = (y + 0.5 - halfH) / halfH;
    for (let x = 0; x < width; x++) {
      const nx = (x + 0.5 - halfW) / halfW;
      if (!isInsideShape(opts.shape, nx, ny)) continue;
      const insideInner = innerScale > 0 && isInsideShape(opts.shape, nx / innerScale, ny / innerScale);
      if (insideInner) continue;
      const idx = (y * width + x) * 4;
      out[idx] = r;
      out[idx + 1] = g;
      out[idx + 2] = b;
    }
  }
  return { width, height, rgba: out };
}

/**
 * Zlozenie standardowe Porter-Duff "source over destination": `frame` (wlasna
 * wgrana ramka, przezroczysty PNG/WebP) NAD `image` (juz gotowy token) — OBA
 * MUSZA miec ten sam rozmiar (wolajacy skaluje ramke do rozmiaru tokenu
 * PRZED wywolaniem, ta funkcja tego nie robi — jedna odpowiedzialnosc).
 */
export function compositeCustomFrame(image: DecodedImage, frame: DecodedImage): DecodedImage {
  if (frame.width !== image.width || frame.height !== image.height) {
    throw new Error(`compositeCustomFrame: rozmiar ramki (${frame.width}x${frame.height}) musi zgadzac sie z rozmiarem tokenu (${image.width}x${image.height})`);
  }
  const out = new Uint8ClampedArray(image.rgba.length);
  for (let i = 0; i < image.rgba.length; i += 4) {
    const srcA = frame.rgba[i + 3]! / 255;
    const dstA = image.rgba[i + 3]! / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA <= 0) {
      out[i] = 0;
      out[i + 1] = 0;
      out[i + 2] = 0;
      out[i + 3] = 0;
      continue;
    }
    for (let c = 0; c < 3; c++) {
      out[i + c] = Math.round((frame.rgba[i + c]! * srcA + image.rgba[i + c]! * dstA * (1 - srcA)) / outA);
    }
    out[i + 3] = Math.round(outA * 255);
  }
  return { width: image.width, height: image.height, rgba: out };
}

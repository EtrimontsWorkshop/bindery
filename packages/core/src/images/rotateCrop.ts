import type { DecodedImage } from './normalizeDecodedImage.js';

/**
 * [zgloszenie uzytkownika, "Zaznacz i wytnij" — mozliwosc obrocenia
 * zaznaczonego obszaru] Czysta, testowalna funkcja PIKSELOWA (zero canvasu —
 * dziala identycznie w Node/testach i w przegladarce, ten sam powod co
 * `normalizeDecodedImage.ts`/`brightenImage.ts`): dla kazdego piksela
 * WYJSCIOWEGO oblicza, SKAD w obrazie ZRODLOWYM go wziac (mapowanie
 * ODWROTNE — "gdzie w zrodle lezy ten piksel wyjscia", nie "gdzie w wyjsciu
 * ladowac ten piksel zrodla" — jedyny sposob, zeby KAZDY piksel wyjscia byl
 * wypelniony, bez dziur, niezaleznie od kata).
 *
 * `rotationRad` to kat WLASNEJ osi "szerokosci" zaznaczenia (lokalny +X),
 * zmierzony w przestrzeni PIKSELI OBRAZU ZRODLOWEGO (Y w dol, jak wszedzie w
 * DOM/canvas) — WOLAJACY (patrz `renderRotatedRegion.ts`) wylicza go z
 * PRAWDZIWYCH, juz przeksztalconych rogow prostokata, nigdy z osobnego,
 * recznie odwracanego znaku katu (ten sam powod co `pageOverlayGeometry.ts`:
 * "napisz JEDNA funkcje konwersji, uzywaj WYLACZNIE jej" — tu odpowiednik to
 * "wyprowadz kat z PRAWDZIWYCH punktow, nigdy nie zgaduj znaku").
 *
 * Dwuliniowa interpolacja (nie najblizszy sasiad) — kazdy inny kat niz
 * wielokrotnosc 90° inaczej dawalby widocznie postrzepione krawedzie na
 * finalnym, uzywanym jako scena/token obrazie.
 */
export interface RotateAndCropOptions {
  /** Srodek wycinanego obszaru, we WSPOLRZEDNYCH PIKSELI obrazu zrodlowego. */
  centerX: number;
  centerY: number;
  /** Docelowe wymiary wyniku w pikselach (rozmiar zaznaczenia PO ewentualnym skalowaniu do docelowej rozdzielczosci, PRZED obrotem). */
  outputWidth: number;
  outputHeight: number;
  /** Radiany — patrz komentarz przy funkcji. */
  rotationRad: number;
  /**
   * [KROK-42 Z2, "kadrowanie i zoom wewnatrz maski tokenu"] Ile pikseli
   * ZRODLA odpowiada JEDNEMU pikselowi WYJSCIA — >1 ODDALA (widac WIECEJ
   * zrodla, mniej szczegolu na piksel wyjscia), <1 PRZYBLIZA (zoom).
   * Domyslnie 1 (bez zmiany skali) — PELNA wsteczna zgodnosc z
   * dotychczasowym zachowaniem (`renderRotatedRegion.ts` i wszystkie
   * istniejace testy nigdy nie zoomuja, tylko kadruja+obracaja w skali 1:1).
   * Jednorodne skalowanie KOMUTUJE z obrotem (ten sam wspolczynnik w obu
   * osiach), wiec kolejnosc "przeskaluj potem obroc" i "obroc potem
   * przeskaluj" dają identyczny wynik — stosowane PRZED obrotem ponizej,
   * zero dodatkowej algebry na samym kacie.
   */
  scale?: number;
}

function sampleBilinear(source: DecodedImage, x: number, y: number): [number, number, number, number] {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const fx = x - x0;
  const fy = y - y0;
  const get = (xi: number, yi: number): [number, number, number, number] => {
    if (xi < 0 || yi < 0 || xi >= source.width || yi >= source.height) return [0, 0, 0, 0];
    const idx = (yi * source.width + xi) * 4;
    return [source.rgba[idx]!, source.rgba[idx + 1]!, source.rgba[idx + 2]!, source.rgba[idx + 3]!];
  };
  const c00 = get(x0, y0);
  const c10 = get(x1, y0);
  const c01 = get(x0, y1);
  const c11 = get(x1, y1);
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const top = lerp(c00[i]!, c10[i]!, fx);
    const bottom = lerp(c01[i]!, c11[i]!, fx);
    out[i] = lerp(top, bottom, fy);
  }
  return out;
}

export function rotateAndCropImage(source: DecodedImage, opts: RotateAndCropOptions): DecodedImage {
  const outW = Math.max(1, Math.round(opts.outputWidth));
  const outH = Math.max(1, Math.round(opts.outputHeight));
  const rgba = new Uint8ClampedArray(outW * outH * 4);
  const cos = Math.cos(opts.rotationRad);
  const sin = Math.sin(opts.rotationRad);
  const scale = opts.scale ?? 1;

  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      // [zmierzony na zywo blad pierwszej wersji] Punkt wyjsciowy wzgledem
      // SRODKA wyjscia, we WLASNYCH ("nieobroconych") osiach zaznaczenia —
      // BEZ dodatkowego "+0.5" (dawna wersja mylila konwencje: `sampleBilinear`
      // (nizej) traktuje CALKOWITA wspolrzedna jako "dokladnie ten piksel,
      // zero mieszania" — dodanie tu wlasnego "+0.5" przesuwalo KAZDE
      // probkowanie o pol piksela, co przy `rotationRad=0` psulo nawet
      // najprostszy przypadek "ten sam srodek i rozmiar" — zamiast czystej
      // identycznosci dawalo systematyczne, powtarzalne przesuniecie o 0.5px,
      // zlapane wprost testem jednostkowym (`rotateCrop.test.ts`).
      const lx = (ox - outW / 2) * scale;
      const ly = (oy - outH / 2) * scale;
      // Odwzorowanie ODWROTNE: obroc lokalny punkt o `rotationRad`, zeby znalezc jego POZYCJE w obrazie zrodlowym (to WLASNIE ten kat, pod jakim lokalna os "szerokosci" zaznaczenia lezy w zrodle).
      const sx = opts.centerX + lx * cos - ly * sin;
      const sy = opts.centerY + lx * sin + ly * cos;
      const [r, g, b, a] = sampleBilinear(source, sx, sy);
      const outIdx = (oy * outW + ox) * 4;
      rgba[outIdx] = r;
      rgba[outIdx + 1] = g;
      rgba[outIdx + 2] = b;
      rgba[outIdx + 3] = a;
    }
  }

  return { width: outW, height: outH, rgba };
}

import { describe, expect, it } from 'vitest';
import { renderRotatedRegion } from '../../src/images/renderRotatedRegion.js';
import { computeRenderPlan, transformPoint } from '../../src/images/regionRenderer.js';
import type { RegionRenderer, RenderRegionOptions, PdfPageForRender } from '../../src/images/regionRenderer.js';
import type { Rect } from '../../src/geometry.js';
import type { DecodedImage } from '../../src/images/normalizeDecodedImage.js';

/**
 * [naprawa zgloszonego bledu — recenzja calego designu, "rotated crop na
 * stronie z page.rotate != 0 wycina zle piksele"] Fabryka fałszywej strony —
 * `getViewport({scale})` zwraca `baseTransform` przeskalowany liniowo (tak
 * jak prawdziwe pdf.js: macierz viewportu przy skali S to macierz przy
 * skali 1 pomnozona przez S). `baseTransform` symuluje TO, co `page.rotate`
 * naprawde robi z macierza pdf.js — dla `rotate=0` to zwykle skalowanie +
 * odbicie Y (`[1,0,0,-1,0,0]`), dla realnej rotacji strony to macierz
 * MIESZAJACA X/Y (nie tylko skala+odbicie) — DOKLADNIE ten przypadek, ktory
 * naiwna, stara formula w `renderRotatedRegion.ts` (skalowanie+odbicie Y
 * liczone WPROST z bbox, bez udzialu `page.getViewport`) calkowicie
 * pomijala.
 */
function makeFakePage(baseTransform: readonly [number, number, number, number, number, number]): PdfPageForRender {
  return {
    getViewport({ scale }) {
      return { transform: baseTransform.map((v) => v * scale) };
    },
  } as PdfPageForRender;
}

/** Macierz strony BEZ rotacji (`page.rotate === 0`) — konwencja pdf.js: device_x = pdf_x, device_y = -pdf_y (odbicie Y wzgledem 0). Wszystkie 9 plikow w `samples/` tego projektu maja `page.rotate === 0`. */
const UNROTATED_PAGE = makeFakePage([1, 0, 0, -1, 0, 0]);

/**
 * Macierz strony Z RZECZYWISTA ROTACJA — MIESZA X/Y (nie tylko skaluje i
 * odbija), tak jak prawdziwa macierz pdf.js dla strony z `/Rotate 90/180/270`
 * naprawde wyglada. Nie musi byc BAJT W BAJT tym, co pdf.js realnie zwraca
 * dla `rotation:90` (to zalezy od jego wewnetrznej implementacji) — wystarczy,
 * ze test dowodzi: `renderRotatedRegion` POPRAWNIE uzywa CALEJ macierzy z
 * `page.getViewport`, a nie tylko zakłada skalowanie+odbicie Y.
 */
const ROTATED_PAGE = makeFakePage([0, 1, -1, 0, 0, 0]);

/**
 * Falszywy renderer strony — dla DOWOLNEGO zadanego bboksa (PDF, Y w gore)
 * "renderuje" plaska, czarna bitmape z jednym jasnym markerem w PODANEJ
 * pozycji PDF, POPRAWNIE uwzgledniajac `page.getViewport` (tak jak prawdziwy
 * `regionRenderer.ts` — stad reuzycie `computeRenderPlan`/`transformPoint`,
 * ktore sa WLASNYMI, juz osobno przetestowanymi funkcjami `regionRenderer.ts`,
 * nie logika `renderRotatedRegion.ts` pod testem). Marker jest umieszczany
 * przez zastosowanie TEJ SAMEJ transformacji, wiec test dowodzi, ze
 * `renderRotatedRegion` poprawnie ODWRACA to mapowanie dla dowolnej strony —
 * nie tylko dla strony bez rotacji.
 */
function fakeRenderer(markerPdfX: number, markerPdfY: number, markerHalfSizePdf: number): RegionRenderer {
  return {
    async renderRegion(page: PdfPageForRender, bbox: Rect, opts: RenderRegionOptions): Promise<DecodedImage> {
      const plan = computeRenderPlan((scale) => page.getViewport({ scale }).transform, bbox, opts.targetLongEdgePx);
      const transform = page.getViewport({ scale: plan.scale }).transform;
      const [markerDeviceX, markerDeviceY] = transformPoint(transform, markerPdfX, markerPdfY);
      const markerPixelX = markerDeviceX - plan.offsetX;
      const markerPixelY = markerDeviceY - plan.offsetY;
      const markerHalfSizePx = markerHalfSizePdf * plan.scale;
      const rgba = new Uint8ClampedArray(plan.outWidth * plan.outHeight * 4);
      for (let oy = 0; oy < plan.outHeight; oy++) {
        for (let ox = 0; ox < plan.outWidth; ox++) {
          const idx = (oy * plan.outWidth + ox) * 4;
          rgba[idx + 3] = 255; // czarne, nieprzezroczyste tlo
          if (Math.abs(ox - markerPixelX) <= markerHalfSizePx && Math.abs(oy - markerPixelY) <= markerHalfSizePx) {
            rgba[idx] = 255;
            rgba[idx + 1] = 255;
            rgba[idx + 2] = 255;
          }
        }
      }
      return { width: plan.outWidth, height: plan.outHeight, rgba };
    },
  };
}

function findMarkerCentroid(image: DecodedImage): { x: number; y: number } {
  let sumX = 0;
  let sumY = 0;
  let sumWeight = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const idx = (y * image.width + x) * 4;
      const brightness = image.rgba[idx]! + image.rgba[idx + 1]! + image.rgba[idx + 2]!;
      sumX += x * brightness;
      sumY += y * brightness;
      sumWeight += brightness;
    }
  }
  return { x: sumX / sumWeight, y: sumY / sumWeight };
}

describe('renderRotatedRegion', () => {
  it('rotationRad=0, znacznik na prawo od srodka regionu -> ladowuje sie na prawo od srodka wyjscia', () => {
    const renderer = fakeRenderer(330, 300, 5); // 30pt na prawo (PDF +X) od srodka regionu (300,300)
    return renderRotatedRegion(UNROTATED_PAGE, { centerX: 300, centerY: 300, width: 100, height: 100, rotationRad: 0 }, renderer, { targetLongEdgePx: 200 }).then((result) => {
      const marker = findMarkerCentroid(result);
      const dx = marker.x - result.width / 2;
      const dy = marker.y - result.height / 2;
      expect(dx).toBeGreaterThan(10);
      expect(Math.abs(dy)).toBeLessThan(10);
    });
  });

  it('[Konwencja tej funkcji, zweryfikowana wprost tym testem] rotationRad=+90° W PDF (Y w gore) — znacznik na prawo (PDF +X) od srodka ladowuje sie POD srodkiem wyjscia. Jesli integracja z UI (kierunek przeciagania uchwytu obrotu) okaze sie odwrotna, jedyna poprawka to negacja kata PRZED wywolaniem tej funkcji (w `ReviewScreen.ts`, przy konwersji ekran->PDF), nie tutaj.', () => {
    const renderer = fakeRenderer(330, 300, 5);
    return renderRotatedRegion(UNROTATED_PAGE, { centerX: 300, centerY: 300, width: 100, height: 100, rotationRad: Math.PI / 2 }, renderer, { targetLongEdgePx: 200 }).then((result) => {
      const marker = findMarkerCentroid(result);
      const dx = marker.x - result.width / 2;
      const dy = marker.y - result.height / 2;
      expect(Math.abs(dx)).toBeLessThan(10);
      expect(dy).toBeGreaterThan(10);
    });
  });

  it('wynikowe wymiary odpowiadaja proporcjom regionu (nie otoczki) i docelowej dlugosci krawedzi', () => {
    const renderer = fakeRenderer(0, 0, 1);
    return renderRotatedRegion(UNROTATED_PAGE, { centerX: 300, centerY: 300, width: 200, height: 100, rotationRad: Math.PI / 4 }, renderer, { targetLongEdgePx: 400 }).then((result) => {
      expect(result.width).toBe(400);
      expect(result.height).toBe(200);
    });
  });

  it('[naprawa zgloszonego bledu] strona z RZECZYWISTA rotacja (macierz page.getViewport miesza X/Y) — znacznik na prawo (PDF +X) od srodka regionu WCIAZ ladowuje sie na prawo od srodka wyjscia dla rotationRad=0, mimo ze surowe wspolrzedne PDF zostaly "obrocone" przez sama strone. Przed naprawa (naiwne skalowanie+odbicie Y liczone z bbox, bez udzialu page.getViewport) ten test wykrywalby zle wspolrzedne na kazdej stronie z page.rotate != 0.', () => {
    const renderer = fakeRenderer(330, 300, 5);
    return renderRotatedRegion(ROTATED_PAGE, { centerX: 300, centerY: 300, width: 100, height: 100, rotationRad: 0 }, renderer, { targetLongEdgePx: 200 }).then((result) => {
      const marker = findMarkerCentroid(result);
      const dx = marker.x - result.width / 2;
      const dy = marker.y - result.height / 2;
      expect(dx).toBeGreaterThan(10);
      expect(Math.abs(dy)).toBeLessThan(10);
    });
  });
});

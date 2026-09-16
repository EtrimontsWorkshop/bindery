import type { Rect } from '../geometry.js';
import type { DecodedImage } from './normalizeDecodedImage.js';
import { rotateAndCropImage } from './rotateCrop.js';
import { computeRenderPlan, transformPoint, type PdfPageForRender, type RegionRenderer, type RenderRegionOptions } from './regionRenderer.js';

/**
 * [zgloszenie uzytkownika, "Zaznacz i wytnij" — mozliwosc obrocenia
 * zaznaczonego obszaru] Prostokat NIEROWNOLEGLY do osi, we WSPOLRZEDNYCH PDF
 * (Y w gore) — patrz `RotatedRect` w `pageOverlayGeometry.ts` (ten sam
 * ksztalt danych, ale tamten typ zyje w pliku o geometrii EKRANU/nakladki,
 * nie chcemy stad zaleznosci w niewlasciwa strone; `packages/module` sam
 * konwertuje ekran->PDF przez `screenRotatedRectToPdf` PRZED wywolaniem
 * tego, wiec ten plik dostaje juz gotowy prostokat w PDF-owych jednostkach).
 */
export interface RotatedPdfRegion {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  rotationRad: number;
}

/**
 * Renderuje obrocony region PDF-a do prostego, "wyprostowanego" obrazu — BEZ
 * modyfikowania samego renderu pdf.js (`renderer.renderRegion` ponizej to
 * DOKLADNIE ta sama, juz sprawdzona funkcja co przy zwyklym, nieobroconym
 * "Zaznacz i wytnij"). Dwa kroki:
 *
 * 1. Wylicz OTOCZKE (bbox rownolegly do osi) obroconego prostokata i wyrenderuj
 *    JA normalnie — to, co widac na tym wiekszym kawalku strony, jest tresciowo
 *    wystarczajace, zeby wyciac z niego dowolnie obrocony prostokat w srodku.
 * 2. `rotateAndCropImage` (czysta funkcja pikselowa, `rotateCrop.ts`) wycina i
 *    "prostuje" wlasciwy, obrocony prostokat z tej wiekszej bitmapy.
 *
 * Srodek/kat obroconego prostokata sa przeliczane na PIKSELE tej WIEKSZEJ
 * bitmapy przez te sama technike co `screenRotatedRectToPdf`/`rotateAndCropImage`
 * juz uzywaja: przeksztalc 4 prawdziwe rogi (tu: z PDF-a na piksele bitmapy),
 * wyprowadz srodek/wymiary/kat z ICH pozycji — zero osobnej, recznie
 * odwracanej algebry na samym kacie.
 *
 * [naprawa zgloszonego bledu — recenzja calego designu] Przeliczenie PDF ->
 * piksele bitmapy MUSI uzywac DOKLADNIE tej samej transformacji, ktorej uzyl
 * `renderer.renderRegion` do wyprodukowania `source` — czyli prawdziwej
 * macierzy pdf.js `page.getViewport({scale}).transform` (ktora sama
 * uwzglednia `page.rotate`, patrz `regionRenderer.ts`), NIE naiwnego
 * skalowania+odbicia Y liczonego wprost z `bbox`. Ta druga formula byla
 * poprawna WYLACZNIE dla stron z `rotate === 0` (co jest prawda dla
 * wszystkich 9 plikow w `samples/` tego projektu, stad blad byl niewidoczny
 * do tej pory) — na stronie z realna rotacja dawalaby zle wspolrzedne bez
 * zadnego bledu/ostrzezenia. `computeRenderPlan` to CZYSTA, deterministyczna
 * funkcja tego samego `bbox`/`targetLongEdgePx` co render wyzej uzyl, wiec
 * ponowne jej wywolanie tutaj zwraca DOKLADNIE ten sam `scale`/`offsetX/Y`
 * (a `plan.outWidth/outHeight` sa z definicji rowne `source.width/height`).
 */
export async function renderRotatedRegion(page: PdfPageForRender, region: RotatedPdfRegion, renderer: RegionRenderer, opts: RenderRegionOptions): Promise<DecodedImage> {
  const hw = region.width / 2;
  const hh = region.height / 2;
  const cos = Math.cos(region.rotationRad);
  const sin = Math.sin(region.rotationRad);
  const localCorners: Array<[number, number]> = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
  const pdfCorners = localCorners.map(([lx, ly]): [number, number] => [region.centerX + lx * cos - ly * sin, region.centerY + lx * sin + ly * cos]);

  const xs = pdfCorners.map((p) => p[0]);
  const ys = pdfCorners.map((p) => p[1]);
  const bbox: Rect = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };

  // Rozdzielczosc renderu OTOCZKI skalowana tak, zeby WLASCIWA (mniejsza)
  // selekcja i tak wyjdzie w okolicach `opts.targetLongEdgePx` po przycieciu
  // — inaczej duza otoczka wokol waskiego, mocno obroconego prostokata
  // dawalaby niepotrzebnie niska rozdzielczosc samej selekcji.
  const bboxLongEdge = Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY);
  const regionLongEdge = Math.max(region.width, region.height);
  const bboxTargetLongEdgePx = regionLongEdge > 0 && bboxLongEdge > 0 ? opts.targetLongEdgePx * (bboxLongEdge / regionLongEdge) : opts.targetLongEdgePx;

  const source = await renderer.renderRegion(page, bbox, { targetLongEdgePx: bboxTargetLongEdgePx, signal: opts.signal });

  const plan = computeRenderPlan((scale) => page.getViewport({ scale }).transform, bbox, bboxTargetLongEdgePx);
  const viewportTransform = page.getViewport({ scale: plan.scale }).transform;
  const pixelCorners = pdfCorners.map(([x, y]): [number, number] => {
    const [deviceX, deviceY] = transformPoint(viewportTransform, x, y);
    return [deviceX - plan.offsetX, deviceY - plan.offsetY];
  });

  const centerX = pixelCorners.reduce((sum, p) => sum + p[0], 0) / 4;
  const centerY = pixelCorners.reduce((sum, p) => sum + p[1], 0) / 4;
  const [p0, p1] = pixelCorners as [[number, number], [number, number], [number, number], [number, number]];
  const rotationRad = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);

  const outScale = regionLongEdge > 0 ? opts.targetLongEdgePx / regionLongEdge : 1;
  const outputWidth = Math.max(1, Math.round(region.width * outScale));
  const outputHeight = Math.max(1, Math.round(region.height * outScale));

  return rotateAndCropImage(source, { centerX, centerY, outputWidth, outputHeight, rotationRad });
}

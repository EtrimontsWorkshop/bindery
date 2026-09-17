import type { Rect } from './geometry.js';

/**
 * [Step 11 Z3] Conversion of a PDF bbox (Y up) -> screen/SVG-overlay
 * coordinates over the rendered page preview (Y down) — the brief states
 * directly: "write ONE conversion function, unit-test it, use ONLY it".
 * This is the FOURTH occurrence of the same bug class in the project (step
 * 4: the shape of `cm` arguments; step 5: `constructPath`; step 6:
 * `item.width` already in device space) — hence it lives in
 * `packages/core`, not `packages/module` (which has NO test
 * infrastructure, see CLAUDE.md/package.json), so it can actually be
 * verified with a unit test, not just "eyeballed" in the browser.
 */

export type PageRotation = 0 | 90 | 180 | 270;

export interface RenderedPageGeometry {
  /** Page box in PDF space (e.g. `PreviewPageHandle.box`/page `Provenance`) — BEFORE rotation. */
  pageBox: Rect;
  /** Pixels of the ACTUALLY rendered bitmap (AFTER accounting for rotation, e.g. `EncodedImage`/`DecodedImage` from `renderPagePreview`). */
  imageWidthPx: number;
  imageHeightPx: number;
  /** `PreviewPageHandle.rotation`/`page.rotate` — 0 in the VAST majority of real PDFs (all 9 `samples/` files in this project). */
  rotation: PageRotation;
}

/**
 * A single PDF point -> screen pixel (0,0 = top-left corner of the
 * rendered bitmap, Y increases DOWNWARD — DOM/canvas/SVG convention).
 *
 * [VERIFICATION] The `rotation === 0` case is fully covered by unit tests
 * (`pageOverlayGeometry.test.ts`) on directly computed examples. The
 * `90`/`180`/`270` cases have formulas derived from the same model (Y
 * flip, then rotation following pdf.js's `page.rotate` convention —
 * rotating the CONTENT clockwise), but due to the absence in `samples/`
 * (gitignored, R1) of even a single real file with rotation != 0, they
 * have NOT been visually verified on a real page — marked as "to be
 * confirmed on the first real case" in RAPORT-KROK-11.md.
 */
export function pdfPointToScreen(x: number, y: number, page: RenderedPageGeometry): [number, number] {
  const { pageBox, imageWidthPx, imageHeightPx, rotation } = page;
  const pageWidth = pageBox.maxX - pageBox.minX;
  const pageHeight = pageBox.maxY - pageBox.minY;
  if (pageWidth <= 0 || pageHeight <= 0) return [0, 0];

  // Normalization relative to the BOTTOM-left corner of the page, still in PDF space (Y up).
  const nx = x - pageBox.minX;
  const nyUp = y - pageBox.minY;
  // THE ONLY place the Y axis is flipped in the whole module — PDF Y-up -> screen Y-down, BEFORE rotation.
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

/** PDF bbox -> screen bbox — takes ALL 4 corners through `pdfPointToScreen` and computes the bounding box, so it works correctly regardless of rotation (without a separate min/max formula per case). */
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
 * [Step 18, "Select and crop"] The INVERSE of `pdfPointToScreen` — a screen
 * pixel (of the overlay over the rendered page preview) -> a PDF point.
 * Needed when the user draws a bbox with the mouse themselves (we're not
 * reading an already-existing `provenance.bbox`, like `pdfRectToScreen`,
 * but going the other way). Derived algebraically from `pdfPointToScreen`
 * (reversing the order: forward is scaling -> rotation -> Y flip ->
 * translation, here in reverse order) — THE SAME function used in both
 * directions (file header: "write ONE conversion function... use ONLY
 * it", here analogously one function per direction, not a duplicate of
 * the rotation logic).
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

/** Screen bbox -> PDF bbox — mirror of `pdfRectToScreen` (4 corners through `screenPointToPdf`, bounding box), robust regardless of rotation. */
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
 * [user report, "Select and crop" — ability to rotate the selected area] A
 * rectangle that is NOT axis-aligned — center + OWN dimensions (before
 * rotation) + angle. `rotationRad` is the angle of the "width" AXIS (local
 * +X) relative to the positive X axis of the given coordinate system, IN
 * THE CONVENTION OF THAT system (Y down for `screen`, radians).
 */
export interface RotatedRect {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  rotationRad: number;
}

/**
 * [user report] A rotated rectangle (screen) -> a rotated rectangle (PDF)
 * — does NOT do its OWN, separate algebra on the angle (no new opportunity
 * to mix up the sign/direction of rotation): it computes the rectangle's 4
 * corners in SCREEN SPACE (plain geometry), passes EACH one individually
 * through the ALREADY proven `screenPointToPdf` (the same function as
 * `screenRectToPdf` above — works correctly regardless of PAGE rotation),
 * and derives the center/dimensions/angle in PDF space from the POSITIONS
 * of the transformed corners (center = average of corners, width/height =
 * distances between adjacent corners, angle = `atan2` of one edge's
 * vector) — EXACTLY the same pattern that the already-proven
 * `rotateAndCropImage` (`rotateCrop.ts`) uses on the pixel-extraction
 * side: "derive the angle from REAL, already-transformed points", never
 * from a separate, manually-inverted formula for the angle alone.
 *
 * Assumes a UNIFORM scale (the same pixels/point ratio in X and Y) — true
 * for EVERY page preview in this project (we never stretch the preview
 * anisotropically) — otherwise a rotated rectangle on screen would map to
 * a parallelogram (not a rectangle) in PDF space.
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
 * The bounding box (axis-aligned bbox) of a rotated rectangle — PURE
 * geometry, independent of the coordinate system (works identically for
 * `screen` and `pdf`, the only difference between them being the direction
 * of the Y axis, which doesn't affect the bounding box itself). Used by
 * `ReviewScreen.ts` to store `CIFImage.provenance.bbox` (ALWAYS
 * axis-aligned throughout the project) for a manually rotated crop — one
 * place for the "4 corners from local coordinates via rotation, then
 * min/max" pattern, instead of yet another copy of the same algebra (see
 * `renderRotatedRegion.ts`, where the same pattern already occurs).
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

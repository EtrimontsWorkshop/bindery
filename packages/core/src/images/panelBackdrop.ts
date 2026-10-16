import type { RawLook } from './blankSheet.js';
import type { DecodedImage } from './normalizeDecodedImage.js';

/**
 * The panels a page draws behind its boxes of text and cards: dark textured or gradient rectangles that fill their
 * whole box. Offered as pictures they are a bare texture, one for every box of the book. Measured on a real rulebook
 * (a dark science-fiction layout): the panels are rasters that are opaque all over, mean luminance 33-68, spread
 * 15-37, saturation 8-20, most of them painted at 40%-65% opacity; the pictures of the same book that are offered at
 * those opacities carry a figure, a table or a card (spread 55 and more, or a render of a region).
 */

/** Share of the raster's pixels that must be opaque: a crest or a faded figure has a transparent surround. */
export const PANEL_OVERLAY_MIN_OPAQUE_FRACTION = 0.8;
const PANEL_MIN_OPAQUE_FRACTION = PANEL_OVERLAY_MIN_OPAQUE_FRACTION;
/** Share of the picture's box that the page's text must cover for a translucent panel to count on that alone. */
export const PANEL_MIN_TEXT_COVERAGE = 0.15;
/** Size of the small render in which a panel is checked for a drawing. */
export const PANEL_PREVIEW_LONG_EDGE_PX = 256;
/** Share of a picture's box that a panel must cover for the panel to frame it (a card with a portrait on it) rather than only touch it. */
export const PANEL_FRAMES_PICTURE_MIN_SHARE = 0.9;
/** What a bare dark texture looks like (see above). */
const TEXTURE_MAX_MEAN_LUMINANCE = 75;
const TEXTURE_MAX_STDDEV = 40;
const TEXTURE_MAX_SATURATION = 25;
/** Spread limit for an opaque panel (measured: 27 for a panel behind a table; a dark painted illustration in a text column has 34). */
const OPAQUE_PANEL_MAX_STDDEV = 30;
/** The confidence below which the classifier itself was not sure the picture is content (the review lists it unchecked). */
const WEAK_SIGNAL_MAX_CONFIDENCE = 0.6;

/** Whether the raster, judged by its pixels alone, is a plain dark texture or gradient. */
export function isBareDarkTexture(look: RawLook): boolean {
  return look.meanLuminance <= TEXTURE_MAX_MEAN_LUMINANCE && look.luminanceStdDev <= TEXTURE_MAX_STDDEV && look.meanSaturation <= TEXTURE_MAX_SATURATION;
}

export interface PanelEvidence {
  /** Painted translucent everywhere it appears. */
  translucent: boolean;
  /** Another image cuts it out through a mask: then it is a shape of the page's design, judged by other rules. */
  masked: boolean;
  /** Share of the raster's pixels that are opaque, `null` when it was not measured. */
  opaqueFraction: number | null;
  /** Share of the picture's box that text blocks of the page cover. */
  textCoverage: number;
  /** The picture is the raw resource, not a render of a region (which would hold whatever else lies there). */
  extractedRaw: boolean;
  /** How sure the classifier was that this is content (0-1). */
  confidence: number;
  /** Visible-pixel statistics of the raw resource, `null` when not measured. */
  look: RawLook | null;
}

export function isPanelBackdrop(evidence: PanelEvidence): boolean {
  if (evidence.masked || evidence.opaqueFraction === null || evidence.opaqueFraction < PANEL_MIN_OPAQUE_FRACTION) return false;
  // Only a raw raster that looks like a plain dark texture: a light emblem, a seal or a faded figure painted translucent is a picture, and a render of a region holds whatever else lies there.
  if (!evidence.extractedRaw || evidence.look === null || !isBareDarkTexture(evidence.look)) return false;
  // A translucent rectangle with the page's text on it.
  if (evidence.translucent && evidence.textCoverage >= PANEL_MIN_TEXT_COVERAGE) return true;
  // A texture that nobody was sure about, that is translucent (the page's own panel layer, whatever lies on it: a vector drawing, a table) or that has text on it. An opaque one without text is
  // indistinguishable from a dark photograph by its pixels.
  if (evidence.confidence >= WEAK_SIGNAL_MAX_CONFIDENCE) return false;
  if (evidence.translucent) return true;
  // Opaque, with text on it: only when it is smoother still than the panels measured (a dark painted illustration among text, spread 34, is not a panel).
  return evidence.textCoverage >= PANEL_MIN_TEXT_COVERAGE && evidence.look.luminanceStdDev <= OPAQUE_PANEL_MAX_STDDEV;
}

/**
 * A dark panel that carries a drawing rather than text or nothing: a floor plan, a map, a technical drawing. The panel is
 * judged by comparing a render of its region with what the bare texture alone would show there: where the render is
 * clearly brighter than the texture (at the opacity the page paints it), something is drawn on it.
 */
const DRAWING_MAX_TEXT_COVERAGE = 0.05;
const DRAWING_MIN_SHARE = 0.01;
/** How much brighter (luminance 0-255) than the bare texture a pixel of the render must be to count as drawn. */
const DRAWN_MIN_EXCESS = 50;

function luminance(rgba: Uint8ClampedArray | Uint8Array, i: number): number {
  return 0.3 * rgba[i]! + 0.59 * rgba[i + 1]! + 0.11 * rgba[i + 2]!;
}

/**
 * The share (0-1) of a render's pixels that are drawn on top of a raster, measured against what the raster alone would show
 * there. What lies under a translucent panel is not known (the page's own background shows through), so the render is
 * fitted to the raster's luminance by a straight line, and a pixel counts as drawn when it is clearly brighter than that fit
 * (taken at the brightest of the neighboring pixels, so that a fine texture a pixel out of register does not count).
 */
export function drawnShare(render: DecodedImage, raw: DecodedImage): number {
  const { width: w, height: h } = render;
  if (w === 0 || h === 0 || raw.width === 0 || raw.height === 0) return 0;
  const texture = new Float32Array(w * h);
  const shown = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * raw.height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * raw.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * raw.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * raw.width) / w));
      let sum = 0;
      let n = 0;
      for (let ry = y0; ry < y1 && ry < raw.height; ry++) {
        for (let rx = x0; rx < x1 && rx < raw.width; rx++) {
          sum += luminance(raw.rgba, (ry * raw.width + rx) * 4);
          n++;
        }
      }
      texture[y * w + x] = n > 0 ? sum / n : 0;
      shown[y * w + x] = luminance(render.rgba, (y * w + x) * 4);
    }
  }
  const count = w * h;
  let sumT = 0;
  let sumR = 0;
  for (let i = 0; i < count; i++) {
    sumT += texture[i]!;
    sumR += shown[i]!;
  }
  const meanT = sumT / count;
  const meanR = sumR / count;
  let covariance = 0;
  let varianceT = 0;
  for (let i = 0; i < count; i++) {
    covariance += (texture[i]! - meanT) * (shown[i]! - meanR);
    varianceT += (texture[i]! - meanT) ** 2;
  }
  const slope = varianceT > 0 ? Math.max(0, covariance / varianceT) : 0;
  const offset = meanR - slope * meanT;
  let drawn = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let ceiling = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          ceiling = Math.max(ceiling, texture[yy * w + xx]!);
        }
      }
      if (shown[y * w + x]! - (slope * ceiling + offset) >= DRAWN_MIN_EXCESS) drawn++;
    }
  }
  return drawn / count;
}

/** Whether a dark panel, rendered with whatever the page draws on it, is a picture (a plan, a map) and not a backdrop. */
export function isDrawingOnPanel(evidence: { textCoverage: number; drawnShare: number }): boolean {
  return evidence.textCoverage < DRAWING_MAX_TEXT_COVERAGE && evidence.drawnShare >= DRAWING_MIN_SHARE;
}

/**
 * Mean saturation (0-255) from which a big translucent raster is colorful enough to be a picture (a city map) and not a panel or a paper wash. Measured on a real starter
 * set: the map under a diagram has 42-45; the dark panels 8-16, paper-like textures of two other books 6 and 18.
 */
const PICTURE_MIN_SATURATION = 30;

/** Whether the raster is a colorful picture, judged by its pixels alone. */
export function isColorfulPicture(look: RawLook): boolean {
  return look.meanSaturation >= PICTURE_MIN_SATURATION;
}

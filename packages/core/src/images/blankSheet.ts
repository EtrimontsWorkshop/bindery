/**
 * A table or a form that the page draws on a plain sheet: the raster is a flat white (or flat dark) rectangle, and
 * everything that makes it a table (rows, headings, numbers) is page text and vector lines. Offered as a picture it
 * would be a render of the page's own text; it is not one. Measured on a real rulebook: the 20 sidebar and full-page
 * tables have a raw raster of mean luminance 247, spread 2.2-3.2 and saturation 5 (the dark ones 35, 0.3-1.0 and 10),
 * the page-sized character-sheet forms 237-238, 9.6-13.9 and 15-16. The paper notes of the other rulebooks are
 * coloured (saturation 37-102) or textured (spread 8.3 and more); a grey paper document of one of them (235, 9, 0)
 * is not tinted, a lightly tinted page of another (227, 12.4, 16) is darker. Rasters that are a solid fill under a
 * mask (a white disc, a flat colour) are never judged by the flat rule: what they show is drawn elsewhere.
 */

/** Visible-pixel statistics of a raster (luminance and saturation 0-255). */
export interface RawLook {
  meanLuminance: number;
  luminanceStdDev: number;
  meanSaturation: number;
}

/** What is known about the picture beside its raster: whether the page text lies over it, and how much of the page it fills. */
export interface SheetContext {
  textOverPicture: boolean;
  pageShare: number;
}

// Tables: a flat raster with the page text over it.
const FLAT_LIGHT_MIN_MEAN = 240;
const FLAT_LIGHT_MAX_STDDEV = 6;
const FLAT_LIGHT_MAX_SATURATION = 12;
const FLAT_DARK_MAX_MEAN = 60;
const FLAT_DARK_MAX_STDDEV = 2;
// Forms: a page-sized, light, lightly tinted raster (the printed frame of a character sheet).
const FORM_MIN_PAGE_SHARE = 0.5;
const FORM_MIN_MEAN = 235;
const FORM_MAX_STDDEV = 16;
const FORM_MIN_SATURATION = 12;
const FORM_MAX_SATURATION = 20;

export function isBlankSheet(look: RawLook, context: SheetContext): boolean {
  const flatLight = look.meanLuminance >= FLAT_LIGHT_MIN_MEAN && look.luminanceStdDev < FLAT_LIGHT_MAX_STDDEV && look.meanSaturation < FLAT_LIGHT_MAX_SATURATION;
  const flatDark = look.meanLuminance < FLAT_DARK_MAX_MEAN && look.luminanceStdDev < FLAT_DARK_MAX_STDDEV;
  if (context.textOverPicture && (flatLight || flatDark)) return true;
  return (
    context.pageShare >= FORM_MIN_PAGE_SHARE &&
    look.meanLuminance >= FORM_MIN_MEAN &&
    look.luminanceStdDev < FORM_MAX_STDDEV &&
    look.meanSaturation >= FORM_MIN_SATURATION &&
    look.meanSaturation < FORM_MAX_SATURATION
  );
}

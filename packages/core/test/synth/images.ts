import { PdfWriter } from './rawPdf.js';

export interface ImageXObjectOptions {
  width: number;
  height: number;
  /** Pixel RGB, width*height*3 bytes, no filter (raw). */
  rgb: Buffer;
}

/** Embeds a DeviceRGB image XObject without compression (raw bytes, simple to verify). */
export function imageXObject(writer: PdfWriter, opts: ImageXObjectOptions): number {
  if (opts.rgb.length !== opts.width * opts.height * 3) {
    throw new Error('imageXObject: the rgb length does not match width*height*3');
  }
  return writer.addStreamObj(
    `/Type /XObject /Subtype /Image /Width ${opts.width} /Height ${opts.height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8`,
    opts.rgb,
  );
}

/** Fills an RGB buffer with a single color. */
export function solidRgb(width: number, height: number, r: number, g: number, b: number): Buffer {
  const buf = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    buf[i * 3] = r;
    buf[i * 3 + 1] = g;
    buf[i * 3 + 2] = b;
  }
  return buf;
}

/**
 * Fills an RGB buffer with a CHECKERBOARD of two colors — deterministic like `solidRgb`, but with
 * REAL pixel variance (a luminance standard deviation > 0). Needed where a fixture represents real
 * content (`content`) and must pass through `computeLuminanceStdDev` like a real illustration — a
 * uniform `solidRgb` has a stddev of EXACTLY 0 and would (correctly) be rejected as a "flat
 * texture", which is misleading for fixtures testing something else.
 */
export function checkerboardRgb(
  width: number,
  height: number,
  colorA: readonly [number, number, number],
  colorB: readonly [number, number, number],
  cellSize = 8,
): Buffer {
  const buf = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const isA = (Math.floor(x / cellSize) + Math.floor(y / cellSize)) % 2 === 0;
      const [r, g, b] = isA ? colorA : colorB;
      const i = (y * width + x) * 3;
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
    }
  }
  return buf;
}

/**
 * Builds a Form XObject used as the /G target of a luminosity mask — it MUST have /Group
 * /S /Transparency, otherwise pdf.js won't build the group (see PartialEvaluator.buildFormXObject
 * in pdf.worker.mjs: beginGroup is emitted only when dict.get("Group") exists).
 *
 * The form's content paints an IMAGE (not a vector fill) — in line with real PDF maps (in
 * practice a luminosity mask is a grayscale image, not a vector), and so that the 'image' event
 * actually occurs INSIDE beginGroup/endGroup — the only way the 'group' evidence path in
 * imageRegistry can ever match anything.
 */
export function luminosityMaskForm(writer: PdfWriter, opts: { width: number; height: number }): number {
  const maskImageRef = imageXObject(writer, { width: 2, height: 2, rgb: solidRgb(2, 2, 255, 255, 255) });
  const content = Buffer.from(`${opts.width} 0 0 ${opts.height} 0 0 cm /MaskImg Do\n`, 'latin1');
  return writer.addStreamObj(
    `/Type /XObject /Subtype /Form /FormType 1 /BBox [0 0 ${opts.width} ${opts.height}] ` +
      `/Group << /Type /Group /S /Transparency /CS /DeviceGray >> ` +
      `/Resources << /XObject << /MaskImg ${maskImageRef} 0 R >> >>`,
    content,
  );
}

/** An ExtGState with /SMask /Luminosity pointing at a Form XObject from luminosityMaskForm(). */
export function luminosityExtGState(writer: PdfWriter, maskFormRef: number): number {
  return writer.addObj(`<< /Type /ExtGState /SMask << /Type /Mask /S /Luminosity /G ${maskFormRef} 0 R >> >>`);
}

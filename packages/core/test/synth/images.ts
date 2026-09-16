import { PdfWriter } from './rawPdf.js';

export interface ImageXObjectOptions {
  width: number;
  height: number;
  /** RGB pikseli, width*height*3 bajtow, bez filtra (surowe). */
  rgb: Buffer;
}

/** Osadza obraz XObject DeviceRGB bez kompresji (surowe bajty, proste do weryfikacji). */
export function imageXObject(writer: PdfWriter, opts: ImageXObjectOptions): number {
  if (opts.rgb.length !== opts.width * opts.height * 3) {
    throw new Error('imageXObject: dlugosc rgb nie zgadza sie z width*height*3');
  }
  return writer.addStreamObj(
    `/Type /XObject /Subtype /Image /Width ${opts.width} /Height ${opts.height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8`,
    opts.rgb,
  );
}

/** Wypelnia bufor RGB jednolitym kolorem. */
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
 * Wypelnia bufor RGB SZACHOWNICA dwoch kolorow — deterministyczne jak
 * `solidRgb`, ale z REALNA wariancja pikseli (odchylenie standardowe
 * luminancji > 0). Potrzebne tam, gdzie fixture reprezentuje prawdziwa tresc
 * (`content`) i musi przejsc przez `computeLuminanceStdDev`
 * (KROK-8 Z2, `finalize.ts`) tak jak prawdziwa ilustracja — jednolity
 * `solidRgb` ma stddev DOKLADNIE 0 i zostalby (poprawnie) odrzucony jako
 * "plaska tekstura", myloznacznie dla fixture'ow testujacych co innego.
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
 * Buduje Form XObject uzywany jako cel /G maski luminancyjnej — MUSI miec /Group
 * /S /Transparency, inaczej pdf.js nie zbuduje grupy (patrz PartialEvaluator.buildFormXObject
 * w pdf.worker.mjs: beginGroup jest emitowany tylko gdy dict.get("Group") istnieje).
 *
 * Tresc formy maluje OBRAZ (nie wypelnienie wektorowe) — zgodnie z realnymi
 * mapami PDF (RAPORT-SPIKE: luminosity maski w praktyce to grayscale image, nie
 * wektor), i zeby event 'image' faktycznie wystapil WEWNATRZ beginGroup/endGroup —
 * to jedyny sposob, w jaki sciezka dowodowa 'group' w imageRegistry moze
 * kiedykolwiek dopasowac cokolwiek (zweryfikowane empirycznie w KROK-4: wersja
 * z samym wypelnieniem wektorowym `re f` daje zero eventow 'image' w grupie).
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

/** ExtGState z /SMask /Luminosity wskazujacym na Form XObject z luminosityMaskForm(). */
export function luminosityExtGState(writer: PdfWriter, maskFormRef: number): number {
  return writer.addObj(`<< /Type /ExtGState /SMask << /Type /Mask /S /Luminosity /G ${maskFormRef} 0 R >> >>`);
}

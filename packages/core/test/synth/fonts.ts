import { PdfWriter } from './rawPdf.js';

/**
 * Builds a /ToUnicode CMap program (bfchar) from a map of a 1-byte code -> target string.
 *
 * Why ToUnicode, and not a correct /Encoding + real glyph mapping: pdf.js builds `TextItem.str`
 * primarily from ToUnicode when present. That lets us freely construct any test text
 * (fragmentation, ligatures, combining marks, simulated broken PUA) regardless of whether the
 * embedded font actually has matching glyphs — we never render these PDFs visually, so they don't
 * have to be visually correct.
 */
export function buildToUnicodeCMap(mapping: Map<number, string>): Buffer {
  const lines: string[] = [];
  lines.push('/CIDInit /ProcSet findresource begin');
  lines.push('12 dict begin');
  lines.push('begincmap');
  lines.push('/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def');
  lines.push('/CMapName /Adobe-Identity-UCS def');
  lines.push('/CMapType 2 def');
  lines.push('1 begincodespacerange');
  lines.push('<00> <FF>');
  lines.push('endcodespacerange');
  const entries = [...mapping.entries()];
  lines.push(`${entries.length} beginbfchar`);
  for (const [code, target] of entries) {
    const srcHex = code.toString(16).padStart(2, '0');
    let dstHex = '';
    for (const ch of target) {
      const cp = ch.codePointAt(0)!;
      dstHex += cp.toString(16).padStart(4, '0');
    }
    lines.push(`<${srcHex}> <${dstHex}>`);
  }
  lines.push('endbfchar');
  lines.push('endcmap');
  lines.push('CMapName currentdict /CMap defineresource pop');
  lines.push('end');
  lines.push('end');
  return Buffer.from(lines.join('\n') + '\n', 'latin1');
}

export interface EmbedFontOptions {
  /** The /BaseFont value — exactly what pdf.js returns as commonObjs.get(x).name. */
  baseFont: string;
  ttfBytes: Buffer;
  /** A 1-byte code (0..255) -> the target string in the extracted text. */
  toUnicode: Map<number, string>;
}

/** Embeds /FontFile2 + /FontDescriptor (expensive: the TTF bytes) — to be shared between many Fonts. */
export function embedFontDescriptor(writer: PdfWriter, baseFont: string, ttfBytes: Buffer): number {
  const fontFileRef = writer.addStreamObj(`/Length1 ${ttfBytes.length}`, ttfBytes);
  return writer.addObj(
    `<< /Type /FontDescriptor /FontName /${baseFont} /Flags 32 ` +
      `/FontBBox [-200 -300 1200 1000] /ItalicAngle 0 /Ascent 750 /Descent -250 ` +
      `/CapHeight 700 /StemV 80 /FontFile2 ${fontFileRef} 0 R >>`,
  );
}

/**
 * Creates a /Font object (cheap: no TTF bytes of its own) pointing at an already existing
 * /FontDescriptor. Each call with a DIFFERENT `baseFont` gives a different font.name in pdf.js's
 * eyes (see buildTextContentItem in pdf.worker.mjs), despite the same glyphs — this is the only
 * reliable way to force a separate TextItem per token (geometry alone isn't enough, pdf.js merges
 * adjacent glyphs by distance, regardless of the number of Tj operators).
 */
export function embedFontFromDescriptor(
  writer: PdfWriter,
  opts: { baseFont: string; descriptorRef: number; toUnicode: Map<number, string> },
): number {
  const toUnicodeBuf = buildToUnicodeCMap(opts.toUnicode);
  const toUnicodeRef = writer.addStreamObj('/Type /CMap', toUnicodeBuf);
  const widths = new Array(256).fill(500).join(' ');
  return writer.addObj(
    `<< /Type /Font /Subtype /TrueType /BaseFont /${opts.baseFont} ` +
      `/FirstChar 0 /LastChar 255 /Widths [${widths}] ` +
      `/FontDescriptor ${opts.descriptorRef} 0 R /ToUnicode ${toUnicodeRef} 0 R >>`,
  );
}

/**
 * Embeds a TrueType font as a simple font (not Type0/CID) with a full ToUnicode.
 */
export function embedFont(writer: PdfWriter, opts: EmbedFontOptions): number {
  const descriptorRef = embedFontDescriptor(writer, opts.baseFont, opts.ttfBytes);
  return embedFontFromDescriptor(writer, { baseFont: opts.baseFont, descriptorRef, toUnicode: opts.toUnicode });
}

/** An identity mapping for printable ASCII (0x20..0x7E) — a convenient base to extend. */
export function asciiIdentityMap(): Map<number, string> {
  const m = new Map<number, string>();
  for (let c = 0x20; c <= 0x7e; c++) {
    m.set(c, String.fromCharCode(c));
  }
  return m;
}

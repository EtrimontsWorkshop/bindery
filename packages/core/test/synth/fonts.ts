import { PdfWriter } from './rawPdf.js';

/**
 * Buduje program CMap /ToUnicode (bfchar) z mapy kod 1-bajtowy -> string docelowy.
 *
 * Dlaczego ToUnicode, a nie poprawne /Encoding + prawdziwe mapowanie glifow:
 * pdf.js buduje `TextItem.str` przede wszystkim z ToUnicode, gdy jest obecne.
 * To pozwala nam swobodnie konstruowac dowolny tekst testowy (fragmentacje,
 * ligatury, znaki laczace, symulowane zepsute PUA) niezaleznie od tego, czy
 * wbudowany font faktycznie ma pasujace glify — nigdy nie renderujemy tych
 * PDF-ow wizualnie, wiec nie musi to byc poprawne wizualnie.
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
  /** Wartosc /BaseFont — to dokladnie to, co pdf.js zwroci jako commonObjs.get(x).name (MDD §5.1, F0-Q1). */
  baseFont: string;
  ttfBytes: Buffer;
  /** Kod 1-bajtowy (0..255) -> string docelowy w wyekstrahowanym tekscie. */
  toUnicode: Map<number, string>;
}

/** Osadza /FontFile2 + /FontDescriptor (drogie: bajty TTF) — do dzielenia miedzy wieloma Font. */
export function embedFontDescriptor(writer: PdfWriter, baseFont: string, ttfBytes: Buffer): number {
  const fontFileRef = writer.addStreamObj(`/Length1 ${ttfBytes.length}`, ttfBytes);
  return writer.addObj(
    `<< /Type /FontDescriptor /FontName /${baseFont} /Flags 32 ` +
      `/FontBBox [-200 -300 1200 1000] /ItalicAngle 0 /Ascent 750 /Descent -250 ` +
      `/CapHeight 700 /StemV 80 /FontFile2 ${fontFileRef} 0 R >>`,
  );
}

/**
 * Tworzy obiekt /Font (tani: bez wlasnych bajtow TTF) wskazujacy na juz istniejacy
 * /FontDescriptor. Kazde wywolanie z INNYM `baseFont` daje font.name rozny w oczach
 * pdf.js (patrz buildTextContentItem w pdf.worker.mjs), mimo tych samych glifow —
 * to jest jedyny niezawodny sposob wymuszenia osobnego TextItem per token
 * (geometria sama w sobie nie wystarcza, pdf.js scala sasiadujace glify wg
 * odleglosci, niezaleznie od liczby operatorow Tj).
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
 * Osadza font TrueType jako prosty font (nie Type0/CID) z pelnym ToUnicode.
 * Zwraca numer obiektu /Font, gotowy do wpiecia w slownik /Resources /Font strony.
 */
export function embedFont(writer: PdfWriter, opts: EmbedFontOptions): number {
  const descriptorRef = embedFontDescriptor(writer, opts.baseFont, opts.ttfBytes);
  return embedFontFromDescriptor(writer, { baseFont: opts.baseFont, descriptorRef, toUnicode: opts.toUnicode });
}

/** Mapowanie identycznosciowe dla ASCII drukowalnego (0x20..0x7E) — wygodna baza do rozszerzania. */
export function asciiIdentityMap(): Map<number, string> {
  const m = new Map<number, string>();
  for (let c = 0x20; c <= 0x7e; c++) {
    m.set(c, String.fromCharCode(c));
  }
  return m;
}

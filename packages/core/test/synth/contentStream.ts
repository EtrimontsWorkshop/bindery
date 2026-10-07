/**
 * Builds the operators of a PDF content stream as a flat list of lines, joined into a Buffer at
 * the end. See the operator cheat sheet in
 */
export class ContentStreamBuilder {
  private lines: string[] = [];

  save(): this {
    this.lines.push('q');
    return this;
  }

  restore(): this {
    this.lines.push('Q');
    return this;
  }

  cm(a: number, b: number, c: number, d: number, e: number, f: number): this {
    this.lines.push(`${a} ${b} ${c} ${d} ${e} ${f} cm`);
    return this;
  }

  gs(name: string): this {
    this.lines.push(`/${name} gs`);
    return this;
  }

  doXObject(name: string): this {
    this.lines.push(`/${name} Do`);
    return this;
  }

  beginText(): this {
    this.lines.push('BT');
    return this;
  }

  endText(): this {
    this.lines.push('ET');
    return this;
  }

  setFont(name: string, size: number): this {
    this.lines.push(`/${name} ${size} Tf`);
    return this;
  }

  /** The text position matrix — a b c d e f Tm. Key for rotation (see the cheat sheet). */
  setTextMatrix(a: number, b: number, c: number, d: number, e: number, f: number): this {
    this.lines.push(`${a} ${b} ${c} ${d} ${e} ${f} Tm`);
    return this;
  }

  moveText(dx: number, dy: number): this {
    this.lines.push(`${dx} ${dy} Td`);
    return this;
  }

  /** Tj with codes as a hex string — avoids the need to escape ( ) \ in literal strings. */
  showTextHex(codes: number[]): this {
    this.lines.push(`<${codes.map((c) => c.toString(16).padStart(2, '0')).join('')}> Tj`);
    return this;
  }

  /**
   * TJ with an array of hex strings and kerning numbers (a shift in thousandths of an em, positive
   * moves LEFT). Used for in-one-item kerning from the cheat sheet.
   */
  showTextArrayHex(parts: (number[] | number)[]): this {
    const rendered = parts
      .map((p) => (Array.isArray(p) ? `<${p.map((c) => c.toString(16).padStart(2, '0')).join('')}>` : `${p}`))
      .join(' ');
    this.lines.push(`[${rendered}] TJ`);
    return this;
  }

  /** A raw operator line — an escape hatch for cases not covered above. */
  raw(line: string): this {
    this.lines.push(line);
    return this;
  }

  /**
   * An inline image (BI...ID...EI) — the only way to embed an image WITHOUT a reference to a PDF
   * object (no XObject), hence `paintInlineImageXObject` in pdf.js never has an objId. `data` is the
   * RAW bytes (no filter), latin1-safe 1:1 with the output bytes — works even when the data contains
   * the byte 0x0A, because `join('\n')` only INSERTS separators BETWEEN array elements, it doesn't
   * parse the contents of each element.
   */
  inlineImage(dictBody: string, data: Buffer): this {
    this.lines.push(`BI ${dictBody} ID`);
    this.lines.push(data.toString('latin1'));
    this.lines.push('EI');
    return this;
  }

  toBuffer(): Buffer {
    return Buffer.from(this.lines.join('\n') + '\n', 'latin1');
  }
}

/** Encodes a JS string into an array of 1-byte codes 0..255 (code point <-> byte identity). */
export function asciiCodes(s: string): number[] {
  const codes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i);
    if (cp === undefined || cp > 0xff) {
      throw new Error(`asciiCodes: znak spoza 0..255 na pozycji ${i} w "${s}"`);
    }
    codes.push(cp);
  }
  return codes;
}

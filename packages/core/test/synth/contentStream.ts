/**
 * Buduje operatory strumienia tresci PDF-a jako plaska lista linii, laczone w Buffer
 * na koncu. Patrz szpargalka operatorowa w KROK-3-fixtures.md.
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

  /** Macierz pozycji tekstu — a b c d e f Tm. Kluczowa dla rotacji (patrz szpargalka). */
  setTextMatrix(a: number, b: number, c: number, d: number, e: number, f: number): this {
    this.lines.push(`${a} ${b} ${c} ${d} ${e} ${f} Tm`);
    return this;
  }

  moveText(dx: number, dy: number): this {
    this.lines.push(`${dx} ${dy} Td`);
    return this;
  }

  /** Tj z kodami jako hex string — omija koniecznosc escapowania ( ) \ w stringach literalnych. */
  showTextHex(codes: number[]): this {
    this.lines.push(`<${codes.map((c) => c.toString(16).padStart(2, '0')).join('')}> Tj`);
    return this;
  }

  /**
   * TJ z tablica hex-stringow i liczb kerningu (przesuniecie w tysiecznych em, dodatnie
   * przesuwa w LEWO). Uzywane do kerningu-w-jednym-itemie z szpargalki.
   */
  showTextArrayHex(parts: (number[] | number)[]): this {
    const rendered = parts
      .map((p) => (Array.isArray(p) ? `<${p.map((c) => c.toString(16).padStart(2, '0')).join('')}>` : `${p}`))
      .join(' ');
    this.lines.push(`[${rendered}] TJ`);
    return this;
  }

  /** Surowa linia operatora — furtka dla przypadkow nie pokrytych powyzej. */
  raw(line: string): this {
    this.lines.push(line);
    return this;
  }

  /**
   * Obraz inline (BI...ID...EI) — jedyny sposob osadzenia obrazu BEZ referencji
   * do obiektu PDF (brak XObject), stad `paintInlineImageXObject` w pdf.js nigdy
   * nie ma objId (KROK-4). `data` to SUROWE bajty (bez filtra), latin1-bezpieczne
   * 1:1 z bajtami wyjsciowymi — dziala nawet gdy dane zawieraja bajt 0x0A, bo
   * `join('\n')` tylko WSTAWIA separatory MIEDZY elementami tablicy, nie parsuje
   * zawartosci kazdego elementu.
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

/** Koduje string JS na tablice kodow 1-bajtowych 0..255 (identycznosc code point <-> bajt). */
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

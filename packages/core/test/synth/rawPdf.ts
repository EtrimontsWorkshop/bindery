/**
 * Minimalny emiter surowego PDF-a — kontrola na poziomie obiektów i xref, nie
 * abstrakcji "narysuj tekst". Patrz KROK-3-fixtures.md dla uzasadnienia,
 * dlaczego nie pdf-lib/PDFKit.
 *
 * Determinizm jest wymogiem twardym: /ID stale, brak znacznikow czasu, kolejnosc
 * obiektow ustalona przez kolejnosc wywolan writeObj/writeStreamObj.
 */

const FIXED_ID_HEX = '00112233445566778899aabbccddeeff0102030405060708090a0b0c0d0e0f';

function pad10(n: number): string {
  return String(n).padStart(10, '0');
}

export class PdfWriter {
  private chunks: Buffer[] = [];
  private offset = 0;
  private objOffsets = new Map<number, number>();
  private nextObjNum = 1;

  constructor() {
    // Naglowek + komentarz binarny (4 bajty > 0x80) — konwencja PDF sygnalizujaca
    // narzedziom, ze plik zawiera dane binarne.
    this.raw('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');
  }

  private raw(data: string | Buffer): void {
    const buf = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
    this.chunks.push(buf);
    this.offset += buf.length;
  }

  /** Rezerwuje numer obiektu bez zapisywania tresci — do referencji "do przodu" (Kids, Parent). */
  reserveObj(): number {
    return this.nextObjNum++;
  }

  ref(num: number): string {
    return `${num} 0 R`;
  }

  /** Zapisuje obiekt nie-strumieniowy (slownik, tablica, itp.) pod wczesniej zarezerwowanym numerem. */
  writeObj(num: number, body: string): void {
    if (this.objOffsets.has(num)) {
      throw new Error(`obiekt ${num} juz zapisany`);
    }
    this.objOffsets.set(num, this.offset);
    this.raw(`${num} 0 obj\n${body}\nendobj\n`);
  }

  /** Jak writeObj, ale alokuje numer w miejscu (gdy nie potrzeba referencji do przodu). */
  addObj(body: string): number {
    const num = this.reserveObj();
    this.writeObj(num, body);
    return num;
  }

  /**
   * Zapisuje obiekt strumieniowy. `dictInner` to zawartosc slownika BEZ `<<`/`>>`
   * i BEZ `/Length` — /Length jest dopisywane automatycznie na podstawie danych.
   */
  writeStreamObj(num: number, dictInner: string, data: Buffer): void {
    if (this.objOffsets.has(num)) {
      throw new Error(`obiekt ${num} juz zapisany`);
    }
    this.objOffsets.set(num, this.offset);
    this.raw(`${num} 0 obj\n<< ${dictInner} /Length ${data.length} >>\nstream\n`);
    this.raw(data);
    this.raw('\nendstream\nendobj\n');
  }

  addStreamObj(dictInner: string, data: Buffer): number {
    const num = this.reserveObj();
    this.writeStreamObj(num, dictInner, data);
    return num;
  }

  /** Konczy plik: tablica xref, trailer, startxref. Zwraca kompletny bufor PDF-a. */
  finish(rootRef: number): Buffer {
    const xrefOffset = this.offset;
    const size = this.nextObjNum; // obiekty 1..nextObjNum-1, plus obiekt 0 (wolna lista)

    let xref = `xref\n0 ${size}\n`;
    // Wpis obiektu 0 — glowa listy wolnych obiektow. Dokladnie 20 bajtow na wpis.
    xref += `${pad10(0)} 65535 f\r\n`;
    for (let i = 1; i < size; i++) {
      const off = this.objOffsets.get(i);
      if (off === undefined) {
        throw new Error(`obiekt ${i} zarezerwowany, ale nigdy nie zapisany (writeObj/writeStreamObj)`);
      }
      xref += `${pad10(off)} 00000 n\r\n`;
    }
    this.raw(xref);

    const id = `<${FIXED_ID_HEX}> <${FIXED_ID_HEX}>`;
    this.raw(
      `trailer\n<< /Size ${size} /Root ${rootRef} 0 R /ID [${id}] >>\nstartxref\n${xrefOffset}\n%%EOF`,
    );

    return Buffer.concat(this.chunks);
  }
}

/** Buduje zawartosc slownika /Catalog. */
export function catalogDict(pagesRef: number): string {
  return `<< /Type /Catalog /Pages ${pagesRef} 0 R >>`;
}

/** Buduje zawartosc slownika /Pages (wezel nadrzedny). */
export function pagesDict(kidRefs: number[]): string {
  const kids = kidRefs.map((r) => `${r} 0 R`).join(' ');
  return `<< /Type /Pages /Kids [${kids}] /Count ${kidRefs.length} >>`;
}

export interface PageDictOptions {
  parentRef: number;
  mediaBox: [number, number, number, number];
  contentsRef: number | number[];
  resourcesInner: string;
  rotate?: 0 | 90 | 180 | 270;
}

/** Buduje zawartosc slownika /Page. */
export function pageDict(opts: PageDictOptions): string {
  const box = opts.mediaBox.join(' ');
  const contents = Array.isArray(opts.contentsRef)
    ? `[${opts.contentsRef.map((r) => `${r} 0 R`).join(' ')}]`
    : `${opts.contentsRef} 0 R`;
  const rotate = opts.rotate ? ` /Rotate ${opts.rotate}` : '';
  return `<< /Type /Page /Parent ${opts.parentRef} 0 R /MediaBox [${box}] /Contents ${contents} /Resources << ${opts.resourcesInner} >>${rotate} >>`;
}

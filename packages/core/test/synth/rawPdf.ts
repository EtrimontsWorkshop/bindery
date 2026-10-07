/**
 * A minimal raw PDF emitter — control at the level of objects and xref, not of a "draw text"
 * abstraction. Chosen over pdf-lib/PDFKit for exactly that reason.
 *
 * Determinism is a hard requirement: a constant /ID, no timestamps, the object order fixed by the
 * order of writeObj/writeStreamObj calls.
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
    // The header + a binary comment (4 bytes > 0x80) — a PDF convention signaling to tools that the
    // file contains binary data.
    this.raw('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');
  }

  private raw(data: string | Buffer): void {
    const buf = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
    this.chunks.push(buf);
    this.offset += buf.length;
  }

  /** Reserves an object number without writing content — for forward references (Kids, Parent). */
  reserveObj(): number {
    return this.nextObjNum++;
  }

  ref(num: number): string {
    return `${num} 0 R`;
  }

  /** Writes a non-stream object (a dictionary, an array, etc.) under a previously reserved number. */
  writeObj(num: number, body: string): void {
    if (this.objOffsets.has(num)) {
      throw new Error(`obiekt ${num} juz zapisany`);
    }
    this.objOffsets.set(num, this.offset);
    this.raw(`${num} 0 obj\n${body}\nendobj\n`);
  }

  /** Like writeObj, but allocates the number in place (when no forward reference is needed). */
  addObj(body: string): number {
    const num = this.reserveObj();
    this.writeObj(num, body);
    return num;
  }

  /**
   * Writes a stream object. `dictInner` is the dictionary content WITHOUT `<<`/`>>` and WITHOUT
   * `/Length` — /Length is appended automatically from the data.
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

  /** Finishes the file: the xref table, the trailer, startxref. Returns the complete PDF buffer. */
  finish(rootRef: number): Buffer {
    const xrefOffset = this.offset;
    const size = this.nextObjNum; // objects 1..nextObjNum-1, plus object 0 (the free list)

    let xref = `xref\n0 ${size}\n`;
    // The entry of object 0 — the head of the free-object list. Exactly 20 bytes per entry.
    xref += `${pad10(0)} 65535 f\r\n`;
    for (let i = 1; i < size; i++) {
      const off = this.objOffsets.get(i);
      if (off === undefined) {
        throw new Error(`object ${i} reserved but never written (writeObj/writeStreamObj)`);
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

/** Builds the content of the /Catalog dictionary. */
export function catalogDict(pagesRef: number): string {
  return `<< /Type /Catalog /Pages ${pagesRef} 0 R >>`;
}

/** Builds the content of the /Pages dictionary (the parent node). */
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

/** Builds the content of the /Page dictionary. */
export function pageDict(opts: PageDictOptions): string {
  const box = opts.mediaBox.join(' ');
  const contents = Array.isArray(opts.contentsRef)
    ? `[${opts.contentsRef.map((r) => `${r} 0 R`).join(' ')}]`
    : `${opts.contentsRef} 0 R`;
  const rotate = opts.rotate ? ` /Rotate ${opts.rotate}` : '';
  return `<< /Type /Page /Parent ${opts.parentRef} 0 R /MediaBox [${box}] /Contents ${contents} /Resources << ${opts.resourcesInner} >>${rotate} >>`;
}

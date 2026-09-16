import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';

/**
 * Prostokat wypelniony (fill) i osobny prostokat z obrysem+wypelnieniem
 * (fillStroke) — narysowane operatorem `re` (constructPath) wprost, bez
 * obrazow. KROK-4 nie miala ani jednego fixture'a przechodzacego
 * `constructPath` przez PRAWDZIWY pdf.js (obie fixtury pokrywajace ten
 * opcode w walkOperators.test.ts byly wylacznie na recznie napisanych
 * tablicach) — ten fixture zamyka te luke (KROK-5 Z7).
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  const content = Buffer.from(
    '0 0 0 rg 100 100 200 50 re f\n' + '1 0 0 RG 0 0 0 rg 350 400 80 80 re B\n',
    'latin1',
  );
  const contentRef = writer.addStreamObj('', content);

  writer.writeObj(catalogRef, catalogDict(pagesRef));
  writer.writeObj(pagesRef, pagesDict([pageRef]));
  writer.writeObj(
    pageRef,
    pageDict({
      parentRef: pagesRef,
      mediaBox: [0, 0, 612, 792],
      contentsRef: contentRef,
      resourcesInner: '',
    }),
  );

  return writer.finish(catalogRef);
}

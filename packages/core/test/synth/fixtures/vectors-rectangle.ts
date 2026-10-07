import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';

/**
 * A filled rectangle (fill) and a separate rectangle with outline+fill (fillStroke) — drawn with
 * the `re` operator (constructPath) directly, without images. Before it there wasn't a single
 * fixture passing `constructPath` through a REAL pdf.js (both fixtures covering this opcode in
 * walkOperators.test.ts were only on hand-written arrays) — this fixture closes that gap.
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

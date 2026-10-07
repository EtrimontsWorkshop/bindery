import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { imageXObject, solidRgb } from '../images.js';

/**
 * A POSITIVE case for the "geometry" evidence path of mask detection — unlike images-overlapping,
 * which checks ONLY the absence of false hits. Two images drawn directly one after the other (Do,
 * Do — no intermediate save/transform between them), under THE SAME CTM, so the bbox overlaps
 * 100% (>=95% threshold) and the index difference is 2 (<=3 window threshold). A third, control
 * image is far away (a large index difference, no overlap) and should NOT get any mask evidence.
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  const underRef = imageXObject(writer, { width: 2, height: 2, rgb: solidRgb(2, 2, 200, 200, 200) });
  const overRef = imageXObject(writer, { width: 2, height: 2, rgb: solidRgb(2, 2, 20, 20, 20) });
  const controlRef = imageXObject(writer, { width: 2, height: 2, rgb: solidRgb(2, 2, 80, 160, 240) });

  const content = Buffer.from(
    'q 100 0 0 100 50 600 cm /Under1 Do /Over1 Do Q\n' + 'q 100 0 0 100 300 100 cm /Control1 Do Q\n',
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
      resourcesInner: `/XObject << /Under1 ${underRef} 0 R /Over1 ${overRef} 0 R /Control1 ${controlRef} 0 R >>`,
    }),
  );

  return writer.finish(catalogRef);
}

import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder } from '../contentStream.js';

/**
 * A "vector-drawn" map — a large filled rectangle (>=40% of the page), ZERO images on the whole
 * page. Tests the region-render fallback: the only way to extract anything when there is no image
 * for direct extraction (a vector region without an image -> region render).
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  const content = new ContentStreamBuilder().raw('56 96 500 600 re').raw('f').toBuffer();
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

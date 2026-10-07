import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder } from '../contentStream.js';
import { imageXObject, solidRgb } from '../images.js';

/**
 * A spread background with negative coordinates, extending past the MediaBox — print bleed. This
 * is not an error, it is a signal that the image is a background. The self-check (claims) doesn't
 * compute the bbox from the CTM — that is layout/image-pipeline logic. The property "the image
 * extends past the page" is documented in `expected` as ground truth.
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  const imgRef = imageXObject(writer, { width: 4, height: 4, rgb: solidRgb(4, 4, 80, 80, 120) });

  // MediaBox 612x792; the image 692x892 shifted by (-40,-50) — extends past every edge.
  const content = new ContentStreamBuilder().save().cm(692, 0, 0, 892, -40, -50).doXObject('Im1').restore().toBuffer();
  const contentRef = writer.addStreamObj('', content);

  writer.writeObj(catalogRef, catalogDict(pagesRef));
  writer.writeObj(pagesRef, pagesDict([pageRef]));
  writer.writeObj(
    pageRef,
    pageDict({
      parentRef: pagesRef,
      mediaBox: [0, 0, 612, 792],
      contentsRef: contentRef,
      resourcesInner: `/XObject << /Im1 ${imgRef} 0 R >>`,
    }),
  );

  return writer.finish(catalogRef);
}

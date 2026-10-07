import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { imageXObject, solidRgb } from '../images.js';

/**
 * A mask image drawn with the paintImageMaskXObject operator (opcode 83, /ImageMask true) — the
 * "opcode" evidence path of mask detection, unambiguous by the definition of the PDF format
 * (unlike "group"/Luminosity and the weaker "geometry"). Separately: an ordinary content image
 * with no mask evidence.
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  // A 2x2 stencil mask, 1 bit/pixel, /ImageMask true — verified empirically: the argsArray of
  // paintImageMaskXObject is a SINGLE object {data:objId,...}, NOT a plain string like with
  // paintImageXObject.
  const maskData = Buffer.from([0b11000000]);
  const maskRef = writer.addStreamObj(
    '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ImageMask true /Decode [0 1] /BitsPerComponent 1',
    maskData,
  );
  const contentImgRef = imageXObject(writer, { width: 4, height: 4, rgb: solidRgb(4, 4, 60, 140, 60) });

  const content = Buffer.from(
    'q 0 0 0 rg 100 0 0 100 50 600 cm /Mask1 Do Q\n' + 'q 100 0 0 100 300 600 cm /Content1 Do Q\n',
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
      resourcesInner: `/XObject << /Mask1 ${maskRef} 0 R /Content1 ${contentImgRef} 0 R >>`,
    }),
  );

  return writer.finish(catalogRef);
}

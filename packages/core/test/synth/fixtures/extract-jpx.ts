import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder } from '../contentStream.js';

/**
 * An image declared as JPEG2000 (`/Filter /JPXDecode`) with INVALID stream data — building a real,
 * valid JP2 codestream by hand is impractical. Tests NOT the decoding itself (that needs a real
 * file, see `tools/calibrate-images.ts`), only the ERROR-HANDLING PATH: decoding MUST end with a
 * `Diagnostic`, NEVER a silent skip — regardless of whether the data is valid or not. The
 * acceptance criterion: "the image decoded OR reported as a Diagnostic" — both outcomes are
 * acceptable, a silent absence of a trace is not.
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  // Invalid JPX data — large enough to pass basic stream-length validation, but not a valid JP2
  // codestream.
  const fakeJpxData = Buffer.alloc(256, 0);
  const imgRef = writer.addStreamObj(
    '/Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /JPXDecode',
    fakeJpxData,
  );

  const content = new ContentStreamBuilder().save().cm(500, 0, 0, 600, 56, 96).doXObject('Im1').restore().toBuffer();
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

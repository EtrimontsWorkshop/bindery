import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder } from '../contentStream.js';
import { imageXObject, luminosityExtGState } from '../images.js';

/**
 * The same picture and mask construction as `extract-masked`, but the luminosity mask lets MOST of the
 * picture through (9 of 10 mask pixels white; the black one trims the right edge, as the margin of a
 * tilted print does). Used to check that a mask that only trims the picture does not force a render of
 * the page region.
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  // A picture of a usable size with real variation (a flat colour would be reclassified as a plain fill).
  const size = 128;
  const pixels = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) pixels.set([(x * 2) % 256, (y * 2) % 256, (x * y) % 256], (y * size + x) * 3);
  const contentImgRef = imageXObject(writer, { width: size, height: size, rgb: pixels });

  const maskPixels = Buffer.concat([Buffer.alloc(27, 255), Buffer.alloc(3, 0)]);
  const maskImgRef = imageXObject(writer, { width: 10, height: 1, rgb: maskPixels });
  const maskFormContent = Buffer.from('/MaskImg Do\n', 'latin1');
  const maskFormRef = writer.addStreamObj(
    `/Type /XObject /Subtype /Form /FormType 1 /BBox [0 0 1 1] ` +
      `/Group << /Type /Group /S /Transparency /CS /DeviceRGB >> ` +
      `/Resources << /XObject << /MaskImg ${maskImgRef} 0 R >> >>`,
    maskFormContent,
  );
  const gsRef = luminosityExtGState(writer, maskFormRef);

  const content = new ContentStreamBuilder().save().cm(500, 0, 0, 600, 56, 96).gs('GS1').doXObject('Im1').restore().toBuffer();
  const contentRef = writer.addStreamObj('', content);

  writer.writeObj(catalogRef, catalogDict(pagesRef));
  writer.writeObj(pagesRef, pagesDict([pageRef]));
  writer.writeObj(
    pageRef,
    pageDict({
      parentRef: pagesRef,
      mediaBox: [0, 0, 612, 792],
      contentsRef: contentRef,
      resourcesInner: `/XObject << /Im1 ${contentImgRef} 0 R >> /ExtGState << /GS1 ${gsRef} 0 R >>`,
    }),
  );

  return writer.finish(catalogRef);
}

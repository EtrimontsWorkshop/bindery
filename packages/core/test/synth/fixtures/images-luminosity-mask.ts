import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder } from '../contentStream.js';
import { imageXObject, solidRgb, luminosityMaskForm, luminosityExtGState } from '../images.js';

/**
 * Jeden obraz namalowany pod maska luminancyjna (/ExtGState /SMask /Luminosity).
 * Testuje: pdf.js raportuje beginGroup z smask.subtype === "Luminosity" w operator
 * liscie (MDD F0, faza 3 — isMaskLayer). Zweryfikowane wprost w zrodle
 * PartialEvaluator.buildFormXObject (pdf.worker.mjs): beginGroup wymaga, zeby
 * cel /G maski mial wlasny /Group /S /Transparency.
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  const imgRef = imageXObject(writer, { width: 4, height: 4, rgb: solidRgb(4, 4, 200, 30, 30) });
  const maskFormRef = luminosityMaskForm(writer, { width: 100, height: 100 });
  const gsRef = luminosityExtGState(writer, maskFormRef);

  const content = new ContentStreamBuilder()
    .save()
    .cm(100, 0, 0, 100, 50, 600)
    .gs('GS1')
    .doXObject('Im1')
    .restore()
    .toBuffer();
  const contentRef = writer.addStreamObj('', content);

  writer.writeObj(catalogRef, catalogDict(pagesRef));
  writer.writeObj(pagesRef, pagesDict([pageRef]));
  writer.writeObj(
    pageRef,
    pageDict({
      parentRef: pagesRef,
      mediaBox: [0, 0, 612, 792],
      contentsRef: contentRef,
      resourcesInner: `/XObject << /Im1 ${imgRef} 0 R >> /ExtGState << /GS1 ${gsRef} 0 R >>`,
    }),
  );

  return writer.finish(catalogRef);
}

import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder } from '../contentStream.js';
import { imageXObject, solidRgb } from '../images.js';

/**
 * Baza duza (>=40% strony, ustala klasyfikacje `content` calego klastra) + 3
 * mniejsze obrazy ("ikony") czesciowo na niej lezace — wszystkie WZAJEMNIE
 * nakladajace sie (transytywnie przez baze). Testuje Z2: klaster nakladajacych
 * sie obrazow = JEDNA jednostka ekstrakcji (render regionu obejmujacy CALA
 * kompozycje), nie 4 osobne pliki.
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  const layout: Array<{ w: number; h: number; x: number; y: number }> = [
    { w: 500, h: 600, x: 56, y: 96 }, // baza
    { w: 60, h: 60, x: 100, y: 500 }, // ikona 1, na bazie
    { w: 60, h: 60, x: 400, y: 200 }, // ikona 2, na bazie
    { w: 40, h: 40, x: 250, y: 350 }, // ikona 3, na bazie
  ];

  const refs = layout.map((l, i) => imageXObject(writer, { width: 2, height: 2, rgb: solidRgb(2, 2, (i * 50) % 256, (i * 90) % 256, (i * 130) % 256) }));

  const cs = new ContentStreamBuilder();
  for (let i = 0; i < layout.length; i++) {
    const l = layout[i]!;
    cs.save().cm(l.w, 0, 0, l.h, l.x, l.y).doXObject(`I${i}`).restore();
  }
  const contentRef = writer.addStreamObj('', cs.toBuffer());
  const xobjectEntries = refs.map((r, i) => `/I${i} ${r} 0 R`).join(' ');

  writer.writeObj(catalogRef, catalogDict(pagesRef));
  writer.writeObj(pagesRef, pagesDict([pageRef]));
  writer.writeObj(
    pageRef,
    pageDict({
      parentRef: pagesRef,
      mediaBox: [0, 0, 612, 792],
      contentsRef: contentRef,
      resourcesInner: `/XObject << ${xobjectEntries} >>`,
    }),
  );

  return writer.finish(catalogRef);
}

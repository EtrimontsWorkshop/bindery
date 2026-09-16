import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder } from '../contentStream.js';
import { imageXObject, solidRgb } from '../images.js';

/**
 * 6 obrazow o czesciowo pokrywajacych sie bboxach (np. mapa + ikony na niej).
 * Testuje klastrowanie nakladajacych sie bboxow (MDD faza 3) — realne strony z
 * mapami maja dziesiatki takich nakladajacych sie obrazow (faza 0, Q3).
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  // Uklad: duzy obraz "bazowy" (mapa) + 5 mniejszych czesciowo na nim lezacych (ikony).
  const layout: Array<{ w: number; h: number; x: number; y: number }> = [
    { w: 400, h: 500, x: 100, y: 200 }, // baza
    { w: 80, h: 80, x: 120, y: 600 }, // naklada sie na baze (rog)
    { w: 80, h: 80, x: 420, y: 220 }, // naklada sie na baze (rog)
    { w: 60, h: 60, x: 280, y: 400 }, // w srodku bazy
    { w: 60, h: 60, x: 470, y: 500 }, // czesciowo poza baza
    { w: 40, h: 40, x: 30, y: 30 }, // calkowicie poza baza (bez nakladania)
  ];

  const refs = layout.map((l, i) =>
    imageXObject(writer, { width: 2, height: 2, rgb: solidRgb(2, 2, (i * 40) % 256, (i * 60) % 256, (i * 80) % 256) }),
  );

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

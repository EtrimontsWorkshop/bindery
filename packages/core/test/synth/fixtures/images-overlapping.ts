import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder } from '../contentStream.js';
import { imageXObject, solidRgb } from '../images.js';

/**
 * 6 images with partly overlapping bboxes (e.g. a map + icons on it). Tests the clustering of
 * overlapping bboxes — real map pages have dozens of such overlapping images.
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  // Layout: a large "base" image (a map) + 5 smaller ones lying partly on it (icons).
  const layout: Array<{ w: number; h: number; x: number; y: number }> = [
    { w: 400, h: 500, x: 100, y: 200 }, // the base
    { w: 80, h: 80, x: 120, y: 600 }, // overlaps the base (a corner)
    { w: 80, h: 80, x: 420, y: 220 }, // overlaps the base (a corner)
    { w: 60, h: 60, x: 280, y: 400 }, // in the middle of the base
    { w: 60, h: 60, x: 470, y: 500 }, // partly outside the base
    { w: 40, h: 40, x: 30, y: 30 }, // entirely outside the base (no overlap)
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

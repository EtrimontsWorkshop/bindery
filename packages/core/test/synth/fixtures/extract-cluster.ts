import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder } from '../contentStream.js';
import { imageXObject, solidRgb } from '../images.js';

/**
 * A large base (>=40% of the page, which sets the `content` classification of the whole cluster) +
 * 3 smaller images ("icons") partly lying on it — all MUTUALLY overlapping (transitively through
 * the base). Tests clustering: a cluster of overlapping images = ONE extraction unit (a region
 * render covering the WHOLE composition), not 4 separate files.
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  const layout: Array<{ w: number; h: number; x: number; y: number }> = [
    { w: 500, h: 600, x: 56, y: 96 }, // the base
    { w: 60, h: 60, x: 100, y: 500 }, // icon 1, on the base
    { w: 60, h: 60, x: 400, y: 200 }, // icon 2, on the base
    { w: 40, h: 40, x: 250, y: 350 }, // icon 3, on the base
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

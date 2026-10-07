import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder } from '../contentStream.js';
import { imageXObject, solidRgb } from '../images.js';

/**
 * Two INDEPENDENT images, each large (>10% of the page on its own), touching ONLY along a narrow
 * strip of an edge (overlapRatio < 20% of the smaller one's area) — unlike `extract-cluster` (a
 * small icon ENTIRELY inside a large base), here NEITHER image lies "on" the other, they simply
 * touch edges. Reproduces a bug reported live: on a real page, two portraits (~27%/~22% of the
 * page) were glued into one extraction unit whose bbox union also caught the column of text
 * between them. Tests that `groupIntoUnits` (buildImageExtraction.ts) does NOT merge such a pair —
 * two separate extraction units, not one.
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  // Page 612x792 (484 704 pt^2). A: 300x300=90000 (18.6%). B: 280x300=84000 (17.3%).
  // Overlap: x [330,340]=10pt * y [400,700]=300pt = 3000pt^2 -> overlapRatio relative to the
  // smaller (B, 84000) = 3.6% — well below the 20% threshold.
  const layout: Array<{ w: number; h: number; x: number; y: number }> = [
    { w: 300, h: 300, x: 40, y: 400 }, // image A
    { w: 280, h: 300, x: 330, y: 400 }, // image B, touches A with a narrow strip
  ];

  const refs = layout.map((l, i) => imageXObject(writer, { width: 2, height: 2, rgb: solidRgb(2, 2, (i * 80) % 256, (i * 140) % 256, (i * 200) % 256) }));

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

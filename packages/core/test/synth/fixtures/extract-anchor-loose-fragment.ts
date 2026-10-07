import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder } from '../contentStream.js';
import { imageXObject, solidRgb } from '../images.js';

/**
 * One "anchor" (a large image, >10% of the page) + one SMALL fragment (<2% of the page) touching it
 * ONLY with a narrow corner (overlapRatio relative to the fragment's OWN area ~9%, well below
 * `EDGE_TOUCH_MAX_OVERLAP_RATIO`=20%). Unlike `extract-cluster` (an icon ENTIRELY inside the base,
 * overlapRatio ~100%) — here the fragment does NOT belong to the anchor's composition, it merely
 * touches its corner by accident. Reproduces a bug reported live: an anchor (a portrait) + a small
 * fragment touching with a corner (a duplicate/leftover of a mask) on a real page — attaching the
 * fragment to the anchor stretched the union bbox ~200pt beyond the anchor, bringing back an
 * almost identical, too-wide result as before the fix.
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  // Page 612x792 (484 704 pt^2). Anchor: 320x392=125440 (25.9%). Fragment:
  // 30x30=900 (0.19%), the corner touching the anchor on a narrow strip.
  // Anchor: x[24,344], y[-1,391]. Fragment: x[324,354], y[219,249] ->
  // overlap x[324,344]=20, y[219,249]=30 (fully inside) -> 600pt^2, relative to the
  // fragment's own area (900) = 66.7%... too much. Pick a smaller overlap:
  // Fragment: x[338,368],y[219,249] -> overlap x[338,344]=6, y=30 (fully) -> 180pt^2,
  // relative to its own area (900) = 20% -- right at the limit. Reduce further:
  // Fragment: x[341,371],y[219,249] -> overlap x[341,344]=3, y=30 -> 90pt^2 / 900 = 10%.
  const layout: Array<{ w: number; h: number; x: number; y: number }> = [
    { w: 320, h: 392, x: 24, y: -1 }, // the anchor
    { w: 30, h: 30, x: 341, y: 219 }, // a small fragment, touches ONLY with a corner
  ];

  const refs = layout.map((l, i) => imageXObject(writer, { width: 2, height: 2, rgb: solidRgb(2, 2, (i * 90) % 256, (i * 150) % 256, (i * 210) % 256) }));

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

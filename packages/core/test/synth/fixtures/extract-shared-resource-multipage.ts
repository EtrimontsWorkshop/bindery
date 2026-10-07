import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder } from '../contentStream.js';
import { imageXObject, checkerboardRgb } from '../images.js';

/**
 * ONE shared PDF object (the same `objId`, pdf.js doesn't duplicate a resource between pages)
 * drawn on TWO pages in TWO completely different places — like a shared icon/board used
 * contextually in two separate places of a document, NOT a repeating ornament in the same
 * position (cf. `extract-decorated-3pages`, where the decoration is in THE SAME position on every
 * page). Each occurrence is large on its own (>=40% of the page, an unambiguous `content`), but
 * page 1 and page 2 use DIFFERENT coordinates and proportions.
 *
 * Page 1 has an ADDITIONAL small "helper" overlapping "Shared" with a corner — it forces
 * `clusterMemberCount > 1` (the region-render strategy, see `decideExtractionStrategy` in
 * `strategy.ts`), because a single "clean" image without a cluster goes through DIRECT extraction
 * (ignoring the unit's bbox entirely, returning the raw source dimensions 200x150) — without the
 * helper the test wouldn't exercise the bbox-union computation at all. Page 2 stays solo
 * (irrelevant to the assertions — we check ONLY page 1).
 *
 * Tests that `groupIntoUnits` (buildImageExtraction.ts) computes the unit's bbox union ONLY from
 * occurrences ON THE SAME page as the unit — the bbox of a unit rendered on page 1 MUST NOT contain
 * coordinates from the occurrence on page 2. Observed directly on a real rulebook (one resource
 * used in 5 different places on 5 different pages) — the bbox of a unit rendered on one page
 * covered the coordinates from ALL 5 pages, catching nearly all of that page's content when the
 * region was rendered (a whole statblock page extracted as an "image").
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRefs = [writer.reserveObj(), writer.reserveObj()];

  const imgRef = imageXObject(writer, { width: 200, height: 150, rgb: checkerboardRgb(200, 150, [10, 10, 10], [240, 240, 240]) });
  const helperRef = imageXObject(writer, { width: 2, height: 2, rgb: checkerboardRgb(2, 2, [50, 50, 50], [200, 200, 200]) });

  // Page 1: a narrow, tall rectangle (aspect ~0.32), x[20,270],y[8,784] — 40.0% of the area.
  // Plus a small helper (90x90pt, x[30,120],y[20,110]) overlapping the corner of "Shared".
  const cs1 = new ContentStreamBuilder()
    .save()
    .cm(250, 0, 0, 776, 20, 8)
    .doXObject('Shared')
    .restore()
    .save()
    .cm(90, 0, 0, 90, 30, 20)
    .doXObject('Helper')
    .restore();
  const contentRef1 = writer.addStreamObj('', cs1.toBuffer());

  // Page 2: THE SAME "Shared" resource, a wide, short rectangle (aspect ~1.85),
  // x[6,606],y[6,330] — 40.1% of the area. No helper (solo -> direct extraction,
  // irrelevant to this test). Intent: the bbox union from PAGE 1 and PAGE 2 (the pre-fix bug) would
  // give an aspect of ~0.77 — clearly told apart by the < 0.5 threshold from the correct result (~0.32).
  const cs2 = new ContentStreamBuilder().save().cm(600, 0, 0, 324, 6, 6).doXObject('Shared').restore();
  const contentRef2 = writer.addStreamObj('', cs2.toBuffer());

  writer.writeObj(
    pageRefs[0]!,
    pageDict({
      parentRef: pagesRef,
      mediaBox: [0, 0, 612, 792],
      contentsRef: contentRef1,
      resourcesInner: `/XObject << /Shared ${imgRef} 0 R /Helper ${helperRef} 0 R >>`,
    }),
  );
  writer.writeObj(
    pageRefs[1]!,
    pageDict({ parentRef: pagesRef, mediaBox: [0, 0, 612, 792], contentsRef: contentRef2, resourcesInner: `/XObject << /Shared ${imgRef} 0 R >>` }),
  );

  writer.writeObj(catalogRef, catalogDict(pagesRef));
  writer.writeObj(pagesRef, pagesDict(pageRefs));

  return writer.finish(catalogRef);
}

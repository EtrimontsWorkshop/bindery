import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder } from '../contentStream.js';
import { imageXObject, solidRgb, checkerboardRgb } from '../images.js';

/**
 * 3 pages: a SHARED decoration (the same PDF object in each page's Resources, small, fixed
 * position) + LARGE content (>=40%), UNIQUE per page (a different position/color). Tests that the
 * decoration must be classified as `decoration` on ALL THREE pages, INCLUDING THE FIRST — without
 * positional correlation (`correlatedWith`) the first occurrence of each such resource looks like
 * unique content, because pdf.js doesn't assign a stable `objId` from the first use (it splits
 * into `pageRefs=[1]` and `pageRefs=[2,3]` as TWO separate registry entries).
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRefs = [writer.reserveObj(), writer.reserveObj(), writer.reserveObj()];

  const decorationRef = imageXObject(writer, { width: 2, height: 2, rgb: solidRgb(2, 2, 10, 10, 10) });

  for (let p = 0; p < 3; p++) {
    // INTERNAL size >=100px (like extract-single-clean) — otherwise finalize.ts (MIN_ABSOLUTE_PX,
    // rejecting "too small to be content" after decoding) reclassifies it as `decoration` despite a
    // large RELATIVE area. A checkerboard, not a flat color — see the comment in `extract-single-clean.ts`.
    const contentImgRef = imageXObject(writer, {
      width: 120,
      height: 100,
      rgb: checkerboardRgb(120, 100, [(p * 60 + 20) % 256, (p * 90 + 20) % 256, (p * 140 + 20) % 256], [(p * 60 + 120) % 256, (p * 90 + 120) % 256, (p * 140 + 120) % 256]),
    });
    const cs = new ContentStreamBuilder();
    cs.save().cm(30, 0, 0, 30, 10, 10).doXObject('Decor').restore();
    // The content position differs slightly per page (>0.5pt) — no accidental bbox correlation between pages.
    cs.save().cm(500, 0, 0, 600, 56, 96 + p * 2).doXObject('Content').restore();
    const contentRef = writer.addStreamObj('', cs.toBuffer());

    writer.writeObj(
      pageRefs[p]!,
      pageDict({
        parentRef: pagesRef,
        mediaBox: [0, 0, 612, 792],
        contentsRef: contentRef,
        resourcesInner: `/XObject << /Decor ${decorationRef} 0 R /Content ${contentImgRef} 0 R >>`,
      }),
    );
  }

  writer.writeObj(catalogRef, catalogDict(pagesRef));
  writer.writeObj(pagesRef, pagesDict(pageRefs));

  return writer.finish(catalogRef);
}

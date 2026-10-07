import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder } from '../contentStream.js';
import { imageXObject, solidRgb } from '../images.js';

/**
 * A variant of `extract-bleed.ts` with a SECOND, independent content image (a portrait in a
 * corner, entirely inside the MediaBox, ~15% of the page area — qualifies as an "anchor",
 * `isAnchorCandidate` in `buildImageExtraction.ts`) on THE SAME page as the full-bleed
 * background. Reproduces exactly a bug reported live: when the background is forced to `content`
 * (`treatFullBleedAsContent`), its bbox by definition "contains" every other image on the page
 * (`overlapRatio` relative to the smaller one ~1.0) — the usual anchor logic would merge both
 * into ONE unit, forcing a render of the WHOLE page (with text) instead of a clean direct
 * extraction of each one separately. The test in `groupDFixtures.test.ts` proves that
 * `isForcedFullBleedContent` in `buildImageExtraction.ts` prevents that.
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  // Background: 120x120px intrinsic (NOT 4x4 like `extract-bleed.ts`) — `finalize.ts` reclassifies
  // EVERY 'content' below `MIN_ABSOLUTE_PX` (100px) back to 'decoration' after decoding, regardless
  // of the classification confidence; a real full-page background from a book of course has far
  // more than 100px, so 4x4 here would be an unrealistic fixture artifact.
  const bgRef = imageXObject(writer, { width: 120, height: 120, rgb: solidRgb(120, 120, 80, 80, 120) });
  const portraitRef = imageXObject(writer, { width: 2, height: 2, rgb: solidRgb(2, 2, 220, 60, 60) });

  const content = new ContentStreamBuilder()
    .save()
    .cm(692, 0, 0, 892, -40, -50) // background: MediaBox 612x792, the image 692x892 -> extends past every edge
    .doXObject('Bg')
    .restore()
    .save()
    // 320x270pt: the longer edge >= LARGE_ABSOLUTE_SIZE_PT (300pt, classify.ts) — otherwise
    // `hasLargeAbsoluteOccurrence` is false and Z9-high-body-text-coverage (bodyBoxesByPage below
    // covers the WHOLE page) wrongly classifies the portrait as decoration instead of content,
    // before the isolation even gets a chance.
    .cm(320, 0, 0, 270, 280, 500) // a portrait in the top-right corner, ~18% of the page area, entirely inside the MediaBox
    .doXObject('Portrait')
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
      resourcesInner: `/XObject << /Bg ${bgRef} 0 R /Portrait ${portraitRef} 0 R >>`,
    }),
  );

  return writer.finish(catalogRef);
}

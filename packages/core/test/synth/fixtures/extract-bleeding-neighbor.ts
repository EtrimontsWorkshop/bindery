import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder } from '../contentStream.js';
import { imageXObject, checkerboardRgb } from '../images.js';

/**
 * A content photo (~18% of the page, entirely inside the MediaBox) and a second, smaller image
 * that sticks out past the right edge of the page (print bleed — think of a coloured tab at the
 * page edge) while overlapping the photo by roughly a fifth of its own area. The second image
 * carries no evidence of being content (it bleeds and no text covers its center), so it is
 * `undecided`. Reproduces a layout from a real rulebook, where such page-edge pieces were merged
 * into the photo's extraction unit: the unit's bbox grew to the edge of the page and downwards,
 * so the rendered "image" contained the text next to the photo. The test in
 * `groupDFixtures.test.ts` proves a bleeding `undecided` image is kept out of the photo's unit.
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  // Checkerboards, not flat colors: `finalize.ts` would reject a uniform image as a "flat texture".
  const photoRef = imageXObject(writer, { width: 200, height: 170, rgb: checkerboardRgb(200, 170, [10, 10, 10], [240, 240, 240]) });
  const tabRef = imageXObject(writer, { width: 120, height: 100, rgb: checkerboardRgb(120, 100, [40, 90, 40], [160, 210, 160]) });

  const content = new ContentStreamBuilder()
    .save()
    .cm(320, 0, 0, 270, 150, 380) // the photo: x 150..470, y 380..650, ~18% of the page, inside the MediaBox
    .doXObject('Photo')
    .restore()
    .save()
    .cm(240, 0, 0, 200, 400, 330) // the tab: x 400..640 (past the 612pt page edge), y 330..530, ~10% of the page; overlaps the photo
    .doXObject('Tab')
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
      resourcesInner: `/XObject << /Photo ${photoRef} 0 R /Tab ${tabRef} 0 R >>`,
    }),
  );

  return writer.finish(catalogRef);
}

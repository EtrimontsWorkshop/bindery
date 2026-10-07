import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder } from '../contentStream.js';
import { imageXObject, checkerboardRgb } from '../images.js';

/**
 * One image, no mask, no neighbors (its own cluster), a large share of the page (>=40%) — an
 * unambiguous `content` classification and the `direct` strategy (no mask, no cluster). The
 * INTERNAL size (200x150px) is DELIBERATELY different from the drawing scale on the page
 * (500x600pt) — direct extraction must return the FULL source resolution (200x150), independent
 * of `targetLongEdgePx` (that parameter concerns ONLY the region render).
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  // A checkerboard, not a flat color — `computeLuminanceStdDev` in `finalize.ts` would reject a
  // uniform image as a "flat texture" (stddev=0), which is the correct behavior for real files, but
  // misleading here, where the fixture tests something else (the full resolution of direct extraction).
  const imgRef = imageXObject(writer, { width: 200, height: 150, rgb: checkerboardRgb(200, 150, [10, 10, 10], [240, 240, 240]) });

  const content = new ContentStreamBuilder().save().cm(500, 0, 0, 600, 56, 96).doXObject('Im1').restore().toBuffer();
  const contentRef = writer.addStreamObj('', content);

  writer.writeObj(catalogRef, catalogDict(pagesRef));
  writer.writeObj(pagesRef, pagesDict([pageRef]));
  writer.writeObj(
    pageRef,
    pageDict({
      parentRef: pagesRef,
      mediaBox: [0, 0, 612, 792],
      contentsRef: contentRef,
      resourcesInner: `/XObject << /Im1 ${imgRef} 0 R >>`,
    }),
  );

  return writer.finish(catalogRef);
}

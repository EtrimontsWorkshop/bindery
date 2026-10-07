import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder } from '../contentStream.js';
import { imageXObject } from '../images.js';

/**
 * Reproduces EXACTLY a layout reported live from a real rulebook page: ONE flat image resource
 * (confirmed directly by `buildInventory` on the real file — there is no separate resource for the
 * portrait itself), where MOST pixels are a uniform "paper background" and a small checkerboard
 * "illustration" (an analog of an NPC portrait) is BAKED INTO the same raster, in one corner.
 * `treatFullBleedAsContent` on its own correctly reveals this whole image as `content`, but
 * without `autoCropUniformMargins` the export is the WHOLE canvas (empty background + portrait) —
 * the test in `groupDFixtures.test.ts` proves that the second flag really crops to the
 * illustration alone.
 */
function bakedInIllustrationRgb(width: number, height: number): Buffer {
  const buf = Buffer.alloc(width * height * 3);
  // Background: a uniform beige "paper".
  for (let i = 0; i < width * height; i++) {
    buf[i * 3] = 225;
    buf[i * 3 + 1] = 215;
    buf[i * 3 + 2] = 195;
  }
  // "Portrait": a checkerboard in the top-right corner, ~15% of the area.
  const illoW = Math.round(width * 0.35);
  const illoH = Math.round(height * 0.3);
  const illoX = width - illoW - 10;
  const illoY = 10;
  for (let y = illoY; y < illoY + illoH; y++) {
    for (let x = illoX; x < illoX + illoW; x++) {
      const i = (y * width + x) * 3;
      const on = (x + y) % 2 === 0;
      buf[i] = on ? 15 : 200;
      buf[i + 1] = on ? 25 : 60;
      buf[i + 2] = on ? 35 : 40;
    }
  }
  return buf;
}

export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  // Intrinsic 200x260 — both edges >= MIN_ABSOLUTE_PX (100px, finalize.ts), otherwise
  // `finalizeImages` reclassifies 'content' back to 'decoration' regardless of confidence (see the
  // analogous note in extract-bleed-with-content-sibling.ts).
  const imgRef = imageXObject(writer, { width: 200, height: 260, rgb: bakedInIllustrationRgb(200, 260) });

  // Full bleed: MediaBox 612x792, the image 692x892 shifted -> extends past every edge.
  const content = new ContentStreamBuilder().save().cm(692, 0, 0, 892, -40, -50).doXObject('Bg').restore().toBuffer();
  const contentRef = writer.addStreamObj('', content);

  writer.writeObj(catalogRef, catalogDict(pagesRef));
  writer.writeObj(pagesRef, pagesDict([pageRef]));
  writer.writeObj(
    pageRef,
    pageDict({
      parentRef: pagesRef,
      mediaBox: [0, 0, 612, 792],
      contentsRef: contentRef,
      resourcesInner: `/XObject << /Bg ${imgRef} 0 R >>`,
    }),
  );

  return writer.finish(catalogRef);
}

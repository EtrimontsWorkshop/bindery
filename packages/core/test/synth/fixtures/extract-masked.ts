import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder } from '../contentStream.js';
import { imageXObject, solidRgb, luminosityExtGState } from '../images.js';

/**
 * A large image (>=40% of the page, an unambiguous `content`) under a NON-UNIFORM luminosity mask —
 * the left half of the mask white (visible), the right black (hidden). Deliberately NON-UNIFORM
 * (unlike `luminosityMaskForm` in images.ts, which uses a uniform white for other tests) — it
 * lets us verify AFTER the render that the left and right halves of the RESULT are CLEARLY
 * different (the mask was actually applied), instead of only checking that
 * `strategy==='region-render'` (which proves only the choice of path, not the EFFECT).
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  const contentImgRef = imageXObject(writer, { width: 4, height: 4, rgb: solidRgb(4, 4, 220, 40, 40) });

  // A 2x1 mask: the left pixel white (visible), the right black (hidden).
  //
  // The form's BBox/cm MUST correspond to the unit square ([0 0 1 1], with no additional internal
  // scaling) — the CTM at the moment of `gs` (and so of the mask form) IS ALREADY the same CTM as
  // when drawing the content (500x/600x, set by the outer `cm` BEFORE `gs`). An earlier version of
  // this fixture added INSIDE the form ANOTHER `100 0 0 100 0 0 cm` (with BBox [0 0 100 100]) —
  // that multiplied with the outer scaling (500*100=50000), so the part of the mask visible (after
  // clipping to the page) covered ONLY the first (white) source pixel — the black half landed
  // far outside the page in device space. Verified empirically (debug: scanning a row of the
  // flattened mask canvas showed white across the WHOLE width, despite correctly decoded bytes
  // [255,255,255,0,0,0] in `page.objs`) — it was a bug in the fixture's construction, not in
  // pdf.js/@napi-rs/canvas.
  //
  // /CS /DeviceRGB here, NOT /DeviceGray (although DeviceGray is the textually correct/typical choice
  // for a luminosity mask) — DELIBERATELY, to avoid a REAL bug in the Node render:
  // `CanvasGraphics.prototype.#convertGroupToGray` (pdf.mjs, called in `endGroup` when
  // `group.isGray===true`, which the evaluator sets exactly when the form's Group dict has
  // `/CS /DeviceGray`) tries to "desaturate" the group's canvas by SELF-blitting:
  // `groupCtx.filter='grayscale(1)'; groupCtx.globalCompositeOperation='copy';
  // groupCtx.drawImage(canvas,0,0)` where `canvas === groupCtx.canvas` (source = target of the SAME
  // draw). Verified empirically (debug: a dump of the mask canvas pixels RIGHT BEFORE and RIGHT
  // AFTER that call): BEFORE — a correct white/black split; AFTER — the WHOLE canvas uniformly
  // white. `@napi-rs/canvas` doesn't actually implement the `grayscale(1)` filter
  // (`FeatureTest.isCanvasFilterSupported` wrongly reports support, because it only checks
  // `ctx.filter !== undefined` — see also `NodeFilterFactory.addLuminosityFilter`, which for the
  // same reason returns `"none"`, forcing a separate, CORRECT manual luminance->alpha conversion
  // path in `_bakeSMaskCanvas`), and a self-blit with `globalCompositeOperation='copy'` in that
  // situation wipes out the content instead of copying it. THIS IS NOT a bug in this repo or in our
  // fixture — it is a bug in the interaction of pdf.js (Node/`NodeCanvasFactory`) +
  // `@napi-rs/canvas`, which does NOT affect real Foundry/the browser (`browserRegionRenderer`,
  // OffscreenCanvas, where `DOMFilterFactory` builds a real SVG filter). We bypass it here with
  // `/CS /DeviceRGB` (it doesn't set `group.isGray`; the Luminosity semantics still come from
  // `/S /Luminosity` in the ExtGState, not from the Group CS) — see the pdf.js findings notes for
  // the full description and risk assessment for real PDFs using DeviceGray (the typical,
  // recommended practice).
  const maskPixels = Buffer.from([255, 255, 255, 0, 0, 0]);
  const maskImgRef = imageXObject(writer, { width: 2, height: 1, rgb: maskPixels });
  const maskFormContent = Buffer.from('/MaskImg Do\n', 'latin1');
  const maskFormRef = writer.addStreamObj(
    `/Type /XObject /Subtype /Form /FormType 1 /BBox [0 0 1 1] ` +
      `/Group << /Type /Group /S /Transparency /CS /DeviceRGB >> ` +
      `/Resources << /XObject << /MaskImg ${maskImgRef} 0 R >> >>`,
    maskFormContent,
  );
  const gsRef = luminosityExtGState(writer, maskFormRef);

  const content = new ContentStreamBuilder().save().cm(500, 0, 0, 600, 56, 96).gs('GS1').doXObject('Im1').restore().toBuffer();
  const contentRef = writer.addStreamObj('', content);

  writer.writeObj(catalogRef, catalogDict(pagesRef));
  writer.writeObj(pagesRef, pagesDict([pageRef]));
  writer.writeObj(
    pageRef,
    pageDict({
      parentRef: pagesRef,
      mediaBox: [0, 0, 612, 792],
      contentsRef: contentRef,
      resourcesInner: `/XObject << /Im1 ${contentImgRef} 0 R >> /ExtGState << /GS1 ${gsRef} 0 R >>`,
    }),
  );

  return writer.finish(catalogRef);
}

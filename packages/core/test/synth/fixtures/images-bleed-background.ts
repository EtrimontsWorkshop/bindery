import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder } from '../contentStream.js';
import { imageXObject, solidRgb } from '../images.js';

/**
 * Tlo rozkladowkowe z ujemnymi wspolrzednymi, wykraczajace poza MediaBox — spad
 * drukarski. MDD F0: to nie blad, to sygnal ze obraz jest tlem (faza 3).
 * Samokontrola (claims) nie liczy bbox z CTM — to logika fazy 2/3. Wlasciwosc
 * "obraz wychodzi poza strone" jest udokumentowana w `expected` jako ground truth.
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  const imgRef = imageXObject(writer, { width: 4, height: 4, rgb: solidRgb(4, 4, 80, 80, 120) });

  // MediaBox 612x792; obraz 692x892 przesuniety o (-40,-50) — wychodzi poza kazda krawedz.
  const content = new ContentStreamBuilder().save().cm(692, 0, 0, 892, -40, -50).doXObject('Im1').restore().toBuffer();
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

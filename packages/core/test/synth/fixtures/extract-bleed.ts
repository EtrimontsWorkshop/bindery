import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder } from '../contentStream.js';
import { imageXObject, solidRgb } from '../images.js';

/**
 * Tlo pelnospadowe: obraz WIEKSZY niz MediaBox, przesuniety na ujemne
 * wspolrzedne — wychodzi poza KAZDA krawedz strony (spad drukarski, MDD F0).
 * Testuje klasyfikacje `decoration`, NIE `scene` — mimo ogromnej powierzchni
 * wzglednej (>100% strony), ktora BEZ sprawdzenia pozycji pelnospadowej
 * bylaby mylnie zlapana przez regule "duza powierzchnia = tresc" (Z1).
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

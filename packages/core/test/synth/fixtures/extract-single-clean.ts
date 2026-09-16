import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder } from '../contentStream.js';
import { imageXObject, checkerboardRgb } from '../images.js';

/**
 * Jeden obraz, bez maski, bez sasiadow (wlasny klaster), duza powierzchnia
 * strony (>=40%) — jednoznaczna klasyfikacja `content` (Z1) i strategia
 * `direct` (Z2: brak maski, brak klastra). Rozmiar WEWNETRZNY (200x150px)
 * CELOWO inny niz skala rysowania na stronie (500x600pt) — bezposrednia
 * ekstrakcja musi zwrocic PELNA rozdzielczosc zrodlowa (200x150), niezalezna
 * od `targetLongEdgePx` (ten parametr dotyczy WYLACZNIE renderu regionu, Z3).
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  // Szachownica, nie jednolity kolor (KROK-8 Z2) — `computeLuminanceStdDev` w
  // `finalize.ts` odrzucalby jednolity obraz jako "plaska tekstura" (stddev=0),
  // co jest poprawnym zachowaniem dla prawdziwych plikow, ale mylace tutaj,
  // gdzie fixture testuje co innego (pelna rozdzielczosc ekstrakcji bezposredniej).
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

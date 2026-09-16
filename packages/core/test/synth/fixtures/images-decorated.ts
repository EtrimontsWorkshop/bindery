import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder } from '../contentStream.js';
import { imageXObject, solidRgb } from '../images.js';

const PAGE_COUNT = 3;
const UNIQUE_PER_PAGE = 54; // + 1 dekoracja wspoldzielona = 55 na strone

/**
 * 3 strony, 55+ obrazow na kazdej: jeden ozdobnik (ten sam obiekt PDF, wspoldzielony
 * przez wszystkie strony) + ~54 unikalnych malych obrazow per strona. Testuje sygnal
 * klasyfikacji tresc/dekoracja z fazy 3 (MDD §8 faza 3): zasob powtarzajacy sie na
 * wielu stronach (`pageRefs.length`) to najsilniejszy sygnal dekoracji.
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRefs = Array.from({ length: PAGE_COUNT }, () => writer.reserveObj());

  // Ozdobnik: JEDEN obiekt PDF, referencje z Resources kazdej strony wskazuja na
  // ten sam numer obiektu — dokladnie tak wyglada w praktyce zasob dzielony
  // miedzy stronami (np. ramka/tlo z szablonu strony).
  const decorationRef = imageXObject(writer, { width: 2, height: 2, rgb: solidRgb(2, 2, 10, 10, 10) });

  for (let p = 0; p < PAGE_COUNT; p++) {
    const uniqueRefs: number[] = [];
    for (let i = 0; i < UNIQUE_PER_PAGE; i++) {
      uniqueRefs.push(imageXObject(writer, { width: 2, height: 2, rgb: solidRgb(2, 2, (i * 7) % 256, (i * 13) % 256, (i * 19) % 256) }));
    }

    const cs = new ContentStreamBuilder();
    cs.save().cm(600, 0, 0, 780, 6, 6).doXObject('Decor').restore();
    for (let i = 0; i < uniqueRefs.length; i++) {
      const x = 20 + (i % 10) * 55;
      const y = 20 + Math.floor(i / 10) * 55;
      cs.save().cm(40, 0, 0, 40, x, y).doXObject(`U${i}`).restore();
    }
    const contentRef = writer.addStreamObj('', cs.toBuffer());

    const xobjectEntries = [`/Decor ${decorationRef} 0 R`, ...uniqueRefs.map((r, i) => `/U${i} ${r} 0 R`)].join(' ');

    writer.writeObj(
      pageRefs[p]!,
      pageDict({
        parentRef: pagesRef,
        mediaBox: [0, 0, 612, 792],
        contentsRef: contentRef,
        resourcesInner: `/XObject << ${xobjectEntries} >>`,
      }),
    );
  }

  writer.writeObj(catalogRef, catalogDict(pagesRef));
  writer.writeObj(pagesRef, pagesDict(pageRefs));

  return writer.finish(catalogRef);
}

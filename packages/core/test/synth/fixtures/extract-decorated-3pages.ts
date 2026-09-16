import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder } from '../contentStream.js';
import { imageXObject, solidRgb, checkerboardRgb } from '../images.js';

/**
 * 3 strony: ozdobnik WSPOLDZIELONY (ten sam obiekt PDF w Resources kazdej
 * strony, maly, stala pozycja) + tresc DUZA (>=40%), UNIKALNA per strona
 * (inna pozycja/kolor). Testuje U1: ozdobnik musi byc sklasyfikowany jako
 * `decoration` na WSZYSTKICH TRZECH stronach, W TYM PIERWSZEJ — bez korelacji
 * pozycyjnej (`correlatedWith`) pierwsze wystapienie kazdego takiego zasobu
 * wyglada jak unikalna tresc (MDD faza 3), bo pdf.js nie przydziela stabilnego
 * `objId` od pierwszego uzycia (rozpada sie na `pageRefs=[1]` i
 * `pageRefs=[2,3]` jako DWA osobne wpisy rejestru).
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRefs = [writer.reserveObj(), writer.reserveObj(), writer.reserveObj()];

  const decorationRef = imageXObject(writer, { width: 2, height: 2, rgb: solidRgb(2, 2, 10, 10, 10) });

  for (let p = 0; p < 3; p++) {
    // Rozmiar WEWNETRZNY >=100px (jak extract-single-clean) — inaczej finalize.ts
    // (MIN_ABSOLUTE_PX, odrzucenie "za maly zeby byc tresciа" po dekodowaniu)
    // przeklasyfikowuje na `decoration` mimo duzej powierzchni WZGLEDNEJ (Z1).
    // Szachownica, nie jednolity kolor (KROK-8 Z2) — patrz komentarz w `extract-single-clean.ts`.
    const contentImgRef = imageXObject(writer, {
      width: 120,
      height: 100,
      rgb: checkerboardRgb(120, 100, [(p * 60 + 20) % 256, (p * 90 + 20) % 256, (p * 140 + 20) % 256], [(p * 60 + 120) % 256, (p * 90 + 120) % 256, (p * 140 + 120) % 256]),
    });
    const cs = new ContentStreamBuilder();
    cs.save().cm(30, 0, 0, 30, 10, 10).doXObject('Decor').restore();
    // Pozycja tresci lekko rozna per strona (>0.5pt) — bez przypadkowej korelacji bboksem miedzy stronami.
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

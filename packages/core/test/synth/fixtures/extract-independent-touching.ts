import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder } from '../contentStream.js';
import { imageXObject, solidRgb } from '../images.js';

/**
 * [KROK-16 Z2] Dwa NIEZALEZNE obrazy, kazdy duzy (>10% strony z osobna),
 * stykajace sie WYLACZNIE waskim paskiem krawedzi (overlapRatio < 20% powierzchni
 * mniejszego) — w odroznieniu od `extract-cluster` (mala ikona CALKOWICIE
 * wewnatrz duzej bazy), tu ZADEN obraz nie lezy "na" drugim, po prostu stykaja
 * sie brzegami. Odtwarza zgloszony na zywo blad: `Wrath_&_Glory_Komandozi_Rzezibrzucha.pdf`
 * str. 16, dwa portrety (~27%/~22% strony) sklejone w jedna jednostke
 * ekstrakcji, ktorej unia bboksow zlapala tez kolumne tekstu miedzy nimi.
 * Testuje ze `groupIntoUnits` (buildImageExtraction.ts) NIE laczy takiej pary —
 * dwie osobne jednostki ekstrakcji, nie jedna.
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  // Strona 612x792 (484 704 pt^2). A: 300x300=90000 (18.6%). B: 280x300=84000 (17.3%).
  // Naklad: x [330,340]=10pt * y [400,700]=300pt = 3000pt^2 -> overlapRatio wzgledem
  // mniejszego (B, 84000) = 3.6% — znacznie ponizej progu 20%.
  const layout: Array<{ w: number; h: number; x: number; y: number }> = [
    { w: 300, h: 300, x: 40, y: 400 }, // obraz A
    { w: 280, h: 300, x: 330, y: 400 }, // obraz B, styka sie z A waskim paskiem
  ];

  const refs = layout.map((l, i) => imageXObject(writer, { width: 2, height: 2, rgb: solidRgb(2, 2, (i * 80) % 256, (i * 140) % 256, (i * 200) % 256) }));

  const cs = new ContentStreamBuilder();
  for (let i = 0; i < layout.length; i++) {
    const l = layout[i]!;
    cs.save().cm(l.w, 0, 0, l.h, l.x, l.y).doXObject(`I${i}`).restore();
  }
  const contentRef = writer.addStreamObj('', cs.toBuffer());
  const xobjectEntries = refs.map((r, i) => `/I${i} ${r} 0 R`).join(' ');

  writer.writeObj(catalogRef, catalogDict(pagesRef));
  writer.writeObj(pagesRef, pagesDict([pageRef]));
  writer.writeObj(
    pageRef,
    pageDict({
      parentRef: pagesRef,
      mediaBox: [0, 0, 612, 792],
      contentsRef: contentRef,
      resourcesInner: `/XObject << ${xobjectEntries} >>`,
    }),
  );

  return writer.finish(catalogRef);
}

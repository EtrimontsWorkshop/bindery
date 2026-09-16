import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder } from '../contentStream.js';
import { imageXObject, solidRgb } from '../images.js';

/**
 * [KROK-16 Z2, trzecia iteracja naprawy] Jedna "kotwica" (duzy obraz, >10%
 * strony) + jeden MALY fragment (<2% strony) stykajacy sie z nia WYLACZNIE
 * waskim naroznikiem (overlapRatio wzgledem WLASNEJ powierzchni fragmentu
 * ~9%, znacznie ponizej `EDGE_TOUCH_MAX_OVERLAP_RATIO`=20%). W odroznieniu od
 * `extract-cluster` (ikona CALKOWICIE wewnatrz bazy, overlapRatio ~100%) —
 * tu fragment NIE nalezy do kompozycji kotwicy, tylko przypadkowo dotyka jej
 * rogu. Odtwarza zgloszony na zywo blad: `img_p13_1` (kotwica, portret) +
 * `img_p13_4` (maly fragment stykajacy sie rogiem, duplikat/pozostalosc po
 * masce) z `Wrath_&_Glory_Komandozi_Rzezibrzucha.pdf` str. 14 — dolaczenie
 * fragmentu do kotwicy rozciagalo union bbox ~200pt poza kotwice, odtwarzajac
 * niemal identyczny, zbyt szeroki wynik jak przed naprawa Z2.
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  // Strona 612x792 (484 704 pt^2). Kotwica: 320x392=125440 (25.9%). Fragment:
  // 30x30=900 (0.19%), rog stykajacy sie z kotwica na waskim pasku.
  // Kotwica: x[24,344], y[-1,391]. Fragment: x[324,354], y[219,249] ->
  // naklad x[324,344]=20, y[219,249]=30(fully inside) -> 600pt^2, wzgledem
  // wlasnej powierzchni fragmentu (900) = 66.7%... za duzo. Dobierz mniejszy naklad:
  // Fragment: x[338,368],y[219,249] -> naklad x[338,344]=6,y=30(fully) -> 180pt^2,
  // wzgledem wlasnej powierzchni (900) = 20% -- na granicy. Zmniejsz jeszcze:
  // Fragment: x[341,371],y[219,249] -> naklad x[341,344]=3,y=30 -> 90pt^2 / 900 = 10%.
  const layout: Array<{ w: number; h: number; x: number; y: number }> = [
    { w: 320, h: 392, x: 24, y: -1 }, // kotwica
    { w: 30, h: 30, x: 341, y: 219 }, // maly fragment, dotyka WYLACZNIE rogiem
  ];

  const refs = layout.map((l, i) => imageXObject(writer, { width: 2, height: 2, rgb: solidRgb(2, 2, (i * 90) % 256, (i * 150) % 256, (i * 210) % 256) }));

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

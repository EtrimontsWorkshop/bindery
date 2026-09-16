import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder } from '../contentStream.js';
import { imageXObject } from '../images.js';

/**
 * [na zyczenie uzytkownika, po naprawie "Wrak"] Odtwarza DOKLADNIE zgloszony
 * na zywo uklad prawdziwej strony 25 "Zew Cthulhu 7ed. Wrak.pdf": JEDEN plaski
 * zasob obrazu (potwierdzone wprost przez `buildInventory` na realnym pliku —
 * brak osobnego zasobu na sam portret), gdzie WIEKSZOSC pikseli to jednolite
 * "tlo papieru", a mala szachownicowa "ilustracja" (analog portretu NPC) jest
 * WYPALONA w tym samym rastrze, w jednym rogu. `treatFullBleedAsContent` sam w
 * sobie poprawnie ujawnia caly ten obraz jako `content`, ale bez
 * `autoCropUniformMargins` eksport to CALE plotno (puste tlo + portret) —
 * test w `groupDFixtures.test.ts` dowodzi, ze druga flaga faktycznie przycina
 * do samej ilustracji.
 */
function bakedInIllustrationRgb(width: number, height: number): Buffer {
  const buf = Buffer.alloc(width * height * 3);
  // Tlo: jednolity bezowy "papier".
  for (let i = 0; i < width * height; i++) {
    buf[i * 3] = 225;
    buf[i * 3 + 1] = 215;
    buf[i * 3 + 2] = 195;
  }
  // "Portret": szachownica w prawym gornym rogu, ~15% powierzchni.
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

  // Intrinsic 200x260 — obie krawedzie >= MIN_ABSOLUTE_PX (100px, finalize.ts),
  // inaczej `finalizeImages` reklasyfikuje 'content' z powrotem na 'decoration'
  // niezaleznie od pewnosci (patrz analogiczna uwaga w extract-bleed-with-content-sibling.ts).
  const imgRef = imageXObject(writer, { width: 200, height: 260, rgb: bakedInIllustrationRgb(200, 260) });

  // Pelny spad: MediaBox 612x792, obraz 692x892 przesuniety -> wychodzi poza kazda krawedz.
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

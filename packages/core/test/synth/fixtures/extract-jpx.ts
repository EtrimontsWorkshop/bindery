import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder } from '../contentStream.js';

/**
 * Obraz zadeklarowany jako JPEG2000 (`/Filter /JPXDecode`) z NIEPRAWIDLOWYMI
 * danymi strumienia — zbudowanie prawdziwego, poprawnego kodstrumienia JP2
 * recznie jest niepraktyczne (format zbyt zlozony na reczna konstrukcje jak
 * reszta generatora, patrz KROK-3). Testuje NIE samo dekodowanie (do tego
 * potrzebny prawdziwy plik z `samples/`, patrz `tools/calibrate-images.ts`),
 * tylko SCIEZKE OBSLUGI BLEDU (U6): dekodowanie MUSI zakonczyc sie
 * `Diagnostic`, NIGDY cichym pominieciem — niezaleznie od tego, czy dane sa
 * poprawne czy nie. Brief DoD: "obraz zdekodowany ALBO zgloszony jako
 * Diagnostic" — oba wyniki sa dopuszczalne, cichy brak sladu nie.
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  // Nieprawidlowe dane JPX — wystarczajaco duze, zeby przejsc podstawowa
  // walidacje dlugosci strumienia, ale nie jest to poprawny kodstrumień JP2.
  const fakeJpxData = Buffer.alloc(256, 0);
  const imgRef = writer.addStreamObj(
    '/Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /JPXDecode',
    fakeJpxData,
  );

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

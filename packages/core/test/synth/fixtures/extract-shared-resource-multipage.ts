import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder } from '../contentStream.js';
import { imageXObject, checkerboardRgb } from '../images.js';

/**
 * [KROK-16 Z2, czwarta iteracja naprawy] JEDEN wspoldzielony obiekt PDF (ten
 * sam `objId`, pdf.js nie duplikuje zasobu miedzy stronami) narysowany na
 * DWOCH stronach w DWOCH, kompletnie roznych miejscach — jak wspoldzielona
 * ikona/plansza uzyta kontekstowo w dwoch osobnych miejscach dokumentu, NIE
 * powtarzajacy sie ornament w tej samej pozycji (por. `extract-decorated-3pages`,
 * gdzie ozdobnik jest w TEJ SAMEJ pozycji na kazdej stronie). Kazde
 * wystapienie samo w sobie jest duze (>=40% strony, jednoznacznie `content`),
 * ale strona 1 i strona 2 uzywaja RUZNYCH wspolrzednych i proporcji.
 *
 * Strona 1 ma DODATKOWO maly "pomocnik" nakladajacy sie rogiem na "Shared" —
 * wymusza `clusterMemberCount > 1` (strategia region-render, patrz
 * `decideExtractionStrategy` w `strategy.ts`), bo pojedynczy "czysty" obraz
 * bez klastra idzie ekstrakcja BEZPOSREDNIA (ignoruje bbox jednostki
 * calkowicie, zwraca surowe wymiary zrodlowe 200x150) — bez pomocnika test
 * nie przecwiczylby wcale liczenia unii bboksow. Strona 2 zostaje solo
 * (nieistotna dla asercji — sprawdzamy WYLACZNIE stronę 1).
 *
 * Testuje ze `groupIntoUnits` (buildImageExtraction.ts) liczy unie bboksow
 * jednostki WYLACZNIE z wystapien NA TEJ SAMEJ stronie co jednostka — bbox
 * jednostki renderowanej na stronie 1 NIE moze zawierac wspolrzednych z
 * wystapienia na stronie 2. Zaobserwowane wprost: `g_d0_img_p7_8` z
 * `Wrath_&_Glory_Komandozi_Rzezibrzucha.pdf` (jeden zasob uzyty w 5 roznych
 * miejscach na 5 roznych stronach) — bbox jednostki renderowanej na jednej
 * stronie obejmowal wspolrzedne ze WSZYSTKICH 5 stron, lapiac przy renderze
 * regionu niemal cala tresc tej strony (cala strone statbloku wyekstrahowana
 * jako "obraz").
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRefs = [writer.reserveObj(), writer.reserveObj()];

  const imgRef = imageXObject(writer, { width: 200, height: 150, rgb: checkerboardRgb(200, 150, [10, 10, 10], [240, 240, 240]) });
  const helperRef = imageXObject(writer, { width: 2, height: 2, rgb: checkerboardRgb(2, 2, [50, 50, 50], [200, 200, 200]) });

  // Strona 1: waski i wysoki prostokat (aspekt ~0.32), x[20,270],y[8,784] — 40.0% powierzchni.
  // Plus maly pomocnik (90x90pt, x[30,120],y[20,110]) nakladajacy sie na rog "Shared".
  const cs1 = new ContentStreamBuilder()
    .save()
    .cm(250, 0, 0, 776, 20, 8)
    .doXObject('Shared')
    .restore()
    .save()
    .cm(90, 0, 0, 90, 30, 20)
    .doXObject('Helper')
    .restore();
  const contentRef1 = writer.addStreamObj('', cs1.toBuffer());

  // Strona 2: TEN SAM zasob "Shared", szeroki i niski prostokat (aspekt ~1.85),
  // x[6,606],y[6,330] — 40.1% powierzchni. Bez pomocnika (solo -> ekstrakcja
  // bezposrednia, nieistotna dla tego testu). Zamierzenie: unia bboksow ze
  // STRONY 1 i STRONY 2 (blad sprzed naprawy) dalaby aspekt ~0.77 —
  // jednoznacznie odrozniane progiem < 0.5 od poprawnego wyniku (~0.32).
  const cs2 = new ContentStreamBuilder().save().cm(600, 0, 0, 324, 6, 6).doXObject('Shared').restore();
  const contentRef2 = writer.addStreamObj('', cs2.toBuffer());

  writer.writeObj(
    pageRefs[0]!,
    pageDict({
      parentRef: pagesRef,
      mediaBox: [0, 0, 612, 792],
      contentsRef: contentRef1,
      resourcesInner: `/XObject << /Shared ${imgRef} 0 R /Helper ${helperRef} 0 R >>`,
    }),
  );
  writer.writeObj(
    pageRefs[1]!,
    pageDict({ parentRef: pagesRef, mediaBox: [0, 0, 612, 792], contentsRef: contentRef2, resourcesInner: `/XObject << /Shared ${imgRef} 0 R >>` }),
  );

  writer.writeObj(catalogRef, catalogDict(pagesRef));
  writer.writeObj(pagesRef, pagesDict(pageRefs));

  return writer.finish(catalogRef);
}

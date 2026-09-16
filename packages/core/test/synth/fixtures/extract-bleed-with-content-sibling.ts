import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder } from '../contentStream.js';
import { imageXObject, solidRgb } from '../images.js';

/**
 * [na zyczenie uzytkownika, po naprawie "Wrak"] Wariant `extract-bleed.ts` z
 * DRUGIM, niezaleznym obrazem tresci (portret w rogu, w calosci wewnatrz
 * MediaBox, ~15% powierzchni strony — kwalifikuje sie jako "kotwica",
 * `isAnchorCandidate` w `buildImageExtraction.ts`) na TEJ SAMEJ stronie co tlo
 * pelnospadowe. Odtwarza dokladnie zgloszony na zywo blad: gdy tlo zostaje
 * wymuszone na `content` (`treatFullBleedAsContent`), jego bbox z definicji
 * "zawiera" kazdy inny obraz na stronie (`overlapRatio` wzgledem mniejszego
 * ~1.0) — zwykla logika kotwic polaczylaby oba w JEDNA jednostke, wymuszajac
 * render CALEJ strony (z tekstem) zamiast czystej ekstrakcji bezposredniej
 * kazdego z osobna. Test w `groupDFixtures.test.ts` dowodzi, ze
 * `isForcedFullBleedContent` w `buildImageExtraction.ts` temu zapobiega.
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  // Tlo: 120x120px intrinsic (NIE 4x4 jak `extract-bleed.ts`) — `finalize.ts`
  // reklasyfikuje KAZDY 'content' ponizej `MIN_ABSOLUTE_PX` (100px) z powrotem
  // na 'decoration' po dekodowaniu, niezaleznie od pewnosci klasyfikacji;
  // prawdziwe tlo pelnostronicowe z ksiazki ma oczywiscie duzo wiecej niz
  // 100px, wiec 4x4 tutaj byloby nierealistycznym artefaktem fixtury.
  const bgRef = imageXObject(writer, { width: 120, height: 120, rgb: solidRgb(120, 120, 80, 80, 120) });
  const portraitRef = imageXObject(writer, { width: 2, height: 2, rgb: solidRgb(2, 2, 220, 60, 60) });

  const content = new ContentStreamBuilder()
    .save()
    .cm(692, 0, 0, 892, -40, -50) // tlo: MediaBox 612x792, obraz 692x892 -> wychodzi poza kazda krawedz
    .doXObject('Bg')
    .restore()
    .save()
    // 320x270pt: dluzsza krawedz >= LARGE_ABSOLUTE_SIZE_PT (300pt, classify.ts)
    // — inaczej `hasLargeAbsoluteOccurrence` jest false i Z9-high-body-text-coverage
    // (bodyBoxesByPage ponizej pokrywa CALA strone) mylnie klasyfikuje portret
    // jako decoration zamiast content, zanim izolacja w ogole dostanie szanse.
    .cm(320, 0, 0, 270, 280, 500) // portret w prawym gornym rogu, ~18% powierzchni strony, calkowicie w MediaBox
    .doXObject('Portrait')
    .restore()
    .toBuffer();
  const contentRef = writer.addStreamObj('', content);

  writer.writeObj(catalogRef, catalogDict(pagesRef));
  writer.writeObj(pagesRef, pagesDict([pageRef]));
  writer.writeObj(
    pageRef,
    pageDict({
      parentRef: pagesRef,
      mediaBox: [0, 0, 612, 792],
      contentsRef: contentRef,
      resourcesInner: `/XObject << /Bg ${bgRef} 0 R /Portrait ${portraitRef} 0 R >>`,
    }),
  );

  return writer.finish(catalogRef);
}

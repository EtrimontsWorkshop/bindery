import { PdfWriter, catalogDict, pagesDict, pageDict } from '../rawPdf.js';
import { ContentStreamBuilder } from '../contentStream.js';
import { imageXObject, solidRgb, luminosityExtGState } from '../images.js';

/**
 * Obraz duzy (>=40% strony, jednoznaczne `content`) pod maska luminancyjna
 * NIEJEDNOLITA — lewa polowa maski biala (widoczna), prawa czarna (ukryta).
 * Celowo NIEJEDNOLITA (nie jak `luminosityMaskForm` w images.ts, ktory dla
 * innych testow uzywa jednolitej bieli) — pozwala PO renderze zweryfikowac
 * fakt: lewa i prawa polowa WYNIKU musza byc WYRAZNIE rozne (maska faktycznie
 * zastosowana), zamiast tylko sprawdzac, ze `strategy==='region-render'`
 * (co udowadnia tylko wybor sciezki, nie EFEKT).
 */
export function build(): Buffer {
  const writer = new PdfWriter();
  const catalogRef = writer.reserveObj();
  const pagesRef = writer.reserveObj();
  const pageRef = writer.reserveObj();

  const contentImgRef = imageXObject(writer, { width: 4, height: 4, rgb: solidRgb(4, 4, 220, 40, 40) });

  // Maska 2x1: lewy piksel bialy (widoczny), prawy czarny (ukryty).
  //
  // [KROK-7, odkrycie] BBox/cm formy MUSI odpowiadac jednostce kwadratu
  // ([0 0 1 1], bez dodatkowego wewnetrznego skalowania) — CTM w momencie
  // wykonania `gs` (a wiec i formy maski) JEST JUZ tym samym CTM co przy
  // rysowaniu tresci (500x/600x, ustawionym przez zewnetrzny `cm` PRZED `gs`).
  // Wczesniejsza wersja tego fixture'u dodawala WEWNATRZ formy JESZCZE JEDNO
  // `100 0 0 100 0 0 cm` (z BBox [0 0 100 100]) — to mnozylo sie z zewnetrznym
  // skalowaniem (500*100=50000), przez co widoczny (po przycieciu do strony)
  // fragment maski obejmowal WYLACZNIE pierwszy (bialy) piksel zrodla —
  // czarna polowa ladowala w device-space daleko poza strona. Zweryfikowane
  // empirycznie (debug: skan wiersza sklejonego platna maski pokazywal biel
  // na CALEJ szerokosci, mimo poprawnie zdekodowanych bajtow [255,255,255,0,0,0]
  // w `page.objs`) — to byl blad konstrukcji fixture'u, nie pdf.js/@napi-rs/canvas.
  //
  // [KROK-7, odkrycie #3 — pdf.js x @napi-rs/canvas] /CS /DeviceRGB tutaj
  // NIE /DeviceGray (mimo ze DeviceGray jest tekstowo-poprawnym/typowym
  // wyborem dla maski luminancyjnej) — CELOWO, zeby ominac PRAWDZIWY blad w
  // renderze Node: `CanvasGraphics.prototype.#convertGroupToGray` (pdf.mjs,
  // wywolywane w `endGroup` gdy `group.isGray===true`, co evaluator ustawia
  // dokladnie wtedy gdy Group dict formy ma `/CS /DeviceGray`) probuje
  // "odszarzyc" platno grupy przez SAMO-blit: `groupCtx.filter='grayscale(1)';
  // groupCtx.globalCompositeOperation='copy'; groupCtx.drawImage(canvas,0,0)`
  // gdzie `canvas === groupCtx.canvas` (zrodlo = cel TEGO SAMEGO rysowania).
  // Zweryfikowane empirycznie (debug: dump pikseli platna maski TUZ PRZED i
  // TUZ PO tym wywolaniu): PRZED — poprawny podzial bialy/czarny; PO — CALE
  // platno jednolicie biale. `@napi-rs/canvas` nie implementuje faktycznie
  // filtra `grayscale(1)` (`FeatureTest.isCanvasFilterSupported` mylnie
  // raportuje wsparcie, bo tylko sprawdza `ctx.filter !== undefined` — patrz
  // tez `NodeFilterFactory.addLuminosityFilter` ktore z tego samego powodu
  // zwraca `"none"`, wymuszajac osobna, POPRAWNA reczna sciezke konwersji
  // luminancja->alfa w `_bakeSMaskCanvas`), a samo-blit z `globalCompositeOperation
  // ='copy'` w tej sytuacji zeruje/zamazuje tresc zamiast ja kopiowac.
  // TO NIE JEST blad w tym repo ani w naszym fixture — to blad w interakcji
  // pdf.js(Node/`NodeCanvasFactory`)+`@napi-rs/canvas`, ktory NIE dotyczy
  // prawdziwego Foundry/przegladarki (`browserRegionRenderer`, OffscreenCanvas,
  // gdzie `DOMFilterFactory` buduje prawdziwy filtr SVG). Omijamy go tutaj
  // przez `/CS /DeviceRGB` (nie ustawia `group.isGray`, semantyka Luminosity
  // nadal pochodzi z `/S /Luminosity` w ExtGState, nie z Group CS) — patrz
  // RAPORT-KROK-7.md, sekcja "odkrycia pdf.js", po pelny opis i ocene ryzyka
  // dla prawdziwych PDF-ow uzywajacych DeviceGray (typowa/zalecana praktyka).
  const maskPixels = Buffer.from([255, 255, 255, 0, 0, 0]);
  const maskImgRef = imageXObject(writer, { width: 2, height: 1, rgb: maskPixels });
  const maskFormContent = Buffer.from('/MaskImg Do\n', 'latin1');
  const maskFormRef = writer.addStreamObj(
    `/Type /XObject /Subtype /Form /FormType 1 /BBox [0 0 1 1] ` +
      `/Group << /Type /Group /S /Transparency /CS /DeviceRGB >> ` +
      `/Resources << /XObject << /MaskImg ${maskImgRef} 0 R >> >>`,
    maskFormContent,
  );
  const gsRef = luminosityExtGState(writer, maskFormRef);

  const content = new ContentStreamBuilder().save().cm(500, 0, 0, 600, 56, 96).gs('GS1').doXObject('Im1').restore().toBuffer();
  const contentRef = writer.addStreamObj('', content);

  writer.writeObj(catalogRef, catalogDict(pagesRef));
  writer.writeObj(pagesRef, pagesDict([pageRef]));
  writer.writeObj(
    pageRef,
    pageDict({
      parentRef: pagesRef,
      mediaBox: [0, 0, 612, 792],
      contentsRef: contentRef,
      resourcesInner: `/XObject << /Im1 ${contentImgRef} 0 R >> /ExtGState << /GS1 ${gsRef} 0 R >>`,
    }),
  );

  return writer.finish(catalogRef);
}

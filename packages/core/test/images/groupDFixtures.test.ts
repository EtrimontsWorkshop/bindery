import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { buildImageExtraction, type PdfDocumentLikeForImages } from '../../src/images/buildImageExtraction.js';
import { buildInventory } from '../../src/inventory/inventory.js';
import { nodeCanvasRegionRenderer } from '../../src/images/nodeCanvasRenderer.js';
import { nodeCanvasImageEncoder } from '../../src/images/nodeCanvasImageEncoder.js';

import { build as buildExtractSingleClean } from '../synth/fixtures/extract-single-clean.js';
import { build as buildExtractMasked } from '../synth/fixtures/extract-masked.js';
import { build as buildExtractCluster } from '../synth/fixtures/extract-cluster.js';
import { build as buildExtractVectorOnly } from '../synth/fixtures/extract-vector-only.js';
import { build as buildExtractDecorated3pages } from '../synth/fixtures/extract-decorated-3pages.js';
import { build as buildExtractJpx } from '../synth/fixtures/extract-jpx.js';
import { build as buildExtractBleed } from '../synth/fixtures/extract-bleed.js';
import { build as buildExtractIndependentTouching } from '../synth/fixtures/extract-independent-touching.js';
import { build as buildExtractAnchorLooseFragment } from '../synth/fixtures/extract-anchor-loose-fragment.js';
import { build as buildExtractSharedResourceMultipage } from '../synth/fixtures/extract-shared-resource-multipage.js';
import { build as buildExtractBleedWithContentSibling } from '../synth/fixtures/extract-bleed-with-content-sibling.js';
import { build as buildExtractBleedBakedInIllustration } from '../synth/fixtures/extract-bleed-baked-in-illustration.js';

/**
 * Testy integracyjne fixture'ow grupy D (KROK-7 Z7) — kazdy wiersz DoD z briefu
 * zweryfikowany na PRAWDZIWYM potoku (buildImageExtraction, uzywajacy
 * prawdziwych classify/strategy/extract/finalize), NIE na `claims` fixture'u
 * (te dowodza tylko faktow konstrukcyjnych, patrz test/synth/fixtures/*.json).
 */

async function openDoc(buf: Buffer): Promise<PdfDocumentLikeForImages> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  return doc as unknown as PdfDocumentLikeForImages;
}

// These synthetic fixtures use flat-color rectangles as stand-ins for real
// images, so the "hide single-color images" rule is off by default here — the
// tests below are about geometric classification. It's switched on explicitly
// in the test that covers the rule itself.
async function run(buf: Buffer, opts: { hideBackgroundImages?: boolean } = {}) {
  const invDoc = await openDoc(buf);
  const inv = await buildInventory(invDoc as never);
  const doc = await openDoc(buf);
  return buildImageExtraction(doc, inv, nodeCanvasRegionRenderer, nodeCanvasImageEncoder, { targetLongEdgePx: 512, hideBackgroundImages: false, ...opts });
}

describe('single-color images are hidden from the auto-detected list', () => {
  it('the flat-color background forced to content is hidden when the rule is on, and stays content when it is off', async () => {
    const buf = buildExtractBleedWithContentSibling();
    const invDoc = await openDoc(buf);
    const inv = await buildInventory(invDoc as never);
    // A body-text box covering the whole page supplies the second signal the full-bleed rules need (same trick as the tests below).
    const bodyBlockBoxesByPage = new Map(inv.perPage.map((p) => [p.pageNumber, [p.box]]));
    const runWith = async (hideBackgroundImages: boolean) =>
      buildImageExtraction(await openDoc(buf), inv, nodeCanvasRegionRenderer, nodeCanvasImageEncoder, { targetLongEdgePx: 512, bodyBlockBoxesByPage, treatFullBleedAsContent: true, hideBackgroundImages });
    const visible = (r: Awaited<ReturnType<typeof runWith>>) => r.images.filter((img) => img.classification === 'content' || img.classification === 'undecided').length;
    expect(visible(await runWith(true))).toBeLessThan(visible(await runWith(false)));
  });
});

describe('extract-single-clean: rozdzielczosc wyniku rowna zrodlowej', () => {
  it('ekstrakcja bezposrednia, 200x150px dokladnie, nie przeskalowane', async () => {
    const result = await run(buildExtractSingleClean());
    expect(result.images).toHaveLength(1);
    const img = result.images[0]!;
    expect(img.classification).toBe('content');
    expect(img.extractSource).toBe('objs');
    expect(img.width).toBe(200);
    expect(img.height).toBe(150);
  });
});

describe('extract-masked: maska widoczna w wyniku', () => {
  it('strategia region-render, lewa i prawa polowa wyniku WYRAZNIE rozne (maska faktycznie zastosowana)', async () => {
    const result = await run(buildExtractMasked());
    const content = result.images.find((img) => img.classification === 'content');
    expect(content).toBeDefined();
    expect(content!.extractSource).toBe('region-render');

    // Zdekoduj bajty WebP z powrotem, zeby sprawdzic PIKSELE (nie tylko metadane).
    // Uzywamy tego samego kodeka Node (napi-rs/canvas) do wczytania z powrotem.
    const { loadImage, createCanvas } = await import('@napi-rs/canvas');
    const image = await loadImage(Buffer.from(content!.payload.bytes));
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const leftPixel = ctx.getImageData(2, Math.floor(image.height / 2), 1, 1).data;
    const rightPixel = ctx.getImageData(image.width - 2, Math.floor(image.height / 2), 1, 1).data;
    const different =
      Math.abs(leftPixel[0]! - rightPixel[0]!) > 20 ||
      Math.abs(leftPixel[1]! - rightPixel[1]!) > 20 ||
      Math.abs(leftPixel[2]! - rightPixel[2]!) > 20 ||
      Math.abs(leftPixel[3]! - rightPixel[3]!) > 20;
    expect(different).toBe(true);
  });
});

describe('extract-cluster: jeden plik, nie cztery', () => {
  it('4 obrazy nakladajace sie -> dokladnie JEDEN wpis wyniku', async () => {
    const result = await run(buildExtractCluster());
    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.extractSource).toBe('region-render');
  });
});

describe('extract-independent-touching: dwa niezalezne obrazy, jedna wspolna krawedz', () => {
  // [KROK-16 Z2, naprawa zgloszonego bledu na zywo] Przed ta zmiana
  // `groupIntoUnits` laczylo KAZDA nakladajaca sie pare bez wzgledu na wielkosc
  // — dwa duze, niezalezne obrazy stykajace sie waskim paskiem krawedzi
  // (overlapRatio ~3.6%) trafialy w JEDNA jednostke, ktorej unia bboksow
  // obejmowala tez przestrzen (i ewentualny tekst) miedzy nimi. Kontrast z
  // `extract-cluster` (mala ikona CALKOWICIE wewnatrz duzej bazy, overlapRatio
  // bliskie 1.0) — tamten przypadek MUSI nadal sie laczyc.
  it('dwa obrazy >10% strony kazdy, nakladanie <20% mniejszego -> DWIE osobne jednostki, nie jedna', async () => {
    const result = await run(buildExtractIndependentTouching());
    expect(result.images).toHaveLength(2);
  });
});

describe('extract-anchor-loose-fragment: kotwica + fragment stykajacy sie rogiem', () => {
  // [KROK-16 Z2, trzecia iteracja naprawy] Sama obecnosc "najlepszej kotwicy"
  // (nawet jedynej na stronie) nie wystarcza do dolaczenia malego fragmentu —
  // wymagane jest silne nakladanie (overlapRatio >= 20% wzgledem WLASNEJ
  // powierzchni fragmentu). Ponizej tego progu fragment idzie do wlasnej,
  // osobnej jednostki, nie rozciaga union bboksu kotwicy.
  it('kotwica + fragment stykajacy sie rogiem (overlapRatio ~10%) -> DWIE osobne jednostki', async () => {
    const result = await run(buildExtractAnchorLooseFragment());
    expect(result.images).toHaveLength(2);
  });
});

describe('extract-shared-resource-multipage: wspoldzielony zasob, unia bboksow WYLACZNIE per strona', () => {
  // [KROK-16 Z2, czwarta iteracja naprawy] Bbox jednostki ekstrakcji dla
  // wpisu z wieloma wystapieniami na ROZNYCH stronach musi pochodzic
  // WYLACZNIE z wystapien NA TEJ SAMEJ stronie co jednostka — nie z unii
  // wszystkich wystapien encji niezaleznie od strony (co dawalo bezsensowna,
  // przypadkowo duza unie na Wrath_&_Glory_Komandozi_Rzezibrzucha.pdf).
  it('strona 1 (waski/wysoki, wymuszony region-render) -> aspekt WLASNEGO wystapienia, nie unii ze strona 2', async () => {
    const result = await run(buildExtractSharedResourceMultipage());
    const page1Units = result.images.filter((img) => img.entry.occurrences[0]!.page === 1);
    expect(page1Units.length).toBeGreaterThan(0);
    const shared = page1Units.find((img) => img.extractSource === 'region-render')!;
    expect(shared).toBeDefined();
    // Strona 1: waski/wysoki, aspekt ~0.32 (250/776). Unia z bledu sprzed
    // naprawy (obejmujaca tez wystapienie ze strony 2) dawalaby ~0.77 —
    // jednoznacznie odrozniane progiem < 0.5.
    expect(shared.width / shared.height).toBeLessThan(0.5);
  });
});

describe('extract-vector-only: mapa wyekstrahowana przez render', () => {
  it('brak obrazow na stronie, duzy region wektorowy -> jeden wpis przez region-render', async () => {
    const result = await run(buildExtractVectorOnly());
    expect(result.images).toHaveLength(1);
    const img = result.images[0]!;
    expect(img.entry.objId).toBeNull();
    expect(img.extractSource).toBe('region-render');
    expect(img.width).toBeGreaterThan(0);
    expect(img.height).toBeGreaterThan(0);
  });
});

describe('[U1] extract-decorated-3pages: ozdobnik jako decoration na WSZYSTKICH TRZECH stronach, w tym pierwszej', () => {
  it('korelacja pozycyjna domyka rozbicie objId — pierwsze wystapienie NIE wyglada jak unikalna tresc', async () => {
    const buf = buildExtractDecorated3pages();
    const invDoc = await openDoc(buf);
    const inv = await buildInventory(invDoc as never);

    const decorationEntries = inv.images.filter((e) => e.maxRelativeArea < 0.1); // ozdobnik jest maly, tresc duza (~62%)
    expect(decorationEntries.length).toBeGreaterThanOrEqual(1);
    // Przynajmniej jeden wpis ozdobnika musi miec pageRefs=[1] (pierwsze wystapienie) — dokladnie przypadek U1.
    const firstOccurrenceEntry = decorationEntries.find((e) => e.pageRefs.includes(1));
    expect(firstOccurrenceEntry).toBeDefined();

    const result = await run(buf);
    // [KROK-15 Z3, A10] Ozdobnik koreluje tylko na 3 strony (<5, nowy
    // skalibrowany prog `MULTI_PAGE_DECORATION_THRESHOLD` — patrz komentarz
    // przy stalej) i BEZ spadu drukarskiego jako drugiego sygnalu, wiec od
    // tego kroku NIE jest juz twardo `decoration` — spada do `undecided`
    // (`Z1-no-strong-signal`, bo jego wlasna powierzchnia jest za mala na
    // Z2-moderate) i JEST widoczny w wyniku, nie cichy odrzucony. To jest
    // ZAMIERZONE zachowanie A10 ("przy niepewnosci -> undecided, nigdy
    // decoration"), nie regresja mechanizmu korelacji U1 (ktory nadal
    // poprawnie ZAMYKA rozbicie objId — patrz asercje `decorationEntries`
    // wyzej, wciaz przechodzace bez zmian).
    const contentImages = result.images.filter((img) => img.classification === 'content');
    const undecidedImages = result.images.filter((img) => img.classification === 'undecided');
    expect(contentImages).toHaveLength(3);
    expect(new Set(contentImages.map((img) => img.entry.occurrences[0]!.page))).toEqual(new Set([1, 2, 3]));
    expect(undecidedImages.length).toBeGreaterThanOrEqual(1);
  });
});

describe('extract-jpx: obraz zdekodowany albo zgloszony jako Diagnostic', () => {
  it('dekodowanie nieprawidlowych danych JPX konczy sie Diagnostic, NIGDY cichym pominieciem', async () => {
    const result = await run(buildExtractJpx());
    // Albo udalo sie cos wyciagnac (przez fallback renderu), albo jest Diagnostic — NIGDY oba puste.
    const hasDiagnostic = result.diagnostics.some((d) => d.code === 'IMAGE_DECODE_FAILED' || d.code === 'IMAGE_DECODE_EMPTY');
    const hasResult = result.images.length > 0;
    expect(hasDiagnostic || hasResult).toBe(true);
    // Jesli jest wynik, MUSI to byc przez region-render (bezposrednia sciezka zawiodla, potwierdzone przez Diagnostic LUB brak wpisu w 'objs').
    if (hasResult && !hasDiagnostic) {
      // dopuszczalne, ale malo prawdopodobne z celowo bledynmi danymi — udokumentuj jesli wystapi
      expect(result.images[0]!.width).toBeGreaterThan(0);
    }
  });
});

describe('extract-bleed: decoration, nie scene', () => {
  it('tlo pelnospadowe Z TEKSTEM NA SRODKU (drugi sygnal, KROK-15 Z3/A10) klasyfikowane jako decoration mimo ogromnej powierzchni', async () => {
    const buf = buildExtractBleed();
    const invDoc = await openDoc(buf);
    const inv = await buildInventory(invDoc as never);
    const pageBoxByPage = new Map(inv.perPage.map((p) => [p.pageNumber, p.box]));
    const { classifyImages } = await import('../../src/images/classify.js');
    // [KROK-15 Z3, A10] Spad drukarski SAM w sobie juz nie wystarcza (patrz
    // komentarz przy `Z1-full-bleed-background` w classify.ts) — ta fixtura
    // testuje PRAWDZIWY przypadek tla: tekst akapitu NA SRODKU strony,
    // dokladnie tak jak realne teksturowane tlo z ksiazki (nie tylko geometria
    // spadu, ktora sama pasuje tez do celowej ilustracji rozkladowkowej).
    const bodyBoxesByPage = new Map(inv.perPage.map((p) => [p.pageNumber, [p.box]]));
    const classified = classifyImages(inv.images, pageBoxByPage, bodyBoxesByPage);
    expect(classified).toHaveLength(1);
    expect(classified[0]!.classification).toBe('decoration');
    expect(classified[0]!.reason).toBe('Z1-full-bleed-background');

    // I: wykluczony z wyniku koncowego (orkiestrator nie ekstrahuje 'decoration').
    // `run()` nie przekazuje bodyBoxesByPage (patrz jej definicja) — bez
    // drugiego sygnalu ten sam obraz teraz poprawnie laduje w `undecided`
    // (A10: niepewnosc -> undecided, nie decoration), wiec JEST w wyniku.
    const result = await run(buf);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.classification).toBe('undecided');
  });
});

describe('extract-bleed-with-content-sibling: [na zyczenie uzytkownika] tlo wymuszone na content NIE wchlania sasiedniego obrazu tresci', () => {
  it('treatFullBleedAsContent=true -> DWIE oddzielne jednostki (nie jedna), tlo ekstrahowane BEZPOSREDNIO (bez tekstu), nie jako render calej strony', async () => {
    const buf = buildExtractBleedWithContentSibling();
    const invDoc = await openDoc(buf);
    const inv = await buildInventory(invDoc as never);
    // Ten sam trik co `extract-bleed` wyzej: `bodyBoxesByPage` pokrywajace cala
    // strone WYMUSZA druga strone sygnalu (`centerTextCoverage`) potrzebna do
    // Z1-full-bleed-background/Z1-full-bleed-forced-content, bez potrzeby
    // prawdziwego tekstu w PDF.
    const bodyBlockBoxesByPage = new Map(inv.perPage.map((p) => [p.pageNumber, [p.box]]));

    const doc = await openDoc(buf);
    const result = await buildImageExtraction(doc, inv, nodeCanvasRegionRenderer, nodeCanvasImageEncoder, {
      targetLongEdgePx: 512,
      bodyBlockBoxesByPage,
      treatFullBleedAsContent: true,
      hideBackgroundImages: false,
    });

    // [regresja kluczowa] Bez izolacji `Z1-full-bleed-forced-content` w
    // `partitionCandidatesIntoGroups`, te dwa obrazy laczylyby sie w JEDNA
    // jednostke (bbox tla "zawiera" portret), dajac DLUGOSC 1 zamiast 2 i
    // `region-render` (z tekstem) zamiast `direct` dla tla.
    expect(result.images).toHaveLength(2);

    const bg = result.images.find((img) => img.width > img.height * 1.2 || img.entry.maxRelativeArea > 0.9)!;
    expect(bg).toBeDefined();
    expect(bg.classification).toBe('content');
    expect(bg.extractSource).toBe('objs');

    const portrait = result.images.find((img) => img !== bg)!;
    expect(portrait).toBeDefined();
  });
});

describe('extract-bleed-baked-in-illustration: [na zyczenie uzytkownika, EKSPERYMENTALNE] autoCropUniformMargins przycina do samej ilustracji', () => {
  it('bez autoCropUniformMargins: eksport to CALE plotno (200x260). Z flaga: WYRAZNIE mniejsze, obejmujace tylko rog z ilustracja', async () => {
    const buf = buildExtractBleedBakedInIllustration();

    async function extract(autoCropUniformMargins: boolean) {
      const invDoc = await openDoc(buf);
      const inv = await buildInventory(invDoc as never);
      const bodyBlockBoxesByPage = new Map(inv.perPage.map((p) => [p.pageNumber, [p.box]]));
      const doc = await openDoc(buf);
      return buildImageExtraction(doc, inv, nodeCanvasRegionRenderer, nodeCanvasImageEncoder, {
        targetLongEdgePx: 512,
        bodyBlockBoxesByPage,
        treatFullBleedAsContent: true,
        autoCropUniformMargins,
      });
    }

    const withoutCrop = await extract(false);
    expect(withoutCrop.images).toHaveLength(1);
    expect(withoutCrop.images[0]!.classification).toBe('content');
    expect(withoutCrop.images[0]!.width).toBe(200);
    expect(withoutCrop.images[0]!.height).toBe(260);

    const withCrop = await extract(true);
    expect(withCrop.images).toHaveLength(1);
    expect(withCrop.images[0]!.classification).toBe('content');
    // Ilustracja to ~35%x30% plotna w rogu — przyciety wynik MUSI byc WYRAZNIE
    // mniejszy niz oryginalne 200x260 (52000px^2), ale wciaz sensownego rozmiaru.
    const croppedArea = withCrop.images[0]!.width * withCrop.images[0]!.height;
    expect(croppedArea).toBeLessThan(200 * 260 * 0.5);
    expect(croppedArea).toBeGreaterThan(0);
  });

  /** [na zyczenie uzytkownika, "eksportowane obrazy sa troche za ciemne"] `brightenAutoCroppedImages` — WYLACZNIE dla obrazow faktycznie przycietych. */
  it('brightenAutoCroppedImages: obraz przyciety jest WYRAZNIE jasniejszy z flaga niz bez niej; bez przyciecia flaga nie zmienia nic', async () => {
    const buf = buildExtractBleedBakedInIllustration();

    async function extract(autoCropUniformMargins: boolean, brightenAutoCroppedImages: boolean) {
      const invDoc = await openDoc(buf);
      const inv = await buildInventory(invDoc as never);
      const bodyBlockBoxesByPage = new Map(inv.perPage.map((p) => [p.pageNumber, [p.box]]));
      const doc = await openDoc(buf);
      return buildImageExtraction(doc, inv, nodeCanvasRegionRenderer, nodeCanvasImageEncoder, {
        targetLongEdgePx: 512,
        bodyBlockBoxesByPage,
        treatFullBleedAsContent: true,
        autoCropUniformMargins,
        brightenAutoCroppedImages,
      });
    }

    async function avgLuminance(bytes: Uint8Array): Promise<number> {
      const { loadImage, createCanvas } = await import('@napi-rs/canvas');
      const image = await loadImage(Buffer.from(bytes));
      const canvas = createCanvas(image.width, image.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      const { data } = ctx.getImageData(0, 0, image.width, image.height);
      let sum = 0;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        sum += (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
        count++;
      }
      return sum / count;
    }

    const croppedDim = await extract(true, false);
    const croppedBright = await extract(true, true);
    const dimLuminance = await avgLuminance(croppedDim.images[0]!.payload.bytes);
    const brightLuminance = await avgLuminance(croppedBright.images[0]!.payload.bytes);
    expect(brightLuminance).toBeGreaterThan(dimLuminance + 5);

    // Bez przyciecia (`autoCropUniformMargins:false`), `brightenAutoCroppedImages`
    // nie ma nic do przyciecia -- obraz zostaje BAJT W BAJT identyczny.
    const uncroppedDim = await extract(false, false);
    const uncroppedBright = await extract(false, true);
    expect(uncroppedBright.images[0]!.contentHash).toBe(uncroppedDim.images[0]!.contentHash);
  });
});

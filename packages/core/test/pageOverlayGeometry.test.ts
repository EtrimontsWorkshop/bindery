import { describe, expect, it } from 'vitest';
import { pdfPointToScreen, pdfRectToScreen, screenPointToPdf, screenRectToPdf, screenRotatedRectToPdf, rotatedRectBounds, type RenderedPageGeometry } from '../src/pageOverlayGeometry.js';

/**
 * [KROK-11 Z3] Ta konkretna funkcja jest odpowiedzialna za czwarta (per
 * historia projektu) wersje bledu "wszystko odbite w pionie" — dlatego
 * pokrycie testowe jest tu celowo gestsze niz gdzie indziej, z wprost
 * policzonymi, czytelnymi dla czlowieka przykladami (nie tylko round-trip).
 */

const LETTER_PAGE: RenderedPageGeometry = {
  pageBox: { minX: 0, minY: 0, maxX: 612, maxY: 792 },
  imageWidthPx: 612,
  imageHeightPx: 792,
  rotation: 0,
};

describe('pdfPointToScreen — rotacja 0 (przypadek dominujacy, wszystkie 9 plikow samples/)', () => {
  it('lewy-DOLNY róg strony PDF (0,0) -> lewy-DOLNY róg ekranu (0, imageHeightPx) — Y odbite', () => {
    expect(pdfPointToScreen(0, 0, LETTER_PAGE)).toEqual([0, 792]);
  });

  it('lewy-GORNY róg strony PDF (0, maxY) -> lewy-GORNY róg ekranu (0,0)', () => {
    expect(pdfPointToScreen(0, 792, LETTER_PAGE)).toEqual([0, 0]);
  });

  it('prawy-GORNY róg strony PDF (maxX, maxY) -> prawy-GORNY róg ekranu (imageWidthPx, 0)', () => {
    expect(pdfPointToScreen(612, 792, LETTER_PAGE)).toEqual([612, 0]);
  });

  it('srodek strony -> srodek ekranu (Y-odbicie jest symetryczne w punkcie srodkowym)', () => {
    expect(pdfPointToScreen(306, 396, LETTER_PAGE)).toEqual([306, 396]);
  });

  it('punkt w 3/4 wysokosci OD DOLU (blisko gory strony PDF) -> 1/4 wysokosci OD GORY ekranu', () => {
    // y=594 to 75% wysokosci strony (0-792) liczac OD DOLU (konwencja PDF) —
    // blisko GORY strony wizualnie. Po odbiciu powinno wypasc blisko gory ekranu (25% z 792 = 198).
    const [, screenY] = pdfPointToScreen(0, 594, LETTER_PAGE);
    expect(screenY).toBeCloseTo(198, 5);
  });

  it('skalowanie: podglad wyrenderowany W INNEJ rozdzielczosci niz 1:1pt->1px nadal trafia we wlasciwe miejsce proporcjonalnie', () => {
    const scaledPage: RenderedPageGeometry = { pageBox: { minX: 0, minY: 0, maxX: 612, maxY: 792 }, imageWidthPx: 1224, imageHeightPx: 1584, rotation: 0 };
    // Skala 2x w obu osiach — te same rogi, podwojone piksele.
    expect(pdfPointToScreen(0, 0, scaledPage)).toEqual([0, 1584]);
    expect(pdfPointToScreen(612, 792, scaledPage)).toEqual([1224, 0]);
  });

  it('pageBox z niezerowym minX/minY (np. crop/spad) — normalizacja wzgledem WLASNEGO rogu strony, nie (0,0) globalnie', () => {
    const offsetPage: RenderedPageGeometry = { pageBox: { minX: 50, minY: 100, maxX: 350, maxY: 500 }, imageWidthPx: 300, imageHeightPx: 400, rotation: 0 };
    // Lewy-dolny róg strony (50,100) w przestrzeni PDF -> lewy-dolny róg ekranu (0, 400).
    expect(pdfPointToScreen(50, 100, offsetPage)).toEqual([0, 400]);
    // Lewy-gorny róg strony (50,500) -> lewy-gorny róg ekranu (0, 0).
    expect(pdfPointToScreen(50, 500, offsetPage)).toEqual([0, 0]);
  });
});

describe('pdfRectToScreen — rotacja 0', () => {
  it('bbox w LEWYM-GORNYM rogu strony PDF (duze Y = blisko gory) -> bbox w LEWYM-GORNYM rogu ekranu (male Y)', () => {
    // Prostokat 0<=x<=100, 692<=y<=792 (gorne 100pt strony, w PDF-Y-w-gore to DUZE y).
    const screen = pdfRectToScreen({ minX: 0, minY: 692, maxX: 100, maxY: 792 }, LETTER_PAGE);
    expect(screen).toEqual({ minX: 0, maxX: 100, minY: 0, maxY: 100 });
  });

  it('bbox w LEWYM-DOLNYM rogu strony PDF (male Y) -> bbox w LEWYM-DOLNYM rogu ekranu (duze Y, blisko imageHeightPx)', () => {
    const screen = pdfRectToScreen({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, LETTER_PAGE);
    expect(screen).toEqual({ minX: 0, maxX: 100, minY: 692, maxY: 792 });
  });

  it('bbox obejmujacy CALA strone -> bbox obejmujacy CALA bitmape', () => {
    const screen = pdfRectToScreen(LETTER_PAGE.pageBox, LETTER_PAGE);
    expect(screen).toEqual({ minX: 0, minY: 0, maxX: 612, maxY: 792 });
  });
});

describe('pdfPointToScreen — rotacje 90/180/270 (formula spojna wewnetrznie — patrz komentarz w naglowku pliku o braku realnej weryfikacji wizualnej)', () => {
  it('rotacja 180: lewy-dolny róg PDF -> prawy-gorny róg ekranu (odwrotnosc rotacji 0 w obu osiach)', () => {
    const page: RenderedPageGeometry = { ...LETTER_PAGE, rotation: 180 };
    expect(pdfPointToScreen(0, 0, page)).toEqual([612, 0]);
    expect(pdfPointToScreen(612, 792, page)).toEqual([0, 792]);
  });

  it('rotacje 90/270 zamieniaja wymiary wyjsciowe (portret <-> pejzaz) — sprawdzone na obrazie o INNYCH proporcjach niz strona', () => {
    const rotated90: RenderedPageGeometry = { pageBox: { minX: 0, minY: 0, maxX: 612, maxY: 792 }, imageWidthPx: 792, imageHeightPx: 612, rotation: 90 };
    // Punkt strony musi nadal wypasc W GRANICACH bitmapy [0,792]x[0,612].
    const [x, y] = pdfPointToScreen(306, 396, rotated90);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThanOrEqual(792);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThanOrEqual(612);
  });

  it('rotacja 90 i 270 sa wzajemnie odwrotne dla tego samego punktu (round-trip przez obie o 360 st. wraca do zrodla, pomijajac zaokraglenia skali)', () => {
    const base: RenderedPageGeometry = { pageBox: { minX: 0, minY: 0, maxX: 612, maxY: 792 }, imageWidthPx: 792, imageHeightPx: 612, rotation: 90 };
    const opposite: RenderedPageGeometry = { ...base, rotation: 270 };
    const p90 = pdfPointToScreen(100, 200, base);
    const p270 = pdfPointToScreen(100, 200, opposite);
    // Rozne rotacje MUSZA dawac rozne wyniki dla tego samego punktu wejsciowego (dowod, ze rotacja faktycznie cos zmienia).
    expect(p90).not.toEqual(p270);
  });
});

describe('pdfPointToScreen — przypadki brzegowe', () => {
  it('zdegenerowany pageBox (zerowa szerokosc/wysokosc) nie rzuca, zwraca [0,0]', () => {
    const degenerate: RenderedPageGeometry = { pageBox: { minX: 10, minY: 10, maxX: 10, maxY: 500 }, imageWidthPx: 100, imageHeightPx: 100, rotation: 0 };
    expect(pdfPointToScreen(10, 10, degenerate)).toEqual([0, 0]);
  });
});

describe('screenPointToPdf — [KROK-18] odwrotnosc pdfPointToScreen, rotacja 0', () => {
  it('lewy-DOLNY róg ekranu (0, imageHeightPx) -> lewy-DOLNY róg strony PDF (0,0)', () => {
    expect(screenPointToPdf(0, 792, LETTER_PAGE)).toEqual([0, 0]);
  });

  it('lewy-GORNY róg ekranu (0,0) -> lewy-GORNY róg strony PDF (0, maxY)', () => {
    expect(screenPointToPdf(0, 0, LETTER_PAGE)).toEqual([0, 792]);
  });

  it('round-trip PDF -> ekran -> PDF wraca do zrodla (dowolny punkt wewnatrz strony)', () => {
    for (const [x, y] of [
      [100, 200],
      [306, 396],
      [0, 0],
      [612, 792],
    ] as const) {
      const [sx, sy] = pdfPointToScreen(x, y, LETTER_PAGE);
      const [px, py] = screenPointToPdf(sx, sy, LETTER_PAGE);
      expect(px).toBeCloseTo(x, 6);
      expect(py).toBeCloseTo(y, 6);
    }
  });

  it('round-trip dziala tez przy innej rozdzielczosci renderu (skalowanie 2x) i niezerowym pageBox.min', () => {
    const page: RenderedPageGeometry = { pageBox: { minX: 50, minY: 100, maxX: 350, maxY: 500 }, imageWidthPx: 600, imageHeightPx: 800, rotation: 0 };
    const [sx, sy] = pdfPointToScreen(200, 300, page);
    const [px, py] = screenPointToPdf(sx, sy, page);
    expect(px).toBeCloseTo(200, 6);
    expect(py).toBeCloseTo(300, 6);
  });
});

describe('screenRectToPdf — [KROK-18] odwrotnosc pdfRectToScreen', () => {
  it('bbox ekranu w lewym-gornym rogu (male Y) -> bbox PDF w lewym-gornym rogu strony (duze Y)', () => {
    const pdf = screenRectToPdf({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, LETTER_PAGE);
    expect(pdf).toEqual({ minX: 0, maxX: 100, minY: 692, maxY: 792 });
  });

  it('round-trip PDF -> ekran -> PDF na dowolnym prostokacie', () => {
    const original = { minX: 120, minY: 250, maxX: 480, maxY: 600 };
    const screen = pdfRectToScreen(original, LETTER_PAGE);
    const roundTripped = screenRectToPdf(screen, LETTER_PAGE);
    expect(roundTripped.minX).toBeCloseTo(original.minX, 6);
    expect(roundTripped.maxX).toBeCloseTo(original.maxX, 6);
    expect(roundTripped.minY).toBeCloseTo(original.minY, 6);
    expect(roundTripped.maxY).toBeCloseTo(original.maxY, 6);
  });

  it('round-trip dziala tez pod rotacja 90/270 (nie tylko dominujacy przypadek 0)', () => {
    for (const rotation of [90, 270] as const) {
      const page: RenderedPageGeometry = { pageBox: { minX: 0, minY: 0, maxX: 612, maxY: 792 }, imageWidthPx: 792, imageHeightPx: 612, rotation };
      const original = { minX: 100, minY: 150, maxX: 400, maxY: 600 };
      const screen = pdfRectToScreen(original, page);
      const roundTripped = screenRectToPdf(screen, page);
      expect(roundTripped.minX).toBeCloseTo(original.minX, 6);
      expect(roundTripped.maxX).toBeCloseTo(original.maxX, 6);
      expect(roundTripped.minY).toBeCloseTo(original.minY, 6);
      expect(roundTripped.maxY).toBeCloseTo(original.maxY, 6);
    }
  });
});

describe('screenRotatedRectToPdf — [zgloszenie uzytkownika, "Zaznacz i wytnij" — obrocone zaznaczenie]', () => {
  it('rotationRad=0 (nieobrocony) -> ten sam wynik co zwykly screenRectToPdf (przypadek szczegolny)', () => {
    const rotated = screenRotatedRectToPdf({ centerX: 300, centerY: 300, width: 100, height: 50, rotationRad: 0 }, LETTER_PAGE);
    // Srodek ekranu (300,300), Y-odbicie (skala 1:1, LETTER_PAGE) -> PDF Y = 792-300 = 492.
    expect(rotated.centerX).toBeCloseTo(300, 6);
    expect(rotated.centerY).toBeCloseTo(492, 6);
    expect(rotated.width).toBeCloseTo(100, 6);
    expect(rotated.height).toBeCloseTo(50, 6);
    expect(rotated.rotationRad).toBeCloseTo(0, 6);
  });

  it('[wprost policzony przyklad] obrot 90° w ekranie -> obrot -90° w PDF (odbicie osi Y odwraca zmysl obrotu), wymiary bez zmian', () => {
    // Wprost policzone na LETTER_PAGE (skala 1:1): 4 rogi prostokata
    // srodek=(300,300), szerokosc=100, wysokosc=50, obrocone o 90° w ekranie,
    // przepuszczone przez Y-odbicie (jedyna transformacja przy tej stronie/skali).
    const rotated = screenRotatedRectToPdf({ centerX: 300, centerY: 300, width: 100, height: 50, rotationRad: Math.PI / 2 }, LETTER_PAGE);
    expect(rotated.centerX).toBeCloseTo(300, 6);
    expect(rotated.centerY).toBeCloseTo(492, 6);
    expect(rotated.width).toBeCloseTo(100, 6);
    expect(rotated.height).toBeCloseTo(50, 6);
    expect(rotated.rotationRad).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('dowolny kat (30°) — szerokosc/wysokosc zachowane (skala 1:1), srodek Y-odbity, obrot zanegowany', () => {
    const rotated = screenRotatedRectToPdf({ centerX: 200, centerY: 400, width: 120, height: 60, rotationRad: Math.PI / 6 }, LETTER_PAGE);
    expect(rotated.centerX).toBeCloseTo(200, 6);
    expect(rotated.centerY).toBeCloseTo(392, 6);
    expect(rotated.width).toBeCloseTo(120, 6);
    expect(rotated.height).toBeCloseTo(60, 6);
    expect(rotated.rotationRad).toBeCloseTo(-Math.PI / 6, 6);
  });

  it('dziala pod rotacja strony (90°) — wymiary nadal zachowane, bez zalamania na NaN/Infinity', () => {
    const page: RenderedPageGeometry = { pageBox: { minX: 0, minY: 0, maxX: 612, maxY: 792 }, imageWidthPx: 792, imageHeightPx: 612, rotation: 90 };
    const rotated = screenRotatedRectToPdf({ centerX: 300, centerY: 300, width: 100, height: 50, rotationRad: Math.PI / 4 }, page);
    expect(rotated.width).toBeCloseTo(100, 6);
    expect(rotated.height).toBeCloseTo(50, 6);
    expect(Number.isFinite(rotated.centerX)).toBe(true);
    expect(Number.isFinite(rotated.centerY)).toBe(true);
    expect(Number.isFinite(rotated.rotationRad)).toBe(true);
  });
});

describe('rotatedRectBounds', () => {
  it('rotationRad=0 — otoczka to zwykly axis-aligned prostokat wokol srodka', () => {
    const bounds = rotatedRectBounds({ centerX: 100, centerY: 200, width: 40, height: 20, rotationRad: 0 });
    expect(bounds).toEqual({ minX: 80, maxX: 120, minY: 190, maxY: 210 });
  });

  it('rotationRad=45° — kwadrat obrocony o 45° ma otoczke o boku rownym przekatnej', () => {
    const bounds = rotatedRectBounds({ centerX: 0, centerY: 0, width: 10, height: 10, rotationRad: Math.PI / 4 });
    const half = (10 * Math.SQRT2) / 2;
    expect(bounds.minX).toBeCloseTo(-half, 6);
    expect(bounds.maxX).toBeCloseTo(half, 6);
    expect(bounds.minY).toBeCloseTo(-half, 6);
    expect(bounds.maxY).toBeCloseTo(half, 6);
  });

  it('rotationRad=90° — prostokat "lezacy" po obrocie o 90° ma zamienione szerokosc/wysokosc otoczki', () => {
    const bounds = rotatedRectBounds({ centerX: 50, centerY: 50, width: 30, height: 10, rotationRad: Math.PI / 2 });
    expect(bounds).toEqual({ minX: 45, maxX: 55, minY: 35, maxY: 65 });
  });
});

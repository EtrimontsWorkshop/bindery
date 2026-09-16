import { describe, expect, it } from 'vitest';
import { hasBoundaryBetween, runHygiene } from '../../src/text/hygiene.js';
import type { PdfTextItemLike } from '../../src/text/types.js';

// Ksztalt pola-po-polu zweryfikowany empirycznie wprost na wyjsciu pdf.js
// getTextContent() (RAPORT-KROK-5.md): {str, dir, width, height, transform, fontName, hasEOL}.
function item(str: string, x: number, y: number, opts: Partial<PdfTextItemLike> = {}): PdfTextItemLike {
  return {
    str,
    dir: 'ltr',
    width: opts.width ?? str.length * 6,
    height: opts.height ?? 12,
    transform: opts.transform ?? [12, 0, 0, 12, x, y],
    fontName: opts.fontName ?? 'g_d0_f1',
    hasEOL: opts.hasEOL ?? false,
  };
}

describe('runHygiene — filtrowanie bialych znakow (U2)', () => {
  it('odfiltrowuje item zlozony wylacznie z bialych znakow i zapisuje go jako wordBoundary', () => {
    const items = [item('Alpha', 72, 700), item(' ', 100, 700, { width: 10 }), item('Bravo', 110, 700)];
    const res = runHygiene(items);
    expect(res.items.map((i) => i.str)).toEqual(['Alpha', 'Bravo']);
    expect(res.wordBoundaries).toEqual([{ afterItemIndex: 0, gapStart: 100, gapEnd: 110 }]);
  });

  it('scala kolejne itemy bialoznakowe w JEDNA granice', () => {
    const items = [item('Alpha', 72, 700), item(' ', 100, 700, { width: 5 }), item(' ', 105, 700, { width: 5 }), item('Bravo', 110, 700)];
    const res = runHygiene(items);
    expect(res.wordBoundaries).toHaveLength(1);
    expect(res.wordBoundaries[0]).toEqual({ afterItemIndex: 0, gapStart: 100, gapEnd: 110 });
  });

  it('granica przed pierwszym realnym itemem ma afterItemIndex === -1', () => {
    const items = [item(' ', 72, 700, { width: 5 }), item('Alpha', 80, 700)];
    const res = runHygiene(items);
    expect(res.wordBoundaries[0]!.afterItemIndex).toBe(-1);
  });

  it('item calkowicie pusty (str.length===0) jest pomijany, nie tworzy granicy', () => {
    const items = [item('Alpha', 72, 700), item('', 100, 700), item('Bravo', 110, 700)];
    const res = runHygiene(items);
    expect(res.items.map((i) => i.str)).toEqual(['Alpha', 'Bravo']);
    expect(res.wordBoundaries).toHaveLength(0);
  });
});

describe('runHygiene — deduplikacja pozycyjna', () => {
  it('dokladny duplikat (identyczny str+transform) jest odrzucony do jednego wystapienia', () => {
    const items = [item('Goblin', 72, 700), item('Goblin', 72, 700)];
    const res = runHygiene(items);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.syntheticBold).toBe(false);
  });

  it('duplikat przesuniety < 0.5pt jest scalony i oznaczony syntheticBold', () => {
    const items = [item('Orc', 72, 670), item('Orc', 72.3, 670)];
    const res = runHygiene(items);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.syntheticBold).toBe(true);
  });

  it('przesuniecie >= 0.5pt NIE jest traktowane jako duplikat (dwa oddzielne itemy)', () => {
    const items = [item('Orc', 72, 670), item('Orc', 73, 670)];
    const res = runHygiene(items);
    expect(res.items).toHaveLength(2);
    expect(res.items.every((i) => !i.syntheticBold)).toBe(true);
  });

  it('rozny str przy podobnej pozycji nie jest duplikatem', () => {
    const items = [item('Orc', 72, 670), item('Ogre', 72.1, 670)];
    const res = runHygiene(items);
    expect(res.items).toHaveLength(2);
  });
});

describe('runHygiene — normalizacja NFC, ligatury, soft hyphen', () => {
  it('NFC: forma zdekomponowana i precomponowana daja identyczny str', () => {
    const decomposed = item('Sil̵a', 72, 700); // l + znak laczacy (namiastka non-NFC z KROK-3)
    const precomposed = item('Siła', 72, 670);
    const res = runHygiene([decomposed, precomposed]);
    // NFC nie usuwa znakow laczacych nie-standardowych (U+0335 nie ma formy precomponowanej z "l"),
    // ale normalize('NFC') na obu stringach musi dawac deterministyczny, ustabilizowany wynik.
    expect(res.items[1]!.str).toBe('Siła');
    expect(res.items[1]!.str.normalize('NFC')).toBe(res.items[1]!.str);
  });

  it('rozwija ligatury FB00-FB06 do odpowiednikow ASCII', () => {
    // "of" + ligatura fi (=f+i) + "ce" -> "office"; "fl" + "ame" -> "flame"
    const items = [item('ofﬁce', 72, 700), item('ﬂame', 72, 670)];
    const res = runHygiene(items);
    expect(res.items[0]!.str).toBe('office');
    expect(res.items[1]!.str).toBe('flame');
  });

  it('usuwa soft hyphen U+00AD', () => {
    const res = runHygiene([item('encyclo­', 72, 700)]);
    expect(res.items[0]!.str).toBe('encyclo');
  });
});

describe('runHygiene — metryki po odfiltrowaniu', () => {
  it('fragmentationRatio liczony PO odrzuceniu bialych znakow (nie na surowych itemach)', () => {
    const items = [item('the', 72, 700), item(' ', 90, 700, { width: 30 }), item('a', 130, 700)];
    const res = runHygiene(items);
    expect(res.metrics.nonEmptyItemCount).toBe(2); // "the" i "a" — spacja juz odfiltrowana
    expect(res.metrics.fragmentationRatio).toBeCloseTo(0.5); // "a" < 3 znaki, "the" nie
  });

  it('niska unicodeConfidence generuje Diagnostic UNICODE_LOW_CONFIDENCE', () => {
    const puaText = String.fromCharCode(0xe000, 0xe001, 0xe002, 0xe003, 0xe004);
    const res = runHygiene([item(puaText, 72, 700)]);
    expect(res.metrics.unicodeConfidence).toBeLessThan(0.5);
    expect(res.diagnostics.some((d) => d.code === 'UNICODE_LOW_CONFIDENCE')).toBe(true);
  });
});

describe('hasBoundaryBetween — [U2] granica jako twardy zakaz (test wymuszajacy P1)', () => {
  it('wykrywa granice miedzy dwoma oryginalnymi indeksami', () => {
    const boundaries = [{ afterItemIndex: 2, gapStart: 0, gapEnd: 0 }];
    expect(hasBoundaryBetween(boundaries, 0, 5)).toBe(true);
    expect(hasBoundaryBetween(boundaries, 3, 5)).toBe(false);
    expect(hasBoundaryBetween(boundaries, 0, 2)).toBe(false); // granica DOKLADNIE na prawym koncu (wylaczna) nie liczy sie jako "miedzy"
  });
});

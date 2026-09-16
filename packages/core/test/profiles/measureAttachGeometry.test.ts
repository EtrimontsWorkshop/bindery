import { describe, expect, it } from 'vitest';
import { measureAttachGeometry } from '../../src/profiles/measureAttachGeometry.js';
import type { LabelledPairsPattern, SectionListPattern } from '../../src/profiles/schema.js';
import type { ProfileToken } from '../../src/profiles/types.js';

/** Ten sam wzorzec pomocniczy co inne testy `profiles/*` — jedna linia = jeden token, ulozone od gory (Y wieksze) w dol. */
function row(entries: readonly [string, number] | readonly (readonly [string, number])[], y: number, opts: Partial<ProfileToken> = {}): ProfileToken[] {
  const list = Array.isArray(entries[0]) ? (entries as readonly (readonly [string, number])[]) : [entries as [string, number]];
  return list.map(([text, x]) => ({ text, bbox: { minX: x, maxX: x + 8, minY: y, maxY: y + 10 }, ...opts }));
}

const gridPattern: LabelledPairsPattern = {
  kind: 'labelledPairs',
  labels: { S: 'strength', WYG: 'charisma', KON: 'constitution' },
  valuePattern: '^\\d{1,3}$',
  minPairs: 3,
  terminate: { onRepeatedLabel: true },
  allowTrailingWords: false,
};

const derivedPattern: LabelledPairsPattern = {
  kind: 'labelledPairs',
  labels: { PW: 'hitPoints', Ruch: 'movement' },
  valuePattern: '^.+$',
  minPairs: 2,
  terminate: { onRepeatedLabel: true },
  allowTrailingWords: false,
};

const attackPattern: SectionListPattern = {
  kind: 'sectionList',
  sectionHeader: '^ATAKI$',
  itemPattern: '(?<name>[\\p{L} ]+?) (?<toHit>\\d{1,3})%',
  rejoinHyphenated: false,
};

function grid(y: number): ProfileToken[] {
  return row([['S', 0], ['40', 10], ['WYG', 20], ['25', 30], ['KON', 40], ['35', 50]], y);
}

describe('measureAttachGeometry — [KROK-24 Z2]', () => {
  it('kandydat KONSEKWENTNIE ponizej na kazdej stronie -> nearestBelow, dystanse posortowane', () => {
    const pages = [
      { tokens: [...grid(200), ...row([['PW', 0], ['5', 10], ['Ruch', 20], ['9', 30]], 170)] }, // 30pt gap
      { tokens: [...grid(200), ...row([['PW', 0], ['5', 10], ['Ruch', 20], ['9', 30]], 150)] }, // 50pt gap
    ];
    const result = measureAttachGeometry(pages, gridPattern, derivedPattern);
    expect(result.suggestedStrategy).toBe('nearestBelow');
    expect(result.pagesWithBoth).toBe(2);
    expect(result.measuredPairCount).toBe(2);
    expect(result.belowCount).toBe(2);
    expect(result.aboveCount).toBe(0);
    expect(result.besideCount).toBe(0);
    expect(result.distances).toEqual([...result.distances].sort((a, b) => a - b));
    expect(result.suggestedMaxDistancePt).toBe(Math.ceil(Math.max(...result.distances) + 10));
  });

  it('kandydat KONSEKWENTNIE powyzej -> nearestAbove', () => {
    const pages = [{ tokens: [...row([['PW', 0], ['5', 10], ['Ruch', 20], ['9', 30]], 200), ...grid(170)] }];
    const result = measureAttachGeometry(pages, gridPattern, derivedPattern);
    expect(result.suggestedStrategy).toBe('nearestAbove');
    expect(result.aboveCount).toBe(1);
    expect(result.belowCount).toBe(0);
  });

  it('[krok 19, "nie czas na krzyk"] kandydat OBOK (kolumnowy uklad) na kazdej stronie -> nearest, nie nearestBelow/nearestAbove', () => {
    // Ta sama wysokosc Y co siatka (rozne X) -- ani ponizej, ani powyzej.
    const pages = [{ tokens: [...grid(200), ...row([['PW', 0], ['5', 10], ['Ruch', 20], ['9', 30]], 205, {})] }];
    // Przesuniecie w X, zeby bboxy nie zachodzily na siebie w pionie.
    for (const t of pages[0]!.tokens.slice(6)) {
      t.bbox.minX += 200;
      t.bbox.maxX += 200;
    }
    const result = measureAttachGeometry(pages, gridPattern, derivedPattern);
    expect(result.suggestedStrategy).toBe('nearest');
    expect(result.besideCount).toBe(1);
  });

  it('JEDEN wyjatek psuje "konsekwentnie ponizej" -> spada do nearest (nie wiekszosc, KAZDA para)', () => {
    const pages = [
      { tokens: [...grid(200), ...row([['PW', 0], ['5', 10], ['Ruch', 20], ['9', 30]], 170)] }, // ponizej
      { tokens: [...row([['PW', 0], ['5', 10], ['Ruch', 20], ['9', 30]], 200), ...grid(170)] }, // powyzej -- wyjatek
    ];
    const result = measureAttachGeometry(pages, gridPattern, derivedPattern);
    expect(result.suggestedStrategy).toBe('nearest');
    expect(result.belowCount).toBe(1);
    expect(result.aboveCount).toBe(1);
  });

  it('brak stron z OBOMA wzorcami -> zero danych, brak sugerowanego limitu (null, nie 0 ani liczba domyslna)', () => {
    const pages = [{ tokens: [...grid(200)] }];
    const result = measureAttachGeometry(pages, gridPattern, derivedPattern);
    expect(result.pagesWithBoth).toBe(0);
    expect(result.measuredPairCount).toBe(0);
    expect(result.distances).toEqual([]);
    expect(result.suggestedMaxDistancePt).toBeNull();
  });

  it('dziala tez z kandydatem sectionList (ATAKI), nie tylko labelledPairs', () => {
    const pages = [{ tokens: [...grid(200), ...row([['ATAKI', 0], ['Walka', 10], ['40%', 20]], 170)] }];
    const result = measureAttachGeometry(pages, gridPattern, attackPattern);
    expect(result.suggestedStrategy).toBe('nearestBelow');
    expect(result.measuredPairCount).toBe(1);
  });

  it('wiele siatek na stronie -> parowanie globalne (dokladnie jak w prawdziwym potoku), kazda para liczona osobno', () => {
    const pages = [
      {
        tokens: [
          ...grid(400),
          ...row([['PW', 0], ['5', 10], ['Ruch', 20], ['9', 30]], 370),
          ...grid(200),
          ...row([['PW', 0], ['5', 10], ['Ruch', 20], ['9', 30]], 170),
        ],
      },
    ];
    const result = measureAttachGeometry(pages, gridPattern, derivedPattern);
    expect(result.measuredPairCount).toBe(2);
    expect(result.belowCount).toBe(2);
  });
});

import { describe, expect, it } from 'vitest';
import { lastClaimedTokenBbox, matchProseBlock } from '../../src/profiles/proseBlock.js';
import type { ProfileToken } from '../../src/profiles/types.js';
import type { ProseBlockPattern } from '../../src/profiles/schema.js';
import type { SectionListMatch } from '../../src/profiles/patterns.js';

/** Token na konkretnej pozycji — w odroznieniu od `row()` w patterns.test.ts, `proseBlock` potrzebuje PRAWDZIWEGO ukladu 2D (kolumny, odstepy pionowe). */
function tok(text: string, x: number, y: number, w = 20, fontRole: ProfileToken['fontRole'] = 'body'): ProfileToken {
  return { text, bbox: { minX: x, maxX: x + w, minY: y, maxY: y + 9 }, fontRole };
}

const BASE_PATTERN: ProseBlockPattern = {
  kind: 'proseBlock',
  label: 'Opis',
  offset: { dxPt: 0, dyPt: -10 },
  maxLengthChars: 2000,
  searchRadiusPt: 60,
};

describe('matchProseBlock — [KROK-34 Z2, "Notatki wskazywane w PDF-ie"]', () => {
  it('znajduje najblizszy nieprzejety token wzgledem punktu odniesienia + offset i zbiera dalsze tokeny do konca strumienia', () => {
    const anchor = { minX: 0, maxX: 100, minY: 100, maxY: 109 };
    const tokens = [tok('Niewidzialność:', 0, 89, 20, 'accent'), tok('opis', 15, 89, 20), tok('zdolności.', 0, 60)];
    const match = matchProseBlock(tokens, BASE_PATTERN, anchor, {});
    expect(match?.startIndex).toBe(0);
    expect(match?.text).toBe('Niewidzialność: opis zdolności.');
  });

  it('[A10] brak nieprzejetego tokenu w promieniu searchRadiusPt -> null, nie zgaduje', () => {
    const anchor = { minX: 0, maxX: 100, minY: 100, maxY: 109 };
    const tokens = [tok('daleko', 500, 500)];
    expect(matchProseBlock(tokens, BASE_PATTERN, anchor, {})).toBeNull();
  });

  it('[A10] wszystkie tokeny w zasiegu WYKLUCZONE -> null', () => {
    const anchor = { minX: 0, maxX: 100, minY: 100, maxY: 109 };
    const tokens = [tok('Pancerz:', 0, 89, 60, 'accent')];
    expect(matchProseBlock(tokens, BASE_PATTERN, anchor, { excludedTokenIndices: new Set([0]) })).toBeNull();
  });

  it('[kroki 30/31] hardStopTokenIndices zatrzymuje zbieranie na granicy encji — nie przekracza jej', () => {
    const anchor = { minX: 0, maxX: 100, minY: 100, maxY: 109 };
    const tokens = [tok('Opis', 0, 89), tok('ciag dalszy', 0, 78), tok('Kolejna Postac', 0, 67, 60, 'heading')];
    const match = matchProseBlock(tokens, BASE_PATTERN, anchor, { hardStopTokenIndices: [2] });
    expect(match?.text).toBe('Opis ciag dalszy');
    expect(match?.endIndex).toBe(2);
  });

  it('[KROK-34 Z2, zmierzony na zywo blad, "Wrak.pdf" str. 23, Hansen] token z hardStopTokenIndices NIE moze byc wybrany jako START poszukiwania (nie tylko granica PODCZAS zbierania) — gdy to WLASNIE on jest najblizszym nieprzejetym tokenem (np. zapowiedz kolejnego potwora TUZ PO wlasnej tresci tej encji), wynik to null, nie proza zaczynajaca sie OD granicy', () => {
    const anchor = { minX: 0, maxX: 100, minY: 100, maxY: 109 };
    const tokens = [tok('SCIAPOD', 0, 89, 60, 'heading'), tok('opis kolejnego potwora, niezwiazany z ta encja.', 0, 78, 200)];
    // [KROK-39 Z3b] Bez `referenceTokenIndex` sama odleglosc do `startIndex`
    // (teraz liczona rogowo, `cornerDistanceToPoint`, jak kazdy inny bazowy
    // wybor startu) NIE chroni przed wybraniem prozy TUZ ZA granica jako
    // "najblizszej" — patrz test nizej (blad #4, przypadek "withoutReferenceIndex"),
    // gdzie to jest udokumentowane jako ZNANE i AKCEPTOWANE zachowanie bez
    // tej opcji. Prawdziwa ochrona to `referenceTokenIndex` (odrzuca KAZDEGO
    // kandydata o indeksie >= najblizszej granicy PO nim), ktorej produkcyjny
    // kod (`assembleStatblocks.ts`) UZYWA ZAWSZE, gdy profil ma notesPatterns
    // — wiec ten test musi ja przekazac, zeby wiernie odzwierciedlac
    // rzeczywiste wywolanie. `-1`: w tym synthetycznym scenariuszu encja nie
    // ma ZADNEJ wlasnej tresci przed granica (0), wiec KAZDY token od granicy
    // wzwyz jest "cudzy".
    const match = matchProseBlock(tokens, BASE_PATTERN, anchor, { hardStopTokenIndices: [0], referenceTokenIndex: -1 });
    expect(match).toBeNull();
  });

  it('[KROK-34 Z2, zmierzony na zywo blad #4, "Wrak.pdf" str. 23, Hansen, drugi wzorzec notatki z WIEKSZYM offsetem] wykluczenie SAMEGO tokenu granicy (blad #3) NIE WYSTARCZA, gdy offset (skalibrowany na dluzszej encji) celuje w punkt LEZACY ZA granica — bez `referenceTokenIndex` najblizszy kandydat to wtedy proza ZA granica (nigdy nie "przechodzi sie" przez sam token graniczny sekwencyjnie, po prostu celuje dalej); z `referenceTokenIndex` KAZDY kandydat o indeksie >= najblizszej granicy PO nim jest odrzucony, wiec wynik to null (wlasna tresc za daleko, poza `searchRadiusPt`), nie cudza proza', () => {
    const anchor = { minX: 0, maxX: 100, minY: 95, maxY: 104 };
    const pattern: ProseBlockPattern = { ...BASE_PATTERN, offset: { dxPt: 0, dyPt: -80 } };
    const tokens = [tok('WlasnyOstatniToken', 0, 95), tok('SCIAPOD', 0, 50, 20, 'heading'), tok('niezwiazana proza za granica', 0, 10, 20)];
    const withoutReferenceIndex = matchProseBlock(tokens, pattern, anchor, { hardStopTokenIndices: [1] });
    expect(withoutReferenceIndex?.text).toBe('niezwiazana proza za granica');
    const withReferenceIndex = matchProseBlock(tokens, pattern, anchor, { hardStopTokenIndices: [1], referenceTokenIndex: 0 });
    expect(withReferenceIndex).toBeNull();
  });

  it('wykluczony (juz zaklaimowany), ale NIE-naglowkowy token jest POMIJANY, nie przerywa zbierania — luka w srodku bloku', () => {
    const anchor = { minX: 0, maxX: 100, minY: 100, maxY: 109 };
    const tokens = [tok('Poczatek', 0, 89), tok('wtracenie', 0, 78), tok('koniec', 0, 67)];
    const match = matchProseBlock(tokens, BASE_PATTERN, anchor, { excludedTokenIndices: new Set([1]) });
    expect(match?.text).toBe('Poczatek koniec');
  });

  it('[zgloszenie uzytkownika, "Niewidzialność" lapalo tez Pancerz/Zaklęcia] podnaglowek stylu akcentowego PO wlasnym starcie zatrzymuje zbieranie — NAWET gdy jest rowniez wykluczony (np. "Pancerz:" zaklaimowany przez scalone `derived`, patrz `lastClaimedTokenBbox`)', () => {
    const anchor = { minX: 0, maxX: 100, minY: 100, maxY: 109 };
    const tokens = [tok('Niewidzialność:', 0, 89, 60, 'accent'), tok('opis zdolności.', 0, 78, 60), tok('Pancerz:', 0, 67, 60, 'accent'), tok('5, gruba skóra.', 0, 56, 60)];
    const match = matchProseBlock(tokens, BASE_PATTERN, anchor, { excludedTokenIndices: new Set([2, 3]) });
    expect(match?.text).toBe('Niewidzialność: opis zdolności.');
    expect(match?.endIndex).toBe(2);
  });

  it('[Zmierzony na zywo blad, "Wrak.pdf" str. 24] token stylu akcentowego BEZ koncowego dwukropka (odnosnik miedzyrozdzialowy w nawiasie, "Walka ze sciapodem") NIE zatrzymuje zbierania — tylko PRAWDZIWY podnaglowek (akcent + dwukropek) to robi', () => {
    const anchor = { minX: 0, maxX: 100, minY: 100, maxY: 109 };
    const tokens = [
      tok('Niewidzialność:', 0, 89, 60, 'accent'),
      tok('powinny być obarczone jedną kością karną (patrz:', 0, 78, 200),
      tok('Walka ze sciapodem', 0, 67, 60, 'accent'),
      tok('str. 20).', 0, 56, 60),
      tok('Pancerz:', 0, 45, 60, 'accent'),
      tok('5, gruba skóra.', 0, 34, 60),
    ];
    const match = matchProseBlock(tokens, BASE_PATTERN, anchor, {});
    expect(match?.text).toBe('Niewidzialność: powinny być obarczone jedną kością karną (patrz: Walka ze sciapodem str. 20).');
    expect(match?.endIndex).toBe(4);
  });

  it('[Zmierzony na zywo blad, "Wrak.pdf" str. 24, watermark DriveThruRPG] VENDOR_WATERMARK_PATTERN zatrzymuje zbieranie, nie tylko pomija ten token', () => {
    const anchor = { minX: 0, maxX: 100, minY: 100, maxY: 109 };
    const tokens = [tok('Opis', 0, 89), tok('Jan Kowalski (Order #12345)', 0, 78, 100), tok('cos po', 0, 67)];
    const match = matchProseBlock(tokens, BASE_PATTERN, anchor, {});
    expect(match?.text).toBe('Opis');
  });

  it('maxLengthChars odrzuca CALY kandydujacy token, gdyby przekroczyl limit (przycina czysto, nie w polowie slowa)', () => {
    const pattern: ProseBlockPattern = { ...BASE_PATTERN, maxLengthChars: 10 };
    const anchor = { minX: 0, maxX: 100, minY: 100, maxY: 109 };
    const tokens = [tok('12345', 0, 89), tok('67890123', 0, 78)];
    const match = matchProseBlock(tokens, pattern, anchor, {});
    expect(match?.text).toBe('12345');
  });

  it('[kroki 29/30, ukland kolumnowy] token z INNEJ kolumny (daleko w X) jest pomijany, nie wliczany do bloku', () => {
    const anchor = { minX: 0, maxX: 100, minY: 100, maxY: 109 };
    const tokens = [
      tok('Wlasna kolumna wiersz jeden', 0, 89, 100),
      tok('Wlasna kolumna wiersz dwa', 0, 78, 100),
      tok('Sasiednia kolumna, inny temat', 300, 89, 100),
    ];
    const match = matchProseBlock(tokens, BASE_PATTERN, anchor, {});
    expect(match?.text).toBe('Wlasna kolumna wiersz jeden Wlasna kolumna wiersz dwa');
  });
});

describe('lastClaimedTokenBbox — [KROK-34 Z2]', () => {
  const tokens: ProfileToken[] = Array.from({ length: 10 }, (_, i) => tok(`t${i}`, 0, 100 - i * 10));

  it('bez atakow/umiejetnosci -> ostatni token siatki', () => {
    const bbox = lastClaimedTokenBbox(tokens, { grid: { endIndex: 3 } });
    expect(bbox).toEqual(tokens[2]!.bbox);
  });

  it('ataki rozszerzaja punkt odniesienia do ostatniej PRAWDZIWEJ pozycji (endTokenIndex), nie do endIndex bufora wyszukiwania', () => {
    const attacks: SectionListMatch = { headerTokenIndex: 3, endIndex: 9, items: [{ groups: {}, raw: '', startTokenIndex: 4, endTokenIndex: 5, bbox: tokens[5]!.bbox }] };
    const bbox = lastClaimedTokenBbox(tokens, { grid: { endIndex: 3 }, attacks });
    expect(bbox).toEqual(tokens[5]!.bbox);
  });

  it('[zmierzony na zywo blad, Sciapod str. 24 "Wrak.pdf"] `derived` (moze byc scaleniem Z1, tokeny rozlaczne) NIE jest brany pod uwage — inaczej scalone dopasowanie daleko w strumieniu (np. "Pancerz" we wlasnym akapicie) przeskakiwaloby niezaklaimowana proze MIEDZY atakami a nim', () => {
    const bboxWithoutDerived = lastClaimedTokenBbox(tokens, { grid: { endIndex: 3 } });
    const bboxWithFarDerived = lastClaimedTokenBbox(tokens, { grid: { endIndex: 3 }, derived: { endIndex: 9 } });
    expect(bboxWithFarDerived).toEqual(bboxWithoutDerived);
  });
});

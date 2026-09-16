import { describe, expect, it } from 'vitest';
import { findAttackDescriptionsBelow } from '../../src/profiles/attackDescriptionCrossReference.js';
import { matchSectionList } from '../../src/profiles/patterns.js';
import type { ProfileToken } from '../../src/profiles/types.js';
import type { SectionListPattern } from '../../src/profiles/schema.js';

/** [KROK-33 Z4] Token z rola fontu -- `accent` imituje podnaglowek stylu etykiet ("Ataki:"/"MO:"), `body` zwykla proza. */
function tok(text: string, fontRole: ProfileToken['fontRole'] = 'body'): ProfileToken {
  return { text, bbox: { minX: 0, maxX: 0, minY: 0, maxY: 0 }, fontRole };
}

// Lookahead z trzema granicami -- ta sama "siatka bezpieczenstwa" co produkcyjny
// wzorzec (`NEXT_HEADER_LIKE` w `inferItemPatternFromExamples.ts`): kolejna
// pozycja, PODNAGLOWEK konczacy sie dwukropkiem (accent), albo koniec bufora.
// Bez trzeciej granicy ostatnia pozycja polknelaby WSZYSTKO do konca bufora
// (w tym podnaglowki i proze ponizej), zamiast konczyc sie na progu podnaglowka.
const ATTACK_PATTERN: SectionListPattern = {
  kind: 'sectionList',
  sectionHeader: '^Walka$',
  itemPattern:
    '(?<name>\\p{L}[\\p{L} ()./-]*?) (?<toHit>\\d{1,3})%(?:\\s*\\(\\d+/\\d+\\))?.*?(?=\\s*\\p{L}[\\p{L} ()./-]*? \\d{1,3}%|\\s*\\p{Lu}[\\p{L} ()./-]*:|$)',
  rejoinHyphenated: false,
};

describe('findAttackDescriptionsBelow — [KROK-33 Z4, zgloszenie: "Nazwy ataków powinny być sprawdzane poniżej"]', () => {
  it('[zmierzone str. 24 "Wrak.pdf", Sciapod] podnaglowek (accent) zaczynajacy sie od PELNEJ nazwy ataku -> tekst PO nim (do nastepnego podnaglowka) trafia jako opis TEGO ataku', () => {
    const tokens = [
      tok('Walka'), // header, index 0
      tok('Chwyt i miażdżenie 60%'), // index 1 -- jedna pozycja ataku (uproszczona do jednego tokenu dla testu)
      tok('Kryształowy łuk 50%'), // index 2
      tok('Chwyt i miażdżenie (manewr):', 'accent'), // index 3 -- podnaglowek z WLASNYM dopiskiem, ktorego NIE MA na liscie atakow
      tok('chwytna stopa może złapać ofiarę.'), // index 4
      tok('Kryształowy łuk (atak dystansowy):', 'accent'), // index 5 -- podnaglowek z INNYM dopiskiem niz nazwa ataku
      tok('wystrzeliwuje harpuny na duży dystans.'), // index 6
    ];
    const match = matchSectionList(tokens, ATTACK_PATTERN)[0]!;
    expect(match.items.map((i) => i.groups['name'])).toEqual(['Chwyt i miażdżenie', 'Kryształowy łuk']);

    const belowTexts = findAttackDescriptionsBelow(tokens, match);
    expect(belowTexts[0]).toBe('chwytna stopa może złapać ofiarę.');
    expect(belowTexts[1]).toBe('wystrzeliwuje harpuny na duży dystans.');
  });

  it('brak podnaglowka pasujacego do zadnej nazwy -> [] wszystkich (A7, brak trafienia to poprawny wynik, nie blad)', () => {
    const tokens = [tok('Walka'), tok('Unik 35%'), tok('Coś innego:', 'accent'), tok('opis niezwiazany.')];
    const match = matchSectionList(tokens, ATTACK_PATTERN)[0]!;
    const belowTexts = findAttackDescriptionsBelow(tokens, match);
    expect(belowTexts.every((t) => t === null)).toBe(true);
  });

  it('[A10, dopasowanie CALEJ nazwy, nie fragmentu] podnaglowek zaczynajacy sie od nazwy jako PODCIAGU innego slowa NIE lapie ("Unikat" nie pasuje do "Unik")', () => {
    const tokens = [tok('Walka'), tok('Unik 35%'), tok('Unikat losowy:', 'accent'), tok('to nie jest opis Unik.')];
    const match = matchSectionList(tokens, ATTACK_PATTERN)[0]!;
    const belowTexts = findAttackDescriptionsBelow(tokens, match);
    expect(belowTexts[0]).toBeNull();
  });

  it('kazdy atak dostaje NAJWYZEJ JEDEN akapit -- zbieranie zatrzymuje sie na KOLEJNYM podnaglowku', () => {
    const tokens = [
      tok('Walka'),
      tok('Cios 40%'),
      tok('Kopnięcie 30%'),
      tok('Cios:', 'accent'),
      tok('pierwsze zdanie opisu.'),
      tok('drugie zdanie tego samego opisu.'),
      tok('Kopnięcie:', 'accent'),
      tok('opis kopnięcia.'),
    ];
    const match = matchSectionList(tokens, ATTACK_PATTERN)[0]!;
    const belowTexts = findAttackDescriptionsBelow(tokens, match);
    expect(belowTexts[0]).toBe('pierwsze zdanie opisu. drugie zdanie tego samego opisu.');
    expect(belowTexts[1]).toBe('opis kopnięcia.');
  });

  it('[Zmierzony na zywo blad, prawdziwy eksport Actora "Sciapod" z Foundry, str. 24 "Wrak.pdf"] zlamanie wiersza w srodku slowa (samodzielny token "-") w opisie NIE zostaje dyndajacym wyrazem w notatkach', () => {
    // Prawdziwy uklad: pdf.js oddaje zlamanie wiersza w srodku slowa jako
    // TRZY tokeny — "krysz", samodzielny "-", "tałowego" — dokladnie ten sam
    // ksztalt, ktory `matchSectionList`'s `rejoinHyphenated` juz rozpoznaje
    // (patrz `patterns.ts`). Bez naprawy `findAttackDescriptionsBelow` po
    // prostu skleja WSZYSTKIE tokeny spacja, dajac w prawdziwym eksporcie
    // Actora zanieczyszczone notatki: "krysz- tałowego łuku", "scia- poda",
    // "potwo- ra" zamiast "kryształowego łuku", "sciapoda", "potwora".
    const tokens = [
      tok('Walka'),
      tok('Kryształowy łuk 50%'),
      tok('Kryształowy łuk (atak dystansowy):', 'accent'),
      tok('dziwny łuk scia'),
      tok('-'),
      tok('poda wystrzeliwuje harpuny z krysz'),
      tok('-'),
      tok('tałowego łuku.'),
    ];
    const match = matchSectionList(tokens, ATTACK_PATTERN)[0]!;
    const belowTexts = findAttackDescriptionsBelow(tokens, match);
    expect(belowTexts[0]).toBe('dziwny łuk sciapoda wystrzeliwuje harpuny z kryształowego łuku.');
  });

  it('[ZGŁOSZENIE na zywo, "zaintere- sowany", "Wrak.pdf" str. 30] zlamanie wiersza w srodku slowa oddane INACZEJ niz samodzielnym tokenem "-" — dywiz PRZYKLEJONY do konca poprzedniego tokenu (bez wlasnego, osobnego tokenu "-") — TEZ zostaje scalone bez spacji, nie dyndajacym wyrazem', () => {
    const tokens = [
      tok('Walka'),
      tok('Kryształowy łuk 50%'),
      tok('Kryształowy łuk (atak dystansowy):', 'accent'),
      tok('Skoro Kernicky nie jest zaintere-'),
      tok('sowany… A ten Klein nie jest wcale taki najgorszy.'),
    ];
    const match = matchSectionList(tokens, ATTACK_PATTERN)[0]!;
    const belowTexts = findAttackDescriptionsBelow(tokens, match);
    expect(belowTexts[0]).toBe('Skoro Kernicky nie jest zainteresowany… A ten Klein nie jest wcale taki najgorszy.');
  });

  it('[ZGŁOSZENIE na zywo, "zaintere- sowany"] dywiz PRZYKLEJONY do konca tokenu PO cyfrze/interpunkcji (np. zakres "20-") NIE jest scalany bez spacji — to nie zlamanie wiersza w srodku slowa', () => {
    const tokens = [
      tok('Walka'),
      tok('Kryształowy łuk 50%'),
      tok('Kryształowy łuk (atak dystansowy):', 'accent'),
      tok('temperatura spadła do 20-'),
      tok('30 stopni.'),
    ];
    const match = matchSectionList(tokens, ATTACK_PATTERN)[0]!;
    const belowTexts = findAttackDescriptionsBelow(tokens, match);
    expect(belowTexts[0]).toBe('temperatura spadła do 20- 30 stopni.');
  });

  it('brak pozycji atakow -> [] bez wyjatku', () => {
    const tokens = [tok('Walka')];
    const match = matchSectionList(tokens, ATTACK_PATTERN)[0]!;
    expect(findAttackDescriptionsBelow(tokens, match)).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { matchLabelledPairs, matchSectionList } from '../../src/profiles/patterns.js';
import type { ProfileToken } from '../../src/profiles/types.js';
import type { LabelledPairsPattern, SectionListPattern } from '../../src/profiles/schema.js';

/** Buduje tokeny w jednym wierszu, kolejne po sobie wzdluz X — wystarczajace dla testow silnika (bbox tylko do skladania unii, nie do geometrii parowania — to KROK-18 Z3). */
function row(texts: readonly string[], startY = 0): ProfileToken[] {
  return texts.map((text, i) => ({ text, bbox: { minX: i * 10, maxX: i * 10 + 8, minY: startY, maxY: startY + 10 } }));
}

const CHAR_GRID_PATTERN: LabelledPairsPattern = {
  kind: 'labelledPairs',
  labels: { S: 'strength', WYG: 'charisma', KON: 'constitution', MOC: 'willpower', BC: 'size', WYK: 'education', ZR: 'dexterity', P: 'hitPoints', INT: 'intelligence' },
  valuePattern: '^(\\d{1,3}|[–—-])$',
  minPairs: 3,
  maxPairs: 12,
  terminate: { onRepeatedLabel: true },
  allowTrailingWords: false,
};

describe('matchLabelledPairs — [KROK-18 Z2]', () => {
  it('lapie siatke 9 cech w STALEJ kolejnosci (przypadek polskiego pliku z kroku 12/13)', () => {
    const tokens = row(['S', '40', 'WYG', '25', 'KON', '35', 'MOC', '70', 'BC', '40', 'WYK', '90', 'ZR', '45', 'P', '45', 'INT', '70']);
    const matches = matchLabelledPairs(tokens, CHAR_GRID_PATTERN);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.pairs.map((p) => p.canonicalKey)).toEqual([
      'strength', 'charisma', 'constitution', 'willpower', 'size', 'education', 'dexterity', 'hitPoints', 'intelligence',
    ]);
    expect(matches[0]!.pairs[0]).toEqual({ label: 'S', canonicalKey: 'strength', value: '40', tokenIndex: 0 });
    expect(matches[0]!.startIndex).toBe(0);
    expect(matches[0]!.endIndex).toBe(18);
  });

  it('lapie siatke w INNEJ kolejnosci bez zmiany logiki (S2 — zbior etykiet, nie sekwencja)', () => {
    const tokens = row(['INT', '75', 'S', '25', 'P', '–', 'MOC', '70']);
    const matches = matchLabelledPairs(tokens, CHAR_GRID_PATTERN);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.pairs.map((p) => p.label)).toEqual(['INT', 'S', 'P', 'MOC']);
    expect(matches[0]!.pairs[2]!.value).toBe('–');
  });

  it('mniej niz minPairs -> brak dopasowania', () => {
    const tokens = row(['S', '40', 'WYG', '25']);
    expect(matchLabelledPairs(tokens, CHAR_GRID_PATTERN)).toHaveLength(0);
  });

  it('powtorzona etykieta zamyka siatke (terminate.onRepeatedLabel) — dwie osobne siatki na stronie (str. 55 z kroku 12/13)', () => {
    const tokens = row(['S', '60', 'WYG', '45', 'KON', '65', 'S', '50', 'WYG', '50', 'KON', '60']);
    const matches = matchLabelledPairs(tokens, CHAR_GRID_PATTERN);
    expect(matches).toHaveLength(2);
    expect(matches[0]!.pairs.map((p) => p.value)).toEqual(['60', '45', '65']);
    expect(matches[1]!.pairs.map((p) => p.value)).toEqual(['50', '50', '60']);
    expect(matches[1]!.startIndex).toBe(6);
  });

  it('maxGapPt zamyka siatke, gdy przestrzenna odleglosc miedzy parami jest za duza (dwie NIEPOWIAZANE siatki na stronie)', () => {
    const near = row(['S', '40', 'WYG', '25', 'KON', '35'], 0);
    const far = row(['MOC', '70', 'BC', '40', 'WYK', '90'], 500); // daleko w dol strony
    const tokens = [...near, ...far];
    const pattern: LabelledPairsPattern = { ...CHAR_GRID_PATTERN, terminate: { onRepeatedLabel: true, maxGapPt: 40 } };
    const matches = matchLabelledPairs(tokens, pattern);
    expect(matches).toHaveLength(2);
    expect(matches[0]!.pairs).toHaveLength(3);
    expect(matches[1]!.pairs).toHaveLength(3);
  });

  it('allowTrailingWords absorbuje opisowe tokeny PO wartosci, do nastepnej etykiety (blok pochodnych, "12/12" + "latając")', () => {
    const derivedPattern: LabelledPairsPattern = {
      kind: 'labelledPairs',
      labels: { PW: 'hitPoints', Ruch: 'movement' },
      valuePattern: '^.+$',
      minPairs: 2,
      terminate: { onRepeatedLabel: true },
      allowTrailingWords: true,
    };
    const tokens = row(['PW', '12', 'unosząc', 'się', 'w', 'powietrzu', 'Ruch', '9']);
    const matches = matchLabelledPairs(tokens, derivedPattern);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.pairs[0]!.value).toBe('12 unosząc się w powietrzu');
    expect(matches[0]!.pairs[1]!.value).toBe('9');
  });

  it('[KROK-19 Z0, zmierzony na realnej ksiazce blad] allowTrailingWords NIE polyka calej reszty strony, gdy brakuje kolejnej etykiety (str. 30 Zew Cthulhu — ostatni blok pochodnych przed proza konczaca strone)', () => {
    const derivedPattern: LabelledPairsPattern = {
      kind: 'labelledPairs',
      labels: { PW: 'hitPoints', 'Punkty Magii': 'magicPoints' },
      valuePattern: '^.+$',
      minPairs: 1,
      terminate: { onRepeatedLabel: true },
      allowTrailingWords: true,
    };
    const longProse = 'Zmniejszona liczba PW ze względu na wcześniejszy atak jaki przypuściła na niego Pasożytnicza Obca Forma Życia'.split(' ');
    const tokens = row(['Punkty Magii', '14', '*', ...longProse]);
    const matches = matchLabelledPairs(tokens, derivedPattern);
    const value = matches[0]!.pairs[0]!.value;
    expect(value.split(' ').length).toBeLessThanOrEqual(8); // "14" + do 6 slow koncowych, nie caly akapit
    expect(value).not.toContain('Pasożytnicza');
  });

  it('[KROK-19 Z4, zmierzony na realnej ksiazce blad] allowTrailingWords odrzuca CALY kandydujacy token, gdy pdf.js polaczyl caly wiersz przypisu w JEDEN wieloslowny token (str. 30, "Punkty Magii" Pasożytniczej wchlaniajace przypis o PW Joshuy)', () => {
    const derivedPattern: LabelledPairsPattern = { kind: 'labelledPairs', labels: { PW: 'hitPoints', 'Punkty Magii': 'magicPoints' }, valuePattern: '^.+$', minPairs: 1, terminate: { onRepeatedLabel: true }, allowTrailingWords: true };
    const tokens = row(['Punkty Magii', '14', '*', 'Zmniejszona liczba PW ze względu na wcześniejszy atak, jaki', 'przypuściła na niego Pasożytnicza Obca Forma Życia.', 'ATAKI']);
    const matches = matchLabelledPairs(tokens, derivedPattern);
    const value = matches[0]!.pairs[0]!.value;
    expect(value).not.toContain('Pasożytnicza');
    expect(value).not.toContain('Zmniejszona');
  });

  it('[KROK-19 Z4, zmierzony na realnej ksiazce blad] allowTrailingWords + trailingWordsStopBefore: nie chlonie naglowka INNEJ sekcji ("ATAKI") jako slowa opisowego (str. 55, funkcjonariusz — "Punkty Magii" 10 wchlaniajace "ATAKI Ataki w rundzie:" nastepnej postaci)', () => {
    const derivedPattern: LabelledPairsPattern = {
      kind: 'labelledPairs',
      labels: { PW: 'hitPoints', 'Punkty Magii': 'magicPoints' },
      valuePattern: '^.+$',
      minPairs: 1,
      terminate: { onRepeatedLabel: true },
      allowTrailingWords: true,
      trailingWordsStopBefore: '^ATAKI$|^\\p{Lu}[\\p{L} ]*:$',
    };
    const tokens = row(['Punkty Magii', '10', 'ATAKI', 'Ataki w rundzie:', '1', '%']);
    const matches = matchLabelledPairs(tokens, derivedPattern);
    expect(matches[0]!.pairs[0]!.value).toBe('10');
  });

  it('[KROK-21 Z3] allowTrailingWords nie chlonie znaku wodnego DriveThruRPG jako slowa opisowego, bez zadnej konfiguracji profilu', () => {
    const derivedPattern: LabelledPairsPattern = {
      kind: 'labelledPairs',
      labels: { PW: 'hitPoints', Ruch: 'movement' },
      valuePattern: '^.+$',
      minPairs: 1,
      terminate: { onRepeatedLabel: true },
      allowTrailingWords: true,
    }; // celowo BEZ trailingWordsStopBefore
    const tokens = row(['Ruch', '9', 'Maciej Pasierbek (Order #47403027)']);
    const matches = matchLabelledPairs(tokens, derivedPattern);
    expect(matches[0]!.pairs[0]!.value).toBe('9');
  });

  it('zwraca bbox jako unie tokenow etykiet siatki', () => {
    const tokens = row(['S', '40', 'WYG', '25', 'KON', '35']);
    const matches = matchLabelledPairs(tokens, CHAR_GRID_PATTERN);
    expect(matches[0]!.bbox).toEqual({ minX: 0, maxX: 48, minY: 0, maxY: 10 });
  });

  describe('footnoteText — [KROK-33 Z1, zmierzony na zywo brak, Sciapod str. 24 "Wrak.pdf"]', () => {
    const derivedPattern: LabelledPairsPattern = {
      kind: 'labelledPairs',
      labels: { 'MO:': 'bonusDamage', 'Krzepa:': 'build', 'Ruch:': 'movement', 'PM:': 'manaPoints' },
      valuePattern: '^.+$',
      minPairs: 1,
      terminate: { onRepeatedLabel: true },
      allowTrailingWords: false,
    };

    it('dokladnie JEDNA para w bloku konczaca sie gola gwiazdka -> przypis z NASTEPNEGO wiersza dolaczony WYLACZNIE do niej', () => {
      const tokens = row(['MO:', '+5K6', 'Krzepa:', '6', 'Ruch:', '7/9*', 'PM:', '8', '*Pływanie']);
      const matches = matchLabelledPairs(tokens, derivedPattern);
      expect(matches).toHaveLength(1);
      const [mo, krzepa, ruch, pm] = matches[0]!.pairs;
      expect(mo!.footnoteText).toBeUndefined();
      expect(krzepa!.footnoteText).toBeUndefined();
      expect(ruch!.footnoteText).toBe('*Pływanie');
      expect(pm!.footnoteText).toBeUndefined();
      // Przypis zostaje SKONSUMOWANY (endIndex go obejmuje), zeby nic innego nizej nie probowalo go jeszcze raz dopasowac.
      expect(matches[0]!.endIndex).toBe(9);
    });

    it('DWIE pary konczace sie gola gwiazdka w tym samym bloku -> przypis NIE zostaje dolaczony do zadnej (A10, nie zgaduj)', () => {
      const tokens = row(['MO:', '+5K6*', 'Krzepa:', '6', 'Ruch:', '7/9*', 'PM:', '8', '*Jakis przypis']);
      const matches = matchLabelledPairs(tokens, derivedPattern);
      expect(matches[0]!.pairs.every((p) => p.footnoteText === undefined)).toBe(true);
      // Bez jednoznacznego adresata przypis NIE jest konsumowany -- zostaje osobnym tokenem w strumieniu.
      expect(matches[0]!.endIndex).toBe(8);
    });

    it('brak wiersza zaczynajacego sie od gwiazdki po bloku -> zwykle dopasowanie bez zmian', () => {
      const tokens = row(['Ruch:', '7/9*', 'PM:', '8']);
      const matches = matchLabelledPairs(tokens, derivedPattern);
      expect(matches[0]!.pairs[0]!.footnoteText).toBeUndefined();
      expect(matches[0]!.endIndex).toBe(4);
    });

    it('nastepny token zaczyna sie od gwiazdki, ale ZADNA wartosc w bloku nie konczy sie gwiazdka -> nie dolaczany (nic pasujacego do przypisania)', () => {
      const tokens = row(['Ruch:', '9', 'PM:', '8', '*Cos niepowiazanego']);
      const matches = matchLabelledPairs(tokens, derivedPattern);
      expect(matches[0]!.pairs.every((p) => p.footnoteText === undefined)).toBe(true);
      expect(matches[0]!.endIndex).toBe(4);
    });
  });

  describe('descriptionText — [KROK-34 Z1, zmierzony na zywo brak, Sciapod str. 24 "Wrak.pdf"]', () => {
    const armorPattern: LabelledPairsPattern = {
      kind: 'labelledPairs',
      labels: { 'Pancerz:': 'armour', 'Ruch:': 'movement' },
      valuePattern: '^.+$',
      minPairs: 1,
      terminate: { onRepeatedLabel: true },
      allowTrailingWords: false,
    };

    it('liczba + przecinek + opis W JEDNYM TOKENIE (realny ksztalt pdf.js) -> value przycieta do liczby, reszta w descriptionText', () => {
      const tokens = row(['Pancerz:', '5, niezwykle gruba skóra. Pamiętaj, że obrażenia']);
      const matches = matchLabelledPairs(tokens, armorPattern);
      expect(matches[0]!.pairs[0]!.value).toBe('5');
      expect(matches[0]!.pairs[0]!.descriptionText).toBe('niezwykle gruba skóra. Pamiętaj, że obrażenia');
    });

    it('liczba + srednik/dwukropek dzialaja tak samo jak przecinek', () => {
      expect(matchLabelledPairs(row(['Pancerz:', '3; kolczuga']), armorPattern)[0]!.pairs[0]).toMatchObject({ value: '3', descriptionText: 'kolczuga' });
      expect(matchLabelledPairs(row(['Pancerz:', '3: kolczuga']), armorPattern)[0]!.pairs[0]).toMatchObject({ value: '3', descriptionText: 'kolczuga' });
    });

    it('sama liczba bez opisu -> descriptionText nieustawione, value bez zmian (bez regresji na czystych wartosciach)', () => {
      const matches = matchLabelledPairs(row(['Pancerz:', '5']), armorPattern);
      expect(matches[0]!.pairs[0]!.value).toBe('5');
      expect(matches[0]!.pairs[0]!.descriptionText).toBeUndefined();
    });

    it('[DoD kroku 34: "wartosc opisowa nie moze zniknac"] wartosc CZYSTO opisowa bez wiodacej liczby ("brak") zostaje CALA w value, nie jest dzielona', () => {
      const matches = matchLabelledPairs(row(['Pancerz:', 'brak']), armorPattern);
      expect(matches[0]!.pairs[0]!.value).toBe('brak');
      expect(matches[0]!.pairs[0]!.descriptionText).toBeUndefined();
    });

    it('[DoD kroku 34] liczba ZLEPIONA bez separatora z dalszym opisem ("2-punktowa gruba skóra") zostaje CALA w value -- brak przecinka/srednika/dwukropka po liczbie', () => {
      const matches = matchLabelledPairs(row(['Pancerz:', '2-punktowa gruba skóra']), armorPattern);
      expect(matches[0]!.pairs[0]!.value).toBe('2-punktowa gruba skóra');
      expect(matches[0]!.pairs[0]!.descriptionText).toBeUndefined();
    });

    it('[regresja zlapana na zywo] zapis N/M ("7/9*", Ruch) NIE jest dzielony -- "/" nie jest separatorem z listy', () => {
      const matches = matchLabelledPairs(row(['Ruch:', '7/9*']), armorPattern);
      expect(matches[0]!.pairs[0]!.value).toBe('7/9*');
      expect(matches[0]!.pairs[0]!.descriptionText).toBeUndefined();
    });

    it('[regresja zlapana na zywo] allowTrailingWords + opis oddzielony SAMA SPACJA (bez przecinka) NIE jest dzielony -- to jest ISTNIEJACE zachowanie "12 latający" = cala wartosc', () => {
      const pattern: LabelledPairsPattern = { ...armorPattern, allowTrailingWords: true };
      const matches = matchLabelledPairs(row(['Ruch:', '12', 'unosząc', 'się', 'w', 'powietrzu']), pattern);
      expect(matches[0]!.pairs[0]!.value).toBe('12 unosząc się w powietrzu');
      expect(matches[0]!.pairs[0]!.descriptionText).toBeUndefined();
    });

    it('[zgloszenie uzytkownika, "Pancerz jest niepełny", zmierzone na zywo na Sciapodzie str. 24 "Wrak.pdf"] zdanie opisowe PRZELAMANE na kolejny fizyczny wiersz (osobny token pdf.js) doklejane do descriptionText, mimo ze przekracza MAX_TRAILING_WORDS (5 slow) i allowTrailingWords jest wylaczone', () => {
      const tokens = row([
        'Pancerz:',
        '5, niezwykle gruba skóra. Pamiętaj, że obrażenia',
        'zadawane srebrną bronią ignorują pancerz.',
      ]);
      const matches = matchLabelledPairs(tokens, armorPattern);
      expect(matches[0]!.pairs[0]!.value).toBe('5');
      expect(matches[0]!.pairs[0]!.descriptionText).toBe('niezwykle gruba skóra. Pamiętaj, że obrażenia zadawane srebrną bronią ignorują pancerz.');
      expect(matches[0]!.endIndex).toBe(3);
    });

    it('kontynuacja zatrzymuje sie na KOLEJNEJ etykiecie tego wzorca, nie polyka pary "Ruch:"/"7"', () => {
      const tokens = row(['Pancerz:', '5, gruba skóra', 'Ruch:', '8']);
      const matches = matchLabelledPairs(tokens, armorPattern);
      expect(matches[0]!.pairs[0]!.descriptionText).toBe('gruba skóra');
      expect(matches[0]!.pairs.map((p) => p.canonicalKey)).toEqual(['armour', 'movement']);
      expect(matches[0]!.pairs[1]).toMatchObject({ value: '8' });
    });

    it('kontynuacja ma twardy limit (guard) i zatrzymuje sie, gdy zdanie nigdy nie konczy sie kropka/wykrzyknikiem/pytajnikiem', () => {
      const tokens = row(['Pancerz:', '5, opis', 'bez', 'zadnej', 'koncowej', 'interpunkcji', 'nigdy', 'sie', 'nie', 'konczy']);
      const matches = matchLabelledPairs(tokens, armorPattern);
      expect(matches[0]!.pairs[0]!.descriptionText).toBe('opis bez zadnej koncowej interpunkcji nigdy');
    });
  });
});

const ATTACK_PATTERN: SectionListPattern = {
  kind: 'sectionList',
  sectionHeader: '^ATAKI$',
  itemPattern: '(?<name>[\\p{L} ()]+?) (?<toHit>\\d{1,3})%',
  rejoinHyphenated: false,
};

describe('matchSectionList — [KROK-18 Z2]', () => {
  it('lapie pozycje ataku po naglowku ATAKI, laczac tokeny w bufor', () => {
    const tokens = row(['ATAKI', 'Walka', 'Wręcz', '40%', 'Unik', '30%']);
    const matches = matchSectionList(tokens, ATTACK_PATTERN);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.items.map((i) => i.groups['name']?.trim())).toEqual(['Walka Wręcz', 'Unik']);
    expect(matches[0]!.items.map((i) => i.groups['toHit'])).toEqual(['40', '30']);
  });

  it('zamyka sekcje przy kolejnym naglowku ATAKI (dwie postacie na jednej stronie, str. 30 z kroku 12/13)', () => {
    const tokens = row(['ATAKI', 'Bijatyka', '30%', 'ATAKI', 'Przyssanie', '40%']);
    const matches = matchSectionList(tokens, ATTACK_PATTERN);
    expect(matches).toHaveLength(2);
    expect(matches[0]!.items[0]!.groups['name']?.trim()).toBe('Bijatyka');
    expect(matches[1]!.items[0]!.groups['name']?.trim()).toBe('Przyssanie');
    expect(matches[1]!.headerTokenIndex).toBe(3);
  });

  it('[KROK-34, zmierzony na zywo blad, "name: may not be undefined" w Foundry] pusty itemPattern (dopasowuje zero znakow na KAZDEJ pozycji buforu) nie produkuje setek pustych pozycji — schemat juz to odrzuca przy wczytaniu (schema.test.ts), to dodatkowa siatka bezpieczenstwa dla draftu Profile Studio jeszcze niewalidowanego', () => {
    const pattern: SectionListPattern = { ...ATTACK_PATTERN, itemPattern: '' };
    const tokens = row(['ATAKI', 'Walka', 'Wręcz', '40%', 'Unik', '30%']);
    const matches = matchSectionList(tokens, pattern);
    expect(matches[0]!.items).toEqual([]);
  });

  it('rejoinHyphenated skleja opis rozbity dywizacja na osobne tokeny (str. 84, Missy Beaker, krok 12)', () => {
    const pattern: SectionListPattern = { ...ATTACK_PATTERN, itemPattern: '(?<desc>[\\p{L} .;-]+)', rejoinHyphenated: true };
    const tokens = row(['ATAKI', 'nie', 'wyko', '-', 'nuje', 'ataków.']);
    const matches = matchSectionList(tokens, pattern);
    expect(matches[0]!.items[0]!.raw).toContain('wykonuje');
    expect(matches[0]!.items[0]!.raw).not.toContain('wyko -nuje');
  });

  it('[KROK-19 Z1, zmierzony na realnej ksiazce blad] skipAfterHeader pomija naglowek kolumny tabeli PRZED pierwsza prawdziwa pozycja (str. 30, "% obrażenia" jako dwa osobne tokeny)', () => {
    const pattern: SectionListPattern = { ...ATTACK_PATTERN, skipAfterHeader: '^%$|^obrażenia$' };
    const tokens = row(['ATAKI', '%', 'obrażenia', 'Przyssanie', '40%']);
    const matches = matchSectionList(tokens, pattern);
    expect(matches[0]!.items[0]!.groups['name']?.trim()).toBe('Przyssanie');
  });

  it('skipAfterHeader zatrzymuje sie na pierwszym tokenie, ktory NIE pasuje (nie polyka prawdziwej tresci)', () => {
    const pattern: SectionListPattern = { ...ATTACK_PATTERN, skipAfterHeader: '^%$|^obrażenia$' };
    const tokens = row(['ATAKI', 'Przyssanie', '40%']); // brak naglowka kolumny na tej stronie
    const matches = matchSectionList(tokens, pattern);
    expect(matches[0]!.items[0]!.groups['name']?.trim()).toBe('Przyssanie');
  });

  describe('[KROK-40, zgloszenie na zywo, "pistolet trafia do melee zamiast do range"] rangedKeywords', () => {
    it('oznacza pozycje jako ranged, gdy grupa name zawiera jedno ze slow kluczowych (case-insensitive)', () => {
      const pattern: SectionListPattern = { ...ATTACK_PATTERN, rangedKeywords: ['broń palna'] };
      const tokens = row(['ATAKI', 'Walka', 'Wręcz', '40%', 'Broń', 'Palna', '(pistolet)', '30%']);
      const matches = matchSectionList(tokens, pattern);
      expect(matches[0]!.items.map((i) => i.ranged)).toEqual([false, true]);
    });

    it('nie oznacza niczego, gdy rangedKeywords puste (domyslne, wsteczna zgodnosc)', () => {
      const tokens = row(['ATAKI', 'Broń', 'Palna', '40%']);
      const matches = matchSectionList(tokens, ATTACK_PATTERN);
      expect(matches[0]!.items[0]!.ranged).toBe(false);
    });
  });

  it('[KROK-19 Z1, naprawiony blad #2, zmierzony na realnej ksiazce] skipAfterHeader znajduje naglowek kolumny mimo zmiennej dlugosci preambuly miedzy naglowkiem sekcji a nim ("Ataki w rundzie: 1" przed "% obrażenia", str. 30)', () => {
    const pattern: SectionListPattern = { ...ATTACK_PATTERN, skipAfterHeader: '^%$|^obrażenia$' };
    const tokens = row(['ATAKI', 'Ataki w rundzie:', '1 (przyssanie lub przejęcie kontroli)', '%', 'obrażenia', 'Przyssanie', '40%']);
    const matches = matchSectionList(tokens, pattern);
    expect(matches[0]!.items[0]!.groups['name']?.trim()).toBe('Przyssanie');
  });

  it('[KROK-19 Z4, zmierzony na realnej ksiazce blad] terminateSectionBefore przerywa bufor PRZED tokenem-naglowkiem kolejnej sekcji, nawet gdy nie ma juz kolejnego ATAKI na stronie (str. 30 — lista Umiejętności: nastepujaca po opisie Pasożytniczej)', () => {
    const pattern: SectionListPattern = { ...ATTACK_PATTERN, terminateSectionBefore: '^\\p{Lu}[\\p{L} ]*:$' };
    const tokens = row(['ATAKI', 'Przyssanie', '40%', 'Umiejętności:', 'Historia', '75%']);
    const matches = matchSectionList(tokens, pattern);
    expect(matches[0]!.items.map((i) => i.groups['name']?.trim())).toEqual(['Przyssanie']);
  });

  it('[KROK-19 Z4, zmierzony na realnej ksiazce blad] itemPattern z wymogiem "Wielka+mala litera" na starcie nazwy: nie lapie samotnego ")" z nazwy zawierajacej cyfry w nawiasie ("Broń Palna (Rewolwer .32) 40%")', () => {
    const realBookItemPattern = '(?<name>\\p{Lu}\\p{Ll}[\\p{L} ()./\\d-]*?) (?<toHit>\\d{1,3})%';
    const pattern: SectionListPattern = { ...ATTACK_PATTERN, itemPattern: realBookItemPattern };
    const tokens = row(['ATAKI', 'Broń', 'Palna', '(Rewolwer', '.32)', '40%', '(20/8)', '1K8', 'Unik', '25%']);
    const matches = matchSectionList(tokens, pattern);
    expect(matches[0]!.items.map((i) => i.groups['name']?.trim())).toEqual(['Broń Palna (Rewolwer .32)', 'Unik']);
  });

  it('[KROK-19 Z4, zmierzony na realnej ksiazce blad] itemPattern nie doczepia koncowki obrazen "(MO)" jako prefiksu NASTEPNEJ nazwy ataku ("...1K6 + 1K4 (MO) Walka Wręcz (Siekiera) 50%")', () => {
    const realBookItemPattern = '(?<name>\\p{Lu}\\p{Ll}[\\p{L} ()./\\d-]*?) (?<toHit>\\d{1,3})%';
    const pattern: SectionListPattern = { ...ATTACK_PATTERN, itemPattern: realBookItemPattern };
    const tokens = row(['ATAKI', 'Walka', 'Wręcz', '(Bijatyka)', '50%', '(25/10)', '1K3', '+', '1K6', '(MO)', 'Walka', 'Wręcz', '(Siekiera)', '50%', '(25/10)', 'Unik', '25%']);
    const matches = matchSectionList(tokens, pattern);
    expect(matches[0]!.items.map((i) => i.groups['name']?.trim())).toEqual(['Walka Wręcz (Bijatyka)', 'Walka Wręcz (Siekiera)', 'Unik']);
  });

  it('[KROK-19 Z5, zgloszony na zywo brak] itemPattern z grupa damage: przechwytuje obrazenia miedzy "TOHIT% (X/Y)" a NASTEPNA pozycja (str. 55, funkcjonariusz — 3 bronie, kazda z wlasnym obrazeniem)', () => {
    const realBookItemPattern = '(?<name>\\p{Lu}\\p{Ll}[\\p{L} ()./\\d-]*?) (?<toHit>\\d{1,3})%(?:\\s*\\(\\d+/\\d+\\))?(?<damage>.*?)(?=\\s*\\p{Lu}\\p{Ll}[\\p{L} ()./\\d-]*? \\d{1,3}%|$)';
    const pattern: SectionListPattern = { ...ATTACK_PATTERN, itemPattern: realBookItemPattern };
    const tokens = row([
      'ATAKI', 'Walka', 'Wręcz', '(Bijatyka)', '40% (20/8)', '1K3', 'Walka', 'Wręcz', '(Pałka', 'Policyjna)', '40% (20/8)', '1K6',
      'Broń', 'Palna', '(Rewolwer', '.32)', '40% (20/8)', '1K8', 'Unik', '25%',
    ]);
    const matches = matchSectionList(tokens, pattern);
    const items = matches[0]!.items;
    expect(items.map((i) => i.groups['name']?.trim())).toEqual(['Walka Wręcz (Bijatyka)', 'Walka Wręcz (Pałka Policyjna)', 'Broń Palna (Rewolwer .32)', 'Unik']);
    expect(items.map((i) => i.groups['damage']?.trim())).toEqual(['1K3', '1K6', '1K8', '']);
  });

  it('[KROK-19 Z5] itemPattern z grupa damage: koncowka "(MO)" trafia do obrazen POPRZEDNIEJ broni, nie do nazwy nastepnej (str. 84, Jacob Beaker)', () => {
    const realBookItemPattern = '(?<name>\\p{Lu}\\p{Ll}[\\p{L} ()./\\d-]*?) (?<toHit>\\d{1,3})%(?:\\s*\\(\\d+/\\d+\\))?(?<damage>.*?)(?=\\s*\\p{Lu}\\p{Ll}[\\p{L} ()./\\d-]*? \\d{1,3}%|$)';
    const pattern: SectionListPattern = { ...ATTACK_PATTERN, itemPattern: realBookItemPattern };
    const tokens = row([
      'ATAKI', 'Walka', 'Wręcz', '(Bijatyka)', '50% (25/10)', '1K3', '+', '1K6', '(MO)', 'Walka', 'Wręcz', '(Siekiera)', '50% (25/10)', 'Unik', '25% (12/5)',
    ]);
    const matches = matchSectionList(tokens, pattern);
    const items = matches[0]!.items;
    expect(items.map((i) => i.groups['name']?.trim())).toEqual(['Walka Wręcz (Bijatyka)', 'Walka Wręcz (Siekiera)', 'Unik']);
    expect(items[0]!.groups['damage']?.trim()).toBe('1K3 + 1K6 (MO)');
    expect(items[1]!.groups['damage']?.trim()).toBe('');
  });

  it('podaje poprawny zakres tokenow (startTokenIndex/endTokenIndex) dla dopasowanej pozycji', () => {
    const tokens = row(['ATAKI', 'Walka', 'Wręcz', '40%']);
    const matches = matchSectionList(tokens, ATTACK_PATTERN);
    const item = matches[0]!.items[0]!;
    expect(item.startTokenIndex).toBe(1);
    expect(item.endTokenIndex).toBe(3);
  });

  it('brak naglowka -> brak dopasowan', () => {
    const tokens = row(['Walka', 'Wręcz', '40%']);
    expect(matchSectionList(tokens, ATTACK_PATTERN)).toHaveLength(0);
  });

  it('[KROK-21 Z3, zmierzony na zywo blad] znak wodny DriveThruRPG zatrzymuje bufor sekcji BEZ zadnej konfiguracji profilu (dziala niezaleznie od terminateSectionBefore tego profilu — cecha dystrybutora, nie publikacji)', () => {
    const realBookItemPattern = '(?<name>\\p{Lu}\\p{Ll}[\\p{L} ()./\\d-]*?) (?<toHit>\\d{1,3})%(?:\\s*\\(\\d+/\\d+\\))?(?<damage>.*?)(?=\\s*\\p{Lu}\\p{Ll}[\\p{L} ()./\\d-]*? \\d{1,3}%|$)';
    const pattern: SectionListPattern = { ...ATTACK_PATTERN, itemPattern: realBookItemPattern }; // celowo BEZ terminateSectionBefore
    const tokens = row(['ATAKI', 'Unik', '30%', 'Maciej Pasierbek (Order #47403027)']);
    const matches = matchSectionList(tokens, pattern);
    expect(matches[0]!.items.map((i) => i.groups['name']?.trim())).toEqual(['Unik']);
    expect(matches[0]!.items[0]!.groups['damage']?.trim()).toBe('');
  });

  it('[KROK-20 Z2, zmierzony na zywo blad] hardStopTokenIndices ogranicza bufor, gdy ani naglowek ani terminateSectionBefore nie robia tego wczesniej (str. 55 "nie czas na krzyk" — Unik ostatniej pozycji polykal cala siatke cech NASTEPNEJ postaci, bo miedzy nimi nie stoi zaden naglowek)', () => {
    const realBookItemPattern = '(?<name>\\p{Lu}\\p{Ll}[\\p{L} ()./\\d-]*?) (?<toHit>\\d{1,3})%(?:\\s*\\(\\d+/\\d+\\))?(?<damage>.*?)(?=\\s*\\p{Lu}\\p{Ll}[\\p{L} ()./\\d-]*? \\d{1,3}%|$)';
    const pattern: SectionListPattern = { ...ATTACK_PATTERN, itemPattern: realBookItemPattern };
    // Brak "Umiejętności:"/kolejnego "ATAKI" miedzy koncem tej sekcji a "S" —
    // dokladnie uklad zmierzony na str. 55 (trzy przykladowe postacie w rzad).
    const tokens = row(['ATAKI', 'Walka', 'Wręcz', '40%', 'Unik', '22%', 'S', '60', 'WYG', '40', 'KON', '60']);
    const sIndex = tokens.findIndex((t) => t.text === 'S');

    const withoutHardStop = matchSectionList(tokens, pattern);
    expect(withoutHardStop[0]!.items.at(-1)!.groups['damage']).toContain('WYG');

    const withHardStop = matchSectionList(tokens, pattern, [sIndex]);
    expect(withHardStop[0]!.items.at(-1)!.groups['name']?.trim()).toBe('Unik');
    expect(withHardStop[0]!.items.at(-1)!.groups['damage']?.trim()).toBe('');
  });

  it('hardStopTokenIndices ponizej/rownym naglowkowi sekcji sa ignorowane (dotyczy tylko GRANIC PO tej sekcji)', () => {
    const tokens = row(['ATAKI', 'Walka', '40%']);
    const matches = matchSectionList(tokens, ATTACK_PATTERN, [0]); // 0 = sam naglowek ATAKI
    expect(matches[0]!.items.map((i) => i.groups['name']?.trim())).toEqual(['Walka']);
  });
});

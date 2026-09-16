import { describe, expect, it } from 'vitest';
import { inferItemPatternFromExamples, collectRowText, type RowTextToken } from '../../src/profiles/inferItemPatternFromExamples.js';
import { matchSectionList } from '../../src/profiles/patterns.js';
import type { ProfileToken } from '../../src/profiles/types.js';
import type { SectionListPattern } from '../../src/profiles/schema.js';

function tok(text: string): ProfileToken {
  return { text, bbox: { minX: 0, maxX: 0, minY: 0, maxY: 0 } };
}

/** Zbudowany bufor sekcji przez `matchSectionList` z pojedynczym naglowkiem + reszta tokenow polaczona spacjami -- pierwszy token to zawsze naglowek. */
function itemsFor(pattern: SectionListPattern, header: string, ...body: string[]): { groups: Record<string, string> }[] {
  return matchSectionList([tok(header), ...body.map(tok)], pattern)[0]?.items ?? [];
}

describe('inferItemPatternFromExamples — [KROK-29 Z1]', () => {
  it('brak przykladow -> null', () => {
    expect(inferItemPatternFromExamples('attacks', [])).toBeNull();
  });

  it('przyklad bez zadnej liczby -> null (nie zgaduje dowolnego wyrazenia)', () => {
    expect(inferItemPatternFromExamples('attacks', ['coś bez liczby'])).toBeNull();
  });

  describe('umiejetnosci — ksztalt "nazwa + procent", lista oddzielona przecinkami', () => {
    it('[zmierzone str. 23 "Zew Cthulhu 7ed. Wrak.pdf", Calhoun] rozpoznaje WSZYSTKIE 17 pozycji listy PL z nawiasami i polskimi znakami z JEDNEGO przykladu', () => {
      const inferred = inferItemPatternFromExamples('skills', ['Elektryka 35%']);
      expect(inferred?.shape).toBe('shapePercentList');
      const pattern: SectionListPattern = { kind: 'sectionList', sectionHeader: '^Umiejętności$', itemPattern: inferred!.itemPattern, rejoinHyphenated: false };
      const items = itemsFor(
        pattern,
        'Umiejętności',
        ': Elektryka 35%, Mechanika 65%, Nasłuchiwanie 40%, Nauka (Inżynieria) 20%, Nawigacja 75%, Nurkowanie 45%, Obsługa Ciężkiego Sprzętu 25%, Pierwsza Pomoc 70%, Pilotowanie (Łódź) 80%, Pływanie 65%, Prawo 30%, Psychologia 40%, Rzucanie 40%, Spostrzegawczość 50%, Wiedza o Naturze 55%, Wspinaczka 40%, Zastraszanie 45%.',
      );
      expect(items.map((i) => `${i.groups['name']}=${i.groups['value']}%`)).toEqual([
        'Elektryka=35%',
        'Mechanika=65%',
        'Nasłuchiwanie=40%',
        'Nauka (Inżynieria)=20%',
        'Nawigacja=75%',
        'Nurkowanie=45%',
        'Obsługa Ciężkiego Sprzętu=25%',
        'Pierwsza Pomoc=70%',
        'Pilotowanie (Łódź)=80%',
        'Pływanie=65%',
        'Prawo=30%',
        'Psychologia=40%',
        'Rzucanie=40%',
        'Spostrzegawczość=50%',
        'Wiedza o Naturze=55%',
        'Wspinaczka=40%',
        'Zastraszanie=45%',
      ]);
    });

    it('przyklad bez procentu na zakladce umiejetnosci -> null', () => {
      expect(inferItemPatternFromExamples('skills', ['Pancerz 2'])).toBeNull();
    });
  });

  describe('ataki — ksztalt "nazwa + procent [+ reszta po przecinku]", jedna pozycja per "linia" bufora', () => {
    it('[zmierzone str. 23 "Zew Cthulhu 7ed. Wrak.pdf", Calhoun] JEDEN przyklad z procentem -> rozpoznaje "Walka wręcz" i "Unik", ale NIE "pałka" (brak procentu)', () => {
      const inferred = inferItemPatternFromExamples('attacks', ['Walka wręcz (Bijatyka) 30% (15/6), obrażenia 1K3+1K4 lub']);
      expect(inferred?.shape).toBe('shapePercentRest');
      const pattern: SectionListPattern = { kind: 'sectionList', sectionHeader: '^Walka$', itemPattern: inferred!.itemPattern, rejoinHyphenated: false };
      const items = itemsFor(pattern, 'Walka', 'Walka wręcz (Bijatyka) 30% (15/6), obrażenia 1K3+1K4 lub', 'pałka 1K4+1K4', 'Unik 30% (15/6)');
      // [KROK-30 Z2] "pałka 1K4+1K4 lub" -- w tym CHLONIETE jako nienazwany
      // "ogon" pozycji 1 (lookahead nie zna jeszcze ksztaltu "wartosc bez
      // procentu", wiec ta pozycja nie moze zostac osobnym dopasowaniem), ale
      // grupa `damage` zostaje CZYSTA -- "pałka" nie wchodzi do niej, tylko do
      // nienazwanego, odrzucanego ogona dopasowania.
      expect(items).toHaveLength(2);
      expect(items[0]!.groups['name']).toBe('Walka wręcz (Bijatyka)');
      expect(items[0]!.groups['damage']).toBe('1K3+1K4');
      expect(items[1]!.groups['name']).toBe('Unik');
    });

    it('[to samo zmierzone, DRUGI przyklad "pałka" rozszerza wzorzec] Z DWOMA przykladami (procent + bezprocentowy) rozpoznaje WSZYSTKIE TRZY pozycje osobno', () => {
      const inferred = inferItemPatternFromExamples('attacks', ['Walka wręcz (Bijatyka) 30% (15/6), obrażenia 1K3+1K4 lub', 'pałka 1K4+1K4']);
      expect(inferred?.shape).toBe('shapeMixed');
      const pattern: SectionListPattern = { kind: 'sectionList', sectionHeader: '^Walka$', itemPattern: inferred!.itemPattern, rejoinHyphenated: false };
      const items = itemsFor(pattern, 'Walka', 'Walka wręcz (Bijatyka) 30% (15/6), obrażenia 1K3+1K4 lub', 'pałka 1K4+1K4', 'Unik 30% (15/6)');
      expect(items).toHaveLength(3);
      expect(items[0]!.groups['name']).toBe('Walka wręcz (Bijatyka)');
      expect(items[0]!.groups['toHit']).toBe('30');
      // [KROK-30 Z2, zmierzony na zywo blad] Czysta wartosc kostkowa -- BEZ
      // przecinka, BEZ slowa etykiety ("obrażenia"), BEZ dyndajacego "lub".
      // Realny bug: `CIFAttack.damage` wychodzil jako ", obrażenia 1K3+1K4 lub".
      expect(items[0]!.groups['damage']).toBe('1K3+1K4');
      expect(items[1]!.groups['name']).toBe('pałka');
      expect(items[1]!.groups['damage']).toBe('1K4+1K4');
      expect(items[1]!.groups['toHit']).toBeUndefined();
      expect(items[2]!.groups['name']).toBe('Unik');
      expect(items[2]!.groups['toHit']).toBe('30');
    });

    it('[Zmierzony na zywo blad, prawdziwy eksport Actora "Sciapod" z Foundry] ksztalt mieszany (procent + bezprocentowy) NIE lapie golych numerow z prozy opisu zdolnosci specjalnych jako fantomowych "broni bez procentu"', () => {
      // Realny tekst opisu zdolnosci specjalnej ze str. 24 "Wrak.pdf" — po
      // ostatnim prawdziwym ataku ("Unik 35% (17/7)") sekcja leci dalej w
      // proze pelna zwyklych liczb ("o długości 6 stóp (ok. 180 cm)...
      // zasięg... ok. 40 m"). Bez DICE_VALUE kazda z nich (poprzedzona
      // jakimkolwiek slowem) wygladala jak poprawna pozycja `valueItem` —
      // zmierzone wprost w prawdziwym eksporcie Actora: fantomowe bronie
      // "stóp (ok." (obrażenia=180) i "cm). Podstawowy zasięg tej broni to
      // ok." (obrażenia=40).
      const inferred = inferItemPatternFromExamples('attacks', ['Walka wręcz (Bijatyka) 30% (15/6), obrażenia 1K3+1K4 lub', 'pałka 1K4+1K4']);
      const pattern: SectionListPattern = { kind: 'sectionList', sectionHeader: '^Walka$', itemPattern: inferred!.itemPattern, rejoinHyphenated: false };
      const items = itemsFor(
        pattern,
        'Walka',
        'Kryształowy łuk 50% (25/10), obrażenia 1K8+2K6',
        'Unik 35% (17/7)',
        'dziwny łuk ściąpoda wystrzeliwuje przypominające harpuny strzały o długości 6 stóp (ok. 180 cm). Podstawowy zasięg tej broni to ok. 40 m.',
      );
      expect(items.map((i) => i.groups['name'])).not.toContain('stóp (ok.');
      expect(items.map((i) => i.groups['name'])).not.toContain('cm). Podstawowy zasięg tej broni to ok.');
      expect(items.map((i) => i.groups['damage'])).not.toContain('180');
      expect(items.map((i) => i.groups['damage'])).not.toContain('40');
      expect(items).toHaveLength(2);
      expect(items[0]!.groups['name']).toBe('Kryształowy łuk');
      expect(items[1]!.groups['name']).toBe('Unik');
    });

    it('[KROK-33 Z3, zmierzony na zywo blad, Sciapod str. 24 "Wrak.pdf"] separator dwukropek + obrazenia na KONCU dlugiego opisu (nie zaraz po separatorze) -- damage nadal wychodzi czyste', () => {
      const inferred = inferItemPatternFromExamples('attacks', ['Walka wręcz (Bijatyka) 30% (15/6), obrażenia 1K3+1K4 lub', 'pałka 1K4+1K4']);
      const pattern: SectionListPattern = { kind: 'sectionList', sectionHeader: '^Walka$', itemPattern: inferred!.itemPattern, rejoinHyphenated: false };
      const items = itemsFor(
        pattern,
        'Walka',
        'Chwyt i miażdżenie (manewr) 60% (30/12): pochwycenie,',
        'miażdżenie odbywa się w następnej rundzie, obrażenia 5K6',
        'Kryształowy łuk 50% (25/10), obrażenia 1K8+2K6',
      );
      expect(items[0]!.groups['name']).toBe('Chwyt i miażdżenie (manewr)');
      expect(items[0]!.groups['toHit']).toBe('60');
      expect(items[0]!.groups['damage']).toBe('5K6');
      expect(items[1]!.groups['name']).toBe('Kryształowy łuk');
      expect(items[1]!.groups['damage']).toBe('1K8+2K6');
    });

    it('[Zmierzony na zywo blad, DRUGI prawdziwy eksport Actora "Sciapod" z Foundry] dlugi akapit fabularny miedzy naglowkiem "Walka" a pierwsza pozycja NIE zanieczyszcza jej nazwy', () => {
      // Prawdziwy uklad str. 24 "Wrak.pdf": naglowek "Walka", zaraz potem
      // DLUGI akapit opisujacy sposob walki sciapoda, dopiero PO NIM pierwsza
      // prawdziwa pozycja ataku. Bez naprawy kropki w `NAME_CLASS`,
      // dopasowanie global/leftmost-first probowalo NAJPIERW pozycje startowa
      // na poczatku akapitu i (skoro kropka byla dozwolona w klasie nazwy)
      // pochlanialo CALY akapit + prawdziwa nazwe jako jedna, zanieczyszczona
      // nazwe pozycji — zmierzone wprost w prawdziwym eksporcie Actora:
      // `name` = "może użyć swojej stopy i zadeptać przeciwnika lub wykonać
      // atak dystansowy przy pomocy krysz- tałowego łuku. Walka wręcz
      // (Bijatyka)" zamiast czystego "Walka wręcz (Bijatyka)".
      const inferred = inferItemPatternFromExamples('attacks', ['Walka wręcz (Bijatyka) 30% (15/6), obrażenia 1K3+1K4 lub', 'pałka 1K4+1K4']);
      const pattern: SectionListPattern = { kind: 'sectionList', sectionHeader: '^Walka$', itemPattern: inferred!.itemPattern, rejoinHyphenated: false };
      const items = itemsFor(
        pattern,
        'Walka',
        'może użyć swojej stopy i zadeptać przeciwnika lub wykonać atak dystansowy przy pomocy krysz- tałowego łuku.',
        'Walka wręcz (Bijatyka) 60% (30/12), obrażenia 5K6',
        'Chwyt i miażdżenie (manewr) 60% (30/12): pochwycenie, miażdżenie odbywa się w następnej rundzie, obrażenia 5K6',
        'Kryształowy łuk 50% (25/10), obrażenia 1K8+2K6',
      );
      expect(items.map((i) => i.groups['name'])).not.toContain(
        'może użyć swojej stopy i zadeptać przeciwnika lub wykonać atak dystansowy przy pomocy krysz- tałowego łuku. Walka wręcz (Bijatyka)',
      );
      expect(items[0]!.groups['name']).toBe('Walka wręcz (Bijatyka)');
      expect(items[0]!.groups['damage']).toBe('5K6');
      expect(items[1]!.groups['name']).toBe('Chwyt i miażdżenie (manewr)');
      expect(items[2]!.groups['name']).toBe('Kryształowy łuk');
    });

    it('[ZGŁOSZENIE na zywo, "Wrak.pdf" Badacze, prawdziwy eksport Actora "Siren"/"Ellen Gray" z Foundry str. 27/30] nazwa broni z kalibrem w nawiasie ("Broń Palna (pistolet .22)") NIE polyka kolejnej pozycji — cyfra/kropka WEWNATRZ wlasnego nawiasu nazwy sa dopuszczone, w odroznieniu od golej kropki w otwartej prozie (test Sciapoda powyzej)', () => {
      const inferred = inferItemPatternFromExamples('attacks', [
        'Walka Wręcz (Bijatyka) 45% (22/9), obrażenia 1K3',
        'Broń Palna (pistolet .22) 30% (15/6), obrażenia 1K6',
      ]);
      const pattern: SectionListPattern = { kind: 'sectionList', sectionHeader: '^Walka$', itemPattern: inferred!.itemPattern, rejoinHyphenated: false };
      const items = itemsFor(
        pattern,
        'Walka',
        'Walka Wręcz (Bijatyka) 45% (22/9), obrażenia 1K3',
        'Broń Palna (pistolet .22) 30% (15/6), obrażenia 1K6',
        'Unik 35% (17/7)',
      );
      expect(items.map((i) => i.groups['name'])).toEqual(['Walka Wręcz (Bijatyka)', 'Broń Palna (pistolet .22)', 'Unik']);
      expect(items[1]!.groups['toHit']).toBe('30');
      expect(items[1]!.groups['damage']).toBe('1K6');
    });

    it('WYLACZNIE przyklad bezprocentowy ("pałka 1K4+1K4") -> ksztalt "wartosc bez procentu" samodzielnie', () => {
      const inferred = inferItemPatternFromExamples('attacks', ['pałka 1K4+1K4']);
      expect(inferred?.shape).toBe('shapeValueOnly');
      const pattern: SectionListPattern = { kind: 'sectionList', sectionHeader: '^Broń$', itemPattern: inferred!.itemPattern, rejoinHyphenated: false };
      const items = itemsFor(pattern, 'Broń', 'pałka 1K4+1K4', 'nóż 1K3+1K4');
      expect(items.map((i) => `${i.groups['name']}=${i.groups['damage']}`)).toEqual(['pałka=1K4+1K4', 'nóż=1K3+1K4']);
    });

    it('[KROK-30 Z2] etykieta obrazen w INNYM jezyku (angielskie "damage") daje TAK SAMO czysta wartosc -- zero slownika jezykowego zaszytego na sztywno', () => {
      const inferred = inferItemPatternFromExamples('attacks', ['Fighting 40%, damage 1D6']);
      const pattern: SectionListPattern = { kind: 'sectionList', sectionHeader: '^Attacks$', itemPattern: inferred!.itemPattern, rejoinHyphenated: false };
      const items = itemsFor(pattern, 'Attacks', 'Fighting 40%, damage 1D6', 'Dodge 30%');
      expect(items[0]!.groups['damage']).toBe('1D6');
      expect(items[1]!.groups['name']).toBe('Dodge');
    });

    it('[KROK-30 Z2] pozycja BEZ zadnej etykiety miedzy procentem a wartoscia ("Bite 50% 1D8") -- wartosc dalej czysta', () => {
      const inferred = inferItemPatternFromExamples('attacks', ['Bite 50% 1D8']);
      const pattern: SectionListPattern = { kind: 'sectionList', sectionHeader: '^Attacks$', itemPattern: inferred!.itemPattern, rejoinHyphenated: false };
      const items = itemsFor(pattern, 'Attacks', 'Bite 50% 1D8', 'Claw 40% 1D4');
      expect(items.map((i) => `${i.groups['name']}=${i.groups['toHit']}=${i.groups['damage']}`)).toEqual(['Bite=50=1D8', 'Claw=40=1D4']);
    });
  });
});

describe('collectRowText — [KROK-29 Z1] tekst calego wizualnego wiersza wokol klikniecia', () => {
  function rt(text: string, minX: number, minY: number, maxY = minY + 10): RowTextToken {
    return { text, bbox: { minX, maxX: minX + 8, minY, maxY } };
  }

  it('pdf.js juz sklejyl cala linie w JEDEN token -- zwraca po prostu jego tekst', () => {
    const tokens = [rt('Walka wręcz (Bijatyka) 30% (15/6), obrażenia 1K3+1K4 lub', 72, 650)];
    expect(collectRowText(tokens, 0)).toBe('Walka wręcz (Bijatyka) 30% (15/6), obrażenia 1K3+1K4 lub');
  });

  it('linia rozbita na kilka tokenow o zachodzacym Y -- sklejone w kolejnosci X, spacja miedzy', () => {
    // [KROK-30] Dodatkowy SZEROKI token na INNYM wierszu tej samej kolumny —
    // realistyczne dane strony (np. reszta bloku statystyk) zawsze dostarczaja
    // takiego "mostu"; bez niego trzy WASKIE, ROZLACZNE fragmenty ("Unik",
    // "30%", "(15/6)") formalnie nie scalajaby sie w jedno pasmo kolumny
    // (`findColumnBand` — patrz jej wlasny komentarz o koniecznosci mostu).
    // `rt()` daje zawsze szerokosc 8pt, wiec most budujemy recznie z
    // realistycznie szeroka bbox (obejmujaca X wszystkich trzech fragmentow).
    const bridge: RowTextToken = { text: 'Walka wręcz (Bijatyka) 30% (15/6), obrażenia 1K3+1K4', bbox: { minX: 72, maxX: 300, minY: 650, maxY: 660 } };
    const tokens = [rt('Unik', 72, 626), rt('30%', 100, 627), rt('(15/6)', 130, 626), bridge];
    expect(collectRowText(tokens, 1)).toBe('Unik 30% (15/6)');
  });

  it('token z INNEGO wiersza (rozlaczne Y) NIE trafia do zebranego tekstu', () => {
    const tokens = [rt('Walka', 72, 662, 671), rt('Unik', 72, 626, 635)];
    expect(collectRowText(tokens, 0)).toBe('Walka');
  });

  it('[KROK-30, zmierzony na zywo blad] token z SASIEDNIEJ KOLUMNY na TEJ SAMEJ wysokosci (Y) NIE trafia do zebranego tekstu -- na str. 23 "Wrak.pdf" klikniecie w atak Calhouna (lewa lama) wciagalo slowa opisu Sciapoda z prawej lamy', () => {
    const tokens = [
      // Lewa lama (72-289): waskie etykiety siatki + szeroki wiersz-most laczacy je w jedno pasmo kolumny.
      rt('S', 72, 700),
      rt('KON', 117, 700),
      { text: 'Walka wręcz (Bijatyka) 30% (15/6)', bbox: { minX: 72, maxX: 289, minY: 650, maxY: 659 } },
      { text: ',', bbox: { minX: 72, maxX: 80, minY: 626, maxY: 635 } },
      // Prawa lama (307-524), TA SAMA wysokosc (Y) co wiersz ataku Calhouna.
      rt('podobnie', 316, 650),
      rt('do', 400, 650),
      rt('ślimaków', 450, 650),
    ];
    const attackRowIndex = tokens.findIndex((t) => t.text.startsWith('Walka wręcz'));
    expect(collectRowText(tokens, attackRowIndex)).toBe('Walka wręcz (Bijatyka) 30% (15/6)');
  });
});

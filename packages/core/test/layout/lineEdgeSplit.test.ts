import { describe, expect, it } from 'vitest';
import { splitLineByEdgeRun } from '../../src/layout/lineEdgeSplit.js';
import type { TextLine } from '../../src/layout/lineCluster.js';

function line(id: string, text: string, minX: number, maxX: number, y: number, fontKey = 'Body@10'): TextLine {
  return {
    id,
    text,
    bbox: { minX, minY: y, maxX, maxY: y + 10 },
    columnIndex: 0,
    crossAxisPosition: y,
    fonts: [{ key: fontKey, size: 10 }],
    dominantFont: { key: fontKey, size: 10 },
    syntheticBold: false,
  };
}

describe('splitLineByEdgeRun — [KROK-11 Z1] naglowek-etykieta srodakapitowa (prefiks/sufiks), dyskryminator pozycyjny', () => {
  it('przebieg NA POCZATKU linii, inny font, DLUZSZY remainder (accent, nie heading) — dzieli sie mimo braku roli heading', () => {
    // [KROK-11] Real bug: etykieta srodakapitowa czesto ma role `accent`, nie `heading`
    // (Cienie str. 20 "DOM MLOTOW", Za_lini_wroga str. 24/68) — nowy dyskryminator
    // jest POZYCYJNY i w ogole nie patrzy na `fontRoles`, wiec ten przypadek
    // teraz poprawnie sie rozcina (KROK-9's role-pair discriminator go gubil).
    const mixedLine: TextLine = {
      ...line('mix0', 'DOM MLOTOW rozpoczyna sie od opisu wnetrza', 72, 400, 700, 'Accent@14'),
      runs: [
        { fontKey: 'Accent@14', text: 'DOM MLOTOW', bbox: { minX: 72, minY: 700, maxX: 160, maxY: 712 } },
        { fontKey: 'Body@10', text: 'rozpoczyna sie od opisu wnetrza', bbox: { minX: 162, minY: 700, maxX: 400, maxY: 712 } },
      ],
      fonts: [
        { key: 'Accent@14', size: 14 },
        { key: 'Body@10', size: 10 },
      ],
    };
    const split = splitLineByEdgeRun(mixedLine);
    expect(split).toHaveLength(2);
    expect(split[0]!.text).toBe('DOM MLOTOW');
    expect(split[0]!.dominantFont.key).toBe('Accent@14');
    expect(split[1]!.text).toBe('rozpoczyna sie od opisu wnetrza');
    expect(split[1]!.dominantFont.key).toBe('Body@10');
  });

  it('wyroznienie W PRAWDZIWYM SRODKU zdania (dominujacy font PO OBU stronach) — NIE dzieli sie', () => {
    // Dominujacy font linii (po laczej dlugosci znakow) to Body@10 (9+26=35
    // znakow), Accent@10 ma tylko 17 — akcent jest WYSPA w srodku, otoczona
    // dominujacym fontem z obu stron, wiec ani prefiks, ani sufiks go nie lapie.
    const mixedLine: TextLine = {
      ...line('mix1', 'The word truly emphasized continues normally', 72, 500, 700, 'Body@10'),
      runs: [
        { fontKey: 'Body@10', text: 'The word ', bbox: { minX: 72, minY: 700, maxX: 130, maxY: 712 } }, // 9 znakow
        { fontKey: 'Accent@10', text: 'truly emphasized', bbox: { minX: 130, minY: 700, maxX: 240, maxY: 712 } }, // 17 znakow
        { fontKey: 'Body@10', text: ' continues normally', bbox: { minX: 240, minY: 700, maxX: 500, maxY: 712 } }, // 20 znakow
      ],
      fonts: [
        { key: 'Body@10', size: 10 },
        { key: 'Accent@10', size: 10 },
      ],
    };
    const split = splitLineByEdgeRun(mixedLine);
    expect(split).toHaveLength(1);
    expect(split[0]!.id).toBe('mix1');
  });

  it('przebieg na KONCU linii, inny font niz dluzszy poczatkowy — dzieli sie jako SUFIKS (dominanta calej linii, nie "reszty")', () => {
    // [KROK-11, poprawka] Dominanta liczona dla CALEJ linii: Accent (42 znaki)
    // > Body (10 znakow) -> Accent jest "prawdziwym glosem" linii, krotszy
    // Body na koncu jest wiec anomalia-sufiksem i zostaje odciety. To
    // SYMETRYCZNY odpowiednik pierwszego testu (tam krotszy byl PREFIKS).
    const mixedLine: TextLine = {
      ...line('mix2', 'A very long opening label continues into short tail', 72, 500, 700, 'Accent@10'),
      runs: [
        { fontKey: 'Accent@10', text: 'A very long opening label continues into', bbox: { minX: 72, minY: 700, maxX: 400, maxY: 712 } },
        { fontKey: 'Body@10', text: 'short tail', bbox: { minX: 400, minY: 700, maxX: 500, maxY: 712 } },
      ],
      fonts: [
        { key: 'Accent@10', size: 10 },
        { key: 'Body@10', size: 10 },
      ],
    };
    const split = splitLineByEdgeRun(mixedLine);
    expect(split).toHaveLength(2);
    expect(split[0]!.text).toBe('A very long opening label continues into');
    expect(split[1]!.text).toBe('short tail');
  });

  it('remis dlugosci (przebieg brzegowy DOKLADNIE polowa calosci) — NIE dzieli sie (scisla nierownosc)', () => {
    const tiedLine: TextLine = {
      ...line('mix5', 'AAAAAAAAAA BBBBBBBBBB', 72, 300, 700, 'FontA@10'),
      runs: [
        { fontKey: 'FontA@10', text: 'AAAAAAAAAA', bbox: { minX: 72, minY: 700, maxX: 180, maxY: 712 } }, // 10 znakow
        { fontKey: 'FontB@10', text: 'BBBBBBBBBB', bbox: { minX: 180, minY: 700, maxX: 300, maxY: 712 } }, // 10 znakow
      ],
      fonts: [
        { key: 'FontA@10', size: 10 },
        { key: 'FontB@10', size: 10 },
      ],
    };
    const split = splitLineByEdgeRun(tiedLine);
    expect(split).toHaveLength(1);
    expect(split[0]!.id).toBe('mix5');
  });

  it('pojedynczy `run` (linia jednolita) — NIE dzieli sie (brak >=2 przebiegow)', () => {
    const uniformLine: TextLine = {
      ...line('mix3', 'Uniform paragraph text all one font', 72, 400, 700, 'Body@10'),
      runs: [{ fontKey: 'Body@10', text: 'Uniform paragraph text all one font', bbox: { minX: 72, minY: 700, maxX: 400, maxY: 712 } }],
    };
    const split = splitLineByEdgeRun(uniformLine);
    expect(split).toHaveLength(1);
    expect(split[0]!.id).toBe('mix3');
  });

  it('brak `runs` w ogole — NIE dzieli sie (bezpieczne dla recznie budowanych fixture bez tego pola)', () => {
    const bareLine = line('mix4', 'Plain line without runs metadata at all', 72, 400, 700);
    const split = splitLineByEdgeRun(bareLine);
    expect(split).toHaveLength(1);
    expect(split[0]!.id).toBe('mix4');
  });

  it('3 przebiegi: tytul-oblique + etykieta-inny-font + body — dzieli sie na 3 fragmenty, KAZDY brzegowy przebieg osobno (real case, Za_lini_wroga str. 24)', () => {
    // [KROK-11, real data] Dokladnie ta struktura biegow zaobserwowana na
    // `Za_lini_wroga.pdf` str. 24 (linia "Operacja Straz Przednia Poziom
    // trudnosci..."): 3 rozne fonty, DWA rozne fonty w samym prefiksie (tytul
    // + etykieta) — musza zostac rozbite na DWA OSOBNE fragmenty, nie jeden
    // zbiorczy "prefiks".
    const realLine: TextLine = {
      ...line('p24-0-74', 'Operacja Straz Przednia Poziom trudnosci i wrogowie to misja dla druzyny', 401, 594, 291, 'Helvetica@8.5'),
      runs: [
        { fontKey: 'Helvetica-Oblique@8.5', text: 'Operacja Straz Przednia', bbox: { minX: 401, minY: 291, maxX: 507, maxY: 300 } }, // 23
        { fontKey: 'Autobahn_PL@19', text: 'Poziom trudnosci i wrogowie', bbox: { minX: 401, minY: 300, maxX: 594, maxY: 320 } }, // 27
        {
          fontKey: 'Helvetica@8.5',
          text: 'to misja dla druzyny i rozwoju wydarzen podczas waszych sesji. Na tej samej', // 77
          bbox: { minX: 401, minY: 320, maxX: 594, maxY: 329 },
        },
      ],
      fonts: [
        { key: 'Helvetica-Oblique@8.5', size: 8.5 },
        { key: 'Autobahn_PL@19', size: 19 },
        { key: 'Helvetica@8.5', size: 8.5 },
      ],
    };
    const split = splitLineByEdgeRun(realLine);
    expect(split).toHaveLength(3);
    expect(split[0]!.text).toBe('Operacja Straz Przednia');
    expect(split[1]!.text).toBe('Poziom trudnosci i wrogowie');
    expect(split[2]!.text).toContain('to misja dla druzyny');
  });

  it('3 przebiegi: body-dlugi + mikro-przebieg-inny-font + etykieta-sufiks — dzieli sie, sufiks rozbity na osobne fragmenty (real case, Wrath & Glory str. 9 "drocZEniE buntu")', () => {
    // [KROK-11, real data] Dokladnie ta struktura biegow zaobserwowana na
    // `Wrath_&_Glory_Komandozi_Rzezibrzucha.pdf` str. 9 — dominujacy body
    // (52 znaki) znacznie dluzszy niz oba konczace przebiegi razem (1+15=16),
    // wiec oba trafiaja do strefy sufiksu i zostaja odciete jako OSOBNE
    // fragmenty (miniaturowy "o" nie zlewa sie z etykieta).
    const realLine: TextLine = {
      ...line('p9-0-11', 'Rzezibrzuch zdaje sobie sprawe, ze jego pozycja jestodrocZEniE buntu', 45, 300, 660, 'CaxtonStd-Book@7.5'),
      runs: [
        {
          fontKey: 'CaxtonStd-Book@7.5',
          text: 'Rzezibrzuch zdaje sobie sprawe, ze jego pozycja jest', // 53
          bbox: { minX: 45, minY: 660, maxX: 250, maxY: 669 },
        },
        { fontKey: 'CaxtonStd-Bold-SC700@19', text: 'o', bbox: { minX: 250, minY: 655, maxX: 258, maxY: 674 } }, // 1
        { fontKey: 'CaxtonStd-Bold-SC700@13.5', text: 'drocZEniE buntu', bbox: { minX: 258, minY: 655, maxX: 300, maxY: 669 } }, // 15
      ],
      fonts: [
        { key: 'CaxtonStd-Book@7.5', size: 7.5 },
        { key: 'CaxtonStd-Bold-SC700@19', size: 19 },
        { key: 'CaxtonStd-Bold-SC700@13.5', size: 13.5 },
      ],
    };
    const split = splitLineByEdgeRun(realLine);
    expect(split.length).toBeGreaterThanOrEqual(2);
    // Body-tekst musi wyladowac w OSOBNYM fragmencie od etykiety — zaden
    // pojedynczy fragment nie moze zawierac obu naraz sklejonych.
    expect(split[0]!.text).toBe('Rzezibrzuch zdaje sobie sprawe, ze jego pozycja jest');
    expect(split[split.length - 1]!.text).toBe('drocZEniE buntu');
    for (const fragment of split) expect(fragment.text).not.toContain('jestodrocZEniE');
  });
});

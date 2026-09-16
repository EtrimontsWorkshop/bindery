import { describe, expect, it } from 'vitest';
import { attachAndMergeLabelledPairs, attachNearest, attachNearestWithDiagnostics, resolveEntityNames, type AttachCandidate, type GeometricAnchor, type NameCandidate } from '../../src/profiles/entityAssembly.js';
import type { Rect } from '../../src/geometry.js';
import type { LabelledPairsMatch } from '../../src/profiles/patterns.js';

function rect(minX: number, minY: number, w = 10, h = 10): Rect {
  return { minX, minY, maxX: minX + w, maxY: minY + h };
}

describe('attachNearest — [KROK-18 Z3]', () => {
  it('dolacza najblizszego kandydata PONIZEJ kotwicy (blok pochodnych ponizej siatki cech, Y rosnie w gore w PDF)', () => {
    const anchors: GeometricAnchor[] = [{ bbox: rect(0, 100), anchorTokenIndex: 0 }];
    const candidates: AttachCandidate[] = [
      { bbox: rect(0, 60), tokenIndex: 1 }, // ponizej, blisko
      { bbox: rect(0, 140), tokenIndex: 2 }, // POWYZEJ kotwicy — zla strona, nigdy nie wybrany dla nearestBelow
    ];
    const result = attachNearest(anchors, candidates, 'nearestBelow', 60);
    expect(result[0]).toBe(candidates[0]);
  });

  it('kandydat poza maxDistancePt -> null', () => {
    const anchors: GeometricAnchor[] = [{ bbox: rect(0, 100), anchorTokenIndex: 0 }];
    const candidates: AttachCandidate[] = [{ bbox: rect(0, 0), tokenIndex: 1 }]; // 100pt ponizej
    expect(attachNearest(anchors, candidates, 'nearestBelow', 50)[0]).toBeNull();
  });

  it('[KROK-18 Z7, ukland kolumnowy zmierzony na realnej ksiazce] "nearest" dolacza kandydata OBOK kotwicy (ta sama linia, rozne X) — nearestBelow/nearestAbove nigdy by go nie znalazly', () => {
    const anchors: GeometricAnchor[] = [{ bbox: rect(60, 675, 80, 66), anchorTokenIndex: 0 }]; // siatka "Rece", str. 56 Zew Cthulhu
    const candidates: AttachCandidate[] = [{ bbox: rect(182, 679, 70, 63), tokenIndex: 1 }]; // blok pochodnych, TA SAMA linia, obok
    expect(attachNearest(anchors, candidates, 'nearestBelow', 100)[0]).toBeNull();
    expect(attachNearest(anchors, candidates, 'nearest', 100)[0]).toBe(candidates[0]);
  });

  it('kazdy kandydat dolaczany WYLACZNIE raz — dwie kotwice nie dziela tego samego kandydata; wygrywa GEOMETRYCZNIE blizsza, nie ta wczesniejsza w strumieniu', () => {
    const anchors: GeometricAnchor[] = [
      { bbox: rect(0, 100), anchorTokenIndex: 0 }, // dystans do kandydata: 30
      { bbox: rect(0, 80), anchorTokenIndex: 1 }, // dystans do kandydata: 10 — BLIZEJ, mimo pozniejszej pozycji w strumieniu
    ];
    const onlyCandidate: AttachCandidate[] = [{ bbox: rect(0, 60), tokenIndex: 2 }];
    const result = attachNearest(anchors, onlyCandidate, 'nearestBelow', 60);
    expect(result[1]).toBe(onlyCandidate[0]);
    expect(result[0]).toBeNull();
  });

  it('[KROK-21, zmierzony na zywo blad] dopasowanie GLOBALNE zamiast zachlannego per-kotwica-w-strumieniu — str. 55 "nie czas na krzyk": siatka pierwszej postaci w strumieniu (Warwick) jest geometrycznie blizej sekcji ATAKI SASIADKI niz wlasnej (przez odstep na portret w jego wlasnej kolumnie); zachlanne przetwarzanie w kolejnosci strumienia "kradlo" cudza sekcje, zamieniajac dane dwoch postaci miejscami', () => {
    const warwickGrid: GeometricAnchor = { bbox: rect(175, 653, 94, 57), anchorTokenIndex: 0 }; // pierwszy w strumieniu
    const pielegniarkaGrid: GeometricAnchor = { bbox: rect(309, 631, 94, 57), anchorTokenIndex: 10 };
    const warwickAtaki: AttachCandidate = { bbox: rect(61, 517, 10, 6), tokenIndex: 1 }; // WLASNA sekcja Warwicka — daleko (inna kolumna+duzy odstep pionowy)
    const pielegniarkaAtaki: AttachCandidate = { bbox: rect(309, 594, 10, 6), tokenIndex: 11 }; // WLASNA sekcja Pielegniarki — blisko

    const result = attachNearest([warwickGrid, pielegniarkaGrid], [warwickAtaki, pielegniarkaAtaki], 'nearestBelow', 250);
    expect(result[0]).toBe(warwickAtaki);
    expect(result[1]).toBe(pielegniarkaAtaki);
  });
});

describe('attachNearestWithDiagnostics — [KROK-29, zmierzony na zywo blad "87pt > 400pt"]', () => {
  it('kandydat GENUINE za daleko (nawet zignorowawszy maxDistancePt, dalej niz limit) -> reason "tooFar"', () => {
    const anchors: GeometricAnchor[] = [{ bbox: rect(0, 100), anchorTokenIndex: 0 }];
    const candidates: AttachCandidate[] = [{ bbox: rect(0, 0), tokenIndex: 1 }]; // 100pt ponizej
    const diag = attachNearestWithDiagnostics(anchors, candidates, 'nearestBelow', 50);
    expect(diag.attached[0]).toBeNull();
    expect(diag.nearestOutOfRange[0]).toEqual({ distance: expect.any(Number), candidate: candidates[0], reason: 'tooFar' });
  });

  it('[zmierzony na zywo blad, str. 23 "Zew Cthulhu 7ed. Wrak.pdf"] kandydat W ZASIEGU (dystans <= limit), ale PRZEJETY przez inna, blizsza kotwice w globalnym dopasowaniu -> reason "claimedByOther", NIE "tooFar" (poprzednia wersja nie odrozniala tych dwoch stanow, dajac mylacy komunikat UI "87pt > 400pt" mimo ze 87 < 400)', () => {
    const anchorA: GeometricAnchor = { bbox: rect(0, 100), anchorTokenIndex: 0 }; // dystans do jedynego kandydata: 40 -- w zasiegu (limit 100), ale...
    const anchorB: GeometricAnchor = { bbox: rect(0, 65), anchorTokenIndex: 1 }; // dystans do tego samego kandydata: 5 -- BLIZEJ, przejmuje go pierwszy w zachlannym globalnym sortowaniu
    const sharedCandidate: AttachCandidate = { bbox: rect(0, 55), tokenIndex: 2 };

    // Jedyny kandydat na stronie -- B (blizej) dostaje go, A zostaje BEZ
    // dopasowania mimo ze jego wlasny dystans do niego (40) MIESCI SIE w limicie (100).
    const diag = attachNearestWithDiagnostics([anchorA, anchorB], [sharedCandidate], 'nearestBelow', 100);
    expect(diag.attached[1]).toBe(sharedCandidate);
    expect(diag.attached[0]).toBeNull();
    expect(diag.nearestOutOfRange[0]).toEqual({ distance: expect.any(Number), candidate: sharedCandidate, reason: 'claimedByOther' });
    expect(diag.nearestOutOfRange[0]!.distance).toBeLessThanOrEqual(100);
  });

  it('brak jakiegokolwiek kandydata w danym kierunku -> nearestOutOfRange null (nie mylic z "za daleko")', () => {
    const anchors: GeometricAnchor[] = [{ bbox: rect(0, 100), anchorTokenIndex: 0 }];
    const diag = attachNearestWithDiagnostics(anchors, [], 'nearestBelow', 100);
    expect(diag.nearestOutOfRange[0]).toBeNull();
  });
});

describe('resolveEntityNames — [KROK-18 Z3]', () => {
  const baseConfig = { strategy: 'nearestAbove' as const, maxDistancePt: 120, nameConfidenceThreshold: 0.7, page: 30, namePlaceholder: 'NPC ze str. {page} (#{ordinal})' };

  it('jednoznaczny kandydat blisko kotwicy -> pewna nazwa', () => {
    const anchors: GeometricAnchor[] = [{ bbox: rect(0, 0), anchorTokenIndex: 5 }];
    const names: NameCandidate[] = [{ text: 'Joshua Thomas', bbox: rect(0, 20), tokenIndex: 0 }];
    const [res] = resolveEntityNames(anchors, names, baseConfig);
    expect(res).toEqual({ kind: 'confident', text: 'Joshua Thomas', confidence: expect.any(Number), tokenIndex: 0 });
    if (res!.kind === 'confident') expect(res.confidence).toBeGreaterThan(baseConfig.nameConfidenceThreshold);
  });

  it('brak kandydata w zasiegu -> placeholder z pusta lista', () => {
    const anchors: GeometricAnchor[] = [{ bbox: rect(0, 0), anchorTokenIndex: 0 }];
    const res = resolveEntityNames(anchors, [], baseConfig)[0]!;
    expect(res).toEqual({ kind: 'placeholder', placeholder: 'NPC ze str. 30 (#1)', candidates: [] });
  });

  it('[S4] dwaj kandydaci prawie rownie blisko (dwuznacznosc) -> placeholder, NIGDY zgadnieta nazwa', () => {
    const anchors: GeometricAnchor[] = [{ bbox: rect(0, 0), anchorTokenIndex: 5 }];
    const names: NameCandidate[] = [
      { text: 'Nazwa Wlasciwa', bbox: rect(0, 20), tokenIndex: 0 }, // dystans 10
      { text: 'Cos Innego Rownie Blisko', bbox: rect(5, 21), tokenIndex: 1 }, // dystans 11 — prawie identyczny
    ];
    const [res] = resolveEntityNames(anchors, names, baseConfig);
    expect(res!.kind).toBe('placeholder');
    if (res!.kind === 'placeholder') expect(res.candidates).toContain('Nazwa Wlasciwa');
  });

  it('[ZGŁOSZENIE po kroku 30, "Dlaczego muszę wskazywać ręcznie, skoro profil już to zawiera"] knownSiblingTokenIndices wylacza kandydata z liczenia dwuznacznosci', () => {
    // Ten sam uklad co test wyzej ("dwaj kandydaci prawie rownie blisko"), ale
    // drugi kandydat jest oznaczony jako "znany sasiad" (np. rozpoznany PRZEZ
    // OSOBNY wzorzec zawodu/typu, `entityAssembly.typeLabelPattern`) — silnik
    // JUZ WIE, ze to inne pole, wiec nie liczy sie jako prawdziwa dwuznacznosc.
    const anchors: GeometricAnchor[] = [{ bbox: rect(0, 0), anchorTokenIndex: 5 }];
    const names: NameCandidate[] = [
      { text: 'Nazwa Wlasciwa', bbox: rect(0, 20), tokenIndex: 0 },
      { text: 'Cos Innego Rownie Blisko', bbox: rect(5, 21), tokenIndex: 1 },
    ];
    const config = { ...baseConfig, knownSiblingTokenIndices: new Set([1]) };
    const [res] = resolveEntityNames(anchors, names, config);
    expect(res!.kind).toBe('confident');
    if (res!.kind === 'confident') expect(res.text).toBe('Nazwa Wlasciwa');
  });

  it('[H3] preferEarlierSibling wybiera NAZWE nad PODTYTULEM, nie sam najblizszy tekst', () => {
    // Podtytul ("74 lata, badacz okultyzmu") stoi BLIZEJ kotwicy (siatki) niz
    // sama nazwa ("Joshua Thomas") nad nim, w tym samym kroju — dokladnie
    // przypadek z kroku 13, ktory naiwne "najblizszy" psulo w 50% przypadkow.
    const anchors: GeometricAnchor[] = [{ bbox: rect(0, 0), anchorTokenIndex: 10 }];
    const names: NameCandidate[] = [
      { text: 'Joshua Thomas', bbox: rect(0, 40), tokenIndex: 5 }, // dalej, ale WCZESNIEJSZY w strumieniu
      { text: '74 lata, badacz okultyzmu', bbox: rect(0, 20), tokenIndex: 6 }, // blizej, ale PO nazwie
    ];
    const config = { ...baseConfig, preferEarlierSibling: { maxDeltaYPt: 25 } };
    const [res] = resolveEntityNames(anchors, names, config);
    expect(res!.kind).toBe('confident');
    if (res!.kind === 'confident') expect(res.text).toBe('Joshua Thomas');
  });

  it('[KROK-30, zmierzony na zywo blad] nazwa JUZ najblizsza (podtytul na TEJ SAMEJ linii, nie zachodzi w X) -> pewna, BEZ kary dwuznacznosci', () => {
    // Zmierzone wprost na str. 23 "Zew Cthulhu 7ed. Wrak.pdf": "John Calhoun,"
    // (X[72,143]) jest JUZ najblizszy kotwicy (nie trzeba przelaczac wyboru
    // via preferEarlierSibling), a "kapitan jachtu" stoi TUZ PO nim na tej
    // samej linii (X[146.6,214.4], Y identyczne) -- podtytul, nie konkurent.
    // Przed naprawa: kara dwuznacznosci uruchamiala sie ZAWSZE w tym ukladzie,
    // bo wykluczenie dzialalo WYLACZNIE gdy preferEarlierSibling musial
    // aktywnie przelaczyc wybor (co tu nie zachodzi -- nazwa juz wygrywa).
    const anchors: GeometricAnchor[] = [{ bbox: rect(72, 0), anchorTokenIndex: 10 }]; // X=72, jak realna siatka cech pod nazwa
    const names: NameCandidate[] = [
      { text: 'John Calhoun,', bbox: rect(72, 20, 71), tokenIndex: 2 }, // X[72,143], najblizszy juz teraz
      { text: 'kapitan jachtu', bbox: rect(146, 20, 68), tokenIndex: 3 }, // X[146,214], PO nazwie, bez zachodzenia
    ];
    const config = { ...baseConfig, preferEarlierSibling: { maxDeltaYPt: 2 } };
    const [res] = resolveEntityNames(anchors, names, config);
    expect(res).toEqual({ kind: 'confident', text: 'John Calhoun,', confidence: expect.any(Number), tokenIndex: 2 });
  });

  it('[KROK-30, regresja zlapana natychmiast po pierwszej wersji] DWAJ NIEZALEZNI konkurujacy kandydaci w tym samym miejscu (zachodzace X) -> dalej placeholder, MIMO preferEarlierSibling', () => {
    // Odwrotnosc powyzszego: "Kandydat A"/"Kandydat B" stoja NIEMAL W TYM
    // SAMYM miejscu (X zachodzi na siebie) -- to NIE jest wzorzec
    // Nazwa+Podtytul (ktory stoi JEDNO PO DRUGIM, bez zachodzenia X), tylko
    // prawdziwa dwuznacznosc, ktora silnik MA wykryc niezaleznie od tego, czy
    // profil ma skonfigurowane `preferEarlierSibling`.
    const anchors: GeometricAnchor[] = [{ bbox: rect(0, 0), anchorTokenIndex: 5 }];
    const names: NameCandidate[] = [
      { text: 'Kandydat A', bbox: rect(0, 20), tokenIndex: 0 },
      { text: 'Kandydat B', bbox: rect(1, 21), tokenIndex: 1 }, // X zachodzi na Kandydat A
    ];
    const config = { ...baseConfig, preferEarlierSibling: { maxDeltaYPt: 20 } };
    const [res] = resolveEntityNames(anchors, names, config);
    expect(res!.kind).toBe('placeholder');
  });

  it('[KROK-22, znaleziony przy budowie Profile Studio] `tokenIndex` w wyniku "confident" to PRAWDZIWY indeks tokenu w strumieniu, nie pozycja kandydata w tablicy `nameCandidates`', () => {
    // Kotwica druga w strumieniu (anchorTokenIndex wiekszy), ale jej kandydat na
    // nazwe jest PIERWSZYM elementem tablicy `nameCandidates` (indeks 0) — gdyby
    // wynik zwracal pozycje w tablicy zamiast prawdziwego `tokenIndex`, wskazywalby
    // na CALKIEM INNY (przypadkowy) token w strumieniu.
    const anchors: GeometricAnchor[] = [{ bbox: rect(0, 0), anchorTokenIndex: 42 }];
    const names: NameCandidate[] = [{ text: 'Prawdziwa Nazwa', bbox: rect(0, 20), tokenIndex: 99 }];
    const [res] = resolveEntityNames(anchors, names, baseConfig);
    expect(res!.kind).toBe('confident');
    if (res!.kind === 'confident') expect(res.tokenIndex).toBe(99);
  });

  it('[Z0, "Kawalki"] wiele czesci ciala pod wlasnymi krotkimi naglowkami na jednej stronie — kazda siatka dostaje WLASCIWA nazwe, nie wszystkie te sama', () => {
    // Ukland: trzy pary (naglowek, siatka) skladane od gory strony w dol —
    // Rece/Glowa/Nogi, kazda para blisko siebie, pary odlegle od siebie
    // nawzajem (odzwierciedla realny ukland str. 56-57 z Zew_Cthulhu, gdzie
    // kazda czesc ciala ma WLASNA kotwice+naglowek, nie jedna wspolna nazwe
    // potwora dla wszystkich trzech).
    const anchors: GeometricAnchor[] = [
      { bbox: rect(0, 200), anchorTokenIndex: 1 }, // siatka "Rece"
      { bbox: rect(0, 100), anchorTokenIndex: 3 }, // siatka "Glowa"
      { bbox: rect(0, 0), anchorTokenIndex: 5 }, // siatka "Nogi"
    ];
    const names: NameCandidate[] = [
      { text: 'Ręce', bbox: rect(0, 220), tokenIndex: 0 },
      { text: 'Głowa', bbox: rect(0, 120), tokenIndex: 2 },
      { text: 'Nogi', bbox: rect(0, 20), tokenIndex: 4 },
    ];
    const config = { ...baseConfig, maxDistancePt: 40 };
    const results = resolveEntityNames(anchors, names, config);
    expect(results.map((r) => (r.kind === 'confident' ? r.text : 'BRAK'))).toEqual(['Ręce', 'Głowa', 'Nogi']);
  });
});

/** Buduje `LabelledPairsMatch` minimalny do testow geometrii — `pairs`/`startIndex`/`endIndex` nie wplywaja na dopasowanie, tylko `bbox`. */
function pairsMatch(canonicalKeys: readonly string[], bbox: Rect, startIndex = 0): LabelledPairsMatch {
  return {
    pairs: canonicalKeys.map((canonicalKey, i) => ({ label: canonicalKey, canonicalKey, value: 'x', tokenIndex: startIndex + i })),
    startIndex,
    endIndex: startIndex + canonicalKeys.length,
    bbox,
  };
}

describe('attachAndMergeLabelledPairs — [KROK-34 Z1, zmierzony na zywo brak, Sciapod str. 24 "Wrak.pdf"]', () => {
  it('DOKLADNIE JEDNO dopasowanie na kotwice -> zachowanie IDENTYCZNE jak attachNearest (zero regresji na wszystkich dotychczasowych profilach referencyjnych)', () => {
    const anchors: GeometricAnchor[] = [{ bbox: rect(0, 100), anchorTokenIndex: 0 }];
    const derived = pairsMatch(['hitPoints', 'movement'], rect(0, 60));
    const result = attachAndMergeLabelledPairs(anchors, [derived], 'nearest', 400);
    expect(result.attached[0]).toBe(derived);
  });

  it('[zmierzony na zywo problem] DWA ROZLACZNE dopasowania TEGO SAMEGO wzorca blisko JEDNEJ kotwicy ("Pancerz" we wlasnym akapicie, daleko od reszty pochodnych) -> obydwa dolaczone, pary POLACZONE w jeden wynik', () => {
    const anchors: GeometricAnchor[] = [{ bbox: rect(0, 700), anchorTokenIndex: 0 }];
    const mainBlock = pairsMatch(['hitPoints', 'movement', 'build'], rect(0, 680)); // tuz przy kotwicy
    const armorParagraph = pairsMatch(['armour'], rect(0, 300)); // daleko nizej, WLASNY akapit
    const result = attachAndMergeLabelledPairs(anchors, [mainBlock, armorParagraph], 'nearest', 450);
    expect(result.attached[0]!.pairs.map((p) => p.canonicalKey)).toEqual(['hitPoints', 'movement', 'build', 'armour']);
  });

  it('[KROK-34 Z2, zmierzony na zywo blad] `subMatches` udostepnia WLASNE, ciagle zakresy kazdego scalonego dopasowania — `attached[0].startIndex..endIndex` to bounding UNIA (NIE ciagly zakres), wiec kod pomijajacy juz-pokazana tresc (proseBlock) musi iterowac po `subMatches`, nie po `attached`', () => {
    const anchors: GeometricAnchor[] = [{ bbox: rect(0, 700), anchorTokenIndex: 0 }];
    const mainBlock = pairsMatch(['hitPoints'], rect(0, 680), 20); // tokenIndex 20-21
    const armorParagraph = pairsMatch(['armour'], rect(0, 300), 70); // tokenIndex 70-71, DALEKO w strumieniu
    const result = attachAndMergeLabelledPairs(anchors, [mainBlock, armorParagraph], 'nearest', 450);
    // Scalony wynik bounding-uje CALY zakres 20..71 -- gdyby ktos zlapal sie na to jako "ciagly zaklaimowany zakres", polknalby tez niezaklaimowana proze miedzy 21 a 70.
    expect(result.attached[0]!.startIndex).toBe(20);
    expect(result.attached[0]!.endIndex).toBe(71);
    // `subMatches` daje PRAWDZIWE, rozlaczne zakresy zamiast tego.
    expect(result.subMatches[0]!.map((m) => [m.startIndex, m.endIndex])).toEqual([
      [20, 21],
      [70, 71],
    ]);
  });

  it('osierocone dopasowanie POZA maxDistancePt KAZDEJ kotwicy -> odrzucone (A10 — brak dopasowania to nadal poprawny wynik, nie zgadywanie)', () => {
    const anchors: GeometricAnchor[] = [{ bbox: rect(0, 700), anchorTokenIndex: 0 }];
    const mainBlock = pairsMatch(['hitPoints'], rect(0, 680));
    const tooFar = pairsMatch(['armour'], rect(0, 0)); // 680pt, poza limitem
    const result = attachAndMergeLabelledPairs(anchors, [mainBlock, tooFar], 'nearest', 450);
    expect(result.attached[0]!.pairs.map((p) => p.canonicalKey)).toEqual(['hitPoints']);
  });

  it('[zgloszenie uzytkownika, powtarzajacy sie problem z Pancerzem po kazdej przebudowie profilu w Profile Studio] osierocone dopasowanie POZA podstawowym maxDistancePt, ale W GRANICACH mnoznika rundy osieroconej (1.5x) -> mimo to dolaczone — profil nie musi juz recznie podnosic maxDistancePt za kazdym razem, gdy Profile Studio resetuje je do wartosci domyslnej (400)', () => {
    const anchors: GeometricAnchor[] = [{ bbox: rect(0, 700), anchorTokenIndex: 0 }];
    const mainBlock = pairsMatch(['hitPoints'], rect(0, 680));
    const orphan = pairsMatch(['armour'], rect(0, 190)); // dystans 500pt: poza podstawowym 400, w granicach 400*1.5=600
    const result = attachAndMergeLabelledPairs(anchors, [mainBlock, orphan], 'nearest', 400);
    expect(result.attached[0]!.pairs.map((p) => p.canonicalKey)).toEqual(['hitPoints', 'armour']);
  });

  it('osierocone dopasowanie POZA nawet mnoznikiem rundy osieroconej -> nadal odrzucone (mnoznik ma granice, nie jest nieskonczony)', () => {
    const anchors: GeometricAnchor[] = [{ bbox: rect(0, 700), anchorTokenIndex: 0 }];
    const mainBlock = pairsMatch(['hitPoints'], rect(0, 680));
    const orphan = pairsMatch(['armour'], rect(0, 0)); // dystans 690pt: poza tez 400*1.5=600
    const result = attachAndMergeLabelledPairs(anchors, [mainBlock, orphan], 'nearest', 400);
    expect(result.attached[0]!.pairs.map((p) => p.canonicalKey)).toEqual(['hitPoints']);
  });

  it('DWIE kotwice na stronie -- osierocone dopasowanie dolacza sie do NAJBLIZSZEJ z nich, nie do obu (zero krzyzowego zanieczyszczenia miedzy sasiednimi postaciami, np. str. 23 "Wrak.pdf" — Calhoun+Hansen)', () => {
    const anchors: GeometricAnchor[] = [
      { bbox: rect(0, 700), anchorTokenIndex: 0 }, // postac A
      { bbox: rect(200, 700), anchorTokenIndex: 10 }, // postac B, obok
    ];
    const mainA = pairsMatch(['hitPoints'], rect(0, 680), 1);
    const mainB = pairsMatch(['hitPoints'], rect(200, 680), 11);
    const orphanCloserToB = pairsMatch(['armour'], rect(210, 300), 20); // geometrycznie blizej B
    const result = attachAndMergeLabelledPairs(anchors, [mainA, mainB, orphanCloserToB], 'nearest', 500);
    expect(result.attached[0]!.pairs.map((p) => p.canonicalKey)).toEqual(['hitPoints']);
    expect(result.attached[1]!.pairs.map((p) => p.canonicalKey)).toEqual(['hitPoints', 'armour']);
  });

  it('konflikt canonicalKey miedzy dopasowaniami -- pierwsze (najblizsze/PRIMARY) wygrywa, nie jest nadpisywane przez osierocone', () => {
    const anchors: GeometricAnchor[] = [{ bbox: rect(0, 700), anchorTokenIndex: 0 }];
    const primary = pairsMatch(['armour'], rect(0, 680));
    primary.pairs[0]!.value = 'z-primary';
    const orphan = pairsMatch(['armour'], rect(0, 300));
    orphan.pairs[0]!.value = 'z-orphan';
    const result = attachAndMergeLabelledPairs(anchors, [primary, orphan], 'nearest', 450);
    expect(result.attached[0]!.pairs).toHaveLength(1);
    expect(result.attached[0]!.pairs[0]!.value).toBe('z-primary');
  });

  it('brak dopasowan w ogole -> null dla kazdej kotwicy', () => {
    const anchors: GeometricAnchor[] = [{ bbox: rect(0, 700), anchorTokenIndex: 0 }];
    expect(attachAndMergeLabelledPairs(anchors, [], 'nearest', 450).attached).toEqual([null]);
  });
});

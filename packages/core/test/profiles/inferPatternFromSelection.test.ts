import { describe, expect, it } from 'vitest';
import {
  inferLabelledPairsFromTokens,
  inferSectionListFromTokens,
  estimateTypicalRowGapPt,
  findValueCandidatesNearLabel,
  findTerminateTokenAtY,
  mergeTouchingTokens,
  splitMergedLabelValueTokens,
  stripStrayLeadingColonTokens,
  classifyValue,
  type SelectionToken,
  type IndexedSelectionToken,
} from '../../src/profiles/inferPatternFromSelection.js';

function tok(text: string, x: number, y = 0): SelectionToken {
  return { text, bbox: { minX: x, maxX: x + 8, minY: y, maxY: y + 10 } };
}

function itok(text: string, x: number, y: number, tokenIndex: number): IndexedSelectionToken {
  return { ...tok(text, x, y), tokenIndex };
}

describe('inferLabelledPairsFromTokens — [KROK-24 Z1, poluzowane w KROK-25 Z1]', () => {
  it('wykrywa WSZYSTKIE pary etykieta-wartość w zaznaczeniu (siatka cech), wszystkie wysokiej pewnosci', () => {
    const tokens = [tok('S', 0), tok('40', 10), tok('WYG', 20), tok('25', 30), tok('KON', 40), tok('35', 50)];
    const result = inferLabelledPairsFromTokens(tokens);
    expect(result.map((r) => [r.label, r.value, r.confidence])).toEqual([
      ['S', '40', 'high'],
      ['WYG', '25', 'high'],
      ['KON', '35', 'high'],
    ]);
  });

  it('[realna etykieta zmierzona w kroku 23] etykieta wieloznakowa ze spacja ("Modyfikator obrażeń") wykrywana, wartosc ze znakiem (nadal wysoka pewnosc, bo liczba)', () => {
    const tokens = [tok('Modyfikator obrażeń', 0), tok('-2', 10)];
    const result = inferLabelledPairsFromTokens(tokens);
    expect(result).toHaveLength(1);
    expect(result[0]!.label).toBe('Modyfikator obrażeń');
    expect(result[0]!.confidence).toBe('high');
  });

  it('[KROK-25 Z1, naprawiony dlug kroku 24] notacja kostek ("+1K4") JEST teraz rozpoznawana jako wartosc, z NISKA pewnoscia', () => {
    const tokens = [tok('Modyfikator obrażeń', 0), tok('+1K4', 10)];
    const result = inferLabelledPairsFromTokens(tokens);
    expect(result).toHaveLength(1);
    expect(result[0]!).toMatchObject({ label: 'Modyfikator obrażeń', value: '+1K4', confidence: 'low' });
  });

  it('[KROK-34, zmierzony na zywo blad, "Wrak.pdf" str. 24 "Pancerz → Zaklęcia"] token KONCZACY SIE dwukropkiem (wyglada jak etykieta NASTEPNEJ pary) NIGDY nie jest przyjmowany jako wartosc, nawet niskiej pewnosci — gdy zaznaczenie autora pominelo prawdziwa wartosc (np. dlugi, zawijany opis odrzucony jako za dlugi na etykiete W KOLEJNEJ iteracji), etykieta zostaje bez pary zamiast dostac cudza etykiete jako "wartosc"', () => {
    const tokens = [tok('Pancerz:', 0), tok('Zaklęcia:', 10)];
    expect(inferLabelledPairsFromTokens(tokens)).toEqual([]);
  });

  it('[DoD kroku 25, dokladnie ten przypadek] caly blok pochodnych ze str. 57 proponuje WSZYSTKIE PIEC par, w tym Modyfikator obrażeń', () => {
    const tokens = [
      tok('PW', 0),
      tok('15', 10),
      tok('Modyfikator obrażeń', 20),
      tok('+1K4', 30),
      tok('Krzepa', 40),
      tok('1', 50),
      tok('Ruch', 60),
      tok('8', 70),
      tok('Punkty Magii', 80),
      tok('18', 90),
    ];
    const result = inferLabelledPairsFromTokens(tokens);
    expect(result.map((r) => r.label)).toEqual(['PW', 'Modyfikator obrażeń', 'Krzepa', 'Ruch', 'Punkty Magii']);
  });

  it('inne przyklady wartosci nienumerycznych z briefu ("skóra 2", "8 (latając 12)") -- niska pewnosc, nie odrzucone', () => {
    expect(inferLabelledPairsFromTokens([tok('Zbroja', 0), tok('skóra 2', 10)])[0]).toMatchObject({ confidence: 'low' });
    expect(inferLabelledPairsFromTokens([tok('Ruch', 0), tok('8 (latając 12)', 10)])[0]).toMatchObject({ confidence: 'low' });
  });

  it('wartosc bedaca CALYM zdaniem prozy (konczy sie kropka/wykrzyknikiem/pytajnikiem) nadal odrzucona -- to nie jest "cokolwiek", to opis', () => {
    const tokens = [tok('Opis', 0), tok('To jest dlugi opis fabularny.', 10)];
    expect(inferLabelledPairsFromTokens(tokens)).toEqual([]);
  });

  it('[KROK-43, zmierzony na zywo blad, "Wielki Terror" str. 91] krotka, jednoslowna odpowiedz zakonczona kropka ("Brak.") JEST teraz akceptowana jako wartosc -- to nie zdanie, to konwencjonalna odpowiedz "brak/none"', () => {
    const tokens = [tok('Pancerz', 0), tok('Brak.', 10)];
    const result = inferLabelledPairsFromTokens(tokens);
    expect(result).toHaveLength(1);
    expect(result[0]!).toMatchObject({ label: 'Pancerz', value: 'Brak.', confidence: 'low' });
  });

  it('[KROK-43] ale wykrzyknik/pytajnik na koncu zostaje TWARDYM sygnalem prozy, nawet dla jednego slowa', () => {
    expect(inferLabelledPairsFromTokens([tok('Uwaga', 0), tok('Naprawde?', 10)])).toEqual([]);
    expect(inferLabelledPairsFromTokens([tok('Uwaga', 0), tok('Uciekaj!', 10)])).toEqual([]);
  });

  it('zbyt dluga wartosc (ponad VALUE_MAX_LENGTH) odrzucona, nawet bez koncowej kropki', () => {
    const tokens = [tok('Opis', 0), tok('a'.repeat(41), 10)];
    expect(inferLabelledPairsFromTokens(tokens)).toEqual([]);
  });

  it('akceptuje "–" (myslnik) jako wartosc wysokiej pewnosci (brak cechy)', () => {
    const tokens = [tok('ZR', 0), tok('–', 10)];
    const result = inferLabelledPairsFromTokens(tokens);
    expect(result).toHaveLength(1);
    expect(result[0]!).toMatchObject({ value: '–', confidence: 'high' });
  });

  it('akceptuje wartosc typu "12/12" (aktualne/maksymalne), wysoka pewnosc', () => {
    const tokens = [tok('PW', 0), tok('12/12', 10)];
    const result = inferLabelledPairsFromTokens(tokens);
    expect(result).toHaveLength(1);
    expect(result[0]!.confidence).toBe('high');
  });

  it('NIE proponuje pary liczba->liczba (etykieta musi zawierac litere)', () => {
    const tokens = [tok('12', 0), tok('34', 10)];
    const result = inferLabelledPairsFromTokens(tokens);
    expect(result).toEqual([]);
  });

  it('preferuj nadmiar nad brak: proza (zdanie opisowe) jako "etykieta" tez zostanie zaproponowana, jesli po niej stoi liczba -- autor odznaczy', () => {
    const tokens = [tok('Opis postaci', 0), tok('30', 10)];
    const result = inferLabelledPairsFromTokens(tokens);
    expect(result).toHaveLength(1); // celowy false positive, tanio kosztujacy (jedno odznaczenie)
  });

  it('pusta lub jednoelementowa selekcja -> brak par', () => {
    expect(inferLabelledPairsFromTokens([])).toEqual([]);
    expect(inferLabelledPairsFromTokens([tok('S', 0)])).toEqual([]);
  });
});

describe('inferSectionListFromTokens — [KROK-24 Z1]', () => {
  it('pierwszy token = kandydat na naglowek, reszta = podglad pozycji', () => {
    const tokens = [tok('ATAKI', 0), tok('Walka', 10), tok('40%', 20), tok('1K3', 30)];
    const result = inferSectionListFromTokens(tokens);
    expect(result).not.toBeNull();
    expect(result!.header).toBe('ATAKI');
    expect(result!.itemsPreview).toBe('Walka 40% 1K3');
  });

  it('pusta selekcja -> null', () => {
    expect(inferSectionListFromTokens([])).toBeNull();
  });

  it('pojedynczy token -> naglowek, pusty podglad pozycji', () => {
    const result = inferSectionListFromTokens([tok('ATAKI', 0)]);
    expect(result).toEqual({ header: 'ATAKI', itemsPreview: '', headerBbox: { minX: 0, maxX: 8, minY: 0, maxY: 10 } });
  });
});

describe('estimateTypicalRowGapPt — [KROK-28 Z2]', () => {
  it('mediana odstepow miedzy sasiadujacymi tokenami w tym samym wierszu', () => {
    // trzy pary w tym samym wierszu (Y=0), kazda z odstepem 10pt (bbox width=8: 0-8, 18-26, 36-44)
    const tokens = [tok('S', 0), tok('40', 18), tok('WYG', 36)];
    expect(estimateTypicalRowGapPt(tokens)).toBe(10);
  });

  it('brak zadnej mierzalnej pary (rozne wiersze, zero pokrycia pionowego) -> fallback', () => {
    const tokens = [tok('S', 0, 0), tok('40', 0, 100)];
    expect(estimateTypicalRowGapPt(tokens)).toBe(20);
  });

  it('pusta/pojedyncza lista -> fallback', () => {
    expect(estimateTypicalRowGapPt([])).toBe(20);
    expect(estimateTypicalRowGapPt([tok('S', 0)])).toBe(20);
  });
});

describe('findValueCandidatesNearLabel — [KROK-28 Z2, kliknięcie etykiety odczytuje wartość]', () => {
  it('jeden jednoznaczny kandydat w tym samym wierszu, w typowym zasiegu', () => {
    const label = itok('S', 0, 0, 0);
    const tokens = [label, itok('40', 20, 0, 1)];
    const result = findValueCandidatesNearLabel(tokens, label.bbox, 10);
    expect(result).toEqual([{ text: '40', bbox: tokens[1]!.bbox, tokenIndex: 1, confidence: 'high' }]);
  });

  it('wartosc POZA typowym zasiegiem (daleko w prawo) nie jest brana pod uwage', () => {
    const label = itok('S', 0, 0, 0);
    const farValue = itok('40', 1000, 0, 1);
    const result = findValueCandidatesNearLabel([label, farValue], label.bbox, 10);
    expect(result).toEqual([]);
  });

  it('dwaj kandydaci NAPRAWDE blisko siebie (podobny dystans) -> obaj zwroceni (niejednoznacznosc, nie zgadywanie)', () => {
    const label = itok('S', 0, 0, 0);
    // gap do "40" = 12pt, gap do "45" = 16pt -- stosunek 16/12=1.33, ponizej progu "naprawde blisko" -> oba prawdziwe kandydaci (np. dwie kolumny wartosci).
    const tokens = [label, itok('40', 20, 0, 1), itok('45', 24, 0, 2)];
    const result = findValueCandidatesNearLabel(tokens, label.bbox, 10);
    expect(result.map((c) => c.text)).toEqual(['40', '45']);
  });

  it('[KROK-28, zmierzony na realnej stronie Quick-Startu blad] kandydat WYRAZNIE dalszy niz pierwszy (np. NASTEPNA etykieta dalej w wierszu) NIE dolacza jako "dodatkowy kandydat"', () => {
    const label = itok('STR', 0, 0, 0);
    // "35" tuz obok (gap 12pt) to prawdziwa wartosc; "CON" (kolejna etykieta) 40pt dalej -- realny uklad z Quick-Startu, ktory wczesniej falszywie dawal 2 kandydatow.
    const tokens = [label, itok('35', 20, 0, 1), itok('CON', 60, 0, 2)];
    const result = findValueCandidatesNearLabel(tokens, label.bbox, 10);
    expect(result.map((c) => c.text)).toEqual(['35']);
  });

  it('brak kandydata w wierszu -> szuka w kolumnie pod spodem (Y ROSNIE W GORE strony -- "pod spodem" ma MNIEJSZY Y niz etykieta)', () => {
    const label = itok('S', 0, 20, 0);
    const below = itok('40', 0, 0, 1);
    const result = findValueCandidatesNearLabel([label, below], label.bbox, 10);
    expect(result).toEqual([{ text: '40', bbox: below.bbox, tokenIndex: 1, confidence: 'high' }]);
  });

  it('brak jakiegokolwiek kandydata -> pusta lista, nie wyjatek', () => {
    const label = itok('S', 0, 0, 0);
    expect(findValueCandidatesNearLabel([label], label.bbox, 10)).toEqual([]);
  });
});

describe('findTerminateTokenAtY — [KROK-28 Z3, granica sekcji z przeciagniecia; Y ROSNIE W GORE strony, jak wszedzie w @bindery/core]', () => {
  it('najblizszy token PO naglowku, ktorego GORNA krawedz (maxY) jest na lub ponizej danego Y', () => {
    // Naglowek "ATAKI" najwyzej (Y=100); w dol strony (male Y): "Walka"(70), "Unik"(40), kolejna sekcja "Umiejętności:"(10).
    const tokens = [itok('ATAKI', 0, 100, 0), itok('Walka', 0, 70, 1), itok('Unik', 0, 40, 2), itok('Umiejętności:', 0, 10, 3)];
    // Granica wyladowala na Y=55: "Walka" (maxY=80) jest NAD nia (odrzucony), "Unik" (maxY=50) i "Umiejętności:" (maxY=20) sa POD nia -- "Unik" jest BLIZEJ (wiekszy maxY wsrod kwalifikujacych sie).
    const result = findTerminateTokenAtY(tokens, 0, 55);
    expect(result).toEqual({ text: 'Unik', bbox: tokens[2]!.bbox, tokenIndex: 2 });
  });

  it('ignoruje tokeny PRZED afterTokenIndex, nawet gdy geometrycznie ponizej Y', () => {
    // "Umiejętności:" (index 0) lezy bardzo nisko (maxY=0) -- kwalifikowalby sie geometrycznie dla y=0, ale ma tokenIndex 0 <= afterTokenIndex 1 -> pomijany.
    // Jedyny token PO afterTokenIndex ("ATAKI", index 2) lezy wysoko (maxY=110) -- nie kwalifikuje sie dla y=0 -> null.
    const tokens = [itok('Umiejętności:', 0, -10, 0), itok('nagłówek', 0, 100, 1), itok('ATAKI', 0, 100, 2)];
    const result = findTerminateTokenAtY(tokens, 1, 0);
    expect(result).toBeNull();
  });

  it('nic nie lezy ponizej Y -> null (koniec strumienia jest poprawna odpowiedzia)', () => {
    // Granica przeciagnieta DALEKO PONIZEJ najnizszego tokenu na stronie (Y bardzo male/ujemne) -- nic nie ma tak nisko.
    const tokens = [itok('ATAKI', 0, 100, 0), itok('Walka', 0, 80, 1)];
    expect(findTerminateTokenAtY(tokens, 0, -1000)).toBeNull();
  });
});

describe('mergeTouchingTokens — [KROK-28, zmierzony na zywo blad "Jørgen" -> "^J$"]', () => {
  it('scala dwa stykajace sie tokeny (odstep <= progu) w tym samym wierszu w jeden', () => {
    // "J" konczy sie na x=8, "ørgen" zaczyna na x=8 -- zero odstepu, dokladnie zmierzony przypadek rozbicia na styku znaku diakrytycznego.
    const tokens = [tok('J', 0), tok('ørgen', 8)];
    const result = mergeTouchingTokens(tokens);
    expect(result).toEqual([{ text: 'Jørgen', bbox: { minX: 0, maxX: 16, minY: 0, maxY: 10 } }]);
  });

  it('NIE scala tokenow z normalnym odstepem miedzywyrazowym', () => {
    // Odstep 10pt -- typowa spacja, nie styk glifow.
    const tokens = [tok('Jørgen', 0), tok('Hansen', 18)];
    const result = mergeTouchingTokens(tokens);
    expect(result).toEqual([tok('Jørgen', 0), tok('Hansen', 18)]);
  });

  it('scala LANCUCH kilku stykajacych sie fragmentow w jeden token', () => {
    const tokens = [tok('J', 0), tok('ø', 8), tok('rgen', 12)];
    const result = mergeTouchingTokens(tokens);
    expect(result).toEqual([{ text: 'Jørgen', bbox: { minX: 0, maxX: 20, minY: 0, maxY: 10 } }]);
  });

  it('NIE scala stykajacych sie tokenow na ROZNYCH wierszach (zero pokrycia pionowego)', () => {
    const tokens = [tok('J', 0, 0), tok('ørgen', 8, 100)];
    const result = mergeTouchingTokens(tokens);
    expect(result).toEqual([tok('J', 0, 0), tok('ørgen', 8, 100)]);
  });

  it('realny przypadek: "Jørgen Hansen" jako trzy fragmenty pdf.js -> dwa tokeny po scaleniu, granica sekcji z klikniecia w "Jørgen" daje pelne slowo', () => {
    const tokens = [tok('J', 0), tok('ørgen', 8), tok('Hansen', 60)];
    const result = mergeTouchingTokens(tokens);
    expect(result.map((t) => t.text)).toEqual(['Jørgen', 'Hansen']);
  });

  it('pusta lista -> pusta lista', () => {
    expect(mergeTouchingTokens([])).toEqual([]);
  });

  it('[Regresja, zmierzona na zywo natychmiast po pierwszej wersji] NIE scala dwoch PELNYCH slow, nawet stykajacych sie geometrycznie -- pierwsza wersja zrobila naglowek "Umiejętności" nieklikalnym, sklejajac go z sasiednim slowem tylko dlatego, ze odstep byl geometrycznie bliski zeru (skladanie z justowaniem tekstu koduje odstep jako korekte w TJ, nie jako osobny glif)', () => {
    const tokens = [tok('Umiejętności', 0), tok('Kalambury', 8)];
    const result = mergeTouchingTokens(tokens);
    expect(result).toEqual([tok('Umiejętności', 0), tok('Kalambury', 8)]);
  });

  it('sklejenie WYMAGA, zeby PRZYNAJMNIEJ JEDNA strona byla krotkim fragmentem -- dwa dluzsze, stykajace sie tokeny zostaja osobno', () => {
    const tokens = [tok('Walka', 0), tok('Wręcz', 8)];
    expect(mergeTouchingTokens(tokens)).toEqual([tok('Walka', 0), tok('Wręcz', 8)]);
  });

  it('[KROK-29 Z3] `fontKey` przetrwa scalenie fragmentow (oba fragmenty realnego rozbicia diakrytykiem dziela TEN SAM font)', () => {
    const tokens: SelectionToken[] = [
      { ...tok('J', 0), fontKey: 'Arial-Bold@12' },
      { ...tok('ørgen', 8), fontKey: 'Arial-Bold@12' },
    ];
    expect(mergeTouchingTokens(tokens)).toEqual([{ text: 'Jørgen', bbox: { minX: 0, maxX: 16, minY: 0, maxY: 10 }, fontKey: 'Arial-Bold@12' }]);
  });
});

describe('splitMergedLabelValueTokens — [KROK-42, zmierzony na zywo blad "Zew Cthulhu... Noc Zagłady v.2.0" str. 15]', () => {
  it('rozdziela ciasno skladana etykiete siatki cech scalona przez pdf.js w jeden token ("S 40" -> "S", "40")', () => {
    const tokens = [tok('S 40', 0)];
    const result = splitMergedLabelValueTokens(tokens);
    expect(result.map((t) => t.text)).toEqual(['S', '40']);
  });

  it('dziala dla wieloznakowej etykiety i dwucyfrowej wartosci ("MOC 80")', () => {
    expect(splitMergedLabelValueTokens([tok('MOC 80', 0)]).map((t) => t.text)).toEqual(['MOC', '80']);
  });

  it('rozdziela caly rzad siatki cech (8 scalonych tokenow -> 16 naprzemiennych etykieta/wartosc)', () => {
    const tokens = ['S 40', 'KON 40', 'BC 40', 'ZR 40', 'INT 80', 'WYG 50', 'MOC 70', 'WYK 75'].map((t, i) => tok(t, i * 40));
    const result = splitMergedLabelValueTokens(tokens);
    expect(result.map((t) => t.text)).toEqual(['S', '40', 'KON', '40', 'BC', '40', 'ZR', '40', 'INT', '80', 'WYG', '50', 'MOC', '70', 'WYK', '75']);
  });

  it('rozdziela wartosc myslnikowa ("P -")', () => {
    expect(splitMergedLabelValueTokens([tok('P -', 0)]).map((t) => t.text)).toEqual(['P', '-']);
  });

  it('dzieli bbox proporcjonalnie do liczby znakow etykiety/wartosci', () => {
    // "S 40" ma 4 znaki, etykieta "S" to 1/4 -- granica podzialu na x=0+8*(1/4)=2.
    const result = splitMergedLabelValueTokens([tok('S 40', 0)]);
    expect(result[0]!.bbox).toEqual({ minX: 0, maxX: 2, minY: 0, maxY: 10 });
    expect(result[1]!.bbox).toEqual({ minX: 2, maxX: 8, minY: 0, maxY: 10 });
  });

  it('NIE rusza tokenow, ktore JUZ sa oddzielnymi etykieta/wartoscia (pdf.js ich nie scalil)', () => {
    const tokens = [tok('S', 0), tok('40', 10)];
    expect(splitMergedLabelValueTokens(tokens)).toEqual(tokens);
  });

  it('NIE rozdziela etykiety zakonczonej dwukropkiem ("Krzepa: 5" -- ten uklad zawsze przychodzi jako DWA osobne tokeny z pdf.js, zmierzone wprost, nigdy scalone w jeden)', () => {
    const tokens = [tok('Krzepa: 5', 0)];
    expect(splitMergedLabelValueTokens(tokens)).toEqual(tokens);
  });

  it('NIE rozdziela dluzszego zdania/prozy (notacja kostek "+1K4" nie jest czysta liczba, wiec dopasowanie konczy sie na koncu stringa i nie pasuje)', () => {
    const tokens = [tok('Obrażenia 1K3+2 latający', 0)];
    expect(splitMergedLabelValueTokens(tokens)).toEqual(tokens);
  });

  it('NIE rozdziela etykiety dluzszej niz 12 liter (poza realistycznym zasiegiem skrotu cechy)', () => {
    const tokens = [tok('Spostrzegawczość 40', 0)];
    expect(splitMergedLabelValueTokens(tokens)).toEqual(tokens);
  });

  it('pusta lista -> pusta lista', () => {
    expect(splitMergedLabelValueTokens([])).toEqual([]);
  });
});

describe('classifyValue — [KROK-43, "Brak." nadal jest wartoscia, nie zdaniem]', () => {
  it('krotka jednoslowna odpowiedz z kropka ("Brak.") -> "low", nie odrzucona', () => {
    expect(classifyValue('Brak.')).toBe('low');
  });

  it('dwuslowna krotka odpowiedz z kropka ("Brak zbroi.") -> nadal "low"', () => {
    expect(classifyValue('Brak zbroi.')).toBe('low');
  });

  it('prawdziwe zdanie (ponad SHORT_ANSWER_MAX_WORDS slow) zakonczone kropka -> nadal odrzucone', () => {
    expect(classifyValue('To jest dlugi opis fabularny.')).toBeNull();
  });

  it('wykrzyknik/pytajnik na koncu -> zawsze odrzucone, niezaleznie od dlugosci', () => {
    expect(classifyValue('Uciekaj!')).toBeNull();
    expect(classifyValue('Naprawde?')).toBeNull();
  });
});

describe('stripStrayLeadingColonTokens — [KROK-43, zmierzony na zywo blad "Wielki Terror" str. 91 "Pancerz" / ": Brak."]', () => {
  it('usuwa dwukropek+spacje z POCZATKU tokenu, ktory pdf.js zostawil przy wartosci zamiast przy etykiecie', () => {
    const tokens = [tok('Pancerz', 0), tok(': Brak.', 10)];
    expect(stripStrayLeadingColonTokens(tokens).map((t) => t.text)).toEqual(['Pancerz', 'Brak.']);
  });

  it('dziala tez bez spacji po dwukropku (": Brak" i ":Brak" oba dają "Brak")', () => {
    expect(stripStrayLeadingColonTokens([tok(':Brak.', 0)]).map((t) => t.text)).toEqual(['Brak.']);
  });

  it('NIE rusza tokenow bez wiodacego dwukropka', () => {
    const tokens = [tok('Pancerz', 0), tok('Brak.', 10)];
    expect(stripStrayLeadingColonTokens(tokens)).toEqual(tokens);
  });

  it('token bedacy WYLACZNIE dwukropkiem (i ewentualna spacja) znika calkowicie zamiast zostac pustym tokenem', () => {
    const tokens = [tok('Pancerz', 0), tok(': ', 10), tok('Brak.', 20)];
    expect(stripStrayLeadingColonTokens(tokens).map((t) => t.text)).toEqual(['Pancerz', 'Brak.']);
  });

  it('realny przypadek: cala para "Pancerz"/": Brak." poprawnie parowana PO oczyszczeniu strumienia', () => {
    const tokens = [tok('Pancerz', 0), tok(': Brak.', 10), tok('Wyposażenie', 30)];
    const cleaned = stripStrayLeadingColonTokens(tokens);
    const pairs = inferLabelledPairsFromTokens(cleaned);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!).toMatchObject({ label: 'Pancerz', value: 'Brak.' });
  });

  it('pusta lista -> pusta lista', () => {
    expect(stripStrayLeadingColonTokens([])).toEqual([]);
  });
});

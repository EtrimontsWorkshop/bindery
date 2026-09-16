import { rectGapDistance, unionRect, type Rect } from '../geometry.js';
import type { ProfileToken } from './types.js';
import type { LabelledPairsPattern, SectionListPattern } from './schema.js';

/**
 * [KROK-18 Z2] Silnik wzorcow nad surowym strumieniem tokenow — implementacja
 * `Bindery-MDD-v2.1.md` §5.5. Dwa rodzaje wzorcow zaimplementowane tutaj:
 * `labelledPairs` (siatka cech / blok pochodnych) i `sectionList` (ATAKI).
 * `fontRoleCandidate` (kandydat na nazwe encji) i parowanie geometryczne
 * (`entityAssembly`) to KROK-18 Z3 — celowo poza tym plikiem.
 *
 * `labelledPairs` uogolnia `collectGrids` ze spike'u kroku 13
 * (`spike/statblocks2/parse2.mjs`, H1) — TA sama logika (zbior etykiet,
 * dowolna kolejnosc, zamkniecie przy powtorzonej etykiecie), ale sterowana
 * konfiguracja profilu zamiast zaszytej na sztywno listy `CHAR_LABELS`.
 */

/**
 * [KROK-21 Z3, zmierzony na zywo problem] Znak wodny DriveThruRPG
 * ("Imię Nazwisko (Order #12345678)") — zweryfikowany na WSZYSTKICH 6
 * plikach `samples/` (identyczny format na kazdej sprawdzonej stronie
 * kazdego pliku). To cecha DYSTRYBUTORA, nie konkretnej publikacji ani
 * jezyka — zyje w silniku (stosowana ZAWSZE, niezaleznie od tego, co autor
 * profilu wpisal we WLASNY `terminateSectionBefore`/`trailingWordsStopBefore`), nie w kazdym profilu z
 * osobna, zeby nie trzeba bylo pamietac o niej przy kazdym nowym profilu.
 * Dotyczy KAZDEGO pliku kupionego na DriveThruRPG — wiekszosci materialu
 * uzytkownikow (krok 21, odkrycie #3 z RAPORT-KROK-20.md).
 */
export const VENDOR_WATERMARK_PATTERN = /\(Order #\d+\)/;

/**
 * [KROK-19 Z0, doprecyzowane w Z4] Gorna granica dla `allowTrailingWords` —
 * patrz komentarz przy jej uzyciu w `matchLabelledPairs`. Liczona w
 * PRAWDZIWYCH SLOWACH (dzielonych po bialych znakach WEWNATRZ kazdego
 * tokenu), NIE w tokenach — zmierzone wprost jako niewystarczajace, gdy
 * liczono tokeny: pdf.js czasem laczy caly wiersz przypisu w JEDEN TextItem
 * (np. "Zmniejszona liczba PW ze względu na wcześniejszy atak, jaki" to
 * JEDEN token, 10 prawdziwych slow) — limit "6 tokenow" pozwalal wtedy
 * polknac ~20 slow niepowiazanej prozy w JEDNEJ-DWóCH iteracjach.
 */
const MAX_TRAILING_WORDS = 4;

export interface LabelledPairMatchEntry {
  /** Etykieta z PDF-a (klucz `pattern.labels`). */
  label: string;
  /** Klucz kanoniczny (wartosc `pattern.labels[label]`). */
  canonicalKey: string;
  value: string;
  tokenIndex: number;
  /**
   * [KROK-33 Z1, zmierzony na zywo brak, Sciapod str. 24] Wartosc konczaca sie
   * gola gwiazdka ("Ruch: 7/9*") bywa przypisem stojacym NIE tuz po wartosci
   * (co juz obsluguje `allowTrailingWords`), tylko na WLASNYM WIERSZU po calym
   * BLOKU par (np. "MO: +5K6 Krzepa: 6 Ruch: 7/9* PM: 8" — jeden wiersz, potem
   * "*Pływanie" na kolejnym). Wypelnione WYLACZNIE gdy dokladnie JEDNA para w
   * tym dopasowaniu ma wartosc konczaca sie gola gwiazdka — przy wielu
   * kandydatach nie da sie jednoznacznie przypisac, ktoremu przypisowi
   * odpowiada ktora gwiazdka (A10, nie zgaduj).
   */
  footnoteText?: string;
  /**
   * [KROK-34 Z1, zmierzony na zywo brak, Sciapod str. 24 "Wrak.pdf"] Wartosc
   * bywa JEDNYM tokenem pdf.js niosacym ZARAZEM liczbe I dalszy opis w tym
   * samym wierszu ("Pancerz: 5, niezwykle gruba skóra. Pamiętaj..." — cale to
   * po dwukropku to JEDEN token) — bez rozdzielenia trafialoby to WPROST do
   * pola liczbowego adaptera (np. `armor.value`), ktore nie parsuje takiego
   * ciagu jako liczby, wiec pole zostawalo puste (A13, ten sam mechanizm co
   * blad Ruchu 8/7 z kroku 30/33: adapter wylacza automatyke systemu TYLKO
   * przy sparsowanej wartosci). Wypelnione WYLACZNIE gdy `value` zaczyna sie
   * od liczby (opcjonalnie z gola gwiazdka) i PO NIEJ nastepuje separator
   * (przecinek/srednik/dwukropek) ALBO biala spacja i cokolwiek jeszcze —
   * `value` zostaje wtedy PRZYCIETA do samej liczby, reszta trafia tutaj
   * (A3 — nic nie ginie w ciszy). Wartosc CZYSTO opisowa bez wiodacej liczby
   * ("brak", "2-punktowa gruba skóra") NIE jest dzielona — trafia do `value`
   * w calosci, tak jak dotychczas (drugie kryterium kroku 34: opis nie moze
   * zniknac, gdy nie ma liczby do wydzielenia).
   */
  descriptionText?: string;
}

export interface LabelledPairsMatch {
  pairs: LabelledPairMatchEntry[];
  /** Indeks PIERWSZEGO tokenu etykiety w strumieniu wejsciowym. */
  startIndex: number;
  /** Indeks PIERWSZY PO ostatnim skonsumowanym tokenie (exclusive). */
  endIndex: number;
  bbox: Rect;
}

/** Czy token wyglada jak kolejna etykieta z `pattern.labels` (uzywane przez `allowTrailingWords`, zeby nie polykac kolejnej pary). */
function looksLikeLabel(text: string, labels: Readonly<Record<string, string>>): boolean {
  return Object.prototype.hasOwnProperty.call(labels, text);
}

/**
 * Zbiera WSZYSTKIE dopasowania `labelledPairs` w strumieniu tokenow. Zbior
 * etykiet, DOWOLNA kolejnosc i liczba (S2, H1 kroku 12/13) — nie zaklada
 * ktora etykieta jest pierwsza ani ile ich bedzie (miedzy `minPairs` a
 * `maxPairs`).
 */
export function matchLabelledPairs(tokens: readonly ProfileToken[], pattern: LabelledPairsPattern): LabelledPairsMatch[] {
  const valueRe = new RegExp(pattern.valuePattern);
  const maxGapPt = pattern.terminate.maxGapPt;
  const matches: LabelledPairsMatch[] = [];

  let i = 0;
  while (i < tokens.length) {
    const startToken = tokens[i]!;
    if (!looksLikeLabel(startToken.text, pattern.labels) || !valueRe.test(tokens[i + 1]?.text ?? '')) {
      i++;
      continue;
    }

    const pairs: LabelledPairMatchEntry[] = [];
    const seen = new Set<string>();
    let j = i;
    let lastValueBbox: Rect | null = null;

    while (j < tokens.length) {
      const labelTok = tokens[j]!;
      const valueTok = tokens[j + 1];
      if (!valueTok || !looksLikeLabel(labelTok.text, pattern.labels) || !valueRe.test(valueTok.text)) break;
      if (pattern.terminate.onRepeatedLabel && seen.has(labelTok.text)) break;
      if (maxGapPt !== undefined && lastValueBbox && rectGapDistance(lastValueBbox, labelTok.bbox) > maxGapPt) break;
      if (pattern.maxPairs !== undefined && pairs.length >= pattern.maxPairs) break;

      let valueText = valueTok.text;
      let consumedThrough = j + 2;
      // [S1] "12/12" + "latając" — absorbuj tokeny opisowe PO wartosci, dopoki
      // nie natrafimy na kolejna etykiete (albo koniec strumienia).
      if (pattern.allowTrailingWords) {
        const stopRe = pattern.trailingWordsStopBefore ? new RegExp(pattern.trailingWordsStopBefore, 'u') : null;
        let k = j + 2;
        let absorbedWords = 0;
        // [KROK-19 Z0, naprawa zmierzonego bledu; Z4, doprecyzowane] Bez
        // gornej granicy: gdy ostatnia para bloku nie ma juz ZADNEJ etykiety
        // PO sobie na stronie (np. ostatni blok pochodnych przed proza
        // konczaca strone), "slowo koncowe" polykalo dosloWNIE reszte strony
        // do konca tokenow — zmierzone wprost na str. 30 (`Punkty Magii`
        // wchlonelo >1000 znakow dalszej prozy). Limit liczy PRAWDZIWE SLOWA
        // (nie tokeny — pdf.js czasem laczy caly wiersz przypisu w JEDEN
        // token, patrz komentarz przy `MAX_TRAILING_WORDS`), a CALY kandydujacy
        // token jest odrzucany (nie czesciowo obcinany), jesli przekroczylby
        // limit — zapobiega wchlonieciu polowy zdania. MDD-owy przypadek
        // uzycia to JEDNO slowo opisowe ("12/12" + "latając").
        while (k < tokens.length && !looksLikeLabel(tokens[k]!.text, pattern.labels) && !(stopRe && stopRe.test(tokens[k]!.text)) && !VENDOR_WATERMARK_PATTERN.test(tokens[k]!.text)) {
          const candidateWords = tokens[k]!.text.trim().split(/\s+/).filter(Boolean).length;
          if (absorbedWords + candidateWords > MAX_TRAILING_WORDS) break;
          valueText += ` ${tokens[k]!.text}`;
          consumedThrough = k + 1;
          absorbedWords += candidateWords;
          if (/[.!?]$/.test(tokens[k]!.text.trim())) break;
          k++;
        }
      }

      // [KROK-34 Z1] Rozdzielenie "5, opis" -> value="5" + descriptionText="opis"
      // -- PO absorpcji slow opisowych powyzej, zeby dzialalo niezaleznie od
      // `allowTrailingWords` (dziala rowniez, gdy CALY tekst byl JUZ jednym,
      // scalonym przez pdf.js tokenem -- dokladnie przypadek Sciapoda).
      //
      // Liczba (opcjonalnie z gola gwiazdka jak przy `footnoteText`) NA
      // POCZATKU wartosci, po ktorej idzie separator (przecinek/srednik/
      // dwukropek, z dowolnymi bialymi znakami wokol), a PO NIM jeszcze jakis
      // tekst. Celowo NIE lapie samej liczby ("45"), liczby zlepionej BEZ
      // separatora z dalszym tekstem ("2-punktowa" — ma zostac WHOLE jako
      // wartosc opisowa), zapisu N/M ("7/9*" — Ruch, `/` nie jest separatorem
      // z listy) — ani [regresja zlapana testem "12/12"+"latając" ->
      // "12 unosząc się w powietrzu"] liczby oddzielonej od dalszego tekstu
      // SAMA SPACJA bez zadnego znaku interpunkcyjnego: to jest dokladnie
      // ksztalt, ktory `allowTrailingWords` juz celowo doklejal jako CZESC
      // wartosci opisowej (Ruch "12 latający" — cale to JEST wartoscia, nie
      // liczba+opis do rozdzielenia). Wymog znaku interpunkcyjnego odroznia
      // "opis doklejony do etykiety w tym samym tokenie" (Pancerz, gdzie
      // przecinek naprawde stoi w zrodle) od "opis doklejony PRZEZ silnik"
      // (allowTrailingWords, gdzie separatora nigdy nie ma).
      //
      // [KROK-34, obejscie falszywego alarmu check:boundary] Ta stala BYLA
      // module-scope (`const VALUE_WITH_DESCRIPTION` na gorze pliku) — esbuild
      // zmapowal ja na skrocona nazwe "ui" (dokladnie ten sam, juz udokumentowany
      // w `scripts/check-boundary.mjs` falszywy alarm co `isReferenceReportGreen`
      // z kroku 17: minifikator przydziela krotkie nazwy wg pozycji/czestosci w
      // ZASIEGU, nie wedlug tresci zrodlowej nazwy), a `ui.test(...)` pasowal do
      // wzorca "restricted-word + kropka". Zadeklarowana LOKALNIE (inny budzet
      // nazw minifikacji niz zasieg modulu) zamiast zmieniac logike silnika.
      const valueWithDescriptionPattern = /^(\d+\*?)\s*[,;:]\s*(\S[\s\S]*)$/u;
      const splitMatch = valueWithDescriptionPattern.exec(valueText.trim());
      let descriptionText = splitMatch?.[2]?.trim();
      if (splitMatch) valueText = splitMatch[1]!;

      // [zgloszenie uzytkownika, "Pancerz jest niepełny"] `descriptionText`
      // powyzej lapie WYLACZNIE tekst ze WLASNEGO tokenu wartosci — ale zdanie
      // opisowe bywa PRZELAMANE na kolejny fizyczny wiersz PDF-a (osobny token
      // pdf.js, inny Y), zmierzone wprost na Sciapodzie str. 24: "Pancerz: 5,
      // niezwykle gruba skóra. Pamiętaj, że obrażenia" (jeden token) +
      // "zadawane srebrną bronią ignorują pancerz." (KOLEJNY token, 5 prawdziwych
      // slow — za dlugo dla `allowTrailingWords`/`MAX_TRAILING_WORDS` powyzej,
      // ktory CELOWO odrzuca cale takie tokeny, zeby chronic przed dawnym
      // bledem "Punkty Magii polkely >1000 znakow prozy"). Kontynuacja TUTAJ
      // jest waska i bezpieczna: uruchamia sie WYLACZNIE gdy `descriptionText`
      // juz istnieje (a wiec zdanie NAPRAWDE bylo w toku) i JESZCZE nie
      // konczy sie kropka/wykrzyknikiem/pytajnikiem, zatrzymuje sie na
      // PIERWSZYM takim tokenie (koniec zdania), na kolejnej etykiecie tego
      // wzorca albo na znaku wodnym dystrybutora — z twardym gornym limitem
      // (`guard`) na wypadek zdania bez zadnej koncowej interpunkcji.
      if (descriptionText && !/[.!?]$/.test(descriptionText)) {
        let k = consumedThrough;
        let guard = 0;
        while (k < tokens.length && guard < 5 && !looksLikeLabel(tokens[k]!.text, pattern.labels) && !VENDOR_WATERMARK_PATTERN.test(tokens[k]!.text)) {
          descriptionText += ` ${tokens[k]!.text}`;
          consumedThrough = k + 1;
          guard++;
          const shouldStop = /[.!?]$/.test(tokens[k]!.text.trim());
          k++;
          if (shouldStop) break;
        }
      }

      pairs.push({ label: labelTok.text, canonicalKey: pattern.labels[labelTok.text]!, value: valueText, tokenIndex: j, ...(descriptionText ? { descriptionText } : {}) });
      seen.add(labelTok.text);
      lastValueBbox = tokens[consumedThrough - 1]?.bbox ?? valueTok.bbox;
      j = consumedThrough;
    }

    // [KROK-33 Z1] Przypis stojacy na WLASNYM wierszu tuz PO calym bloku par
    // (patrz komentarz `footnoteText` przy `LabelledPairMatchEntry`) — token
    // NIE jest juz etykieta+wartoscia (petla wyzej wlasnie dlatego sie
    // zatrzymala), wiec sprawdzany OSOBNO, PO zbudowaniu wszystkich par.
    const footnoteToken = tokens[j];
    if (footnoteToken && /^\*\S/.test(footnoteToken.text.trim())) {
      const starredPairs = pairs.filter((p) => /\*$/.test(p.value.trim()));
      if (starredPairs.length === 1) {
        starredPairs[0]!.footnoteText = footnoteToken.text.trim();
        j++;
      }
    }

    if (pairs.length >= pattern.minPairs) {
      const bbox = pairs.reduce<Rect | null>((acc, p) => {
        const tokBbox = tokens[p.tokenIndex]!.bbox;
        return acc ? unionRect(acc, tokBbox) : tokBbox;
      }, null)!;
      matches.push({ pairs, startIndex: i, endIndex: j, bbox });
      i = j;
    } else {
      i++;
    }
  }

  return matches;
}

export interface SectionListItemMatch {
  /** Nazwane grupy z `itemPattern` (np. `name`, `toHit`) — puste jesli wzorzec ich nie definiuje. */
  groups: Record<string, string>;
  raw: string;
  startTokenIndex: number;
  endTokenIndex: number;
  bbox: Rect;
  /** [KROK-40] `true`, gdy grupa `name` zawiera (case-insensitive) ktoras z `pattern.rangedKeywords`. */
  ranged: boolean;
}

export interface SectionListMatch {
  headerTokenIndex: number;
  items: SectionListItemMatch[];
  /** Indeks PIERWSZY PO ostatnim tokenie nalezacym do tej sekcji (naglowek nastepnej sekcji albo koniec strumienia). */
  endIndex: number;
}

/**
 * Zbiera dopasowania `sectionList` (np. blok ATAKI). Laczy tokeny sekcji w
 * jeden bufor tekstowy (sledzac, ktory token dostarczyl kazdy znak), potem
 * dopasowuje `itemPattern` globalnie do bufora — odpornosc na to, ze
 * pojedyncza pozycja ataku bywa rozbita na wiele tokenow pdf.js, bez
 * zakladania linii/kolumn (S1).
 *
 * @param hardStopTokenIndices [KROK-20 Z2, zmierzony na zywo blad] Indeksy
 * tokenow poczatkow INNYCH encji na stronie (typowo `LabelledPairsMatch.
 * startIndex` kotwicy `entityAssembly.anchor`, patrz `assembleStatblocks.ts`)
 * — bufor sekcji NIGDY nie przekracza najblizszego z nich. Bez tego: gdy dwie
 * postacie stoja obok siebie w strumieniu tokenow BEZ dzielacego naglowka
 * kolokrotkowego (`terminateSectionBefore`) miedzy koncem ATAKI jednej a poczatkiem
 * siatki cech drugiej — co zdarza sie naprawde (str. 55 "nie czas na krzyk":
 * trzy przykladowe postacie w rzad, kazda wlasna siatka+ATAKI, bez kolejnych
 * naglowkow miedzy nimi) — bufor lecial AZ do NASTEPNEGO wystapienia `ATAKI`
 * (czyli WLASNEGO naglowka DRUGIEJ postaci), polykajac calkowicie jej nazwe,
 * siatke cech i pochodne jako "opis obrazen" OSTATNIEJ pozycji ataku
 * pierwszej postaci (zmierzone: `Unik 22%` dostawal w `damage` >100 znakow
 * cudzej siatki). Opcjonalny — bez niego zachowanie identyczne jak wczesniej.
 */
export function matchSectionList(tokens: readonly ProfileToken[], pattern: SectionListPattern, hardStopTokenIndices?: readonly number[]): SectionListMatch[] {
  const headerRe = new RegExp(pattern.sectionHeader);
  // [KROK-18 Z2, naprawiony blad] Flaga `u` konieczna: `\p{L}` (litery
  // dowolnego jezyka) w `itemPattern` — jak w profilu PL z tego kroku — bez
  // niej NIE jest interpretowane jako unicode property escape (JS je wtedy
  // czyta jako literalny znak `p` + `{L}`), wiec dopasowanie po prostu nigdy
  // sie nie udaje, bez zadnego bledu/wyjatku sygnalizujacego przyczyne.
  const itemRe = new RegExp(pattern.itemPattern, 'gu');
  const matches: SectionListMatch[] = [];
  const sortedHardStops = hardStopTokenIndices ? [...hardStopTokenIndices].sort((a, b) => a - b) : undefined;

  let i = 0;
  while (i < tokens.length) {
    if (!headerRe.test(tokens[i]!.text)) {
      i++;
      continue;
    }
    const headerTokenIndex = i;
    const hardStop = sortedHardStops?.find((idx) => idx > headerTokenIndex);

    let buffer = '';
    // charToToken[c] = indeks tokenu, ktory dostarczyl znak `buffer[c]`.
    const charToToken: number[] = [];
    let j = headerTokenIndex + 1;

    // [KROK-19 Z1, naprawiony blad #2] Pomin naglowek KOLUMNY tabeli (np. "%"
    // + "obrażenia" jako osobne tokeny) miedzy naglowkiem sekcji a pierwsza
    // prawdziwa pozycja. Pierwsza wersja zakladala, ze naglowek kolumny jest
    // BEZPOSREDNIO po naglowku sekcji — zmierzone wprost jako falszywe: w tej
    // ksiazce miedzy nimi stoi zmiennej dlugosci preambula ("Ataki w rundzie:"
    // + liczba, czasem z dopiskiem w nawiasie), wiec petla "kontynuuj tylko
    // dopoki kolejny token pasuje" zatrzymywala sie natychmiast na "Ataki w
    // rundzie:" i nigdy nie docierala do "%"/"obrażenia". Naprawa: szukaj
    // OSTATNIEGO tokenu pasujacego do wzorca w ograniczonym oknie (nie musi
    // byc przylegajacy do naglowka sekcji), potem pomin wszystko AZ DO NIEGO
    // wlacznie. Brak dopasowania w oknie -> nic nie pomijaj (strona bez tej
    // preambuly, jak w izolowanych testach jednostkowych).
    if (pattern.skipAfterHeader) {
      const skipRe = new RegExp(pattern.skipAfterHeader, 'u');
      const SKIP_SEARCH_LIMIT = 10;
      let lastMatch = -1;
      for (let k = j; k < Math.min(tokens.length, j + SKIP_SEARCH_LIMIT) && !headerRe.test(tokens[k]!.text); k++) {
        if (skipRe.test(tokens[k]!.text)) lastMatch = k;
      }
      if (lastMatch >= 0) j = lastMatch + 1;
    }

    const stopRe = pattern.terminateSectionBefore ? new RegExp(pattern.terminateSectionBefore, 'u') : null;
    let pendingHyphen = false;
    while (
      j < tokens.length &&
      !headerRe.test(tokens[j]!.text) &&
      !(stopRe && stopRe.test(tokens[j]!.text)) &&
      !VENDOR_WATERMARK_PATTERN.test(tokens[j]!.text) &&
      (hardStop === undefined || j < hardStop)
    ) {
      const text = tokens[j]!.text;
      const isHyphenToken = pattern.rejoinHyphenated && /^[-–]$/.test(text);
      if (isHyphenToken && buffer.length > 0) {
        pendingHyphen = true;
        j++;
        continue;
      }
      const prefix = buffer.length === 0 || pendingHyphen ? '' : ' ';
      if (prefix) charToToken.push(-1); // separator - nie nalezy do zadnego tokenu
      for (let c = 0; c < text.length; c++) charToToken.push(j);
      buffer += prefix + text;
      pendingHyphen = false;
      j++;
    }
    const sectionEndIndex = j;

    const items: SectionListItemMatch[] = [];
    for (const m of buffer.matchAll(itemRe)) {
      // [KROK-34, zmierzony na zywo blad] `itemPattern` pusty (albo kazdy inny,
      // ktory moze dopasowac zero znakow) daje dopasowanie na KAZDEJ pozycji
      // bufora — setki pozycji bez zadnej tresci/grupy, ktore dalej w potoku
      // (`skillsFrom`/`attacksFrom`) staja sie pustymi nazwami. Schemat
      // (`schema.ts`) juz odrzuca pusty `itemPattern` przy wczytaniu profilu —
      // to dodatkowa, silnikowa siatka bezpieczenstwa dla draftu W TRAKCIE
      // edycji w Profile Studio (jeszcze niewalidowanego), zeby podglad na
      // zywo nigdy nie zalal sie tymi samymi smieciami.
      if (m[0].length === 0) continue;
      const start = m.index!;
      const end = start + m[0].length - 1;
      const startTokenIndex = charToToken.slice(start, end + 1).find((t) => t >= 0) ?? headerTokenIndex;
      let endTokenIndex = startTokenIndex;
      for (let c = start; c <= end; c++) {
        const t = charToToken[c]!;
        if (t >= 0) endTokenIndex = t;
      }
      const bbox = Array.from({ length: endTokenIndex - startTokenIndex + 1 }, (_, k) => tokens[startTokenIndex + k]!.bbox).reduce<Rect | null>(
        (acc, b) => (acc ? unionRect(acc, b) : b),
        null,
      )!;
      const groups = { ...(m.groups ?? {}) };
      const nameForRangeCheck = (groups['name'] ?? m[0]).toLowerCase();
      const rangedKeywords = pattern.rangedKeywords ?? [];
      const ranged = rangedKeywords.length > 0 && rangedKeywords.some((kw) => nameForRangeCheck.includes(kw.toLowerCase()));
      items.push({ groups, raw: m[0], startTokenIndex, endTokenIndex, bbox, ranged });
    }

    matches.push({ headerTokenIndex, items, endIndex: sectionEndIndex });
    i = sectionEndIndex;
  }

  return matches;
}

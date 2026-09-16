import type { Rect } from '../geometry.js';

/**
 * [KROK-24 Z1, "największy zysk" per brief] Inferencja wzorca z ZAZNACZENIA
 * myszą — zamiast autor profilu wpisuje etykiety Z PAMIĘCI (krok 23 pokazało,
 * do czego to prowadzi: pominięcie dwóch prawdziwych etykiet leżących MIĘDZY
 * dwiema zapamiętanymi dało `derived: 0 trafień` na całej książce, złapane
 * dopiero przez diagnostykę PO fakcie), autor OBRYSOWUJE obszar, a Studio
 * PROPONUJE — autor tylko potwierdza/koryguje to, co narzędzie znalazło.
 *
 * Wejście to JUŻ przefiltrowane tokeny (te, których środek bboksa leży
 * wewnątrz zaznaczonego prostokąta na stronie — filtr geometryczny robi
 * wywołujący, `ProfileStudio.ts`, bo wymaga `screenRectToPdf`/geometrii
 * konkretnej strony, poza zakresem tego czysto tekstowego pliku), w
 * KOLEJNOŚCI STRUMIENIA (jak wszędzie w tym katalogu — S3).
 */

export interface SelectionToken {
  text: string;
  bbox: Rect;
  /** [KROK-29 Z3] Klucz nosny fontu (patrz `ProfileToken.fontKey`, `types.ts`) — wejscie do nauki `fontRoleCandidate.requireFontKeys` z klikniecia w Profile Studio. */
  fontKey?: string;
}

/**
 * [KROK-28 Z2/Z3, zmierzony na zywo blad, ZAWEZONE po regresji] pdf.js czasem
 * rozbija JEDNO drukowane slowo na kilka `TextItem`, gdy w jego srodku
 * zmienia sie font/kodowanie glifu (typowo: znak diakrytyczny spoza
 * podstawowego zestawu, np. "Jørgen" -> "J" + "ørgen" jako DWA stykajace sie
 * tokeny). Zmierzone na zywo (str. 23 "Zew Cthulhu 7ed. Wrak.pdf"): klikniecie
 * w to, co wizualnie jest jednym slowem "Jørgen", dawalo
 * `terminateSectionBefore: "^J$"` — dopasowuje KAZDE samotne "J" w calej
 * ksiazce, granica przypadkowa.
 *
 * [Regresja, zmierzona na zywo NATYCHMIAST po pierwszej wersji] Pierwsza
 * wersja sklejala KAZDA pare stykajacych sie tokenow, bez wzgledu na ich
 * dlugosc — na innej stronie tej samej ksiazki (naglowek "Umiejętności")
 * zrobilo to nagle NIEKLIKALNYM: realny naglowek zlaczyl sie z sasiednim
 * slowem (odstep miedzywyrazowy w tym PDF-ie, zakodowany jako korekta liczby
 * w operatorze `TJ`, nie jako osobny glif spacji, bywa GEOMETRYCZNIE rowny
 * zeru mimo ze WIZUALNIE to dwa slowa) i przekroczyl `PICKABLE_MAX_LENGTH`
 * (40 znakow) w `ProfileStudio.ts`, wiec przestal dostawac klikalny
 * prostokat w ogole. Naprawa: sklejaj WYLACZNIE, gdy PRZYNAJMNIEJ JEDNA
 * strona zlaczenia jest KROTKIM fragmentem (<= `SHORT_FRAGMENT_MAX_LENGTH`
 * znakow) — dokladnie sygnatura prawdziwego rozbicia diakrytykiem (jeden
 * osamotniony znak/kilka znakow), nigdy dwoch pelnych, normalnej dlugosci
 * slow, ktore po prostu ciasno do siebie przylegaja w tym konkretnym
 * skladzie. Falszywy negatyw (rzadki przypadek slowa rozbitego dokladnie
 * na pol na dwie dluzsze czesci) kosztuje powrot do starego objawu — ta sama
 * klasa problemu co przed tym krokiem, nie nowa awaria. Falszywy pozytyw
 * (sklejenie dwoch prawdziwych slow) kosztuje calkowita utrate mozliwosci
 * kliknieca — dlatego asymetria progu w strone ostroznosci.
 */
const TOUCHING_GAP_PT = 1.5;
const SHORT_FRAGMENT_MAX_LENGTH = 2;

export function mergeTouchingTokens(tokens: readonly SelectionToken[]): SelectionToken[] {
  const merged: SelectionToken[] = [];
  for (const t of tokens) {
    const prev = merged.at(-1);
    if (prev) {
      const gap = t.bbox.minX - prev.bbox.maxX;
      const sameLine = Math.min(prev.bbox.maxY, t.bbox.maxY) - Math.max(prev.bbox.minY, t.bbox.minY) > 0;
      const looksLikeGlyphSplit = prev.text.length <= SHORT_FRAGMENT_MAX_LENGTH || t.text.length <= SHORT_FRAGMENT_MAX_LENGTH;
      if (sameLine && gap <= TOUCHING_GAP_PT && looksLikeGlyphSplit) {
        merged[merged.length - 1] = {
          text: prev.text + t.text,
          bbox: { minX: prev.bbox.minX, maxX: t.bbox.maxX, minY: Math.min(prev.bbox.minY, t.bbox.minY), maxY: Math.max(prev.bbox.maxY, t.bbox.maxY) },
          fontKey: prev.fontKey ?? t.fontKey,
        };
        continue;
      }
    }
    merged.push({ text: t.text, bbox: t.bbox, fontKey: t.fontKey });
  }
  return merged;
}

export type LabelledPairConfidence = 'high' | 'low';

export interface LabelledPairSuggestion {
  label: string;
  value: string;
  /** Indeks etykiety WEWNĄTRZ przekazanej tablicy `tokens` (nie w strumieniu całej strony) — do podświetlenia/odznaczenia w UI. */
  index: number;
  bbox: Rect;
  /**
   * [KROK-25 Z1] `'high'` — wartość wyglada jak liczba/–/— (dawna, jedyna
   * regula kroku 24). `'low'` — wartosc jest CZYMKOLWIEK INNYM, co samo NIE
   * wyglada na proze (nie jest zdaniem, nie jest zbyt dlugie) — poluzowane po
   * zmierzonym wprost braku: str. 57 "Modyfikator obrażeń" -> "+1K4" (notacja
   * kostek) w ogole nie byl proponowany w kroku 24, mimo ze brief TEGO kroku
   * wprost zadal odwrotnego kompromisu ("preferuj nadmiar propozycji nad ich
   * brakiem — falszywy pozytyw kosztuje jedno klikniecie, falszywy negatyw
   * kosztuje blad w profilu"). WYLACZNIE do wyswietlenia w UI (odznaczenie
   * dalej dziala identycznie dla obu poziomow) — nigdy do filtrowania.
   */
  confidence: LabelledPairConfidence;
}

/**
 * [Heurystyka z briefu kroku 24, POLUZOWANA w kroku 25 Z1] Etykieta: krotki
 * token z litera (bez zmian od kroku 24 — LABEL_MAX_LENGTH celowo hojny,
 * dluzszy niz najdluzsza realna etykieta zmierzona w projekcie, "Modyfikator
 * obrażeń", 20 znakow). Wartosc: brief kroku 24 mowil "liczba albo –/—" —
 * zmierzone wprost jako ZA WASKIE (str. 57, `scratch-z1-verify.ts` z kroku
 * 24): "Modyfikator obrażeń" -> "+1K4" nie jest liczba, wiec caly ten wiersz
 * bloku pochodnych nigdy nie trafial na checkliste. Ten krok (brief, dosłownie:
 * "wzorzec wartosci to cokolwiek, co samo NIE wyglada na etykiete") zastepuje
 * to dwustopniowa akceptacja: `'high'` dla starego, scislego wzorca
 * liczbowego, `'low'` dla WSZYSTKIEGO INNEGO co nie jest prozą (nie konczy sie
 * kropka/wykrzyknikiem/pytajnikiem — ten sam sygnal "to nie jest pojedyncza
 * wartosc, to zdanie" co `entityName.ts`'s filtr kandydatow na nazwe — i nie
 * jest za dlugie). Fałszywy pozytyw kosztuje jedno odznaczenie (checkbox
 * dziala identycznie dla obu poziomow pewnosci), fałszywy negatyw kosztowal
 * CALY pominiety wiersz — brief kroku 25 wprost woli pierwsze.
 */
const NUMERIC_OR_DASH_VALUE = /^[-–—]$|^[+-]?\d{1,4}([./]\d{1,4})?\*?$/;
const LABEL_MAX_LENGTH = 30;
const LABEL_HAS_LETTER = /\p{L}/u;
const VALUE_MAX_LENGTH = 40;
/**
 * [KROK-43, zmierzony na zywo blad, "Wielki Terror" str. 91 "Pancerz: Brak."]
 * Wykrzyknik/pytajnik na koncu to NADAL twardy sygnal prozy (statystyki
 * nigdy tak sie nie koncza) — ale sama KROPKA tez konczy krotkie,
 * jednoslowne odpowiedzi konwencjonalne w tej grze ("Brak." = "None.", ten
 * sam sens co "0"/"—"), nie tylko zdania. Pierwotna wersja (KROK-25 Z1)
 * odrzucala KAZDA kropke jako "to zdanie" — na tym PDF-ie odrzucala wiec
 * "Brak." dla Pancerza, silnik szukal dalej i podstawial NASTEPNA etykiete
 * ("Wyposażenie") jako wartosc. Rozroznienie: prawdziwe zdanie ma WIECEJ NIZ
 * `SHORT_ANSWER_MAX_WORDS` prawdziwych slow (liczonych jak wszedzie w tym
 * projekcie — patrz `MAX_TRAILING_WORDS` w `patterns.ts` — bo pdf.js czasem
 * laczy caly wiersz w jeden token), krotka odpowiedz nie.
 */
const HARD_SENTENCE_ENDING = /[!?]$/;
const SHORT_ANSWER_MAX_WORDS = 2;
// [KROK-34, zmierzony na zywo blad, "Wrak.pdf" str. 24 "Pancerz"] Token
// KONCZACY SIE dwukropkiem to (w tej i kazdej innej ksiazce zmierzonej w tym
// projekcie) etykieta NASTEPNEJ pary, nigdy prawdziwa wartosc — zmierzone
// wprost: gdy zaznaczenie autora nie objelo prawdziwej wartosci "Pancerz:"
// (dlugi, zawijany token "5, niezwykle gruba skóra...", odrzucony wyzej jako
// za dlugi na ETYKIETE w NASTEPNEJ iteracji), poluzowana klasyfikacja "low"
// (KROK-25 Z1, dla notacji typu "+1K4") przyjmowala kolejny token W ZAZNACZENIU
// — ktory akurat byl etykieta "Zaklęcia:" — jako "wartosc" dla "Pancerz:",
// pokazujac autorowi mylaca propozycje "Pancerz: → Zaklęcia:". Wykluczenie
// kosztuje jeden rzadki, prawdziwy przypadek (wartosc, ktora SAMA konczy sie
// dwukropkiem — nie zmierzony w zadnej ksiazce tego projektu), a naprawia
// znacznie czestszy: niekompletne zaznaczenie autora nigdy nie podstawia
// cudzej etykiety jako czyjejs wartosci.
const LOOKS_LIKE_LABEL = /:$/;

export function classifyValue(text: string): LabelledPairConfidence | null {
  if (text.length === 0) return null;
  if (NUMERIC_OR_DASH_VALUE.test(text)) return 'high';
  if (text.length > VALUE_MAX_LENGTH || HARD_SENTENCE_ENDING.test(text) || LOOKS_LIKE_LABEL.test(text)) return null;
  if (/\.$/.test(text)) {
    const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
    if (wordCount > SHORT_ANSWER_MAX_WORDS) return null;
  }
  return 'low';
}

/**
 * [KROK-42, zmierzony na zywo blad, "Zew Cthulhu... Noc Zagłady v.2.0" str.
 * 15] Ten sam mechanizm co `mergeDiacriticSplitTokens` w `tokenizePage.ts`
 * (CLAUDE.md: "getTextContent() merges adjacent glyphs into one TextItem
 * purely by position"), ale w PRZECIWNA strone: na tym PDF-ie (inny
 * generator/sklad niz "Wrak.pdf") siatka cech jest wydrukowana NA TYLE
 * ciasno ("S 40", bez dwukropka, bez szerokiej spacji miedzy etykieta a
 * wartoscia), ze WLASNE laczenie glifow pdf.js sklada etykiete i wartosc w
 * JEDEN TextItem, ZANIM cokolwiek w tym projekcie w ogole zobaczy token —
 * zmierzone wprost (spike, `getPageTextTokens` bez zadnej dalszej obrobki
 * juz zwraca `"S 40"` jako pojedynczy token). Caly silnik `labelledPairs`
 * (`matchLabelledPairs`, `inferLabelledPairsFromTokens`,
 * `findValueCandidatesNearLabel`) zaklada DWA oddzielne tokeny (etykieta,
 * wartosc) — bez rozdzielenia z powrotem dostaje 0 dopasowan na calym
 * dokumencie, mimo ze uklad WIZUALNIE wyglada identycznie jak dzialajacy
 * "Wrak.pdf".
 *
 * Rozdziela WYLACZNIE ksztalt "<krotkie-slowo><spacja><liczba lub
 * myslnik>", dopasowany do CALEGO tekstu tokenu (nie w srodku dluzszego
 * zdania — `$` na koncu wzorca) — ten sam ksztalt wartosci co
 * `NUMERIC_OR_DASH_VALUE` powyzej, zeby PRODUKCYJNY silnik i podglad w
 * Studio widzialy TEN SAM podzial (A10 — jeden mechanizm, nie dwie
 * rozjezdzajace sie kopie; wywolywane zarowno z `tokenizePage.ts`, jak i z
 * `ProfileStudio.ts`'s `#getBuildTokens`). Granica X miedzy polowkami jest
 * PRZYBLIZONA (proporcjonalnie do liczby znakow, nie do prawdziwej
 * geometrii glifow, ktorej `getTextContent()` nie ujawnia) — wystarczajaco
 * dokladna do klikniecia/podswietlenia, ten sam kompromis co przy
 * `descriptionText` w `patterns.ts` (KROK-34), gdzie tez nikt nie odtwarza
 * dokladnej geometrii podzielonego tokenu.
 */
const MERGED_LABEL_VALUE = /^(\p{L}[\p{L}]{0,11})\s+([-–—]|[+-]?\d{1,4}(?:[./]\d{1,4})?\*?)$/u;

export function splitMergedLabelValueTokens<T extends { text: string; bbox: Rect }>(tokens: readonly T[]): T[] {
  const out: T[] = [];
  for (const t of tokens) {
    const trimmed = t.text.trim();
    const m = MERGED_LABEL_VALUE.exec(trimmed);
    if (!m) {
      out.push(t);
      continue;
    }
    const labelText = m[1]!;
    const valueText = m[2]!;
    const frac = labelText.length / trimmed.length;
    const splitX = t.bbox.minX + (t.bbox.maxX - t.bbox.minX) * frac;
    out.push({ ...t, text: labelText, bbox: { ...t.bbox, maxX: splitX } });
    out.push({ ...t, text: valueText, bbox: { ...t.bbox, minX: splitX } });
  }
  return out;
}

/**
 * [KROK-43, zmierzony na zywo blad, "Wielki Terror" str. 91 "Pancerz"/"Wyposażenie"]
 * Gdy etykieta jest wytloczona INNYM krojem/pogrubieniem niz jej wartosc
 * (typowy zapis pogrubionych mini-etykiet w statblokach: "**Pancerz**:
 * Brak."), pdf.js czasem stawia granice miedzy dwoma TextItem TUZ PRZED
 * dwukropkiem zamiast PO nim — etykieta zostaje BEZ dwukropka ("Pancerz"), a
 * dwukropek (plus spacja) trafia na POCZATEK NASTEPNEGO tokenu (": Brak."),
 * zamiast na koniec etykiety jak zazwyczaj w tym projekcie (patrz
 * `LOOKS_LIKE_LABEL` wyzej, ktora sprawdza WYLACZNIE koniec etykiety, nie
 * poczatek wartosci). Zmierzone wprost: bez usuniecia tego dwukropka
 * "Brak." (z toczacym dwukropkiem+spacja) i tak zostaloby odrzucone jako
 * krotka odpowiedz, silnik szukalby dalej i podstawilby NASTEPNA etykiete
 * ("Wyposażenie") jako wartosc dla "Pancerz".
 *
 * Usuwa taki blakajacy sie dwukropek Z POCZATKU kazdego tokenu — globalnie,
 * w tej samej warstwie co `splitMergedLabelValueTokens` powyzej
 * (`tokenizePage.ts` I `ProfileStudio.ts`'s `#getBuildTokens`), zeby
 * produkcyjny silnik i podglad w Studio widzialy ten sam, oczyszczony
 * strumien (A10 — jeden mechanizm). Bezpieczne globalnie: prawdziwy tekst
 * (proza, naglowki, nazwy) w zadnej zmierzonej ksiazce tego projektu nie
 * zaczyna sie od dwukropka.
 */
const STRAY_LEADING_COLON = /^:\s*/;

export function stripStrayLeadingColonTokens<T extends { text: string }>(tokens: readonly T[]): T[] {
  const out: T[] = [];
  for (const t of tokens) {
    if (!t.text.startsWith(':')) {
      out.push(t);
      continue;
    }
    const stripped = t.text.replace(STRAY_LEADING_COLON, '');
    if (stripped.length === 0) continue;
    out.push({ ...t, text: stripped });
  }
  return out;
}

export function inferLabelledPairsFromTokens(tokens: readonly SelectionToken[]): LabelledPairSuggestion[] {
  const out: LabelledPairSuggestion[] = [];
  let i = 0;
  while (i < tokens.length - 1) {
    const label = tokens[i]!;
    const value = tokens[i + 1]!;
    const labelText = label.text.trim();
    const valueText = value.text.trim();
    if (labelText.length === 0 || labelText.length > LABEL_MAX_LENGTH || !LABEL_HAS_LETTER.test(labelText)) {
      i++;
      continue;
    }
    const confidence = classifyValue(valueText);
    if (!confidence) {
      i++;
      continue;
    }
    // [KROK-25 Z1, zmierzony wprost blad wlasnej poprawki] Poluzowana klasyfikacja
    // wartosci akceptuje PRAWIE KAZDY krotki token — w tym token WLASNIE
    // skonsumowany jako WARTOSC poprzedniej pary, jesli sam zawiera litere
    // (np. "+1K4" ma litere "K", wiec bez tego przeskoku sam staje sie
    // "etykieta" dla NASTEPNEGO tokenu, "Krzepa" -> falszywa para "+1K4" ->
    // "Krzepa"). Po dopasowaniu parry przeskakujemy OBA jej tokeny, zamiast
    // przesuwac sie o jeden — ten sam model "pary dziela strumien bez
    // zachodzenia" co petla wewnetrzna prawdziwego silnika (`matchLabelledPairs`).
    out.push({ label: labelText, value: valueText, index: i, bbox: label.bbox, confidence });
    i += 2;
  }
  return out;
}

export interface SectionListSuggestion {
  header: string;
  /** Pozostałe tokeny zaznaczenia (PO nagłówku) jako tekst do przejrzenia — WYŁĄCZNIE podgląd (brief: "nie generuj regexów dla itemPattern", struktura pozycji zbyt zmienna). */
  itemsPreview: string;
  headerBbox: Rect;
}

/** [Brief, dosłownie] "Dla sectionList — pierwszy token jako kandydat na nagłówek, reszta jako pozycje." `null` gdy zaznaczenie jest puste. */
export function inferSectionListFromTokens(tokens: readonly SelectionToken[]): SectionListSuggestion | null {
  if (tokens.length === 0) return null;
  const [first, ...rest] = tokens;
  return { header: first!.text.trim(), itemsPreview: rest.map((t) => t.text).join(' '), headerBbox: first!.bbox };
}

/**
 * [KROK-28 Z2] Budowanie pary etykieta-wartość PUNKTEM, nie zaznaczeniem
 * obszaru — kliknięcie etykiety w PDF-ie ma samo odczytać sąsiadującą
 * wartość. Wejście to WSZYSTKIE tokeny strony (nie już-przefiltrowane
 * zaznaczenie jak wyżej), z indeksem w strumieniu (do budowania linku
 * label→value i do `findTerminateTokenAtY` niżej).
 */
export interface IndexedSelectionToken extends SelectionToken {
  /** Indeks tokenu w PELNYM strumieniu strony (nie w przekazanej tablicy). */
  tokenIndex: number;
}

export interface ValueCandidate {
  text: string;
  bbox: Rect;
  tokenIndex: number;
  confidence: LabelledPairConfidence;
}

function verticalOverlap(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
}

function horizontalOverlap(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
}

/**
 * [KROK-28 Z2, "użyj gapStatistics, nie stałej"] `gapStatistics.ts` operuje
 * na SUROWYCH metrykach TextItem z pdf.js (transform/fontKey/width) — Profile
 * Studio celowo NIE ma do nich dostępu na tym etapie (`getPageTextTokens`,
 * KROK-23, świadomie LŻEJSZY niż pełna inwentaryzacja, żeby kliknięcie
 * pojedynczego tokenu nie kosztowało tyle co analiza całej strony). Zamiast
 * pełnej histogramowej klasyfikacji per-font, mediana obserwowanych odstępów
 * MIĘDZY SĄSIADUJĄCYMI TOKENAMI W TYM SAMYM WIERSZU na TEJ stronie —
 * WYWIEDZIONA z dokumentu, nie stała, ale policzalna z samych bboksów, które
 * już mamy. Stała `DEFAULT_ROW_GAP_PT` to WYŁĄCZNIE fallback, gdy strona nie
 * ma żadnej mierzalnej pary (np. jedna kolumna tekstu bez żadnych dwóch
 * tokenów obok siebie).
 */
const DEFAULT_ROW_GAP_PT = 20;
const MAX_MEASURABLE_GAP_PT = 200;

export function estimateTypicalRowGapPt(tokens: readonly SelectionToken[]): number {
  const gaps: number[] = [];
  const sorted = [...tokens].sort((a, b) => a.bbox.minY - b.bbox.minY || a.bbox.minX - b.bbox.minX);
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    if (verticalOverlap(a.bbox, b.bbox) <= 0) continue;
    const gap = b.bbox.minX - a.bbox.maxX;
    if (gap > 0 && gap < MAX_MEASURABLE_GAP_PT) gaps.push(gap);
  }
  if (gaps.length === 0) return DEFAULT_ROW_GAP_PT;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)]!;
}

const ROW_GAP_CUTOFF_MULTIPLIER = 4;
const MAX_VALUE_CANDIDATES = 3;

/**
 * Kandydaci na wartość PO kliknięciej etykiecie: najpierw ten sam wiersz, w
 * zasięgu `typicalRowGapPt * ROW_GAP_CUTOFF_MULTIPLIER` w prawo (brief:
 * "kandydat na prawo... w zasięgu odpowiadającym typowemu odstępowi") —
 * hojny mnożnik, bo fałszywy kandydat kosztuje jedno kliknięcie w inny
 * (A10), brak żadnego kosztuje cichą porażkę. Jeśli nic w wierszu, sprawdź
 * KOLUMNĘ pod spodem (układ pionowy). Zwraca do trzech kandydatów w
 * kolejności odległości — jeśli jest dokładnie jeden, wywołujący może go
 * zastosować automatycznie; więcej niż jeden = pokaż do kliknięcia, nie zgaduj.
 */
/**
 * [KROK-28, zmierzony na realnej stronie Quick-Startu blad wlasnej pierwszej
 * wersji] Bez tego progu: skoro `classifyValue` celowo akceptuje PRAWIE
 * KAZDY krotki token jako wartosc niskiej pewnosci (zeby nie odrzucac
 * notacji kosci/opisow — patrz `classifyValue` wyzej), skanowanie CALEGO
 * wiersza az do `cutoff` zwracalo takze NASTEPNA ETYKIETE jako "dodatkowego
 * kandydata" (np. klikniecie "STR" na str. 29 Quick-Startu dawalo ["35",
 * "CON", "55"] zamiast czystego ["35"]) — bo "CON" samo w sobie tez przechodzi
 * luzna klasyfikacje "cokolwiek, co nie jest proza". Naprawa: PIERWSZY
 * kwalifikujacy sie token ZAWSZE konczy skanowanie w tym kierunku; kolejny
 * dolacza jako PRAWDZIWY alternatywny kandydat WYLACZNIE jesli lezy niemal
 * tak samo blisko (w praktyce: dwie kolumny wartosci obok siebie), nie
 * "gdziekolwiek w zasiegu cutoff".
 */
const CLOSE_ENOUGH_DISTANCE_MULTIPLIER = 1.5;

export function findValueCandidatesNearLabel(tokens: readonly IndexedSelectionToken[], labelBbox: Rect, typicalRowGapPt: number): ValueCandidate[] {
  const cutoff = typicalRowGapPt * ROW_GAP_CUTOFF_MULTIPLIER;
  const takeCandidates = (list: readonly { token: IndexedSelectionToken; distance: number }[]): ValueCandidate[] => {
    const out: ValueCandidate[] = [];
    let firstDistance: number | null = null;
    for (const { token: t, distance } of list) {
      const confidence = classifyValue(t.text.trim());
      if (!confidence) continue;
      if (firstDistance !== null && distance > firstDistance * CLOSE_ENOUGH_DISTANCE_MULTIPLIER) break;
      firstDistance ??= distance;
      out.push({ text: t.text.trim(), bbox: t.bbox, tokenIndex: t.tokenIndex, confidence });
      if (out.length >= MAX_VALUE_CANDIDATES) break;
    }
    return out;
  };

  const sameRow = tokens
    .filter((t) => t.bbox.minX >= labelBbox.maxX && t.bbox.minX - labelBbox.maxX <= cutoff && verticalOverlap(t.bbox, labelBbox) > 0)
    .map((t) => ({ token: t, distance: t.bbox.minX - labelBbox.maxX }))
    .sort((a, b) => a.distance - b.distance);
  const rowCandidates = takeCandidates(sameRow);
  if (rowCandidates.length > 0) return rowCandidates;

  // [Zmierzony na zywo blad] `Rect` w tym module (i w calym `@bindery/core` —
  // patrz `entityAssembly.ts`'s `directionalDistance`: kandydat "ponizej" ma
  // MNIEJSZY `Y` niz kotwica) zyje w przestrzeni PDF, gdzie Y ROSNIE W GORE
  // strony, NIE w dol jak na ekranie. "Pod spodem" (kolumna) znaczy wiec
  // MNIEJSZY `maxY` niz `labelBbox.minY`, nie wiekszy — pierwsza wersja mylila
  // to z konwencja ekranu, co dawalo poprawne wyniki TYLKO dla wartosci w tym
  // samym wierszu (gdzie kierunek Y w ogole nie wchodzi w gre) i cichy
  // odwrocony blad dla ukladow kolumnowych (nigdy nie zmierzony na realnej
  // stronie, bo RAT PACK z Quick-Startu ma wszystkie wartosci w wierszach).
  const sameColumn = tokens
    .filter((t) => t.bbox.maxY <= labelBbox.minY && horizontalOverlap(t.bbox, labelBbox) > 0)
    .map((t) => ({ token: t, distance: labelBbox.minY - t.bbox.maxY }))
    .sort((a, b) => a.distance - b.distance);
  return takeCandidates(sameColumn);
}

export interface TerminateTokenCandidate {
  text: string;
  bbox: Rect;
  tokenIndex: number;
}

/**
 * [KROK-28 Z3, poprawiony zmierzony na zywo blad kierunku] Token, ktorego
 * `terminateSectionBefore` powinno uzyc, wywiedziony z GEOMETRII: najblizszy
 * token WYSTEPUJACY PO `afterTokenIndex` w strumieniu (naglowek sekcji), ktorego
 * gorna krawedz (`maxY`) lezy NA lub PONIZEJ `y` — w przestrzeni PDF (Y rosnie
 * w gore strony, patrz komentarz przy `findValueCandidatesNearLabel`'s
 * `sameColumn`) "ponizej" znaczy MNIEJSZY albo rowny `Y`, nie wiekszy.
 * Pierwsza wersja tej funkcji (i jej wlasne testy, pisane pod tym samym
 * blednym zalozeniem) uzywaly odwrotnego kierunku — zmierzone na zywo na str.
 * 23 "Zew Cthulhu 7ed. Wrak.pdf": obszar sekcji rysowal sie NAD klikniętym
 * naglowkiem zamiast pod nim. `null`, jesli nic nie lezy ponizej `y` (np.
 * uzytkownik przeciagnal krawedz do samego dolu strony) — sekcja konczy sie
 * na koncu strumienia, poprawna odpowiedz, nie blad.
 */
export function findTerminateTokenAtY(tokens: readonly IndexedSelectionToken[], afterTokenIndex: number, y: number): TerminateTokenCandidate | null {
  let best: IndexedSelectionToken | null = null;
  for (const t of tokens) {
    if (t.tokenIndex <= afterTokenIndex) continue;
    if (t.bbox.maxY > y) continue;
    if (!best || t.bbox.maxY > best.bbox.maxY || (t.bbox.maxY === best.bbox.maxY && t.tokenIndex < best.tokenIndex)) best = t;
  }
  if (!best) return null;
  return { text: best.text.trim(), bbox: best.bbox, tokenIndex: best.tokenIndex };
}

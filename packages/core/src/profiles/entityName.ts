import type { Rect } from '../geometry.js';
import type { ProfileToken } from './types.js';
import type { FontRoleCandidatePattern } from './schema.js';

/**
 * [KROK-18 Z3] Kandydaci na nazwe encji — implementacja wzorca
 * `fontRoleCandidate` z §5.5 MDD, uogolnia H2 ze spike'u kroku 13
 * (`collectNameCandidates`): krotki tekst o roli fontu innej niz wykluczone
 * (typowo != 'body'), z dwoma dodatkowymi filtrami odkrytymi w kroku 12 —
 * naglowki biegnace (ten sam tekst na wielu stronach) i kontynuacje wyrazow
 * przenoszonych dywizacja.
 *
 * [H2, krok 12] Sama rola fontu NIE wystarcza jako samodzielne rozstrzygniecie
 * (724 kandydatow na 106 stronach, "fatalna precyzja") — jest WEJSCIEM do
 * filtra geometrycznego (`entityAssembly.ts`), nie samodzielnym wynikiem.
 */

export interface FontRoleCandidateMatch {
  text: string;
  bbox: Rect;
  tokenIndex: number;
}

/**
 * Tekst+fontKey -> zbior numerow stron, na ktorych sie pojawia — do
 * `excludeRepeatedAcrossPages`. Wymaga `token.page`; bez niego (jedna strona
 * naraz) nic nie zostanie odrzucone (bezpieczny brak dzialania, nie falszywe
 * odrzucenie).
 *
 * [KROK-30 Z5, zmierzony na zywo blad] Klucz TYLKO po tekscie (bez fontKey)
 * fałszywie odrzucał wlasna nazwe encji, gdy ten sam ciag znakow pojawia sie
 * GDZIE INDZIEJ w ksiazce z INNEJ przyczyny — zmierzone wprost: "Sciapod"
 * (str. 24 "Zew Cthulhu 7ed. Wrak.pdf") to zarowno naglowek statbloku
 * (`Cambria-Bold@11`, gora strony), JAK I osobna, prawdziwa biegnaca stopka
 * (`ACaslonPro-Italic@8.5`, dol strony, str. 23+24) ORAZ zwykle pogrubione
 * wystapienia w prozie gdzie indziej w ksiazce (`ACaslonPro-Bold@9`, str.
 * 6+14, np. indeks/odnosniki) — RAZEM 4 odrebne strony, ponad prog 3, mimo ze
 * ZADNE POJEDYNCZE zrodlo (ten sam font) nie powtarza sie tyle razy. Prawdziwy
 * naglowek/stopka biegnaca z DEFINICJI utrzymuje SPOJNY styl przy kazdym
 * powtorzeniu (na tym polega bycie "biegnacym") — klucz PO PARZE
 * (tekst, fontKey) rozroznia te przypadki, zachowujac wykrywanie prawdziwych
 * naglowkow biegnacych (ten sam tekst, ten sam font, na wielu stronach) bez
 * fałszywego odrzucania nazwy encji, ktora przypadkiem dzieli SAM TEKST z
 * czyms innym o INNYM foncie gdzie indziej.
 */
function countDistinctPagesPerText(tokens: readonly ProfileToken[]): Map<string, Map<string | undefined, Set<number>>> {
  const byText = new Map<string, Map<string | undefined, Set<number>>>();
  for (const t of tokens) {
    if (t.page === undefined) continue;
    const byFontKey = byText.get(t.text) ?? new Map<string | undefined, Set<number>>();
    const pages = byFontKey.get(t.fontKey) ?? new Set<number>();
    pages.add(t.page);
    byFontKey.set(t.fontKey, pages);
    byText.set(t.text, byFontKey);
  }
  return byText;
}

const RUNNING_HEADER_MIN_DISTINCT_PAGES = 3;

export function matchFontRoleCandidate(tokens: readonly ProfileToken[], pattern: FontRoleCandidatePattern): FontRoleCandidateMatch[] {
  const excludeRoles = new Set(pattern.excludeRoles);
  const pageCountByText = pattern.excludeRepeatedAcrossPages ? countDistinctPagesPerText(tokens) : null;
  // [KROK-29 Z3] Puste `requireFontKeys` (domyslne, wsteczna zgodnosc) = brak
  // dodatkowego filtra, zachowanie identyczne jak przed KROK-29.
  const requiredFontKeys = pattern.requireFontKeys.length > 0 ? new Set(pattern.requireFontKeys) : null;

  const out: FontRoleCandidateMatch[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (!tok.text || tok.text.length === 0 || tok.text.length > pattern.maxLength) continue;
    // [KROK-18 Z7, naprawa zgloszonego przez pomiar bledu] `fontRole ===
    // 'unknown'` (rola FAKTYCZNIE obliczona, ale bez wystarczajacej liczby
    // wystapien w `buildInventory` zeby pewnie zaklasyfikowac) NIE jest tym
    // samym co "rola inna niz body" — to brak sygnalu, nie sygnal pozytywny.
    // Zmierzone wprost: rzadki wariant fontu ("ACaslonPro-Regular@9.5" —
    // wystepujacy tylko w krotkich zdaniach objasniajacych typu "Prawa i lewa
    // reka sa osobnymi istotami...") dostawal `unknown`, nie `body`, wiec
    // domyslny `excludeRoles: ['body']` z profilu (§5.5 MDD) go przepuszczal.
    // Traktuj `unknown` identycznie jak brak roli w ogole.
    if (!tok.fontRole || tok.fontRole === 'unknown' || excludeRoles.has(tok.fontRole)) continue;
    if (requiredFontKeys && (!tok.fontKey || !requiredFontKeys.has(tok.fontKey))) continue;
    // [KROK-18 Z7, naprawa zgloszonego przez pomiar bledu] Zmierzone na realnej
    // ksiazce: zdanie objasniajace bezposrednio po naglowku czesci ciala
    // ("Prawa i lewa reka sa osobnymi istotami, ktore maja te same
    // statystyki.", str. 56) mieszczlo sie pod `maxLength` I mialo role fontu
    // != 'body' (whoski/kursywa wstepu do opisu), wiec przeszlo jako "pewna"
    // nazwa zamiast placeholdera — dokladnie przypadek, przed ktorym S4 mialo
    // chronic. Zadna prawdziwa nazwa w zmierzonej probce nie konczy sie
    // kropka/wykrzyknikiem/pytajnikiem — prozaiczne zdania niemal zawsze tak.
    if (/[.!?]$/.test(tok.text.trim())) continue;

    if (pattern.excludeHyphenContinuations) {
      const isHyphenItself = /^[-–]$/.test(tok.text);
      if (isHyphenItself) continue;
      const prevWasHyphen = i > 0 && /^[-–]$/.test(tokens[i - 1]!.text);
      if (prevWasHyphen) continue;
    }

    if (pageCountByText) {
      const pages = pageCountByText.get(tok.text)?.get(tok.fontKey);
      if (pages && pages.size >= RUNNING_HEADER_MIN_DISTINCT_PAGES) continue;
    }

    // [KROK-20 Z2, zmierzony na zywo blad] Nazwa bywa jednym tokenem razem z
    // naslepujacym przecinkiem, gdy zaraz po niej w zdaniu idzie opis roli
    // ("Jacob Beaker, doker" -> token "Jacob Beaker,") — pdf.js laczy je,
    // bo dzielą ten sam font/rozmiar co reszta frazy. Przecinek nie jest
    // czescia nazwy w zadnym zmierzonym przypadku; obcinany z KONCA tekstu
    // kandydata, nie z calego tokenu (odrzucenie calego tokenu zgubiloby
    // prawdziwa nazwe).
    const text = tok.text.replace(/,+$/, '');
    if (!text) continue;

    out.push({ text, bbox: tok.bbox, tokenIndex: i });
  }
  return out;
}

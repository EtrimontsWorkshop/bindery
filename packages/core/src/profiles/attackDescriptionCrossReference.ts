import type { SectionListMatch } from './patterns.js';
import type { ProfileToken } from './types.js';

/**
 * [KROK-33 Z4, zgloszenie uzytkownika: "Nazwy ataków powinny być sprawdzane
 * poniżej i jak zostanie znalezione, to tekst powinien trafić do notatek."]
 * Opisy atakow w podrecznikach CoC bywaja rozwiniete POZA sama pozycja na
 * liscie ATAKI — w prozie POD statblokiem, wprowadzone WLASNYM podnaglowkiem
 * stylu akcentowego (`fontRole: 'accent'`, ten sam styl co etykiety
 * "Ataki:"/"MO:"), np. "Chwyt i miażdżenie (manewr): chwytna stopa
 * potwora może złapać ofiarę..." (str. 24 "Wrak.pdf", Sciapod). Ta tresc
 * dzis nigdzie nie trafia — dokladnie to, czego szuka uzytkownik, gdy pole
 * na karcie okazuje sie zbyt lakoniczne (A3).
 *
 * [zmierzony na zywo przypadek roznicy dopiskow] Nazwa na liscie ATAKI i
 * podnaglowek ponizej NIE musza miec identycznego dopisku w nawiasie —
 * "Kryształowy łuk" (bez dopisku na liscie) ma ponizej podnaglowek
 * "Kryształowy łuk (atak dystansowy):" (WLASNY, INNY dopisek). Dopasowanie
 * po nazwie bez JEJ WLASNEGO dopisku (jesli taki ma) jako PREFIKSIE
 * podnaglowka, nie po pelnej rownosci stringow.
 */

/** "Chwyt i miażdżenie (manewr)" -> "Chwyt i miażdżenie" — usuwa WLASNY koncowy dopisek w nawiasie nazwy ataku, jesli taki ma. */
function stripTrailingParenthetical(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/** Czy `headingText` zaczyna sie od `name` jako CALE slowo (nie fragment) — dopuszcza koniec dokladnie na `name`, spacje albo nawias zaraz po. */
function startsWithWholeName(headingText: string, name: string): boolean {
  if (headingText === name) return true;
  if (!headingText.startsWith(name)) return false;
  const nextChar = headingText[name.length];
  return nextChar === ' ' || nextChar === '(';
}

/**
 * [Zmierzony na zywo blad, prawdziwy eksport Actora "Sciapod" z Foundry —
 * "krysz- tałowego łuku", "scia- poda", "potwo- ra" w opisie trafiajacym do
 * notatek] Laczy teksty tokenow spacja jak zwykle, ALE samodzielny token
 * "-"/"–" (zlamanie wiersza w PDF-ie w srodku slowa — ten sam token, ktory
 * `matchSectionList`'s `rejoinHyphenated` rozpoznaje, patrz `patterns.ts`)
 * jest USUWANY, a spacja WOKOL niego pominieta, zamiast dolaczony jako
 * osobne, dyndajace slowo. W odroznieniu od `matchSectionList` nie ma tu
 * WLASNEJ flagi profilu — ta funkcja produkuje WOLNY TEKST notatek, nie
 * podlega dalszemu dopasowaniu regexowemu (brak potrzeby mapowania znak->token
 * jak w `matchSectionList`), wiec nie ma scenariusza, w ktorym autor profilu
 * chcialby ZACHOWAC dzielony wyraz w opisie.
 *
 * [ZGŁOSZENIE na zywo, "zaintere- sowany"] Powyzszy ksztalt (samodzielny
 * token "-") to JEDEN ze sposobow, w jaki pdf.js oddaje zlamanie wiersza w
 * srodku slowa — zmierzone na TEJ SAMEJ ksiazce ("Wrak.pdf"), inne miejsce
 * (str. 30, opis znajomego): dywiz bywa PRZYKLEJONY do konca poprzedniego
 * tokenu ("...zaintere-"), a kontynuacja slowa to NASTEPNY token BEZ wlasnej
 * spacji na poczatku ("sowany..."). Rozpoznawane po literze BEZPOSREDNIO
 * przed koncowym dywizem (`\p{L}[-–]$`) — odroznia to od dywizu po cyfrze/
 * interpunkcji (np. zakres "20-30" nigdy nie konczy sie na literze), gdzie
 * scalanie bez spacji bylabyloby bledne.
 */
export function joinRejoiningLineBreakHyphens(texts: readonly string[]): string {
  let result = '';
  let pendingHyphen = false;
  for (const text of texts) {
    if (/^[-–]$/.test(text)) {
      if (result.length > 0) pendingHyphen = true;
      continue;
    }
    const glued = /^(.*\p{L})[-–]$/u.exec(text);
    if (glued) {
      const prefix = result.length === 0 || pendingHyphen ? '' : ' ';
      result += prefix + glued[1];
      pendingHyphen = true;
      continue;
    }
    const prefix = result.length === 0 || pendingHyphen ? '' : ' ';
    result += prefix + text;
    pendingHyphen = false;
  }
  return result;
}

/**
 * Dla kazdej pozycji w `attacks.items`, szuka w tokenach PO ostatniej
 * dopasowanej pozycji (do `attacks.endIndex` — ta sama granica sekcji, ktora
 * juz respektuje `terminateSectionBefore`/granice innych encji, patrz
 * `matchSectionList`) podnaglowka (`fontRole: 'accent'`) zaczynajacego sie od
 * PELNEJ nazwy tego ataku. Gdy znaleziony, zwraca tekst NASTEPUJACYCH po nim
 * tokenow (do kolejnego podnaglowka albo konca zasiegu) jako "opis
 * rozwiniety" — jeden akapit na atak (A10: dopasowanie calej nazwy, nie
 * fragmentu — "Unik" nie zlapie przypadkowego wystapienia w srodku innego
 * slowa). Zwraca `null` na pozycjach, dla ktorych nic nie znaleziono — brak
 * czegokolwiek do znalezienia to poprawny wynik (A7), nie blad.
 */
export interface AttackDescriptionScan {
  /** Rownolegle do `attacks.items` — patrz `findAttackDescriptionsBelow`. */
  texts: (string | null)[];
  /**
   * [KROK-34 Z2] Zakresy tokenow FAKTYCZNIE skonsumowane jako opis JAKIEGOS
   * ataku (podnaglowek + jego tresc, `[start, end)`) — do wykorzystania przez
   * `proseBlock` (notatki wskazywane geometrycznie), zeby NIE zaproponowac
   * TEJ SAMEJ tresci jeszcze raz jako osobnej notatki (brief kroku 34, "Relacja
   * do Z4 z kroku 33": "sprawdz tylko, czy oba mechanizmy nie dublują tej
   * samej treści... i jeśli tak — odfiltruj"). Podnaglowki, ktore NIE
   * dopasowaly zadnej nazwy ataku (np. "Niewidzialność:" na str. 24 "Wrak.pdf"
   * — to NIE jest atak) sa CELOWO pominiete tutaj — ich tresc zostaje
   * dostepna dla `proseBlock`, ktory istnieje WLASNIE po to, zeby ja przechwycic.
   */
  claimedRanges: { start: number; end: number }[];
}

/**
 * Wspolny skan uzywany PRZEZ `findAttackDescriptionsBelow` (tresc) I
 * `proseBlock` z kroku 34 (zakresy do wykluczenia z dedup) — jedno zrodlo
 * prawdy, zeby oba nigdy nie rozjechaly sie w tym, co uznaja za "juz opisane".
 *
 * [KROK-34 Z2, zmierzony na zywo blad, "Wrak.pdf" str. 24] `attacks.endIndex`
 * to granica BUFORA POZYCJI (`terminateSectionBefore`/`matchSectionList`),
 * NIE granica, do ktorej wolno szukac opisow PONIZEJ listy — na realnym
 * profilu `terminateSectionBefore` bywa ustawione WLASNIE NA podnaglowku
 * pierwszego opisu ("Chwyt i miażdżenie (manewr):", zeby lista pozycji NIE
 * zlapala go jako bledna 5. pozycje), co przypadkiem obcina `endIndex`
 * DOKLADNIE tam, gdzie ten skan mial zaczac szukac — `searchStart >=
 * searchEnd` i CALA funkcja Z4 milczy, mimo ze opisy naprawde tam sa.
 * `hardStopTokenIndices` (ta sama granica encji co `matchSectionList` sam
 * dostaje) daje PRAWDZIWA gorna granice, niezalezna od tego, gdzie
 * `terminateSectionBefore` akurat przecina bufor pozycji.
 */
function scanAttackDescriptions(tokens: readonly ProfileToken[], attacks: SectionListMatch, hardStopTokenIndices?: readonly number[]): AttackDescriptionScan {
  const texts: (string | null)[] = attacks.items.map(() => null);
  const claimedRanges: { start: number; end: number }[] = [];
  if (attacks.items.length === 0) return { texts, claimedRanges };

  const searchStart = Math.max(...attacks.items.map((item) => item.endTokenIndex)) + 1;
  // `hardStopTokenIndices` NIEPODANE WCALE (nie: puste []) -> DOKLADNIE stare
  // zachowanie (`searchEnd = attacks.endIndex`), zeby wywolania sprzed tego
  // pola (i ich testy) nie zauwazyly zadnej zmiany.
  const nextHardStop = hardStopTokenIndices ? (hardStopTokenIndices.filter((h) => h > attacks.headerTokenIndex).sort((a, b) => a - b)[0] ?? tokens.length) : undefined;
  const searchEnd = nextHardStop !== undefined ? Math.max(attacks.endIndex, nextHardStop) : attacks.endIndex;
  if (searchStart >= searchEnd) return { texts, claimedRanges };

  // Nazwy najdluzsze najpierw — zeby dluzsza nazwa nie zostala przypadkiem
  // "zjedzona" przez dopasowanie krotszej nazwy bedacej jej prefiksem.
  const candidates = attacks.items
    .map((item, itemIndex) => ({ itemIndex, name: stripTrailingParenthetical(item.groups['name'] ?? '') }))
    .filter((c) => c.name.length > 0)
    .sort((a, b) => b.name.length - a.name.length);

  const claimedItemIndices = new Set<number>();
  let i = searchStart;
  while (i < searchEnd) {
    const tok = tokens[i]!;
    if (tok.fontRole === 'accent') {
      const headingText = tok.text.replace(/:\s*$/, '').trim();
      const match = candidates.find((c) => !claimedItemIndices.has(c.itemIndex) && startsWithWholeName(headingText, c.name));
      let j = i + 1;
      if (match) {
        const parts: string[] = [];
        while (j < searchEnd && tokens[j]!.fontRole !== 'accent') {
          parts.push(tokens[j]!.text);
          j++;
        }
        if (parts.length > 0) {
          texts[match.itemIndex] = joinRejoiningLineBreakHyphens(parts);
          claimedItemIndices.add(match.itemIndex);
          claimedRanges.push({ start: i, end: j });
        }
      }
      i = j;
      continue;
    }
    i++;
  }
  return { texts, claimedRanges };
}

export function findAttackDescriptionsBelow(tokens: readonly ProfileToken[], attacks: SectionListMatch, hardStopTokenIndices?: readonly number[]): (string | null)[] {
  return scanAttackDescriptions(tokens, attacks, hardStopTokenIndices).texts;
}

/** [KROK-34 Z2] Patrz `AttackDescriptionScan.claimedRanges`. */
export function findAttackDescriptionClaimedRanges(tokens: readonly ProfileToken[], attacks: SectionListMatch, hardStopTokenIndices?: readonly number[]): { start: number; end: number }[] {
  return scanAttackDescriptions(tokens, attacks, hardStopTokenIndices).claimedRanges;
}

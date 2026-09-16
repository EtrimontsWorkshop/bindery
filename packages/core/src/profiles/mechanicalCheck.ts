import type { EntityAnalysis } from './studioAnalysis.js';

/**
 * [KROK-24 Z3, "jedyna funkcja łapiąca cichą korupcję mapowań" per brief] W
 * kroku 19 klucz `P` byl zmapowany na `hitPoints`, a okazal sie
 * `sanity` (Poczytalnoscia) — zaden test tego nie lapal, bo wartosci
 * wygladaly wiarygodnie (liczby w sensownym zakresie). Wykryla to dopiero
 * relacja `PW ≈ (KON+BC)/10` sprawdzona recznie na 27 statblokach. Ten plik
 * automatyzuje DOKLADNIE ten pomysl: autor profilu, ktory zna wzory swojego
 * systemu na pamiec, wpisuje relacje miedzy kluczami kanonicznymi, silnik
 * sprawdza je na WSZYSTKICH znalezionych encjach i pokazuje rozbieznosci Z
 * KONKRETNYMI WARTOSCIAMI, nie sam procent zgodnosci.
 *
 * [Brief, dosłownie] "Nie buduj jezyka wyrazen — dwa operatory, cztery
 * dzialania, odwolania do kluczy kanonicznych." Skladnia relacji: `klucz ≈
 * wyrazenie` albo `klucz = wyrazenie`, wyrazenie to `+ - * /` i nawiasy nad
 * kluczami kanonicznymi i liczbami. Zaden inny operator/funkcja.
 */

export interface EntityCanonicalValues {
  /** Etykieta do wyswietlenia w rozbieznosci (nazwa encji albo placeholder) — CZYTELNA, nie surowy `ordinal`. */
  label: string;
  values: Readonly<Record<string, number>>;
}

/** Pierwsza liczba (calkowita albo dziesietna, opcjonalnie ujemna) znaleziona w tekscie wartosci z PDF-a — "12/12" -> 12, "+1K4" -> 1, "–" -> brak (null). Notacja kostek (K4/K6) jest CELOWO poza zakresem (ten sam brief co inferencja z zaznaczenia — "nie probuj byc madrzejszy"). */
function parseNumericValue(raw: string): number | null {
  const m = /-?\d+(?:\.\d+)?/.exec(raw);
  return m ? Number(m[0]) : null;
}

/** [KROK-24 Z3] Wyciaga wartosci liczbowe kluczy kanonicznych z JUZ POLICZONEJ analizy encji (`grid.pairs` + `derived.match.pairs`, siatka cech i blok pochodnych — jedyne dwa miejsca `labelledPairs`, gdzie `canonicalKey` w ogole istnieje). Wartosci nie-liczbowe (myslniki, notacja kostek) sa POMIJANE — relacja odwolujaca sie do takiego klucza zwyczajnie nie da sie policzyc na tej encji (patrz `totalChecked` w wyniku), nie liczy sie jako "0" ani jako blad. */
export function extractCanonicalValues(entity: EntityAnalysis): EntityCanonicalValues {
  const values: Record<string, number> = {};
  for (const p of entity.grid.pairs) {
    const n = parseNumericValue(p.value);
    if (n !== null) values[p.canonicalKey] = n;
  }
  if (entity.derived.match) {
    for (const p of entity.derived.match.pairs) {
      const n = parseNumericValue(p.value);
      if (n !== null) values[p.canonicalKey] = n;
    }
  }
  const label = entity.name.kind === 'confident' ? entity.name.text : entity.name.placeholder;
  return { label, values };
}

export type RelationOperator = '≈' | '=';

export interface ParsedRelation {
  lhsKey: string;
  op: RelationOperator;
  rhsExpr: string;
}

const RELATION_RE = /^\s*([A-Za-z][A-Za-z0-9]*)\s*(≈|=)\s*(.+?)\s*$/u;

/** `null` gdy tekst nie pasuje do skladni `klucz ≈ wyrazenie` / `klucz = wyrazenie` w ogole (np. brak operatora). */
export function parseRelation(text: string): ParsedRelation | null {
  const m = RELATION_RE.exec(text);
  if (!m) return null;
  return { lhsKey: m[1]!, op: m[2] as RelationOperator, rhsExpr: m[3]! };
}

const EXPR_TOKEN_RE = /[A-Za-z][A-Za-z0-9]*|\d+(?:\.\d+)?|[()+\-*/]/g;

/**
 * Ewaluuje wyrazenie arytmetyczne (`+ - * /`, nawiasy, klucze kanoniczne,
 * liczby) nad `values`. `null` przy bledzie skladni ALBO nieznanym/brakujacym
 * kluczu (odrozniane od "0" — brakujaca wartosc NIE jest zerem) ALBO
 * dzieleniu przez zero.
 */
export function evaluateExpression(expr: string, values: Readonly<Record<string, number>>): number | null {
  const tokens = expr.match(EXPR_TOKEN_RE);
  if (!tokens || tokens.join('').length !== expr.replace(/\s+/g, '').length) return null; // znak spoza dozwolonego alfabetu gdzies w wyrazeniu
  let pos = 0;
  const peek = (): string | undefined => tokens[pos];
  const consume = (): string => tokens[pos++]!;

  function parseFactor(): number | null {
    const t = peek();
    if (t === undefined) return null;
    if (t === '(') {
      consume();
      const v = parseExpr();
      if (v === null || peek() !== ')') return null;
      consume();
      return v;
    }
    if (t === '-') {
      consume();
      const v = parseFactor();
      return v === null ? null : -v;
    }
    if (/^\d/.test(t)) {
      consume();
      return Number(t);
    }
    if (/^[A-Za-z]/.test(t)) {
      consume();
      return t in values ? values[t]! : null;
    }
    return null;
  }

  function parseTerm(): number | null {
    let v = parseFactor();
    if (v === null) return null;
    while (peek() === '*' || peek() === '/') {
      const op = consume();
      const rhs = parseFactor();
      if (rhs === null) return null;
      if (op === '*') v = v * rhs;
      else {
        if (rhs === 0) return null;
        v = v / rhs;
      }
    }
    return v;
  }

  function parseExpr(): number | null {
    let v = parseTerm();
    if (v === null) return null;
    while (peek() === '+' || peek() === '-') {
      const op = consume();
      const rhs = parseTerm();
      if (rhs === null) return null;
      v = op === '+' ? v + rhs : v - rhs;
    }
    return v;
  }

  const result = parseExpr();
  if (pos !== tokens.length) return null; // tokeny pozostale po sparsowaniu calego wyrazenia = blad skladni (np. dwa wyrazenia obok siebie)
  return result;
}

/** Tolerancja zaokraglenia dla `≈` — WIEKSZA z {1, 5% oczekiwanej wartosci}, zeby pochlonac zaokraglenie dzielenia (np. `(KON+BC)/10`) bez ukrywania prawdziwych rozbieznosci przy duzych wartosciach. Nieskalibrowana na zadnym konkretnym systemie (zaden nie byl dostepny do pomiaru w tym kroku) — udokumentowana i latwa do zmiany, nie zaszyta bez wyjasnienia (ten sam standard co `AMBIGUITY_RATIO_THRESHOLD` w `entityAssembly.ts`). */
function withinApproxTolerance(actual: number, expected: number): boolean {
  const tolerance = Math.max(1, Math.abs(expected) * 0.05);
  return Math.abs(actual - expected) <= tolerance;
}

export interface RelationMismatch {
  label: string;
  actual: number;
  expected: number;
}

export interface RelationCheckOk {
  text: string;
  ok: true;
  lhsKey: string;
  op: RelationOperator;
  /** Liczba encji, na ktorych OBIE strony (lhsKey i wyrazenie) dalo sie policzyc — mianownik zgodnosci. */
  totalChecked: number;
  matchCount: number;
  /** Rozbieznosci Z KONKRETNYMI WARTOSCIAMI (brief: "nie sam procent") — WSZYSTKIE, nie tylko przyklad. */
  mismatches: readonly RelationMismatch[];
  /** [Brief] "ostrzezenie, gdy zgodnosc jest bardzo niska (prawdopodobnie zle mapowanie) albo idealna dla relacji rownosci (prawdopodobnie to samo pole zmapowane dwa razy)". */
  warning: 'low-match-rate' | 'suspiciously-perfect-equality' | null;
}

export interface RelationCheckError {
  text: string;
  ok: false;
  /** Kod bledu, nie gotowy tekst — lokalizacja jest po stronie UI (`packages/module`), ten pakiet nie ma i18n (A1). */
  errorCode: 'unparseable';
}

export type RelationCheckResult = RelationCheckOk | RelationCheckError;

// [KROK-24 Z3, skalibrowane na prawdziwej ksiazce] Poprawna relacja
// (`hitPoints ≈ (constitution+size)/10` z ORYGINALNYM, poprawnym mapowaniem)
// dala 13/14 = 93% zgodnosci na `coc7-niczas-pl`. Symulacja bledu A11 ("P"
// zmapowane na `hitPoints` zamiast `sanity`) dala 8/14 = 57%. Prog 0.5 (polowa)
// byl ZA NISKI -- 57% mieściloby się jako "wystarczajaco dobre" i blad
// przeszedlby CICHO, dokladnie tak jak w prawdziwym incydencie z kroku 19.
// 0.7 poprawnie rozdziela oba zmierzone przypadki.
const LOW_MATCH_RATE_THRESHOLD = 0.7;
const LOW_MATCH_MIN_SAMPLE = 2;
const PERFECT_EQUALITY_MIN_SAMPLE = 2;

/** Sprawdza JEDNA relacje na WSZYSTKICH dostarczonych encjach. Nigdy nie rzuca — zla skladnia/nieznany klucz daje czytelny `ok: false`, nie wyjatek (ten sam standard co `validateProfile`). */
export function checkRelation(text: string, entities: readonly EntityCanonicalValues[]): RelationCheckResult {
  const parsed = parseRelation(text);
  if (!parsed) return { text, ok: false, errorCode: 'unparseable' };

  const mismatches: RelationMismatch[] = [];
  let totalChecked = 0;
  let matchCount = 0;

  for (const entity of entities) {
    const actual = parsed.lhsKey in entity.values ? entity.values[parsed.lhsKey]! : null;
    const expected = evaluateExpression(parsed.rhsExpr, entity.values);
    if (actual === null || expected === null) continue;
    totalChecked++;
    const matches = parsed.op === '≈' ? withinApproxTolerance(actual, expected) : actual === expected;
    if (matches) matchCount++;
    else mismatches.push({ label: entity.label, actual, expected });
  }

  let warning: RelationCheckOk['warning'] = null;
  if (totalChecked >= LOW_MATCH_MIN_SAMPLE && matchCount / totalChecked < LOW_MATCH_RATE_THRESHOLD) {
    warning = 'low-match-rate';
  } else if (parsed.op === '=' && totalChecked >= PERFECT_EQUALITY_MIN_SAMPLE && matchCount === totalChecked) {
    warning = 'suspiciously-perfect-equality';
  }

  return { text, ok: true, lhsKey: parsed.lhsKey, op: parsed.op, totalChecked, matchCount, mismatches, warning };
}

/** Sprawdza WIELE relacji naraz (jeden wiersz formularza na relacje) — czysta wygoda wywolania, `checkRelation` per wiersz. */
export function checkRelations(texts: readonly string[], entities: readonly EntityCanonicalValues[]): RelationCheckResult[] {
  return texts.map((text) => checkRelation(text, entities));
}

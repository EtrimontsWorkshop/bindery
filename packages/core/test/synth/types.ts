/** Zakres liczbowy — obie granice opcjonalne, przynajmniej jedna wymagana w praktyce. */
export interface ClaimRange {
  min?: number;
  max?: number;
}

export type ClaimValue = number | ClaimRange | string[] | boolean;

/**
 * Warstwa 1 (samokontrola) — wlasciwosci fixture'a weryfikowane uruchomieniem
 * przez pdf.js. Klucze odpowiadaja metrykom liczonym w verifyClaims.ts.
 */
export interface FixtureClaims {
  pageCount?: number;
  /** Odsetek niepustych itemow o str.length < 3. */
  fragmentationRatio?: ClaimRange;
  /** Odsetek itemow z transform[1]!==0 || transform[2]!==0, liczony na WSZYSTKICH itemach. */
  rotatedItemRatio?: ClaimRange;
  /** Liczba itemow str === "" (przed odfiltrowaniem). */
  emptyItemCount?: number | ClaimRange;
  /** Wszystkie itemy tekstowe (puste + niepuste). */
  totalItemCount?: number | ClaimRange;
  /** Itemy niepuste zlozone wylacznie z bialych znakow (np. pojedyncza spacja). */
  whitespaceOnlyItemCount?: number | ClaimRange;
  /** Itemy z niepustym str. */
  nonEmptyItemCount?: number | ClaimRange;
  /** Pewnosc jakosci unicode z detektora fazy 1 (src/quality.ts), 0-1. */
  unicodeConfidence?: ClaimRange;
  /** Pary itemow o identycznym str i identycznej macierzy transform. */
  exactPositionalDuplicateCount?: number | ClaimRange;
  /** Pary itemow o identycznym str, macierz przesunieta o < 1pt. */
  nearPositionalDuplicateCount?: number | ClaimRange;
  /** Liczba operacji obrazowych z getOperatorList(), suma po wszystkich stronach. */
  imageCount?: number | ClaimRange;
  /** Minimalna liczba obrazow na KAZDEJ stronie (nie suma) — do fixture'ow "N obrazow na strone". */
  minImagesPerPage?: number;
  combiningCharCount?: number | ClaimRange;
  ligatureCount?: number | ClaimRange;
  puaCharCount?: number | ClaimRange;
  /** Oczekiwany zbior nazw (commonObjs.get(x).name) uzytych fontow — porownanie jako zbior. */
  distinctFontKeys?: string[];
  /** Czy w operator liscie wystapil beginGroup z smask.subtype === "Luminosity". */
  hasLuminosityGroup?: boolean;
  /** Liczba stron z zerowa liczba glifow (proxy skanu). */
  zeroGlyphPageCount?: number;
  /** Czy jakikolwiek obraz wychodzi poza MediaBox (spad drukarski). */
  hasBleedingImage?: boolean;
  /** Czy na ktorejs stronie dwa rozne obrazy maja pokrywajace sie bboxy. */
  hasOverlappingImages?: boolean;
}

export interface FixtureGroundTruth {
  id: string;
  description: string;
  targetPhase: number;
  claims: FixtureClaims;
  /** Ground truth dla fazy 2 — celowo niekonsumowane teraz, tylko przechowywane. */
  expected?: unknown;
}

export interface Fixture {
  id: string;
  build(): Buffer;
  groundTruth: FixtureGroundTruth;
}

/**
 * Rejestr fontow i ranking rol (MDD §5.1, F0-Q1, R-16, KROK-4 Z2).
 *
 * Fundament: fonty osadzone NIE MAJA flag bold/italic i sufiksy wag roznia sie
 * miedzy odlewniami w nieograniczony sposob (Autobahn, DwarvenAxeBB, -SC700...).
 * Dlatego `key` to zawsze nieprzezroczysty klucz (BaseFont po zdjeciu prefiksu
 * subsetu + rozmiar), a ROLA wynika z rankingu czestosci/rozmiaru w calym
 * dokumencie — NIGDY z parsowania sufiksu. `display` istnieje wylacznie do
 * prezentacji w UI/Profile Studio i nie moze wplywac na `key` ani `role`.
 */

export interface FontEntry {
  /** Klucz nosny: BaseFont po zdjeciu prefiksu subsetu + zaokraglony rozmiar. */
  key: string;
  baseFont: string;
  subsetPrefix: string | null;
  size: number;
  glyphCount: number;
  itemCount: number;
  pages: Set<number>;
  /** Wylacznie do prezentacji. Nigdy jako warunek w regule. */
  display?: { family: string; weightSuffix?: string; italic?: boolean };
}

export type FontRole = 'body' | 'heading' | 'caption' | 'accent' | 'unknown';

const SUBSET_PREFIX_RE = /^([A-Z]{6})\+(.+)$/;

/** Zdejmuje prefiks subsetu (6 wielkich liter + "+") z /BaseFont, jesli obecny. */
export function stripSubsetPrefix(baseFont: string): { prefix: string | null; name: string } {
  const m = SUBSET_PREFIX_RE.exec(baseFont);
  if (m) return { prefix: m[1]!, name: m[2]! };
  return { prefix: null, name: baseFont };
}

// Slownik sufiksow wag/stylow — WYLACZNIE kosmetyka do `display`. Nieznany sufiks
// nie jest bledem: rodzina staje sie cala nazwa, weightSuffix/italic zostaja undefined.
const STYLE_SUFFIXES: Array<{ re: RegExp; weightSuffix?: string; italic?: boolean }> = [
  { re: /-?(SemiboldItalic|SemiBoldItalic|SemiboldIt|SemiBoldIt)$/i, weightSuffix: 'SemiBold', italic: true },
  { re: /-?(ExtraBoldItalic|ExtraBoldIt)$/i, weightSuffix: 'ExtraBold', italic: true },
  { re: /-?(BoldItalic|BoldIt|BoldOblique)$/i, weightSuffix: 'Bold', italic: true },
  { re: /-?(BlackItalic|BlackIt)$/i, weightSuffix: 'Black', italic: true },
  { re: /-?(LightItalic|LightIt)$/i, weightSuffix: 'Light', italic: true },
  { re: /-?(Italic|It|Oblique)$/i, italic: true },
  { re: /-?(ExtraBold|UltraBold)$/i, weightSuffix: 'ExtraBold' },
  { re: /-?(SemiBold|Semibold|DemiBold)$/i, weightSuffix: 'SemiBold' },
  { re: /-?(ExtraLight|UltraLight)$/i, weightSuffix: 'ExtraLight' },
  { re: /-?(Black|Heavy)$/i, weightSuffix: 'Black' },
  { re: /-?(Bold)$/i, weightSuffix: 'Bold' },
  { re: /-?(Medium)$/i, weightSuffix: 'Medium' },
  { re: /-?(Light)$/i, weightSuffix: 'Light' },
  { re: /-?(Thin)$/i, weightSuffix: 'Thin' },
  { re: /-?(Book)$/i, weightSuffix: 'Book' },
  { re: /-?(Regular|Roman|Normal)$/i, weightSuffix: 'Regular' },
];

/** Parsuje sufiks wagi/stylu z nazwy fontu — WYLACZNIE do `display`, nigdy do `key`. */
export function parseDisplaySuffix(name: string): { family: string; weightSuffix?: string; italic?: boolean } {
  for (const { re, weightSuffix, italic } of STYLE_SUFFIXES) {
    const m = re.exec(name);
    if (m) {
      const family = name.slice(0, m.index).replace(/-$/, '');
      const result: { family: string; weightSuffix?: string; italic?: boolean } = { family: family || name };
      if (weightSuffix) result.weightSuffix = weightSuffix;
      if (italic) result.italic = true;
      return result;
    }
  }
  return { family: name };
}

/** Buduje klucz nosny: nazwa (po zdjeciu prefiksu) + rozmiar zaokraglony do 0.5pt. */
export function buildFontKey(baseFont: string, size: number): string {
  const { name } = stripSubsetPrefix(baseFont);
  const roundedSize = Math.round(size * 2) / 2;
  return `${name}@${roundedSize}`;
}

/**
 * Rozwiazuje `TextItem.fontName` (id pdf.js) na klucz nosny fontu przez
 * `page.commonObjs` — ten sam mechanizm co `inventory.ts` (wypelnione juz przez
 * `getOperatorList()`/`getTextContent()`, bez renderu, F0-Q1). Wspoldzielone
 * miedzy inwentaryzacja (krok 4) a warstwa tekstu (krok 5), zeby oba modul
 * uzywaly IDENTYCZNEGO klucza dla tego samego fontu.
 */
export function resolveFontKey(
  fontName: string | undefined,
  commonObjs: { has(id: string): boolean; get(id: string): unknown },
  size: number,
): string | null {
  if (!fontName || !commonObjs.has(fontName)) return null;
  const fontObj = commonObjs.get(fontName) as { name?: string } | undefined;
  const baseFont = fontObj?.name;
  if (!baseFont) return null;
  return buildFontKey(baseFont, size);
}

/**
 * Ranking rol per dokument z czestosci/rozmiaru — NIE z parsowania nazw (MDD F0-Q1).
 * Heurystyka wyjsciowa z KROK-4 (do kalibracji na fixture'ach, nie dogmat):
 * - `body`   — klucz o najwiekszym udziale w lacznej liczbie glifow
 * - `heading`— udzial < 5% i rozmiar > 1.2x rozmiaru body
 * - `caption`— udzial < 10% i rozmiar < 0.9x rozmiaru body
 * - `accent` — udzial < 5%, rozmiar zblizony do body (0.9x-1.2x)
 * - `unknown`— reszta
 */
export function rankFontRoles(entries: readonly FontEntry[]): Map<string, FontRole> {
  const roles = new Map<string, FontRole>();
  if (entries.length === 0) return roles;

  const totalGlyphs = entries.reduce((sum, e) => sum + e.glyphCount, 0);
  if (totalGlyphs === 0) {
    for (const e of entries) roles.set(e.key, 'unknown');
    return roles;
  }

  const body = entries.reduce((max, e) => (e.glyphCount > max.glyphCount ? e : max), entries[0]!);
  const bodySize = body.size || 1;

  for (const e of entries) {
    if (e.key === body.key) {
      roles.set(e.key, 'body');
      continue;
    }
    const share = e.glyphCount / totalGlyphs;
    const sizeRatio = e.size / bodySize;

    if (share < 0.05 && sizeRatio > 1.2) {
      roles.set(e.key, 'heading');
    } else if (share < 0.1 && sizeRatio < 0.9) {
      roles.set(e.key, 'caption');
    } else if (share < 0.05 && sizeRatio >= 0.9 && sizeRatio <= 1.2) {
      roles.set(e.key, 'accent');
    } else {
      roles.set(e.key, 'unknown');
    }
  }

  return roles;
}

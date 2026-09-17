/**
 * Font registry and role ranking (MDD §5.1, F0-Q1, R-16, Step 4 Z2).
 *
 * Foundation: embedded fonts DO NOT HAVE bold/italic flags, and weight
 * suffixes vary between foundries in unbounded ways (Autobahn, DwarvenAxeBB,
 * -SC700...). That's why `key` is always an opaque key (BaseFont with the
 * subset prefix stripped + size), and the ROLE comes from a
 * frequency/size ranking across the whole document — NEVER from parsing the
 * suffix. `display` exists solely for presentation in the UI/Profile Studio
 * and must never influence `key` or `role`.
 */

export interface FontEntry {
  /** The carrier key: BaseFont with the subset prefix stripped + rounded size. */
  key: string;
  baseFont: string;
  subsetPrefix: string | null;
  size: number;
  glyphCount: number;
  itemCount: number;
  pages: Set<number>;
  /** For presentation only. Never used as a condition in a rule. */
  display?: { family: string; weightSuffix?: string; italic?: boolean };
}

export type FontRole = 'body' | 'heading' | 'caption' | 'accent' | 'unknown';

const SUBSET_PREFIX_RE = /^([A-Z]{6})\+(.+)$/;

/** Strips the subset prefix (6 uppercase letters + "+") from /BaseFont, if present. */
export function stripSubsetPrefix(baseFont: string): { prefix: string | null; name: string } {
  const m = SUBSET_PREFIX_RE.exec(baseFont);
  if (m) return { prefix: m[1]!, name: m[2]! };
  return { prefix: null, name: baseFont };
}

// Dictionary of weight/style suffixes — SOLELY cosmetic, for `display`. An unknown
// suffix is not an error: the family becomes the whole name, weightSuffix/italic stay undefined.
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

/** Parses a weight/style suffix from a font name — SOLELY for `display`, never for `key`. */
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

/** Builds the carrier key: name (prefix stripped) + size rounded to 0.5pt. */
export function buildFontKey(baseFont: string, size: number): string {
  const { name } = stripSubsetPrefix(baseFont);
  const roundedSize = Math.round(size * 2) / 2;
  return `${name}@${roundedSize}`;
}

/**
 * Resolves `TextItem.fontName` (a pdf.js id) to a carrier font key via
 * `page.commonObjs` — the same mechanism as `inventory.ts` (already
 * populated by `getOperatorList()`/`getTextContent()`, no render needed,
 * F0-Q1). Shared between inventory building (step 4) and the text layer
 * (step 5), so both modules use an IDENTICAL key for the same font.
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
 * Per-document role ranking from frequency/size — NOT from name parsing (MDD F0-Q1).
 * Starting heuristic from Step 4 (to be calibrated on fixtures, not dogma):
 * - `body`   — the key with the largest share of total glyph count
 * - `heading`— share < 5% and size > 1.2x the body size
 * - `caption`— share < 10% and size < 0.9x the body size
 * - `accent` — share < 5%, size close to body (0.9x-1.2x)
 * - `unknown`— everything else
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

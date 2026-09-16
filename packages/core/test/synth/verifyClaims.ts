import type { ClaimRange, FixtureClaims } from './types.js';
import { computeMetrics, type ComputedMetrics } from './metrics.js';
import { fixtures } from './index.js';

export interface VerifyResult {
  id: string;
  passed: boolean;
  failures: string[];
  computed: ComputedMetrics;
}

function checkRangeOrExact(name: string, actual: number, claim: number | ClaimRange): string | null {
  if (typeof claim === 'number') {
    return actual === claim ? null : `${name}: oczekiwano dokladnie ${claim}, otrzymano ${actual}`;
  }
  if (claim.min !== undefined && actual < claim.min) {
    return `${name}: ${actual} ponizej min ${claim.min}`;
  }
  if (claim.max !== undefined && actual > claim.max) {
    return `${name}: ${actual} powyzej max ${claim.max}`;
  }
  return null;
}

/** Porownuje policzone metryki z deklarowanymi claims. Zwraca liste czytelnych niezgodnosci (pusta = sukces). */
export function checkClaims(claims: FixtureClaims, computed: ComputedMetrics): string[] {
  const failures: string[] = [];
  const push = (f: string | null) => {
    if (f) failures.push(f);
  };

  if (claims.pageCount !== undefined) {
    push(checkRangeOrExact('pageCount', computed.pageCount, claims.pageCount));
  }
  if (claims.fragmentationRatio !== undefined) {
    push(checkRangeOrExact('fragmentationRatio', computed.fragmentationRatio, claims.fragmentationRatio));
  }
  if (claims.rotatedItemRatio !== undefined) {
    push(checkRangeOrExact('rotatedItemRatio', computed.rotatedItemRatio, claims.rotatedItemRatio));
  }
  if (claims.emptyItemCount !== undefined) {
    push(checkRangeOrExact('emptyItemCount', computed.emptyItemCount, claims.emptyItemCount));
  }
  if (claims.totalItemCount !== undefined) {
    push(checkRangeOrExact('totalItemCount', computed.totalItemCount, claims.totalItemCount));
  }
  if (claims.whitespaceOnlyItemCount !== undefined) {
    push(checkRangeOrExact('whitespaceOnlyItemCount', computed.whitespaceOnlyItemCount, claims.whitespaceOnlyItemCount));
  }
  if (claims.nonEmptyItemCount !== undefined) {
    push(checkRangeOrExact('nonEmptyItemCount', computed.nonEmptyItemCount, claims.nonEmptyItemCount));
  }
  if (claims.unicodeConfidence !== undefined) {
    push(checkRangeOrExact('unicodeConfidence', computed.unicodeConfidence, claims.unicodeConfidence));
  }
  if (claims.exactPositionalDuplicateCount !== undefined) {
    push(
      checkRangeOrExact(
        'exactPositionalDuplicateCount',
        computed.exactPositionalDuplicateCount,
        claims.exactPositionalDuplicateCount,
      ),
    );
  }
  if (claims.nearPositionalDuplicateCount !== undefined) {
    push(
      checkRangeOrExact(
        'nearPositionalDuplicateCount',
        computed.nearPositionalDuplicateCount,
        claims.nearPositionalDuplicateCount,
      ),
    );
  }
  if (claims.imageCount !== undefined) {
    push(checkRangeOrExact('imageCount', computed.imageCount, claims.imageCount));
  }
  if (claims.minImagesPerPage !== undefined) {
    const worst = Math.min(...computed.imageCountPerPage);
    if (worst < claims.minImagesPerPage) {
      failures.push(
        `minImagesPerPage: strona z najmniejsza liczba obrazow ma ${worst}, oczekiwano >= ${claims.minImagesPerPage} (per-page: ${computed.imageCountPerPage.join(',')})`,
      );
    }
  }
  if (claims.combiningCharCount !== undefined) {
    push(checkRangeOrExact('combiningCharCount', computed.signals.combiningMarks, claims.combiningCharCount));
  }
  if (claims.ligatureCount !== undefined) {
    push(checkRangeOrExact('ligatureCount', computed.signals.ligatures, claims.ligatureCount));
  }
  if (claims.puaCharCount !== undefined) {
    push(checkRangeOrExact('puaCharCount', computed.signals.privateUse, claims.puaCharCount));
  }
  if (claims.zeroGlyphPageCount !== undefined) {
    push(checkRangeOrExact('zeroGlyphPageCount', computed.zeroGlyphPageCount, claims.zeroGlyphPageCount));
  }
  if (claims.distinctFontKeys !== undefined) {
    const expected = [...claims.distinctFontKeys].sort();
    const actual = computed.distinctFontKeys;
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      failures.push(
        `distinctFontKeys: oczekiwano ${JSON.stringify(expected)}, otrzymano ${JSON.stringify(actual)}`,
      );
    }
  }
  if (claims.hasLuminosityGroup !== undefined) {
    if (computed.hasLuminosityGroup !== claims.hasLuminosityGroup) {
      failures.push(
        `hasLuminosityGroup: oczekiwano ${claims.hasLuminosityGroup}, otrzymano ${computed.hasLuminosityGroup}`,
      );
    }
  }
  if (claims.hasBleedingImage !== undefined) {
    if (computed.hasBleedingImage !== claims.hasBleedingImage) {
      failures.push(`hasBleedingImage: oczekiwano ${claims.hasBleedingImage}, otrzymano ${computed.hasBleedingImage}`);
    }
  }
  if (claims.hasOverlappingImages !== undefined) {
    if (computed.hasOverlappingImages !== claims.hasOverlappingImages) {
      failures.push(
        `hasOverlappingImages: oczekiwano ${claims.hasOverlappingImages}, otrzymano ${computed.hasOverlappingImages}`,
      );
    }
  }

  return failures;
}

export async function verifyAll(): Promise<VerifyResult[]> {
  const results: VerifyResult[] = [];
  for (const fixture of fixtures) {
    const buf = fixture.build();
    const computed = await computeMetrics(buf);
    const failures = checkClaims(fixture.groundTruth.claims, computed);
    results.push({ id: fixture.id, passed: failures.length === 0, failures, computed });
  }
  return results;
}

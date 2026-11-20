/**
 * The logos of a book's credits page: the marks of publishers, patrons and partners, set in a row or a cluster on one
 * of the first pages. They are small pictures with nothing against them (no mask, no repeat, no text over them), so
 * they were offered one by one. Measured on twenty books with every picture labelled: four credits pages gave 22 of
 * the 86 pictures nobody wanted, and no picture that was wanted looks like them.
 *
 * What tells them from a page of small portraits at the front of a book: logos are cut out (round badges, lettering
 * on a transparent ground), portraits are whole rectangles.
 */

/** A credits page is one of the first pages of the book ... */
export const CREDIT_LOGOS_MAX_PAGE = 6;
/** ... with this many small pictures offered at least ... */
export const CREDIT_LOGOS_MIN_COUNT = 5;
/** ... each of this share of the page at most (the logos measured 0.3-2.4%) ... */
export const CREDIT_LOGO_MAX_PAGE_SHARE = 0.03;
/** ... half of them or more being cut out: opaque over less than this share of their box. */
export const CREDIT_LOGO_CUT_OUT_MAX_OPAQUE_FRACTION = 0.97;
export const CREDIT_LOGOS_MIN_CUT_OUT_SHARE = 0.5;

export interface SmallPictureOnPage {
  page: number;
  /** The picture's share of its page (0-1). */
  pageShare: number;
  /** The share of the picture that is not transparent, when measured. */
  opaqueFraction: number | undefined;
}

/** Indices (into `pictures`) of the pictures that are the logos of a credits page. Give it the offered pictures only. */
export function findCreditLogos(pictures: readonly SmallPictureOnPage[]): Set<number> {
  const byPage = new Map<number, number[]>();
  pictures.forEach((p, i) => {
    if (p.page > CREDIT_LOGOS_MAX_PAGE || p.pageShare > CREDIT_LOGO_MAX_PAGE_SHARE) return;
    byPage.set(p.page, [...(byPage.get(p.page) ?? []), i]);
  });
  const logos = new Set<number>();
  for (const indices of byPage.values()) {
    if (indices.length < CREDIT_LOGOS_MIN_COUNT) continue;
    const cutOut = indices.filter((i) => (pictures[i]!.opaqueFraction ?? 1) < CREDIT_LOGO_CUT_OUT_MAX_OPAQUE_FRACTION).length;
    if (cutOut >= CREDIT_LOGOS_MIN_CUT_OUT_SHARE * indices.length) for (const i of indices) logos.add(i);
  }
  return logos;
}

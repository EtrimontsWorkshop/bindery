import { describe, expect, it } from 'vitest';
import { findCreditLogos } from '../../src/images/creditLogos.js';

const logo = (page: number, opaqueFraction: number | undefined = 0.6, pageShare = 0.01) => ({ page, pageShare, opaqueFraction });

describe('findCreditLogos', () => {
  it('takes the small cut-out pictures of one of the first pages when there are five of them', () => {
    const pictures = [logo(2), logo(2, 0.5), logo(2, 1), logo(2, 0.7), logo(2, 1), logo(40)];
    expect([...findCreditLogos(pictures)]).toEqual([0, 1, 2, 3, 4]);
  });

  it('leaves a page of small portraits (whole rectangles) alone', () => {
    expect(findCreditLogos([logo(3, 1), logo(3, 1), logo(3, 1), logo(3, 1), logo(3, 1)]).size).toBe(0);
  });

  it('leaves four logos alone, and logos further into the book', () => {
    expect(findCreditLogos([logo(2), logo(2), logo(2), logo(2)]).size).toBe(0);
    expect(findCreditLogos([logo(7), logo(7), logo(7), logo(7), logo(7)]).size).toBe(0);
  });

  it('does not count a larger picture of the page, and takes an unmeasured picture for a whole one', () => {
    const pictures = [logo(2), logo(2), logo(2), logo(2), logo(2, 0.6, 0.2)];
    expect(findCreditLogos(pictures).size).toBe(0);
    const unmeasured = { page: 2, pageShare: 0.01, opaqueFraction: undefined };
    expect(findCreditLogos([unmeasured, unmeasured, unmeasured, logo(2), logo(2)]).size).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { isHeadingBannerText } from '../../src/images/buildImageExtraction.js';

describe('isHeadingBannerText', () => {
  it('is true when much of the plate is under text and all of that text is headings (the title of a chapter on a band)', () => {
    expect(isHeadingBannerText(0.48, 0.48)).toBe(true);
    expect(isHeadingBannerText(0.54, 0.5)).toBe(true);
  });

  it('is false for a box of text that has a heading among its paragraphs, and for a plate with little text on it', () => {
    expect(isHeadingBannerText(0.54, 0.05)).toBe(false);
    expect(isHeadingBannerText(0.2, 0.2)).toBe(false);
    expect(isHeadingBannerText(0, 0)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { isBlankSheet } from '../../src/images/blankSheet.js';

describe('isBlankSheet', () => {
  const tableOver = { textOverPicture: true, pageShare: 0.1 };

  it('a flat white raster under page text is a table', () => {
    expect(isBlankSheet({ meanLuminance: 247, luminanceStdDev: 2.5, meanSaturation: 5 }, tableOver)).toBe(true);
  });

  it('a flat dark raster under page text is a table too', () => {
    expect(isBlankSheet({ meanLuminance: 35, luminanceStdDev: 0.9, meanSaturation: 10 }, tableOver)).toBe(true);
  });

  it('the flat rule needs the text to lie over the picture: a solid fill under a mask is not judged', () => {
    expect(isBlankSheet({ meanLuminance: 46, luminanceStdDev: 0, meanSaturation: 9 }, { textOverPicture: false, pageShare: 0.1 })).toBe(false);
    expect(isBlankSheet({ meanLuminance: 255, luminanceStdDev: 0, meanSaturation: 0 }, { textOverPicture: false, pageShare: 0.15 })).toBe(false);
  });

  it('a textured or coloured note is not a table', () => {
    expect(isBlankSheet({ meanLuminance: 192, luminanceStdDev: 42, meanSaturation: 102 }, tableOver)).toBe(false);
    expect(isBlankSheet({ meanLuminance: 234.8, luminanceStdDev: 9, meanSaturation: 0 }, tableOver)).toBe(false);
  });

  it('a page-sized light, lightly tinted raster is a form, a smaller one or a darker page is not', () => {
    const form = { meanLuminance: 238, luminanceStdDev: 10.6, meanSaturation: 15 };
    expect(isBlankSheet(form, { textOverPicture: false, pageShare: 0.69 })).toBe(true);
    expect(isBlankSheet(form, { textOverPicture: false, pageShare: 0.2 })).toBe(false);
    expect(isBlankSheet({ meanLuminance: 227, luminanceStdDev: 12.4, meanSaturation: 16 }, { textOverPicture: false, pageShare: 0.66 })).toBe(false);
  });
});

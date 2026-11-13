import { describe, expect, it } from 'vitest';
import { isCoverText, isDocumentPaper, isWrittenPaper } from '../../src/images/buildImageExtraction.js';

describe('isDocumentPaper', () => {
  it('a smooth sheet of tinted paper is the paper of a document', () => {
    expect(isDocumentPaper({ meanLuminance: 187, luminanceStdDev: 10, meanSaturation: 57 })).toBe(true);
  });

  it('a white sheet (a page with its design drawn on white) is not', () => {
    expect(isDocumentPaper({ meanLuminance: 254, luminanceStdDev: 6, meanSaturation: 0 })).toBe(false);
  });

  it('a dark page or a page of art is not', () => {
    expect(isDocumentPaper({ meanLuminance: 40, luminanceStdDev: 12, meanSaturation: 30 })).toBe(false);
    expect(isDocumentPaper({ meanLuminance: 150, luminanceStdDev: 55, meanSaturation: 60 })).toBe(false);
  });
});

describe('isWrittenPaper', () => {
  it('a light, tinted sheet, a little stained or creased, is a sheet to write on', () => {
    expect(isWrittenPaper({ meanLuminance: 229, luminanceStdDev: 14, meanSaturation: 20 })).toBe(true);
    expect(isWrittenPaper({ meanLuminance: 222, luminanceStdDev: 35, meanSaturation: 14 })).toBe(true);
    expect(isWrittenPaper({ meanLuminance: 237, luminanceStdDev: 28, meanSaturation: 8 })).toBe(true);
  });

  it('a white page, a dark one or a busy picture is not', () => {
    expect(isWrittenPaper({ meanLuminance: 254, luminanceStdDev: 6, meanSaturation: 0 })).toBe(false);
    expect(isWrittenPaper({ meanLuminance: 60, luminanceStdDev: 20, meanSaturation: 30 })).toBe(false);
    expect(isWrittenPaper({ meanLuminance: 150, luminanceStdDev: 60, meanSaturation: 40 })).toBe(false);
  });

  it('a sheet the page covers with its words may be more stained (a stack of sheets with its edges showing)', () => {
    const stack = { meanLuminance: 220, luminanceStdDev: 52, meanSaturation: 10 };
    expect(isWrittenPaper(stack)).toBe(false);
    expect(isWrittenPaper(stack, 0.6)).toBe(true);
  });
});

describe('isCoverText', () => {
  /** `count` text items of `chars` characters each, their letters `height` pt tall. */
  const words = (count: number, chars: number, height: number) => Array.from({ length: count }, (_, i) => ({ minX: 10, minY: i * 40, maxX: 10 + chars * height * 0.6, maxY: i * 40 + height, chars }));

  it('takes a few lines of display text for the text of a cover', () => {
    expect(isCoverText(words(17, 18, 30))).toBe(true);
    expect(isCoverText(words(24, 12, 20))).toBe(true);
    expect(isCoverText(words(20, 24, 15))).toBe(false); // a chapter opener: its title and a list of contents
    expect(isCoverText(words(10, 30, 24))).toBe(true);
  });

  it('does not take a page of body text, a watermark or a title alone for one', () => {
    expect(isCoverText(words(120, 40, 9))).toBe(false);
    expect(isCoverText(words(1, 34, 6))).toBe(false);
    expect(isCoverText(words(2, 20, 40))).toBe(false);
    expect(isCoverText(words(60, 30, 24))).toBe(false);
    expect(isCoverText(undefined)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { isPhotoUnderNotes } from '../../src/images/buildImageExtraction.js';

describe('isPhotoUnderNotes', () => {
  it('is true for a dark, textured raster with the text over its edges (a photo with notes pinned on it)', () => {
    expect(isPhotoUnderNotes({ meanLuminance: 74, luminanceStdDev: 29 }, 0.31)).toBe(true);
    expect(isPhotoUnderNotes({ meanLuminance: 45, luminanceStdDev: 15 }, 0.43)).toBe(true);
    // a map with its labels laid over it by the page
    expect(isPhotoUnderNotes({ meanLuminance: 139, luminanceStdDev: 30 }, 0.3)).toBe(true);
  });

  it('is false for light paper, for a flat or lightly textured backdrop, and when the text is over the middle', () => {
    expect(isPhotoUnderNotes({ meanLuminance: 221, luminanceStdDev: 20 }, 0.3)).toBe(false);
    expect(isPhotoUnderNotes({ meanLuminance: 198, luminanceStdDev: 16 }, 0.3)).toBe(false);
    expect(isPhotoUnderNotes({ meanLuminance: 42, luminanceStdDev: 5 }, 0.3)).toBe(false);
    expect(isPhotoUnderNotes({ meanLuminance: 84, luminanceStdDev: 14 }, 0.84)).toBe(false);
  });

  it('is false when the raster could not be read', () => {
    expect(isPhotoUnderNotes(null, 0.2)).toBe(false);
  });
});

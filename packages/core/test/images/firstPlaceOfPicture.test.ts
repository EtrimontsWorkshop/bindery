import { describe, expect, it } from 'vitest';
import { firstPlaceOfPicture } from '../../src/images/buildImageExtraction.js';

describe('firstPlaceOfPicture', () => {
  it('is the box itself for a picture painted once', () => {
    expect(firstPlaceOfPicture([{ minX: 10, minY: 20, maxX: 110, maxY: 80 }])).toEqual({ minX: 10, minY: 20, maxX: 110, maxY: 80 });
  });

  it('keeps only the first place of a picture painted twice far apart (a scoreboard at the top and at the foot)', () => {
    const top = { minX: 10, minY: 600, maxX: 500, maxY: 700 };
    const foot = { minX: 10, minY: 20, maxX: 500, maxY: 120 };
    expect(firstPlaceOfPicture([top, foot])).toEqual(top);
  });

  it('unites copies that lie on or against the first (a shadow, a copy turned the other way)', () => {
    const picture = { minX: 100, minY: 100, maxX: 300, maxY: 300 };
    const shadow = { minX: 104, minY: 96, maxX: 304, maxY: 296 };
    const far = { minX: 400, minY: 400, maxX: 450, maxY: 450 };
    expect(firstPlaceOfPicture([picture, shadow, far])).toEqual({ minX: 100, minY: 96, maxX: 304, maxY: 300 });
  });
});

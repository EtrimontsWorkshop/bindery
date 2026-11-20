import { describe, expect, it } from 'vitest';
import { standUpSidewaysDocument } from '../../src/images/readingTurn.js';

/** A 3x2 picture whose pixels carry their own index in the red channel, to tell which way it was turned. */
const picture = { width: 3, height: 2, rgba: new Uint8ClampedArray([0, 1, 2, 3, 4, 5].flatMap((n) => [n, 0, 0, 255])) };
const reds = (image: { rgba: Uint8ClampedArray }): number[] => [...image.rgba].filter((_, i) => i % 4 === 0);

describe('standUpSidewaysDocument', () => {
  it('leaves a picture that reads as it is', () => {
    expect(standUpSidewaysDocument(picture, 1, () => true)).toBeNull();
  });

  it('leaves a picture that reads neither way', () => {
    expect(standUpSidewaysDocument(picture, 3, () => false)).toBeNull();
  });

  it('turns back by the quarter the page applied, when the picture reads only then', () => {
    const readsWhenPortrait = (image: { width: number; height: number }): boolean => image.height > image.width;
    // Placed a quarter turn clockwise: turned back counterclockwise (three quarters clockwise).
    const fromClockwise = standUpSidewaysDocument(picture, 1, readsWhenPortrait);
    expect(fromClockwise && [fromClockwise.width, fromClockwise.height]).toEqual([2, 3]);
    expect(reds(fromClockwise!)).toEqual([2, 5, 1, 4, 0, 3]);
    // Placed three quarters clockwise: turned back by one.
    const fromCounterclockwise = standUpSidewaysDocument(picture, 3, readsWhenPortrait);
    expect(reds(fromCounterclockwise!)).toEqual([3, 0, 4, 1, 5, 2]);
  });

  it('turns back a document that reads either way by its rows, when its lettering runs up and down as the page shows it', () => {
    const readsEitherWay = (): boolean => true;
    // As the page shows it the lettering runs up and down (the picture is 3 wide, 2 tall here): turned back.
    const lettering = (image: { width: number; height: number }): boolean => image.width > image.height;
    expect(reds(standUpSidewaysDocument(picture, 3, readsEitherWay, lettering)!)).toEqual([3, 0, 4, 1, 5, 2]);
    // Its lettering runs across: left as the page shows it.
    expect(standUpSidewaysDocument(picture, 3, readsEitherWay, () => false)).toBeNull();
    // Without a judge of lettering, as before.
    expect(standUpSidewaysDocument(picture, 1, readsEitherWay)).toBeNull();
  });
});

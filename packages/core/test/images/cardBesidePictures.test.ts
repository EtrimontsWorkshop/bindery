import { describe, expect, it } from 'vitest';
import { cardOfPiece, cardWithoutPictures } from '../../src/images/cardBesidePictures.js';

const box = (minX: number, minY: number, maxX: number, maxY: number) => ({ minX, minY, maxX, maxY });

describe('cardWithoutPictures', () => {
  it('cuts away a picture that spans the card and lies over its top (a photo pinned to a note)', () => {
    expect(cardWithoutPictures(box(45, 10, 545, 761), [box(34, 398, 564, 759)])).toEqual(box(45, 10, 545, 398));
  });

  it('cuts away a picture wider than the card that covers only a part of its width range', () => {
    expect(cardWithoutPictures(box(298, 76, 557, 739), [box(43, 415, 559, 757)])).toEqual(box(298, 76, 557, 415));
  });

  it('cuts away a picture that lies over the bottom of the card', () => {
    expect(cardWithoutPictures(box(0, 0, 100, 400), [box(-5, -3, 105, 150)])).toEqual(box(0, 150, 100, 400));
  });

  it('leaves the card alone when the picture is narrower than it, lies in its middle, or barely touches it', () => {
    const card = box(0, 0, 100, 400);
    expect(cardWithoutPictures(card, [box(10, 200, 90, 400)])).toEqual(card);
    expect(cardWithoutPictures(card, [box(0, 150, 100, 250)])).toEqual(card);
    expect(cardWithoutPictures(card, [box(0, 380, 100, 420)])).toEqual(card);
  });

  it('leaves the card alone when too little of it would remain', () => {
    const card = box(0, 0, 100, 400);
    expect(cardWithoutPictures(card, [box(0, 50, 100, 400)])).toEqual(card);
  });
});

describe('cardOfPiece', () => {
  it('grows an offered piece of a note to the whole note that holds it', () => {
    expect(cardOfPiece(box(83, 417, 225, 653), [box(84, 413, 317, 695)])).toEqual(box(84, 413, 317, 695));
  });

  it('takes the smallest box that holds the piece, and ignores a box that is much bigger, no bigger, or does not hold it', () => {
    const piece = box(100, 100, 200, 300);
    expect(cardOfPiece(piece, [box(90, 90, 260, 340), box(95, 95, 215, 320)])).toEqual(box(95, 95, 215, 320));
    expect(cardOfPiece(piece, [box(0, 0, 600, 790)])).toEqual(piece);
    expect(cardOfPiece(piece, [box(100, 100, 200, 300)])).toEqual(piece);
    expect(cardOfPiece(piece, [box(300, 100, 420, 340)])).toEqual(piece);
  });
});

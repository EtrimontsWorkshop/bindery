import type { Rect } from '../geometry.js';

/** How far a picture's edge may lie from the card's edge and still be flush with it, as a share of the card's size. */
const FLUSH_TOLERANCE = 0.04;
/** The share of the card's height that a picture has to cover for the card to be cut, and that has to remain of it. */
const MIN_COVERED_SHARE = 0.15;
const MIN_REMAINING_SHARE = 0.2;

/**
 * A card of text (a note, a handout) that pictures lie over: the pictures are offered by themselves, so the card is
 * what is left of its box once they are cut away. Only a picture that spans the card's whole width and lies flush with
 * its top or bottom edge can be cut away (what is left is still one rectangle); the card is returned as it was when
 * nothing can be cut or too little of it would remain.
 */
export function cardWithoutPictures(card: Rect, pictures: readonly Rect[]): Rect {
  const width = card.maxX - card.minX;
  const height = card.maxY - card.minY;
  if (width <= 0 || height <= 0) return card;
  let box = card;
  for (const picture of pictures) {
    const spansWidth = picture.minX <= box.minX + width * FLUSH_TOLERANCE && picture.maxX >= box.maxX - width * FLUSH_TOLERANCE;
    const covered = Math.min(picture.maxY, box.maxY) - Math.max(picture.minY, box.minY);
    if (!spansWidth || covered < height * MIN_COVERED_SHARE) continue;
    // PDF space: a larger `y` is higher on the page.
    if (picture.maxY >= box.maxY - height * FLUSH_TOLERANCE && picture.minY > box.minY) box = { ...box, maxY: picture.minY };
    else if (picture.minY <= box.minY + height * FLUSH_TOLERANCE && picture.maxY < box.maxY) box = { ...box, minY: picture.maxY };
  }
  return box.maxY - box.minY >= height * MIN_REMAINING_SHARE ? box : card;
}

/** A piece must lie this far inside a box for the box to be the card it is a piece of. */
const PIECE_MIN_INSIDE_SHARE = 0.8;
/** The card is at most this many times the size of its piece (a whole page behind a note is not the note). */
const CARD_MAX_AREA_RATIO = 3;
const CARD_MIN_AREA_RATIO = 1.1;

/**
 * A note drawn from several pieces, one of which is offered (the others were taken for backdrops because the page's text covers them): the whole
 * note is the smallest box that holds the offered piece and is not much bigger than it. The piece is returned as it was when there is none.
 */
export function cardOfPiece(piece: Rect, cards: readonly Rect[]): Rect {
  const area = (r: Rect): number => Math.max(0, r.maxX - r.minX) * Math.max(0, r.maxY - r.minY);
  const pieceArea = area(piece);
  if (pieceArea <= 0) return piece;
  let best: Rect | null = null;
  for (const card of cards) {
    const cardArea = area(card);
    if (cardArea < pieceArea * CARD_MIN_AREA_RATIO || cardArea > pieceArea * CARD_MAX_AREA_RATIO) continue;
    const insideWidth = Math.min(piece.maxX, card.maxX) - Math.max(piece.minX, card.minX);
    const insideHeight = Math.min(piece.maxY, card.maxY) - Math.max(piece.minY, card.minY);
    if (insideWidth <= 0 || insideHeight <= 0 || (insideWidth * insideHeight) / pieceArea < PIECE_MIN_INSIDE_SHARE) continue;
    if (best === null || cardArea < area(best)) best = card;
  }
  return best ?? piece;
}

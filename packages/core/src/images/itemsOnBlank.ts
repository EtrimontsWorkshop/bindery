import type { DecodedImage } from './normalizeDecodedImage.js';
import type { PixelRect } from './picturesOnGround.js';

/**
 * A sheet of items: several drawings set apart on blank paper (the weapons of an equipment list, each with its name), which
 * the page shows as one picture. Each item is wanted by itself. The ink of the sheet is gathered into pieces — marks close
 * to one another are one piece, and pieces lying largely over one another are one item (cutting along bands of blank paper
 * would not part two items that lie side by side at different heights) — and a piece that is small beside the others (the
 * name under an item, a speck) goes back to the item nearest to it.
 *
 * Returns the items' rectangles in the image's pixels, in reading order, or `null` when the picture is not such a sheet:
 * its edge is not blank paper, it does not come apart, its items do not fill it (a card with lines of writing), or it comes
 * apart into too many pieces (a page of text, a pattern). Many single pictures are made of parts lying apart (dice, a logo,
 * a sign in brush strokes); the caller asks this only of a picture gathered from several pieces of the page.
 */

/** The picture is looked at on a grid of about this many cells along its long edge. */
const GRID_LONG_EDGE = 400;
/** The edge of a sheet is blank: this share of its cells at least are the paper's colour (or transparent). */
const EDGE_MIN_BLANK_SHARE = 0.9;
/** Paper is light: the darkest channel of its colour is this at least. */
const PAPER_MIN_CHANNEL = 200;
/** A cell is ink when its colour is this far from the paper's (mean difference of the channels); a pale wash is not. */
const INK_TOLERANCE = 40;
/** Marks of ink within this share of the sheet's long edge of one another are one piece. */
const JOIN_REACH_SHARE = 0.01;
/** Pieces whose rectangles overlap by this share of the smaller one are one item. */
const SAME_ITEM_OVERLAP = 0.3;
/**
 * A piece whose rectangle is at most this share of the largest piece's is a speck or a detail of a scene (a small figure
 * running from a monster, 0.04): it joins its nearest item. The smallest item of a sheet measured was a helmet, 0.12.
 */
const SMALL_PIECE_SHARE = 0.08;
/** An item is this many cells at least on its short side. */
const ITEM_MIN_SIDE = 12;
/** The items' rectangles cover this share of the rectangle they span at least. */
const ITEMS_MIN_COVER = 0.4;
/** An item's rectangle is at most this many times as long as it is wide; a narrower item gets paper along its sides. */
const ITEM_MAX_ASPECT = 5;
/** At most this many items: more is a page of text or a pattern, not a sheet of items. */
const ITEMS_MAX_COUNT = 8;

interface CellRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const areaOf = (r: CellRect): number => (r.maxX - r.minX + 1) * (r.maxY - r.minY + 1);

/** Gap between two rectangles (0 when they touch or overlap). */
function gapBetween(a: CellRect, b: CellRect): number {
  const dx = Math.max(0, Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX) - 1);
  const dy = Math.max(0, Math.max(a.minY, b.minY) - Math.min(a.maxY, b.maxY) - 1);
  return Math.hypot(dx, dy);
}

/** An item's rectangle, and the boxes of other items' ink that reach into it (to be painted over, see `withoutBoxes`). */
export interface ItemRect extends PixelRect {
  foreign: PixelRect[];
  /** Share of the item's rectangle that is ink (on the grid the sheet is looked at on). */
  inkShare: number;
}

export function findItemsOnBlank(image: DecodedImage): ItemRect[] | null {
  const { width, height, rgba } = image;
  if (width < 64 || height < 64) return null;
  const scale = Math.max(1, Math.max(width, height) / GRID_LONG_EDGE);
  const gw = Math.max(1, Math.floor(width / scale));
  const gh = Math.max(1, Math.floor(height / scale));
  const at = (gx: number, gy: number): number => (Math.min(height - 1, Math.floor((gy + 0.5) * scale)) * width + Math.min(width - 1, Math.floor((gx + 0.5) * scale))) * 4;

  // The paper's colour: the median of the opaque cells along the edge.
  const edge: number[] = [];
  for (let gx = 0; gx < gw; gx++) edge.push(at(gx, 0), at(gx, gh - 1));
  for (let gy = 1; gy < gh - 1; gy++) edge.push(at(0, gy), at(gw - 1, gy));
  const opaque = edge.filter((i) => rgba[i + 3]! > 32);
  const median = (channel: number): number => {
    const values = opaque.map((i) => rgba[i + channel]!).sort((a, b) => a - b);
    return values[values.length >> 1] ?? 255;
  };
  const paper = [median(0), median(1), median(2)] as const;
  if (opaque.length > 0 && Math.min(...paper) < PAPER_MIN_CHANNEL) return null;
  const isInk = (i: number): boolean => rgba[i + 3]! > 32 && (Math.abs(rgba[i]! - paper[0]) + Math.abs(rgba[i + 1]! - paper[1]) + Math.abs(rgba[i + 2]! - paper[2])) / 3 > INK_TOLERANCE;
  if (edge.filter((i) => !isInk(i)).length < EDGE_MIN_BLANK_SHARE * edge.length) return null;

  const ink = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) if (isInk(at(gx, gy))) ink[gy * gw + gx] = 1;
  // Marks of ink close to one another are one piece (the strokes of a sketch): ink grown by a little, then its regions.
  const reach = Math.max(1, Math.round(Math.max(gw, gh) * JOIN_REACH_SHARE));
  const grown = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      if (!ink[gy * gw + gx]) continue;
      for (let y = Math.max(0, gy - reach); y <= Math.min(gh - 1, gy + reach); y++) for (let x = Math.max(0, gx - reach); x <= Math.min(gw - 1, gx + reach); x++) grown[y * gw + x] = 1;
    }
  }
  // Which piece each grown cell belongs to (-1: none).
  const pieceOf = new Int32Array(gw * gh).fill(-1);
  const pieces: CellRect[] = [];
  const stack: number[] = [];
  for (let start = 0; start < gw * gh; start++) {
    if (!grown[start] || pieceOf[start] !== -1) continue;
    const r = { minX: gw, minY: gh, maxX: -1, maxY: -1 };
    pieceOf[start] = pieces.length;
    stack.push(start);
    while (stack.length > 0) {
      const at = stack.pop()!;
      const x = at % gw;
      const y = (at - x) / gw;
      if (x < r.minX) r.minX = x;
      if (x > r.maxX) r.maxX = x;
      if (y < r.minY) r.minY = y;
      if (y > r.maxY) r.maxY = y;
      for (const next of [at - 1, at + 1, at - gw, at + gw]) {
        if (next < 0 || next >= gw * gh || (next === at - 1 && x === 0) || (next === at + 1 && x === gw - 1)) continue;
        if (grown[next] && pieceOf[next] === -1) {
          pieceOf[next] = pieces.length;
          stack.push(next);
        }
      }
    }
    // Back from the grown ink to the ink itself.
    pieces.push({ minX: Math.min(gw - 1, r.minX + reach), minY: Math.min(gh - 1, r.minY + reach), maxX: Math.max(0, r.maxX - reach), maxY: Math.max(0, r.maxY - reach) });
  }
  // Pieces whose rectangles lie largely over one another are one item (a blade drawn apart from its handle).
  const overlapShare = (a: CellRect, b: CellRect): number => {
    const w = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) + 1;
    const h = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) + 1;
    return w > 0 && h > 0 ? (w * h) / Math.min(areaOf(a), areaOf(b)) : 0;
  };
  // Groups of pieces: their rectangle and the pieces in them.
  type Group = CellRect & { members: number[] };
  const join = (a: Group, b: Group): Group => ({ minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY), members: [...a.members, ...b.members] });
  const leaves: Group[] = pieces.map((r, i) => ({ ...r, members: [i] }));
  let merged = true;
  while (merged) {
    merged = false;
    for (let a = 0; a < leaves.length && !merged; a++) {
      for (let b = a + 1; b < leaves.length && !merged; b++) {
        if (overlapShare(leaves[a]!, leaves[b]!) < SAME_ITEM_OVERLAP) continue;
        leaves[a] = join(leaves[a]!, leaves[b]!);
        leaves.splice(b, 1);
        merged = true;
      }
    }
  }
  if (leaves.length < 2) return null;

  // Small pieces join their nearest item, the smallest first.
  const items = [...leaves];
  for (;;) {
    const largest = Math.max(...items.map(areaOf));
    const small = items.filter((p) => areaOf(p) <= SMALL_PIECE_SHARE * largest).sort((a, b) => areaOf(a) - areaOf(b))[0];
    if (small === undefined || items.length < 2) break;
    const others = items.filter((p) => p !== small);
    const nearest = others.reduce((best, p) => (gapBetween(small, p) < gapBetween(small, best) ? p : best));
    items.splice(items.indexOf(small), 1);
    items[items.indexOf(nearest)] = join(small, nearest);
  }
  if (items.length < 2 || items.length > ITEMS_MAX_COUNT) return null;
  // The items fill most of the rectangle they span (a card with a few lines of writing on it comes apart into lines, not items).
  const span: CellRect = { minX: Math.min(...items.map((p) => p.minX)), minY: Math.min(...items.map((p) => p.minY)), maxX: Math.max(...items.map((p) => p.maxX)), maxY: Math.max(...items.map((p) => p.maxY)) };
  if (items.reduce((sum, p) => sum + areaOf(p), 0) < ITEMS_MIN_COVER * areaOf(span)) return null;
  if (items.some((p) => Math.min(p.maxX - p.minX + 1, p.maxY - p.minY + 1) < ITEM_MIN_SIDE)) return null;
  // Items whose rectangles still lie largely over one another are not cleanly apart.
  for (let a = 0; a < items.length; a++) for (let b = a + 1; b < items.length; b++) if (overlapShare(items[a]!, items[b]!) >= SAME_ITEM_OVERLAP) return null;

  const pad = 1;
  return items
    .map((p) => {
      let x0 = Math.max(0, Math.floor((p.minX - pad) * scale));
      let y0 = Math.max(0, Math.floor((p.minY - pad) * scale));
      let x1 = Math.min(width, Math.ceil((p.maxX + 1 + pad) * scale));
      let y1 = Math.min(height, Math.ceil((p.maxY + 1 + pad) * scale));
      // A long, narrow item (a bow, a spear) keeps some paper along its sides: cut tight, it would read as a strip of ornament.
      const long = Math.max(x1 - x0, y1 - y0);
      const want = Math.ceil(long / ITEM_MAX_ASPECT);
      if (x1 - x0 < want) {
        const grow = (want - (x1 - x0)) / 2;
        x0 = Math.max(0, Math.floor(x0 - grow));
        x1 = Math.min(width, Math.ceil(x1 + grow));
        // Against the image's edge on one side: the rest on the other.
        if (x1 - x0 < want && x0 === 0) x1 = Math.min(width, want);
        else if (x1 - x0 < want) x0 = Math.max(0, x1 - want);
      }
      if (y1 - y0 < want) {
        const grow = (want - (y1 - y0)) / 2;
        y0 = Math.max(0, Math.floor(y0 - grow));
        y1 = Math.min(height, Math.ceil(y1 + grow));
        // Against the image's edge on one side: the rest on the other.
        if (y1 - y0 < want && y0 === 0) y1 = Math.min(height, want);
        else if (y1 - y0 < want) y0 = Math.max(0, y1 - want);
      }
      // The ink of other items that reaches into the rectangle (the tip of a blade above a pick), cell by cell, a cell round.
      const own = new Set(p.members);
      const foreign: PixelRect[] = [];
      for (let gy = Math.floor(y0 / scale); gy < Math.min(gh, Math.ceil(y1 / scale)); gy++) {
        for (let gx = Math.floor(x0 / scale); gx < Math.min(gw, Math.ceil(x1 / scale)); gx++) {
          const piece = pieceOf[gy * gw + gx]!;
          if (!ink[gy * gw + gx] || piece === -1 || own.has(piece)) continue;
          foreign.push({ x: (gx - 1) * scale, y: (gy - 1) * scale, width: 3 * scale, height: 3 * scale });
        }
      }
      let inkCells = 0;
      for (let gy = p.minY; gy <= p.maxY; gy++) for (let gx = p.minX; gx <= p.maxX; gx++) inkCells += ink[gy * gw + gx]!;
      return { x: x0, y: y0, width: x1 - x0, height: y1 - y0, foreign, inkShare: inkCells / areaOf(p) };
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * `image` with the `boxes` (the page's words lying on it, in its pixels) painted over in the colour of its paper (the
 * median of its edge): the items of a sheet without their names, which the page writes as text.
 */
export function withoutBoxes(image: DecodedImage, boxes: readonly PixelRect[]): DecodedImage {
  const { width, height, rgba } = image;
  const edge: number[] = [];
  for (let x = 0; x < width; x++) edge.push(x * 4, ((height - 1) * width + x) * 4);
  for (let y = 0; y < height; y++) edge.push(y * width * 4, (y * width + width - 1) * 4);
  const median = (channel: number): number => {
    const values = edge.map((i) => rgba[i + channel]!).sort((a, b) => a - b);
    return values[values.length >> 1] ?? 255;
  };
  const paper = [median(0), median(1), median(2), median(3)];
  const out = new Uint8ClampedArray(rgba);
  for (const box of boxes) {
    const x0 = Math.max(0, Math.floor(box.x));
    const y0 = Math.max(0, Math.floor(box.y));
    const x1 = Math.min(width, Math.ceil(box.x + box.width));
    const y1 = Math.min(height, Math.ceil(box.y + box.height));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) out.set(paper, (y * width + x) * 4);
  }
  return { width, height, rgba: out };
}

/** An item of a sheet holds this share of ink at least: one nearly blank is a piece of a form or of paper, not a drawing. */
const ITEM_MIN_INK_SHARE = 0.04;
/** A name lies within this share of the sheet's long edge of its item. */
const NAME_MAX_GAP_SHARE = 0.04;
/** This share of the items at least have a name by them. */
const NAMED_ITEMS_MIN_SHARE = 0.5;

/**
 * Whether the `items` found on a sheet are a sheet of items: each holds ink (no blank piece of a form or of paper), and most
 * have a name by them among the page's `words` (in the sheet's pixels). A title cut into its words, a logo into its strokes or a
 * row of publishers' logos has no names: measured on 279 books, these were most of what splitting without names offered.
 */
export function areNamedItems(items: readonly ItemRect[], words: readonly PixelRect[], longEdge: number): boolean {
  if (items.some((item) => item.inkShare < ITEM_MIN_INK_SHARE)) return false;
  const gap = NAME_MAX_GAP_SHARE * longEdge;
  const named = items.filter((item) =>
    words.some((w) => w.x < item.x + item.width + gap && w.x + w.width > item.x - gap && w.y < item.y + item.height + gap && w.y + w.height > item.y - gap),
  );
  return named.length >= NAMED_ITEMS_MIN_SHARE * items.length;
}

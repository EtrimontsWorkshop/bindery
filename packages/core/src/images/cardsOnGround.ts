import type { DecodedImage } from './normalizeDecodedImage.js';

/**
 * Cards laid on a page painted as one raster: notes, cuttings or handouts lying on the plain paper of the page, some of them
 * askew, in perspective, or laid over a corner of another. Their rectangles overlap, so the search for solid regions on the
 * ground (see `picturesOnGround.ts`) takes them for one; their outlines tell them apart.
 *
 * What is looked for: the ground (the light, plain paper along the raster's edge, and all of it that joins the edge), the
 * straight edges of what lies on it (tilted up to `MAX_TILT_DEG`), and four-sided shapes made of those edges that are cards:
 * along each side, the ground lies outside and the card inside, or another card lies outside with a step of light across the
 * side going one way all along it (the shadow of the card on top). A card is solid within (not ground). Cards seen nearly whole
 * are taken first; then cards partly under or beside them, a side counting where a card found already lies along it.
 *
 * Measured on twenty books: a page of three handouts on paper (one askew and in perspective, laid over the corner of another)
 * gives its three cards; a composition of photographs laid one on another with no ground between them does not come apart
 * (the edges within the photographs make shapes of their own), and is left whole.
 */

export interface CardQuad {
  /** Corners in the raster's pixels: top left, top right, bottom right, bottom left. */
  corners: [Point, Point, Point, Point];
  /** The corners of the cards laid over this one (a corner of another laid on it), in the raster's pixels. */
  coveredBy?: [Point, Point, Point, Point][];
}

interface Point {
  x: number;
  y: number;
}

/** The raster is looked at with its long edge this many pixels. */
const WORK_LONG_EDGE = 500;
/** The ground is read from a band this wide round the edge (share of the short edge). */
const GROUND_BAND_SHARE = 0.04;
/** Paper is light: the darkest channel of the ground is this at least. */
const GROUND_MIN_CHANNEL = 170;
/** The band along the edge is plain: this share of it is the ground's colour. */
const GROUND_BAND_MIN_PLAIN_SHARE = 0.6;
/** How far from the ground's colour (mean difference of the three channels) a pixel still is ground: the cards are paper too, a shade off it. */
const GROUND_TOLERANCE = 10;
/** Edges are looked for tilted this far from upright at most, in steps of this. */
const MAX_TILT_DEG = 12;
const TILT_STEP_DEG = 0.5;
/** An edge holds this share of the raster's side in pixels of an outline at least. */
const LINE_MIN_VOTES_SHARE = 0.06;
/** The strongest this many edges of each direction are combined. */
const LINES_PER_DIRECTION = 60;
/** Two sides of a card face each other within this many degrees, and run across the other two within this many: a card in perspective. */
const PARALLEL_MAX_DEG = 5;
const SQUARE_MAX_DEG = 6;
/** A card's side is this share of the raster's short side at least, and its area this share of the raster's at least and at most. */
const CARD_MIN_SIDE_SHARE = 0.1;
const CARD_MIN_AREA_SHARE = 0.03;
const CARD_MAX_AREA_SHARE = 0.85;
/** A side is seen when this share of it shows the card's edge. */
const SIDE_SEEN = 0.7;
/** A card seen nearly whole: three sides seen, the fourth this much at least (the edge of a card laid over it). */
const SIDE_WEAK = 0.3;
/** A card partly under others: each side shows this much at least, and with what lies under a card found already, `SIDE_SEEN`. */
const SIDE_PART = 0.25;
/** Each side meets the ground along this share of it at least: the edge of a card, not the end of its text (a step of light within it). */
const SIDE_MIN_GROUND = 0.12;
/** What lies under or beside a card found counts half (a card that would reach under another is no better for it). */
const HIDDEN_WEIGHT = 0.5;
/** Among cards partly under others, the one whose sides meet the ground more is the better: what meets the ground is surely an edge. */
const GROUND_WEIGHT = 0.5;
/** A card is not ground within over this share of it ... */
const CARD_MIN_FILL = 0.85;
/**
 * ... and is of a colour of its own over this share of it: a card of paper a shade off the page's, a photograph. A drawing in line
 * on the page's paper (a floor plan, its rooms enclosed by its walls) or an article of a newspaper page (black on the same white)
 * is the ground's colour within.
 */
const CARD_MIN_TINTED = 0.5;
/** The step of light across the edge of a card laid on a card (mean of a band on each side). */
const CARD_ON_CARD_STEP = 15;
/** Two cards found are not one over the other: their boxes overlap less than this share of the smaller. */
const CARD_MAX_OVERLAP = 0.5;
/** A page of cards has this many at least (one card is a picture on paper, left to `picturesOnGround.ts`) and at most. */
const CARDS_MIN = 2;
const CARDS_MAX = 6;
/**
 * Every card's mean colour is this far from the ground's at least (mean difference of the three channels): cards of paper of their own
 * (handouts on a page measured 36), not parts of the page's own sheet (the frame of a character sheet with its portrait laid on it, the
 * boxes of a form: white as the page).
 */
const CARD_MIN_MEAN_DIFFERENCE = 15;
/** A card laid askew is tilted this far at least (the blocks of a newspaper page measured 2.25 at most, fitted badly; a handout askew 7.75). */
const LAID_MIN_TILT_DEG = 3;
/** The cards found explain this share at least of what is not ground (the rest: the book's frame and ornaments). */
const CARDS_MIN_EXPLAINED = 0.6;

interface Line {
  theta: number;
  rho: number;
  votes: number;
  vertical: boolean;
  /** Per position along the line (x for a horizontal one, y for a vertical one), cumulative counts of evidence, for a card on either side. */
  evidence: [Evidence, Evidence];
}

interface Evidence {
  hit: Float64Array;
  up: Float64Array;
  down: Float64Array;
}

interface Candidate {
  corners: [Point, Point, Point, Point];
  /** For each side (top, right, bottom, left): the line and on which side of it the card lies. */
  sides: { line: Line; side: 0 | 1 }[];
  area: number;
}

/** The cards on the ground of `image` (a page painted as one raster), in reading order; `null` when it is no such page. */
export function findCardsOnGround(image: DecodedImage): CardQuad[] | null {
  const scale = Math.min(1, WORK_LONG_EDGE / Math.max(image.width, image.height));
  const W = Math.max(1, Math.round(image.width * scale));
  const H = Math.max(1, Math.round(image.height * scale));
  if (W < 64 || H < 64) return null;
  // Mean colour over 3x3 pixels of the work raster (sampled from the source).
  const sample = (x: number, y: number): number => (Math.min(image.height - 1, Math.floor((y + 0.5) / scale)) * image.width + Math.min(image.width - 1, Math.floor((x + 0.5) / scale))) * 4;
  const raw = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const at = sample(x, y);
      const alpha = image.rgba[at + 3]! / 255;
      for (let c = 0; c < 3; c++) raw[(y * W + x) * 3 + c] = image.rgba[at + c]! * alpha + 255 * (1 - alpha);
    }
  }
  const colour = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += raw[(Math.min(H - 1, Math.max(0, y + dy)) * W + Math.min(W - 1, Math.max(0, x + dx))) * 3 + c]!;
        colour[(y * W + x) * 3 + c] = sum / 9;
      }
    }
  }
  // The ground: the median colour of the band along the edge, light and plain.
  const band = Math.max(2, Math.round(GROUND_BAND_SHARE * Math.min(W, H)));
  const channels: number[][] = [[], [], []];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x < band || y < band || x >= W - band || y >= H - band) for (let c = 0; c < 3; c++) channels[c]!.push(colour[(y * W + x) * 3 + c]!);
  const ground = channels.map((values) => values.sort((a, b) => a - b)[values.length >> 1]!);
  if (Math.min(...ground) < GROUND_MIN_CHANNEL) return null;
  const nearGround = (i: number): boolean => (Math.abs(colour[i * 3]! - ground[0]!) + Math.abs(colour[i * 3 + 1]! - ground[1]!) + Math.abs(colour[i * 3 + 2]! - ground[2]!)) / 3 <= GROUND_TOLERANCE;
  let bandCells = 0;
  let bandGround = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!(x < band || y < band || x >= W - band || y >= H - band)) continue;
      bandCells++;
      if (nearGround(y * W + x)) bandGround++;
    }
  }
  if (bandGround < GROUND_BAND_MIN_PLAIN_SHARE * bandCells) return null;
  // The ground is what of the ground's colour joins the edge: a light patch within a card is the card's.
  const isGround = new Uint8Array(W * H);
  const stack: number[] = [];
  for (let x = 0; x < W; x++) stack.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y++) stack.push(y * W, y * W + W - 1);
  while (stack.length > 0) {
    const at = stack.pop()!;
    if (isGround[at] || !nearGround(at)) continue;
    isGround[at] = 1;
    const x = at % W;
    const y = (at - x) / W;
    if (x > 0) stack.push(at - 1);
    if (x < W - 1) stack.push(at + 1);
    if (y > 0) stack.push(at - W);
    if (y < H - 1) stack.push(at + W);
  }
  const groundAt = (x: number, y: number): number => {
    const X = Math.round(x);
    const Y = Math.round(y);
    return X < 0 || Y < 0 || X >= W || Y >= H ? -1 : isGround[Y * W + X]!;
  };
  const lightAt = (x: number, y: number): number => {
    const i = (Math.min(H - 1, Math.max(0, Math.round(y))) * W + Math.min(W - 1, Math.max(0, Math.round(x)))) * 3;
    return 0.3 * colour[i]! + 0.59 * colour[i + 1]! + 0.11 * colour[i + 2]!;
  };
  // The outline of the ground: what is not ground, with ground two pixels away across.
  const edgeAcross = new Uint8Array(W * H);
  const edgeAlong = new Uint8Array(W * H);
  for (let y = 2; y < H - 2; y++) {
    for (let x = 2; x < W - 2; x++) {
      const i = y * W + x;
      if (isGround[i]) continue;
      if (isGround[i - 2 * W] !== isGround[i + 2 * W]) edgeAcross[i] = 1;
      if (isGround[i - 2] !== isGround[i + 2]) edgeAlong[i] = 1;
    }
  }

  const thetas: number[] = [];
  for (let t = -MAX_TILT_DEG; t <= MAX_TILT_DEG + 1e-9; t += TILT_STEP_DEG) thetas.push(t);
  const diagonal = Math.ceil(Math.hypot(W, H));
  const span = 2 * diagonal + 1;
  // A horizontal line: -x sin a + y cos a = rho; a vertical one: x cos a + y sin a = rho (a the tilt in both).
  const pointOn = (line: { theta: number; rho: number; vertical: boolean }, t: number): Point => {
    const a = (line.theta * Math.PI) / 180;
    return line.vertical ? { x: (line.rho - t * Math.sin(a)) / Math.cos(a), y: t } : { x: t, y: (line.rho + t * Math.sin(a)) / Math.cos(a) };
  };
  const linesOf = (vertical: boolean): Line[] => {
    const votes = new Float32Array(thetas.length * span);
    const edges = vertical ? edgeAlong : edgeAcross;
    const cos = thetas.map((t) => Math.cos((t * Math.PI) / 180));
    const sin = thetas.map((t) => Math.sin((t * Math.PI) / 180));
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!edges[y * W + x]) continue;
        for (let k = 0; k < thetas.length; k++) {
          const rho = vertical ? x * cos[k]! + y * sin[k]! : -x * sin[k]! + y * cos[k]!;
          votes[k * span + Math.round(rho) + diagonal]!++;
        }
      }
    }
    const minVotes = LINE_MIN_VOTES_SHARE * (vertical ? H : W);
    const peaks: { theta: number; rho: number; votes: number }[] = [];
    for (let k = 0; k < thetas.length; k++) {
      for (let r = 0; r < span; r++) {
        const v = votes[k * span + r]!;
        if (v < minVotes) continue;
        let peak = true;
        for (let dk = -2; dk <= 2 && peak; dk++) {
          for (let dr = -3; dr <= 3; dr++) {
            const kk = k + dk;
            const rr = r + dr;
            if ((dk === 0 && dr === 0) || kk < 0 || kk >= thetas.length || rr < 0 || rr >= span) continue;
            const other = votes[kk * span + rr]!;
            if (other > v || (other === v && (dk < 0 || (dk === 0 && dr < 0)))) {
              peak = false;
              break;
            }
          }
        }
        if (peak) peaks.push({ theta: thetas[k]!, rho: r - diagonal, votes: v });
      }
    }
    peaks.sort((a, b) => b.votes - a.votes);
    return peaks.slice(0, LINES_PER_DIRECTION).map((p) => ({ ...p, vertical, evidence: [evidenceAlong({ ...p, vertical }, 1), evidenceAlong({ ...p, vertical }, -1)] }));
  };
  /** The evidence of a card's edge at each place along a line, the card on the side the normal (times `towards`) points to. */
  const evidenceAlong = (line: { theta: number; rho: number; vertical: boolean }, towards: 1 | -1): Evidence => {
    const length = line.vertical ? H : W;
    const a = (line.theta * Math.PI) / 180;
    const nx = (line.vertical ? Math.cos(a) : -Math.sin(a)) * towards;
    const ny = (line.vertical ? Math.sin(a) : Math.cos(a)) * towards;
    const hit = new Float64Array(length + 1);
    const up = new Float64Array(length + 1);
    const down = new Float64Array(length + 1);
    for (let t = 0; t < length; t++) {
      const { x, y } = pointOn(line, t);
      let h = 0;
      let u = 0;
      let d = 0;
      for (const o of [2, 3, 4]) {
        if (groundAt(x + nx * o, y + ny * o) === 0 && groundAt(x - nx * o, y - ny * o) !== 0) {
          h = 1;
          break;
        }
      }
      if (h === 0 && groundAt(x + nx * 3, y + ny * 3) === 0 && groundAt(x - nx * 3, y - ny * 3) === 0) {
        let inner = 0;
        let outer = 0;
        for (let o = 2; o <= 7; o++) {
          inner += lightAt(x + nx * o, y + ny * o);
          outer += lightAt(x - nx * o, y - ny * o);
        }
        const step = (inner - outer) / 6;
        if (step >= CARD_ON_CARD_STEP) u = 1;
        else if (step <= -CARD_ON_CARD_STEP) d = 1;
      }
      hit[t + 1] = hit[t]! + h;
      up[t + 1] = up[t]! + u;
      down[t + 1] = down[t]! + d;
    }
    return { hit, up, down };
  };
  const across = linesOf(false);
  const along = linesOf(true);

  const meet = (h: Line, v: Line): Point => {
    const a = (h.theta * Math.PI) / 180;
    const b = (v.theta * Math.PI) / 180;
    const det = -Math.sin(a) * Math.sin(b) - Math.cos(a) * Math.cos(b);
    return { x: (h.rho * Math.sin(b) - Math.cos(a) * v.rho) / det, y: (-Math.sin(a) * v.rho - Math.cos(b) * h.rho) / det };
  };
  const minSide = CARD_MIN_SIDE_SHARE * Math.min(W, H);
  const candidates: Candidate[] = [];
  for (const top of across) {
    for (const bottom of across) {
      if (bottom.rho - top.rho < minSide || Math.abs(top.theta - bottom.theta) > PARALLEL_MAX_DEG) continue;
      for (const left of along) {
        for (const right of along) {
          if (right.rho - left.rho < minSide || Math.abs(left.theta - right.theta) > PARALLEL_MAX_DEG) continue;
          if (Math.abs((top.theta + bottom.theta) / 2 - (left.theta + right.theta) / 2) > SQUARE_MAX_DEG) continue;
          const corners: [Point, Point, Point, Point] = [meet(top, left), meet(top, right), meet(bottom, right), meet(bottom, left)];
          const area = polygonArea(corners);
          if (area < CARD_MIN_AREA_SHARE * W * H || area > CARD_MAX_AREA_SHARE * W * H) continue;
          // The normal of a horizontal line points down, of a vertical one right: the card lies below the top, above the bottom.
          candidates.push({ corners, area, sides: [{ line: top, side: 0 }, { line: right, side: 1 }, { line: bottom, side: 1 }, { line: left, side: 0 }] });
        }
      }
    }
  }
  const sideOf = (candidate: Candidate, k: number): { seen: number; ground: number } => {
    const { line, side } = candidate.sides[k]!;
    const ends = [candidate.corners[k]!, candidate.corners[(k + 1) % 4]!];
    const at = ends.map((p) => (line.vertical ? p.y : p.x));
    const length = line.vertical ? H : W;
    const from = Math.max(0, Math.min(length, Math.round(Math.min(at[0]!, at[1]!)) + 1));
    const to = Math.max(0, Math.min(length, Math.round(Math.max(at[0]!, at[1]!)) - 1));
    const total = Math.max(1, Math.round(Math.max(at[0]!, at[1]!)) - Math.round(Math.min(at[0]!, at[1]!)) - 1);
    if (to <= from) return { seen: 0, ground: 0 };
    const e = line.evidence[side]!;
    const hits = e.hit[to]! - e.hit[from]!;
    const ups = e.up[to]! - e.up[from]!;
    const downs = e.down[to]! - e.down[from]!;
    // A card on a card: the step across goes one way all along (its shadow), not both ways (rows of text).
    return { seen: Math.min(1, (hits + Math.abs(ups - downs)) / total), ground: hits / total };
  };
  const fillOf = (corners: readonly Point[]): number => {
    const xs = corners.map((p) => p.x);
    const ys = corners.map((p) => p.y);
    let inside = 0;
    let solid = 0;
    let tinted = 0;
    for (let y = Math.max(0, Math.floor(Math.min(...ys))); y <= Math.min(H - 1, Math.ceil(Math.max(...ys))); y += 2) {
      for (let x = Math.max(0, Math.floor(Math.min(...xs))); x <= Math.min(W - 1, Math.ceil(Math.max(...xs))); x += 2) {
        if (!insidePolygon(corners, x, y)) continue;
        inside++;
        if (!isGround[y * W + x]) solid++;
        if (!nearGround(y * W + x)) tinted++;
      }
    }
    // A card of the ground's colour within is no card (see `CARD_MIN_TINTED`): it counts as hollow.
    return tinted < CARD_MIN_TINTED * inside ? 0 : solid / Math.max(1, inside);
  };
  const boxOf = (corners: readonly Point[]): { minX: number; minY: number; maxX: number; maxY: number } => ({ minX: Math.min(...corners.map((p) => p.x)), maxX: Math.max(...corners.map((p) => p.x)), minY: Math.min(...corners.map((p) => p.y)), maxY: Math.max(...corners.map((p) => p.y)) });
  const picked: Candidate[] = [];
  const clashes = (candidate: Candidate): boolean =>
    picked.some((p) => {
      const a = boxOf(p.corners);
      const b = boxOf(candidate.corners);
      const shared = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)) * Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
      return shared > CARD_MAX_OVERLAP * Math.min(p.area, candidate.area);
    });
  const sidesOf = candidates.map((c) => [0, 1, 2, 3].map((k) => sideOf(c, k)));
  const seenSides = sidesOf.map((sides) => (sides.some((side) => side.ground < SIDE_MIN_GROUND) ? [0, 0, 0, 0] : sides.map((side) => side.seen)));
  const groundOfSides = sidesOf.map((sides) => sides.reduce((sum, side) => sum + side.ground, 0));
  // Cards seen nearly whole, the best seen first.
  for (let round = 0; round < CARDS_MAX; round++) {
    let best = -1;
    let bestScore = 0;
    for (let n = 0; n < candidates.length; n++) {
      const seen = [...seenSides[n]!].sort((a, b) => a - b);
      if (seen[0]! < SIDE_WEAK || seen[1]! < SIDE_SEEN) continue;
      const score = seen.reduce((sum, v) => sum + v, 0);
      if (score <= bestScore || picked.includes(candidates[n]!) || clashes(candidates[n]!) || fillOf(candidates[n]!.corners) < CARD_MIN_FILL) continue;
      best = n;
      bestScore = score;
    }
    if (best < 0) break;
    picked.push(candidates[best]!);
  }
  // Cards partly under or beside those, where a card found lies along a side (or just past it).
  const hiddenShare = (candidate: Candidate, k: number): number => {
    const p = candidate.corners[k]!;
    const q = candidate.corners[(k + 1) % 4]!;
    const length = Math.hypot(q.x - p.x, q.y - p.y);
    const steps = Math.max(2, Math.round(length));
    let hidden = 0;
    for (let s = 1; s < steps; s++) {
      const x = p.x + ((q.x - p.x) * s) / steps;
      const y = p.y + ((q.y - p.y) * s) / steps;
      if (picked.some((card) => insidePolygon(card.corners, x, y) || insidePolygon(card.corners, x + 6 * Math.sign(q.y - p.y), y - 6 * Math.sign(q.x - p.x)) || insidePolygon(card.corners, x - 6 * Math.sign(q.y - p.y), y + 6 * Math.sign(q.x - p.x)))) hidden++;
    }
    return hidden / Math.max(1, steps - 1);
  };
  for (let round = picked.length; round < CARDS_MAX && picked.length > 0; round++) {
    let best = -1;
    let bestScore = 0;
    for (let n = 0; n < candidates.length; n++) {
      const seen = seenSides[n]!;
      if (seen.some((v) => v < SIDE_PART) || picked.includes(candidates[n]!) || clashes(candidates[n]!)) continue;
      // An upper bound first: a side wholly hidden adds `HIDDEN_WEIGHT` of what it does not show.
      if (seen.reduce((sum, v) => sum + v + HIDDEN_WEIGHT * (1 - v), 0) + GROUND_WEIGHT * groundOfSides[n]! <= bestScore) continue;
      const hidden = [0, 1, 2, 3].map((k) => (seen[k]! >= SIDE_SEEN ? 0 : hiddenShare(candidates[n]!, k)));
      if (seen.some((v, k) => v + hidden[k]! < SIDE_SEEN)) continue;
      const score = seen.reduce((sum, v, k) => sum + v + HIDDEN_WEIGHT * hidden[k]!, 0) + GROUND_WEIGHT * groundOfSides[n]!;
      if (score <= bestScore || fillOf(candidates[n]!.corners) < CARD_MIN_FILL) continue;
      best = n;
      bestScore = score;
    }
    if (best < 0) break;
    picked.push(candidates[best]!);
  }
  if (picked.length < CARDS_MIN || picked.length > CARDS_MAX) return null;
  const meanDifference = (corners: readonly Point[]): number => {
    const xs = corners.map((p) => p.x);
    const ys = corners.map((p) => p.y);
    const sum = [0, 0, 0];
    let n = 0;
    for (let y = Math.max(0, Math.floor(Math.min(...ys))); y <= Math.min(H - 1, Math.ceil(Math.max(...ys))); y += 2) {
      for (let x = Math.max(0, Math.floor(Math.min(...xs))); x <= Math.min(W - 1, Math.ceil(Math.max(...xs))); x += 2) {
        if (!insidePolygon(corners, x, y)) continue;
        for (let c = 0; c < 3; c++) sum[c]! += colour[(y * W + x) * 3 + c]!;
        n++;
      }
    }
    return n === 0 ? 0 : sum.reduce((total, value, c) => total + Math.abs(value / n - ground[c]!), 0) / 3;
  };
  if (picked.some((card) => meanDifference(card.corners) < CARD_MIN_MEAN_DIFFERENCE)) return null;
  // Cards laid on the paper: one of them askew, or over another. Upright blocks side by side are the page's own layout (the columns of a
  // newspaper page), and pictures apart on the paper are found as such (see `picturesOnGround.ts`).
  // A card askew has its sides tilted, most of them (a card in perspective may have one side nearly level); a box fitted badly to an
  // upright block has one.
  const tiltOf = (card: Candidate): number => {
    const tilts = card.sides.map((side) => Math.abs(side.line.theta)).sort((a, b) => a - b);
    return (tilts[1]! + tilts[2]!) / 2;
  };
  const overlapping = picked.some((a, i) => picked.some((b, j) => j > i && (a.corners.some((p) => insidePolygon(b.corners, p.x, p.y)) || b.corners.some((p) => insidePolygon(a.corners, p.x, p.y)))));
  if (!overlapping && !picked.some((card) => tiltOf(card) >= LAID_MIN_TILT_DEG)) return null;
  // The cards explain most of what is not ground: the page is cards on paper, not a picture with rectangles in it.
  let solid = 0;
  let explained = 0;
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      if (isGround[y * W + x]) continue;
      solid++;
      if (picked.some((card) => insidePolygon(card.corners, x, y))) explained++;
    }
  }
  if (explained < CARDS_MIN_EXPLAINED * solid) return null;
  // Of two cards that overlap, the one on top shows its edge across the other (a step of light along it); the other's edge there is hidden.
  const edgeShownWithin = (card: Candidate, other: Candidate): number => {
    let sum = 0;
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const p = card.corners[k]!;
      const q = card.corners[(k + 1) % 4]!;
      const length = Math.hypot(q.x - p.x, q.y - p.y);
      const nx = -(q.y - p.y) / length;
      const ny = (q.x - p.x) / length;
      for (let s = 1; s < length; s++) {
        const x = p.x + ((q.x - p.x) * s) / length;
        const y = p.y + ((q.y - p.y) * s) / length;
        if (!insidePolygon(other.corners, x, y)) continue;
        let a = 0;
        let b = 0;
        for (let o = 2; o <= 5; o++) {
          a += lightAt(x + nx * o, y + ny * o);
          b += lightAt(x - nx * o, y - ny * o);
        }
        // Signed, the normal pointing out of the card (corners go clockwise): the step across a card's edge goes one way all along
        // it, the rows of text the edge of a card under it runs through go both ways.
        sum += (a - b) / 4;
        n++;
      }
    }
    return n === 0 ? 0 : Math.abs(sum / n);
  };
  const toSource = (p: Point): Point => ({ x: Math.min(image.width, Math.max(0, p.x / scale)), y: Math.min(image.height, Math.max(0, p.y / scale)) });
  const overlap = (a: Candidate, b: Candidate): boolean => a.corners.some((p) => insidePolygon(b.corners, p.x, p.y)) || b.corners.some((p) => insidePolygon(a.corners, p.x, p.y));
  return picked
    .map((card) => {
      const over = picked.filter((other) => other !== card && overlap(card, other) && edgeShownWithin(other, card) > edgeShownWithin(card, other));
      const corners = card.corners.map(toSource) as [Point, Point, Point, Point];
      return over.length === 0 ? { corners } : { corners, coveredBy: over.map((other) => other.corners.map(toSource) as [Point, Point, Point, Point]) };
    })
    .sort((a, b) => Math.min(...a.corners.map((p) => p.y)) - Math.min(...b.corners.map((p) => p.y)) || Math.min(...a.corners.map((p) => p.x)) - Math.min(...b.corners.map((p) => p.x)));
}

/** The upright box round a card, in the raster's pixels. */
export function envelopeOfCard(card: CardQuad): { x: number; y: number; width: number; height: number } {
  const xs = card.corners.map((p) => p.x);
  const ys = card.corners.map((p) => p.y);
  const x = Math.floor(Math.min(...xs));
  const y = Math.floor(Math.min(...ys));
  return { x, y, width: Math.ceil(Math.max(...xs)) - x, height: Math.ceil(Math.max(...ys)) - y };
}

/**
 * The card cut out of `image` and made a rectangle: its four corners mapped to the corners of the picture (bilinearly). Where cards laid
 * over it cover it (`coveredBy`), its own paper is put back.
 */
export function takeCard(image: DecodedImage, card: CardQuad): DecodedImage {
  const [tl, tr, br, bl] = card.corners;
  const width = Math.max(1, Math.round((Math.hypot(tr.x - tl.x, tr.y - tl.y) + Math.hypot(br.x - bl.x, br.y - bl.y)) / 2));
  const height = Math.max(1, Math.round((Math.hypot(bl.x - tl.x, bl.y - tl.y) + Math.hypot(br.x - tr.x, br.y - tr.y)) / 2));
  const rgba = new Uint8ClampedArray(width * height * 4);
  const covers = card.coveredBy ?? [];
  const covered = (x: number, y: number): boolean => covers.some((cover) => insidePolygon(cover, x, y));
  // Where a card laid over it covers it, its own paper is put back: the median colour of what of it shows.
  let paper: number[] | null = null;
  if (covers.length > 0) {
    const channels: number[][] = [[], [], [], []];
    for (let v = 0.05; v < 1; v += 0.05) {
      for (let u = 0.05; u < 1; u += 0.05) {
        const sx = (1 - u) * (1 - v) * tl.x + u * (1 - v) * tr.x + u * v * br.x + (1 - u) * v * bl.x;
        const sy = (1 - u) * (1 - v) * tl.y + u * (1 - v) * tr.y + u * v * br.y + (1 - u) * v * bl.y;
        if (covered(sx, sy)) continue;
        const from = (Math.min(image.height - 1, Math.max(0, Math.floor(sy))) * image.width + Math.min(image.width - 1, Math.max(0, Math.floor(sx)))) * 4;
        for (let c = 0; c < 4; c++) channels[c]!.push(image.rgba[from + c]!);
      }
    }
    paper = channels.map((values) => values.sort((a, b) => a - b)[values.length >> 1] ?? 255);
  }
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const sx = (1 - u) * (1 - v) * tl.x + u * (1 - v) * tr.x + u * v * br.x + (1 - u) * v * bl.x;
      const sy = (1 - u) * (1 - v) * tl.y + u * (1 - v) * tr.y + u * v * br.y + (1 - u) * v * bl.y;
      const to = (y * width + x) * 4;
      if (paper !== null && covered(sx, sy)) {
        for (let c = 0; c < 4; c++) rgba[to + c] = paper[c]!;
        continue;
      }
      const from = (Math.min(image.height - 1, Math.max(0, Math.floor(sy))) * image.width + Math.min(image.width - 1, Math.max(0, Math.floor(sx)))) * 4;
      for (let c = 0; c < 4; c++) rgba[to + c] = image.rgba[from + c]!;
    }
  }
  return { width, height, rgba };
}

function polygonArea(corners: readonly Point[]): number {
  let twice = 0;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % corners.length]!;
    twice += a.x * b.y - b.x * a.y;
  }
  return Math.abs(twice) / 2;
}

function insidePolygon(corners: readonly Point[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = corners.length - 1; i < corners.length; j = i++) {
    const a = corners[i]!;
    const b = corners[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

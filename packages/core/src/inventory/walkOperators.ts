import type { Matrix, Rect } from '../geometry.js';
import { IDENTITY_MATRIX, multiplyMatrix, unitSquareBBox } from '../geometry.js';

/**
 * A single pass over one page's operator list (MDD annex A, Step 4). A pure
 * function: no I/O, no dependency on PDFPageProxy — testable with hand-written
 * opcode arrays. Consumes the result of `page.getOperatorList()` already
 * extracted by the caller (`inventory.ts`), not the page object itself.
 *
 * Opcode numbers verified directly in pdfjs-dist 6.1.200 (`OPS` in pdf.mjs;
 * `DrawOPS` in pdf.worker.mjs for constructPath's internal format) — not
 * imported from pdfjs-dist, so this module stays fully dependency-free.
 *
 * [Step 6 Z1c] Dispatch based on a TABLE of handlers (`HANDLERS`), not an
 * `if (op === OP_X)` chain. `HANDLED_OPCODES` is MECHANICALLY
 * `[...HANDLERS.keys()]` — not a hand-transcribed list. Twice in a row
 * (Step 4: cm, Step 5: constructPath) a hand-written assumption about
 * argsArray's shape turned out to be wrong, because the unit tests repeated
 * the same assumption as the implementation; the same faulty-assumption
 * mechanism affected the count of HANDLED opcodes in the shape snapshot (Z7,
 * Step 5) — that list was hand-transcribed there too, independent of this
 * file. The dispatch table removes the possibility of drift: adding a
 * handler WITHOUT adding it to `HANDLERS` is impossible, because that's one
 * and the same place in the code.
 */

const OP_SAVE = 10;
const OP_RESTORE = 11;
const OP_TRANSFORM = 12;
const OP_SET_FONT = 37;
const OP_PAINT_FORM_XOBJECT_BEGIN = 74;
const OP_PAINT_FORM_XOBJECT_END = 75;
const OP_BEGIN_GROUP = 76;
const OP_END_GROUP = 77;
const OP_PAINT_IMAGE_MASK_XOBJECT = 83;
const OP_PAINT_IMAGE_XOBJECT = 85;
const OP_PAINT_INLINE_IMAGE_XOBJECT = 86;
const OP_PAINT_IMAGE_XOBJECT_REPEAT = 88;
const OP_CONSTRUCT_PATH = 91;

// Sub-opcodes inside constructPath args[0] — from the general OPS (fill/stroke family).
const FILL_SUBOPS = new Set([22, 23, 24, 25, 26, 27]); // fill,eoFill,fillStroke,eoFillStroke,closeFillStroke,closeEOFillStroke
const STROKE_SUBOPS = new Set([20, 21, 24, 25, 26, 27]); // stroke,closeStroke,fillStroke,eoFillStroke,closeFillStroke,closeEOFillStroke

// DrawOPS — the internal format of a path packed inside constructPath (pdf.worker.mjs).
const DRAW_MOVE_TO = 0;
const DRAW_LINE_TO = 1;
const DRAW_CURVE_TO = 2;
const DRAW_QUADRATIC_CURVE_TO = 3;
const DRAW_CLOSE_PATH = 4;

export interface GroupContext {
  subtype: string | null;
  depth: number;
  beginIndex: number;
}

export type WalkEvent =
  | {
      type: 'image';
      opcode: number;
      objId: string | null;
      ctm: Matrix;
      bbox: Rect;
      inGroup: GroupContext | null;
      index: number;
      /**
       * [Step 16 Z1] The image resource's intrinsic resolution (/Width,
       * /Height pixels from the PDF content), NOT its size on the page
       * (which `bbox` already carries). Zero extra decoding — for
       * `paintImageXObject`, pdf.js itself places it in the operator list as
       * `args[1]`/`args[2]` (verified directly in `pdf.worker.mjs`,
       * PartialEvaluator.buildPaintImageXObject: `args = [objId, w, h]`,
       * where `w`/`h` come from `dict.get("W","Width")`/
       * `dict.get("H","Height")` — a PDF never emits this opcode without
       * both values as numbers, so for ordinary images this field is
       * practically always populated). For `paintImageMaskXObject` it's
       * similarly available in `args[0].width`/`args[0].height`.
       * `paintImageXObjectRepeat` (never observed in samples, see CLAUDE.md)
       * and `paintInlineImageXObject` (inline data, no object reference)
       * don't carry this information in the form collected here — `null` in
       * both cases.
       */
      intrinsicWidth: number | null;
      intrinsicHeight: number | null;
    }
  | { type: 'font'; fontName: string; sizeFromMatrix: number; index: number }
  | { type: 'vector'; kind: 'fill' | 'stroke'; bbox: Rect; ctm: Matrix; inGroup: GroupContext | null; index: number }
  | { type: 'group'; phase: 'begin' | 'end'; subtype: string | null; index: number };

export interface OperatorListLike {
  fnArray: number[];
  argsArray: unknown[][];
}

/** Float32Array/Float64Array become {0:n,1:n,...} after JSON serialization — handle both shapes. */
function toNumberArray(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw as number[];
  if (raw instanceof Float32Array || raw instanceof Float64Array) return Array.from(raw);
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, number>;
    const keys = Object.keys(obj).filter((k) => /^\d+$/.test(k));
    return keys.sort((a, b) => Number(a) - Number(b)).map((k) => obj[k]!);
  }
  return [];
}

/**
 * constructPath's arguments: args[1] is an ARRAY OF SUBPATHS, each packed
 * like a Float32Array (one simple `re` is usually 1 subpath) — NOT a flat
 * array of points directly, as originally assumed. Verified empirically
 * (Step 5 Z7, shape snapshot): real pdf.js gives
 * `array(len=1)<{0:n,...,12:n}>`, not a flat `{0:n,...,12:n}` by itself.
 * Distinguished by the type of the FIRST element: if it's a number, the
 * array is already flat (compatible with existing unit tests); otherwise
 * every element is a separate subpath to be flattened and concatenated.
 */
function flattenSubpaths(raw: unknown): number[] {
  if (raw instanceof Float32Array || raw instanceof Float64Array) return Array.from(raw);
  if (!Array.isArray(raw)) return toNumberArray(raw);
  if (raw.length === 0 || typeof raw[0] === 'number') return raw as number[];
  return (raw as unknown[]).flatMap((subpath) => toNumberArray(subpath));
}

function toMatrix(raw: unknown): Matrix {
  const n = toNumberArray(raw);
  return [n[0] ?? 1, n[1] ?? 0, n[2] ?? 0, n[3] ?? 1, n[4] ?? 0, n[5] ?? 0];
}

/**
 * The `cm` (transform) operator's arguments are in practice 6 FLAT elements
 * `[a,b,c,d,e,f]` in argsArray[i] — NOT nested inside args[0] (unlike, say,
 * setTextMatrix, where args[0] can be one packed matrix). Verified
 * empirically on a real file (Step 4) — the first version assumed nesting
 * and computed a wrong (identity) CTM, which only tests on fixtures
 * revealed, not unit tests on hand-written arrays (which repeated the same
 * faulty assumption).
 */
function matrixFromTransformArgs(args: unknown[]): Matrix {
  if (typeof args[0] === 'number') return toMatrix(args);
  return toMatrix(args[0]);
}

interface PathSegment {
  op: number;
  point: [number, number] | null; // the segment's end point (for moveTo/lineTo); null for closePath
}

function parsePathSegments(flat: number[]): PathSegment[] {
  const segments: PathSegment[] = [];
  let i = 0;
  while (i < flat.length) {
    const op = flat[i++]!;
    if (op === DRAW_MOVE_TO || op === DRAW_LINE_TO) {
      segments.push({ op, point: [flat[i]!, flat[i + 1]!] });
      i += 2;
    } else if (op === DRAW_CURVE_TO) {
      segments.push({ op, point: [flat[i + 4]!, flat[i + 5]!] });
      i += 6;
    } else if (op === DRAW_QUADRATIC_CURVE_TO) {
      segments.push({ op, point: [flat[i + 2]!, flat[i + 3]!] });
      i += 4;
    } else if (op === DRAW_CLOSE_PATH) {
      segments.push({ op, point: null });
    } else {
      // an opcode outside the known set — bail out safely, the path will be rejected as a non-rectangle
      return segments;
    }
  }
  return segments;
}

/**
 * Whether a path is an axis-aligned rectangle — the only shape of interest
 * for vector regions (a stat-block frame/background candidate). Curves and
 * arbitrary polygons are rejected (Step 4, Z4).
 */
function rectanglePoints(segments: PathSegment[]): Array<[number, number]> | null {
  if (segments.some((s) => s.op === DRAW_CURVE_TO || s.op === DRAW_QUADRATIC_CURVE_TO)) return null;

  const points: Array<[number, number]> = [];
  for (const s of segments) {
    if (s.point) points.push(s.point);
  }

  const dedup: Array<[number, number]> = [];
  for (const p of points) {
    const last = dedup[dedup.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) dedup.push(p);
  }
  if (dedup.length > 1) {
    const first = dedup[0]!;
    const last = dedup[dedup.length - 1]!;
    if (first[0] === last[0] && first[1] === last[1]) dedup.pop();
  }
  if (dedup.length !== 4) return null;

  for (let i = 0; i < 4; i++) {
    const a = dedup[i]!;
    const b = dedup[(i + 1) % 4]!;
    const dx = Math.abs(a[0] - b[0]);
    const dy = Math.abs(a[1] - b[1]);
    if (dx > 1e-6 && dy > 1e-6) return null; // a diagonal edge — not axis-aligned
  }
  return dedup;
}

function bboxFromLocalPoints(points: Array<[number, number]>, ctm: Matrix): Rect {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of points) {
    xs.push(ctm[0] * x + ctm[2] * y + ctm[4]);
    ys.push(ctm[1] * x + ctm[3] * y + ctm[5]);
  }
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/**
 * Extracts the image object id from an image opcode's arguments. The shape
 * differs between opcodes — verified empirically (Step 4):
 * - paintImageXObject / paintImageXObjectRepeat: args[0] is the string (objId) directly
 * - paintImageMaskXObject: args[0] is an object { data: objId, width, height, count }
 * - paintInlineImageXObject: no PDF object reference (inline data) — always null
 */
function extractImageObjId(opcode: number, args: unknown[]): string | null {
  if (opcode === OP_PAINT_INLINE_IMAGE_XOBJECT) return null;
  if (opcode === OP_PAINT_IMAGE_MASK_XOBJECT) {
    const arg0 = args[0] as { data?: string } | undefined;
    return arg0?.data ?? null;
  }
  return (args[0] as string) ?? null;
}

/**
 * [Step 16 Z1] Intrinsic resolution — see the comment on `WalkEvent['image']`.
 * `paintImageXObject`: args[1]/args[2] are the numbers `w`/`h` directly. `paintImageMaskXObject`:
 * args[0].width/height. The other opcodes (repeat, inline) don't carry this information here.
 */
function extractIntrinsicSize(opcode: number, args: unknown[]): { width: number | null; height: number | null } {
  if (opcode === OP_PAINT_IMAGE_MASK_XOBJECT) {
    const arg0 = args[0] as { width?: number; height?: number } | undefined;
    return {
      width: typeof arg0?.width === 'number' ? arg0.width : null,
      height: typeof arg0?.height === 'number' ? arg0.height : null,
    };
  }
  if (opcode === OP_PAINT_IMAGE_XOBJECT) {
    const w = args[1];
    const h = args[2];
    return {
      width: typeof w === 'number' ? w : null,
      height: typeof h === 'number' ? h : null,
    };
  }
  return { width: null, height: null };
}

interface WalkContext {
  events: WalkEvent[];
  ctm: Matrix;
  ctmStack: Matrix[];
  groupStack: GroupContext[];
}

type OpHandler = (ctx: WalkContext, args: unknown[], index: number) => void;

function currentGroup(ctx: WalkContext): GroupContext | null {
  return ctx.groupStack.length > 0 ? ctx.groupStack[ctx.groupStack.length - 1]! : null;
}

function handleImagePaint(opcode: number): OpHandler {
  return (ctx, args, index) => {
    const { width, height } = extractIntrinsicSize(opcode, args);
    ctx.events.push({
      type: 'image',
      opcode,
      objId: extractImageObjId(opcode, args),
      ctm: ctx.ctm,
      bbox: unitSquareBBox(ctx.ctm),
      inGroup: currentGroup(ctx),
      index,
      intrinsicWidth: width,
      intrinsicHeight: height,
    });
  };
}

/** The dispatch table: EVERY handled opcode must appear here as a key — `HANDLED_OPCODES` is its keys directly, not a separate list. */
const HANDLERS = new Map<number, OpHandler>([
  [
    OP_SAVE,
    (ctx) => {
      ctx.ctmStack.push(ctx.ctm);
    },
  ],
  [
    OP_RESTORE,
    (ctx) => {
      ctx.ctm = ctx.ctmStack.pop() ?? ctx.ctm;
    },
  ],
  [
    OP_TRANSFORM,
    (ctx, args) => {
      ctx.ctm = multiplyMatrix(ctx.ctm, matrixFromTransformArgs(args));
    },
  ],
  [
    OP_PAINT_FORM_XOBJECT_BEGIN,
    (ctx, args) => {
      // [Step 7, discovery] Per the PDF spec, executing a Form XObject is
      // implicitly q [form matrix] cm [content] Q — pdf.js hands this back
      // as paintFormXObjectBegin/End, NOT as save/restore. Without this
      // entry (treating it the same as save: store the CTM, possibly
      // compose it with the form's /Matrix), every `cm` INSIDE a form (very
      // common — luminosity masks, patterns, repeated content) would
      // PERMANENTLY change the CTM for EVERYTHING drawn AFTER the form
      // ended on the same page, up to the nearest `restore` from an outer
      // scope. Measured empirically: an image painted AFTER a luminosity
      // mask got a bbox multiplied by the mask form's CTM (10,000x instead
      // of 100x) — two completely unrelated images end up with an
      // IDENTICAL, absurd bbox.
      ctx.ctmStack.push(ctx.ctm);
      const formMatrix = args[0];
      if (formMatrix != null) {
        ctx.ctm = multiplyMatrix(ctx.ctm, toMatrix(formMatrix));
      }
    },
  ],
  [
    OP_PAINT_FORM_XOBJECT_END,
    (ctx) => {
      ctx.ctm = ctx.ctmStack.pop() ?? ctx.ctm;
    },
  ],
  [
    OP_SET_FONT,
    (ctx, args, index) => {
      const fontName = (args[0] as string) ?? '';
      const fontSize = (args[1] as number) ?? 0;
      // Approximation: scale from the CTM alone (without the text matrix Tm — that's
      // only tracked when text is actually drawn, outside the scope of this lightweight
      // pass; the precise per-glyph size is computed by inventory.ts from getTextContent()).
      const scale = Math.hypot(ctx.ctm[0], ctx.ctm[1]) || 1;
      ctx.events.push({ type: 'font', fontName, sizeFromMatrix: fontSize * scale, index });
    },
  ],
  [
    OP_BEGIN_GROUP,
    (ctx, args, index) => {
      const groupArgs = args[0] as { smask?: { subtype?: string } } | undefined;
      const subtype = groupArgs?.smask?.subtype ?? null;
      ctx.groupStack.push({ subtype, depth: ctx.groupStack.length + 1, beginIndex: index });
      ctx.events.push({ type: 'group', phase: 'begin', subtype, index });
    },
  ],
  [
    OP_END_GROUP,
    (ctx, _args, index) => {
      const g = ctx.groupStack.pop();
      ctx.events.push({ type: 'group', phase: 'end', subtype: g?.subtype ?? null, index });
    },
  ],
  [OP_PAINT_IMAGE_MASK_XOBJECT, handleImagePaint(OP_PAINT_IMAGE_MASK_XOBJECT)],
  [OP_PAINT_IMAGE_XOBJECT, handleImagePaint(OP_PAINT_IMAGE_XOBJECT)],
  [OP_PAINT_INLINE_IMAGE_XOBJECT, handleImagePaint(OP_PAINT_INLINE_IMAGE_XOBJECT)],
  [OP_PAINT_IMAGE_XOBJECT_REPEAT, handleImagePaint(OP_PAINT_IMAGE_XOBJECT_REPEAT)],
  [
    OP_CONSTRUCT_PATH,
    (ctx, args, index) => {
      const fillOrStroke = args[0] as number;
      const flat = flattenSubpaths(args[1]);
      const segments = parsePathSegments(flat);
      const rectPoints = rectanglePoints(segments);
      if (rectPoints) {
        const bbox = bboxFromLocalPoints(rectPoints, ctx.ctm);
        const inGroup = currentGroup(ctx);
        if (FILL_SUBOPS.has(fillOrStroke)) {
          ctx.events.push({ type: 'vector', kind: 'fill', bbox, ctm: ctx.ctm, inGroup, index });
        }
        if (STROKE_SUBOPS.has(fillOrStroke)) {
          ctx.events.push({ type: 'vector', kind: 'stroke', bbox, ctm: ctx.ctm, inGroup, index });
        }
      }
    },
  ],
]);

/**
 * [Step 6 Z1c] The set of opcodes ACTUALLY handled by `walkOperators` —
 * mechanically `[...HANDLERS.keys()]`, never a hand-transcribed list. Used
 * by the shape-snapshot test (Z7 from Step 5, now fixed), so that adding a
 * new handler without a matching snapshot entry is detected automatically,
 * not dependent on the author's memory.
 */
export const HANDLED_OPCODES: ReadonlySet<number> = new Set(HANDLERS.keys());

export function walkOperators(ops: OperatorListLike, _pageBox: Rect): WalkEvent[] {
  const ctx: WalkContext = { events: [], ctm: IDENTITY_MATRIX, ctmStack: [], groupStack: [] };

  const { fnArray, argsArray } = ops;
  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i]!;
    const args = argsArray[i] ?? [];
    HANDLERS.get(op)?.(ctx, args, i);
  }

  return ctx.events;
}

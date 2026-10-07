import { describe, expect, it } from 'vitest';
import { walkOperators, type WalkEvent } from '../../src/inventory/walkOperators.js';

// Opcode numbers by hand, verified directly in pdfjs-dist 6.1.200 (OPS in pdf.mjs, DrawOPS in
// pdf.worker.mjs) — see the comment at the top of walkOperators.ts.
const SAVE = 10;
const RESTORE = 11;
const TRANSFORM = 12;
const SET_FONT = 37;
const BEGIN_GROUP = 76;
const END_GROUP = 77;
const PAINT_IMAGE_MASK_XOBJECT = 83;
const PAINT_IMAGE_XOBJECT = 85;
const PAINT_INLINE_IMAGE_XOBJECT = 86;
const PAINT_IMAGE_XOBJECT_REPEAT = 88;
const CONSTRUCT_PATH = 91;

const FILL = 22;
const FILL_STROKE = 24;

const DRAW_MOVE_TO = 0;
const DRAW_LINE_TO = 1;
const DRAW_CURVE_TO = 2;
const DRAW_CLOSE_PATH = 4;

const PAGE_BOX = { minX: 0, minY: 0, maxX: 612, maxY: 792 };

function imagesOf(events: WalkEvent[]) {
  return events.filter((e): e is Extract<WalkEvent, { type: 'image' }> => e.type === 'image');
}
function vectorsOf(events: WalkEvent[]) {
  return events.filter((e): e is Extract<WalkEvent, { type: 'vector' }> => e.type === 'vector');
}
function fontsOf(events: WalkEvent[]) {
  return events.filter((e): e is Extract<WalkEvent, { type: 'font' }> => e.type === 'font');
}
function groupsOf(events: WalkEvent[]) {
  return events.filter((e): e is Extract<WalkEvent, { type: 'group' }> => e.type === 'group');
}

describe('walkOperators — CTM and nested save/restore', () => {
  it('computes the image bbox correctly after a cm inside save/restore', () => {
    const fnArray = [SAVE, TRANSFORM, PAINT_IMAGE_XOBJECT, RESTORE];
    const argsArray: unknown[][] = [[], [100, 0, 0, 50, 10, 20], ['Im1', 4, 4], []];
    const events = walkOperators({ fnArray, argsArray }, PAGE_BOX);
    const images = imagesOf(events);
    expect(images).toHaveLength(1);
    expect(images[0]!.objId).toBe('Im1');
    // a unit square through cm [100,0,0,50,10,20] -> [10,20]..[110,70]
    expect(images[0]!.bbox).toEqual({ minX: 10, minY: 20, maxX: 110, maxY: 70 });
  });

  it('restore restores the CTM from before save (two-level nesting)', () => {
    const fnArray = [SAVE, TRANSFORM, SAVE, TRANSFORM, PAINT_IMAGE_XOBJECT, RESTORE, PAINT_IMAGE_XOBJECT, RESTORE];
    const argsArray: unknown[][] = [
      [],
      [2, 0, 0, 2, 0, 0], // the outer cm: scale x2
      [],
      [1, 0, 0, 1, 100, 100], // the inner cm: a translation
      ['Inner', 1, 1],
      [],
      ['Outer', 1, 1],
      [],
    ];
    const events = walkOperators({ fnArray, argsArray }, PAGE_BOX);
    const images = imagesOf(events);
    expect(images).toHaveLength(2);
    // Inner: CTM = scale(2) * translate(100,100) -> the unit square in [200,200]..[202,202]
    expect(images[0]!.objId).toBe('Inner');
    expect(images[0]!.bbox).toEqual({ minX: 200, minY: 200, maxX: 202, maxY: 202 });
    // Outer: after restore back to just the x2 scale -> [0,0]..[2,2]
    expect(images[1]!.objId).toBe('Outer');
    expect(images[1]!.bbox).toEqual({ minX: 0, minY: 0, maxX: 2, maxY: 2 });
  });

  it('a bbox with negative coordinates (print bleed) is not clipped', () => {
    const fnArray = [TRANSFORM, PAINT_IMAGE_XOBJECT];
    const argsArray: unknown[][] = [[692, 0, 0, 892, -40, -50], ['Bg', 1, 1]];
    const events = walkOperators({ fnArray, argsArray }, PAGE_BOX);
    expect(imagesOf(events)[0]!.bbox).toEqual({ minX: -40, minY: -50, maxX: 652, maxY: 842 });
  });
});

describe('walkOperators — groups (Luminosity)', () => {
  it('an image inside beginGroup/Luminosity has inGroup filled in', () => {
    const fnArray = [BEGIN_GROUP, PAINT_IMAGE_XOBJECT, END_GROUP, PAINT_IMAGE_XOBJECT];
    const argsArray: unknown[][] = [[{ smask: { subtype: 'Luminosity' } }], ['Masked', 1, 1], [{}], ['Unmasked', 1, 1]];
    const events = walkOperators({ fnArray, argsArray }, PAGE_BOX);
    const images = imagesOf(events);
    expect(images[0]!.objId).toBe('Masked');
    expect(images[0]!.inGroup?.subtype).toBe('Luminosity');
    expect(images[1]!.objId).toBe('Unmasked');
    expect(images[1]!.inGroup).toBeNull();

    const groups = groupsOf(events);
    expect(groups).toEqual([
      { type: 'group', phase: 'begin', subtype: 'Luminosity', index: 0 },
      { type: 'group', phase: 'end', subtype: 'Luminosity', index: 2 },
    ]);
  });

  it('nested groups — the inner one refers to the nearest enclosing one', () => {
    const fnArray = [BEGIN_GROUP, BEGIN_GROUP, PAINT_IMAGE_XOBJECT, END_GROUP, END_GROUP];
    const argsArray: unknown[][] = [[{}], [{ smask: { subtype: 'Luminosity' } }], ['Im', 1, 1], [{}], [{}]];
    const events = walkOperators({ fnArray, argsArray }, PAGE_BOX);
    expect(imagesOf(events)[0]!.inGroup?.subtype).toBe('Luminosity');
    expect(imagesOf(events)[0]!.inGroup?.depth).toBe(2);
  });
});

describe('walkOperators — images: different argument shapes per opcode', () => {
  it('paintImageMaskXObject extracts the objId from args[0].data (not args[0] directly)', () => {
    const fnArray = [PAINT_IMAGE_MASK_XOBJECT];
    const argsArray: unknown[][] = [[{ data: 'mask_p0_1', width: 2, height: 2, count: 1 }]];
    const events = walkOperators({ fnArray, argsArray }, PAGE_BOX);
    expect(imagesOf(events)[0]!.objId).toBe('mask_p0_1');
    expect(imagesOf(events)[0]!.opcode).toBe(PAINT_IMAGE_MASK_XOBJECT);
  });

  // Internal resolution — zero-decode, straight from the operator list.
  it('paintImageXObject extracts intrinsicWidth/Height from args[1]/args[2]', () => {
    const fnArray = [PAINT_IMAGE_XOBJECT];
    const argsArray: unknown[][] = [['Im1', 1024, 768]];
    const events = walkOperators({ fnArray, argsArray }, PAGE_BOX);
    expect(imagesOf(events)[0]!.intrinsicWidth).toBe(1024);
    expect(imagesOf(events)[0]!.intrinsicHeight).toBe(768);
  });

  it('paintImageMaskXObject extracts intrinsicWidth/Height from args[0].width/height', () => {
    const fnArray = [PAINT_IMAGE_MASK_XOBJECT];
    const argsArray: unknown[][] = [[{ data: 'mask_p0_1', width: 300, height: 200, count: 1 }]];
    const events = walkOperators({ fnArray, argsArray }, PAGE_BOX);
    expect(imagesOf(events)[0]!.intrinsicWidth).toBe(300);
    expect(imagesOf(events)[0]!.intrinsicHeight).toBe(200);
  });

  it('paintInlineImageXObject has no objId (inline data, no object reference)', () => {
    const fnArray = [PAINT_INLINE_IMAGE_XOBJECT];
    const argsArray: unknown[][] = [[{ width: 2, height: 2, data: new Uint8Array([1, 2, 3]) }]];
    const events = walkOperators({ fnArray, argsArray }, PAGE_BOX);
    expect(imagesOf(events)[0]!.objId).toBeNull();
    // No object reference -> no resolution either in this collected form (see the comment on WalkEvent).
    expect(imagesOf(events)[0]!.intrinsicWidth).toBeNull();
    expect(imagesOf(events)[0]!.intrinsicHeight).toBeNull();
  });

  it('paintImageXObjectRepeat treated like paintImageXObject (the objId directly in args[0])', () => {
    const fnArray = [PAINT_IMAGE_XOBJECT_REPEAT];
    const argsArray: unknown[][] = [['Tile', 10, 10]];
    const events = walkOperators({ fnArray, argsArray }, PAGE_BOX);
    expect(imagesOf(events)[0]!.objId).toBe('Tile');
  });
});

describe('walkOperators — fonts', () => {
  it('setFont emits a font event with a size scaled by the CTM', () => {
    const fnArray = [TRANSFORM, SET_FONT];
    const argsArray: unknown[][] = [[2, 0, 0, 2, 0, 0], ['g_d0_f1', 12]];
    const events = walkOperators({ fnArray, argsArray }, PAGE_BOX);
    const fonts = fontsOf(events);
    expect(fonts).toHaveLength(1);
    expect(fonts[0]!.fontName).toBe('g_d0_f1');
    expect(fonts[0]!.sizeFromMatrix).toBe(24); // 12 * scale x2
  });
});

describe('walkOperators — vector regions (rectangles only)', () => {
  it('constructPath with 4 axis-aligned segments + fill gives a vector event', () => {
    // re 100 100 200 50 -> moveTo(100,100) lineTo(300,100) lineTo(300,150) lineTo(100,150) closePath
    const flat = [DRAW_MOVE_TO, 100, 100, DRAW_LINE_TO, 300, 100, DRAW_LINE_TO, 300, 150, DRAW_LINE_TO, 100, 150, DRAW_CLOSE_PATH];
    const fnArray = [CONSTRUCT_PATH];
    const argsArray: unknown[][] = [[FILL, flat, [100, 100, 300, 150]]];
    const events = walkOperators({ fnArray, argsArray }, PAGE_BOX);
    const vectors = vectorsOf(events);
    expect(vectors).toHaveLength(1);
    expect(vectors[0]!.kind).toBe('fill');
    expect(vectors[0]!.bbox).toEqual({ minX: 100, minY: 100, maxX: 300, maxY: 150 });
    expect(vectors[0]!.inGroup).toBeNull();
  });

  it('a fill inside beginGroup/Luminosity has inGroup filled in', () => {
    const flat = [DRAW_MOVE_TO, 0, 0, DRAW_LINE_TO, 10, 0, DRAW_LINE_TO, 10, 10, DRAW_LINE_TO, 0, 10, DRAW_CLOSE_PATH];
    const fnArray = [BEGIN_GROUP, CONSTRUCT_PATH, END_GROUP];
    const argsArray: unknown[][] = [[{ smask: { subtype: 'Luminosity' } }], [FILL, flat, [0, 0, 10, 10]], [{}]];
    const events = walkOperators({ fnArray, argsArray }, PAGE_BOX);
    const vectors = vectorsOf(events);
    expect(vectors).toHaveLength(1);
    expect(vectors[0]!.inGroup?.subtype).toBe('Luminosity');
  });

  it('fillStroke gives TWO events (fill and stroke) for the same rectangle', () => {
    const flat = [DRAW_MOVE_TO, 0, 0, DRAW_LINE_TO, 10, 0, DRAW_LINE_TO, 10, 10, DRAW_LINE_TO, 0, 10, DRAW_CLOSE_PATH];
    const fnArray = [CONSTRUCT_PATH];
    const argsArray: unknown[][] = [[FILL_STROKE, flat, [0, 0, 10, 10]]];
    const events = walkOperators({ fnArray, argsArray }, PAGE_BOX);
    const vectors = vectorsOf(events);
    expect(vectors.map((v) => v.kind).sort()).toEqual(['fill', 'stroke']);
  });

  it('a path with a curve (curveTo) is REJECTED — it is not a rectangle', () => {
    const flat = [DRAW_MOVE_TO, 0, 0, DRAW_CURVE_TO, 1, 1, 2, 2, 10, 10, DRAW_CLOSE_PATH];
    const fnArray = [CONSTRUCT_PATH];
    const argsArray: unknown[][] = [[FILL, flat, [0, 0, 10, 10]]];
    const events = walkOperators({ fnArray, argsArray }, PAGE_BOX);
    expect(vectorsOf(events)).toHaveLength(0);
  });

  it('a diagonal path (a non-axis-aligned parallelogram) is REJECTED', () => {
    const flat = [DRAW_MOVE_TO, 0, 0, DRAW_LINE_TO, 10, 5, DRAW_LINE_TO, 20, 10, DRAW_LINE_TO, 10, 15, DRAW_CLOSE_PATH];
    const fnArray = [CONSTRUCT_PATH];
    const argsArray: unknown[][] = [[FILL, flat, [0, 0, 20, 15]]];
    const events = walkOperators({ fnArray, argsArray }, PAGE_BOX);
    expect(vectorsOf(events)).toHaveLength(0);
  });

  it('polygons with !=4 points are REJECTED', () => {
    // a triangle
    const flat = [DRAW_MOVE_TO, 0, 0, DRAW_LINE_TO, 10, 0, DRAW_LINE_TO, 5, 10, DRAW_CLOSE_PATH];
    const fnArray = [CONSTRUCT_PATH];
    const argsArray: unknown[][] = [[FILL, flat, [0, 0, 10, 10]]];
    const events = walkOperators({ fnArray, argsArray }, PAGE_BOX);
    expect(vectorsOf(events)).toHaveLength(0);
  });
});

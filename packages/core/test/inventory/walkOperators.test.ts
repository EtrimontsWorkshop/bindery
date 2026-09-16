import { describe, expect, it } from 'vitest';
import { walkOperators, type WalkEvent } from '../../src/inventory/walkOperators.js';

// Numery opcode'ow recznie, zweryfikowane wprost w pdfjs-dist 6.1.200 (OPS w pdf.mjs,
// DrawOPS w pdf.worker.mjs) — patrz komentarz na gorze walkOperators.ts.
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

describe('walkOperators — CTM i save/restore zagniezdzone', () => {
  it('liczy bbox obrazu poprawnie po cm wewnatrz save/restore', () => {
    const fnArray = [SAVE, TRANSFORM, PAINT_IMAGE_XOBJECT, RESTORE];
    const argsArray: unknown[][] = [[], [100, 0, 0, 50, 10, 20], ['Im1', 4, 4], []];
    const events = walkOperators({ fnArray, argsArray }, PAGE_BOX);
    const images = imagesOf(events);
    expect(images).toHaveLength(1);
    expect(images[0]!.objId).toBe('Im1');
    // jednostkowy kwadrat przez cm [100,0,0,50,10,20] -> [10,20]..[110,70]
    expect(images[0]!.bbox).toEqual({ minX: 10, minY: 20, maxX: 110, maxY: 70 });
  });

  it('restore przywraca CTM sprzed save (zagniezdzenie dwupoziomowe)', () => {
    const fnArray = [SAVE, TRANSFORM, SAVE, TRANSFORM, PAINT_IMAGE_XOBJECT, RESTORE, PAINT_IMAGE_XOBJECT, RESTORE];
    const argsArray: unknown[][] = [
      [],
      [2, 0, 0, 2, 0, 0], // zewnetrzny cm: skala x2
      [],
      [1, 0, 0, 1, 100, 100], // wewnetrzny cm: przesuniecie
      ['Inner', 1, 1],
      [],
      ['Outer', 1, 1],
      [],
    ];
    const events = walkOperators({ fnArray, argsArray }, PAGE_BOX);
    const images = imagesOf(events);
    expect(images).toHaveLength(2);
    // Inner: CTM = scale(2) * translate(100,100) -> jednostkowy kwadrat w [200,200]..[202,202]
    expect(images[0]!.objId).toBe('Inner');
    expect(images[0]!.bbox).toEqual({ minX: 200, minY: 200, maxX: 202, maxY: 202 });
    // Outer: po restore z powrotem do samej skali x2 -> [0,0]..[2,2]
    expect(images[1]!.objId).toBe('Outer');
    expect(images[1]!.bbox).toEqual({ minX: 0, minY: 0, maxX: 2, maxY: 2 });
  });

  it('bbox z ujemnymi wspolrzednymi (spad drukarski) nie jest przycinany', () => {
    const fnArray = [TRANSFORM, PAINT_IMAGE_XOBJECT];
    const argsArray: unknown[][] = [[692, 0, 0, 892, -40, -50], ['Bg', 1, 1]];
    const events = walkOperators({ fnArray, argsArray }, PAGE_BOX);
    expect(imagesOf(events)[0]!.bbox).toEqual({ minX: -40, minY: -50, maxX: 652, maxY: 842 });
  });
});

describe('walkOperators — grupy (Luminosity)', () => {
  it('obraz wewnatrz beginGroup/Luminosity ma wypelnione inGroup', () => {
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

  it('zagniezdzone grupy — wewnetrzna referuje najblizsza otaczajaca', () => {
    const fnArray = [BEGIN_GROUP, BEGIN_GROUP, PAINT_IMAGE_XOBJECT, END_GROUP, END_GROUP];
    const argsArray: unknown[][] = [[{}], [{ smask: { subtype: 'Luminosity' } }], ['Im', 1, 1], [{}], [{}]];
    const events = walkOperators({ fnArray, argsArray }, PAGE_BOX);
    expect(imagesOf(events)[0]!.inGroup?.subtype).toBe('Luminosity');
    expect(imagesOf(events)[0]!.inGroup?.depth).toBe(2);
  });
});

describe('walkOperators — obrazy: rozne ksztalty argumentow per opcode', () => {
  it('paintImageMaskXObject wyciaga objId z args[0].data (nie args[0] wprost)', () => {
    const fnArray = [PAINT_IMAGE_MASK_XOBJECT];
    const argsArray: unknown[][] = [[{ data: 'mask_p0_1', width: 2, height: 2, count: 1 }]];
    const events = walkOperators({ fnArray, argsArray }, PAGE_BOX);
    expect(imagesOf(events)[0]!.objId).toBe('mask_p0_1');
    expect(imagesOf(events)[0]!.opcode).toBe(PAINT_IMAGE_MASK_XOBJECT);
  });

  // [KROK-16 Z1] Rozdzielczosc wewnetrzna — zero-decode, prosto z operator listy.
  it('paintImageXObject wyciaga intrinsicWidth/Height z args[1]/args[2]', () => {
    const fnArray = [PAINT_IMAGE_XOBJECT];
    const argsArray: unknown[][] = [['Im1', 1024, 768]];
    const events = walkOperators({ fnArray, argsArray }, PAGE_BOX);
    expect(imagesOf(events)[0]!.intrinsicWidth).toBe(1024);
    expect(imagesOf(events)[0]!.intrinsicHeight).toBe(768);
  });

  it('paintImageMaskXObject wyciaga intrinsicWidth/Height z args[0].width/height', () => {
    const fnArray = [PAINT_IMAGE_MASK_XOBJECT];
    const argsArray: unknown[][] = [[{ data: 'mask_p0_1', width: 300, height: 200, count: 1 }]];
    const events = walkOperators({ fnArray, argsArray }, PAGE_BOX);
    expect(imagesOf(events)[0]!.intrinsicWidth).toBe(300);
    expect(imagesOf(events)[0]!.intrinsicHeight).toBe(200);
  });

  it('paintInlineImageXObject nie ma objId (dane inline, brak referencji obiektu)', () => {
    const fnArray = [PAINT_INLINE_IMAGE_XOBJECT];
    const argsArray: unknown[][] = [[{ width: 2, height: 2, data: new Uint8Array([1, 2, 3]) }]];
    const events = walkOperators({ fnArray, argsArray }, PAGE_BOX);
    expect(imagesOf(events)[0]!.objId).toBeNull();
    // Brak referencji obiektu -> tez brak rozdzielczosci w tej zebranej postaci (patrz komentarz na WalkEvent).
    expect(imagesOf(events)[0]!.intrinsicWidth).toBeNull();
    expect(imagesOf(events)[0]!.intrinsicHeight).toBeNull();
  });

  it('paintImageXObjectRepeat traktowany jak paintImageXObject (objId wprost w args[0])', () => {
    const fnArray = [PAINT_IMAGE_XOBJECT_REPEAT];
    const argsArray: unknown[][] = [['Tile', 10, 10]];
    const events = walkOperators({ fnArray, argsArray }, PAGE_BOX);
    expect(imagesOf(events)[0]!.objId).toBe('Tile');
  });
});

describe('walkOperators — fonty', () => {
  it('setFont emituje zdarzenie font z rozmiarem przeskalowanym przez CTM', () => {
    const fnArray = [TRANSFORM, SET_FONT];
    const argsArray: unknown[][] = [[2, 0, 0, 2, 0, 0], ['g_d0_f1', 12]];
    const events = walkOperators({ fnArray, argsArray }, PAGE_BOX);
    const fonts = fontsOf(events);
    expect(fonts).toHaveLength(1);
    expect(fonts[0]!.fontName).toBe('g_d0_f1');
    expect(fonts[0]!.sizeFromMatrix).toBe(24); // 12 * skala x2
  });
});

describe('walkOperators — regiony wektorowe (tylko prostokaty)', () => {
  it('constructPath z 4 segmentami osiowo zorientowanymi + fill daje event vector', () => {
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

  it('[KROK-5 Z6, dlug KROK-4] wypelnienie wewnatrz beginGroup/Luminosity ma wypelnione inGroup', () => {
    const flat = [DRAW_MOVE_TO, 0, 0, DRAW_LINE_TO, 10, 0, DRAW_LINE_TO, 10, 10, DRAW_LINE_TO, 0, 10, DRAW_CLOSE_PATH];
    const fnArray = [BEGIN_GROUP, CONSTRUCT_PATH, END_GROUP];
    const argsArray: unknown[][] = [[{ smask: { subtype: 'Luminosity' } }], [FILL, flat, [0, 0, 10, 10]], [{}]];
    const events = walkOperators({ fnArray, argsArray }, PAGE_BOX);
    const vectors = vectorsOf(events);
    expect(vectors).toHaveLength(1);
    expect(vectors[0]!.inGroup?.subtype).toBe('Luminosity');
  });

  it('fillStroke daje DWA zdarzenia (fill i stroke) dla tego samego prostokata', () => {
    const flat = [DRAW_MOVE_TO, 0, 0, DRAW_LINE_TO, 10, 0, DRAW_LINE_TO, 10, 10, DRAW_LINE_TO, 0, 10, DRAW_CLOSE_PATH];
    const fnArray = [CONSTRUCT_PATH];
    const argsArray: unknown[][] = [[FILL_STROKE, flat, [0, 0, 10, 10]]];
    const events = walkOperators({ fnArray, argsArray }, PAGE_BOX);
    const vectors = vectorsOf(events);
    expect(vectors.map((v) => v.kind).sort()).toEqual(['fill', 'stroke']);
  });

  it('sciezka z krzywa (curveTo) jest ODRZUCONA — nie jest prostokatem', () => {
    const flat = [DRAW_MOVE_TO, 0, 0, DRAW_CURVE_TO, 1, 1, 2, 2, 10, 10, DRAW_CLOSE_PATH];
    const fnArray = [CONSTRUCT_PATH];
    const argsArray: unknown[][] = [[FILL, flat, [0, 0, 10, 10]]];
    const events = walkOperators({ fnArray, argsArray }, PAGE_BOX);
    expect(vectorsOf(events)).toHaveLength(0);
  });

  it('sciezka po przekatnej (rownoleglobok nieosiowy) jest ODRZUCONA', () => {
    const flat = [DRAW_MOVE_TO, 0, 0, DRAW_LINE_TO, 10, 5, DRAW_LINE_TO, 20, 10, DRAW_LINE_TO, 10, 15, DRAW_CLOSE_PATH];
    const fnArray = [CONSTRUCT_PATH];
    const argsArray: unknown[][] = [[FILL, flat, [0, 0, 20, 15]]];
    const events = walkOperators({ fnArray, argsArray }, PAGE_BOX);
    expect(vectorsOf(events)).toHaveLength(0);
  });

  it('wieloboki o !=4 punktach sa ODRZUCONE', () => {
    // trojkat
    const flat = [DRAW_MOVE_TO, 0, 0, DRAW_LINE_TO, 10, 0, DRAW_LINE_TO, 5, 10, DRAW_CLOSE_PATH];
    const fnArray = [CONSTRUCT_PATH];
    const argsArray: unknown[][] = [[FILL, flat, [0, 0, 10, 10]]];
    const events = walkOperators({ fnArray, argsArray }, PAGE_BOX);
    expect(vectorsOf(events)).toHaveLength(0);
  });
});

import type { Matrix, Rect } from '../geometry.js';
import { IDENTITY_MATRIX, multiplyMatrix, unitSquareBBox } from '../geometry.js';

/**
 * Jednokrotne przejscie po operator liscie jednej strony (MDD zal. A, KROK-4).
 * Funkcja czysta: brak I/O, brak zaleznosci od PDFPageProxy — testowalna na
 * recznie napisanych tablicach opcode'ow. Konsumuje wynik `page.getOperatorList()`
 * juz wyciagniety przez wolajacego (`inventory.ts`), nie sam obiekt strony.
 *
 * Numery opcode'ow zweryfikowane wprost w pdfjs-dist 6.1.200 (`OPS` w pdf.mjs;
 * `DrawOPS` w pdf.worker.mjs dla wewnetrznego formatu constructPath) — nie
 * zaimportowane z pdfjs-dist, zeby ten modul pozostal w pelni bezzaleznosciowy.
 *
 * [KROK-6 Z1c] Dispatch oparty o TABLICE handlerow (`HANDLERS`), nie lancuch
 * `if (op === OP_X)`. `HANDLED_OPCODES` to MECHANICZNIE `[...HANDLERS.keys()]` —
 * nie recznie przepisana lista. Dwa razy pod rzad (KROK-4: cm, KROK-5:
 * constructPath) reczne zalozenie o ksztalcie argsArray okazalo sie bledne, bo
 * testy jednostkowe powielaly to samo zalozenie co implementacja; ten sam
 * mechanizm blednego zalozenia dotyczyl liczby OBSLUGIWANYCH opcode'ow w
 * snapshocie ksztaltow (Z7, KROK-5) — lista tam byla recznie przepisana,
 * niezalezna od tego pliku. Dispatch-table usuwa mozliwosc rozjazdu: dodanie
 * handlera BEZ dodania go do `HANDLERS` jest niemozliwe, bo to jedno i to samo
 * miejsce w kodzie.
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

// Sub-opcode'y wewnatrz constructPath args[0] — z ogolnego OPS (fill/stroke rodzina).
const FILL_SUBOPS = new Set([22, 23, 24, 25, 26, 27]); // fill,eoFill,fillStroke,eoFillStroke,closeFillStroke,closeEOFillStroke
const STROKE_SUBOPS = new Set([20, 21, 24, 25, 26, 27]); // stroke,closeStroke,fillStroke,eoFillStroke,closeFillStroke,closeEOFillStroke

// DrawOPS — format wewnetrzny sciezki spakowanej w constructPath (pdf.worker.mjs).
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
       * [KROK-16 Z1] Rozdzielczosc wewnetrzna zasobu obrazu (piksele /Width,
       * /Height z tresci PDF), NIE rozmiar na stronie (ten niesie juz `bbox`).
       * Zero dodatkowego dekodowania — dla `paintImageXObject` pdf.js sam
       * umieszcza je w operator liscie jako `args[1]`/`args[2]` (zweryfikowane
       * wprost w `pdf.worker.mjs`, PartialEvaluator.buildPaintImageXObject:
       * `args = [objId, w, h]`, gdzie `w`/`h` to `dict.get("W","Width")`/
       * `dict.get("H","Height")` — PDF nigdy nie emituje tego opcode'u bez
       * obu wartosci jako liczb, wiec dla zwyklych obrazow to pole jest
       * praktycznie zawsze wypelnione). Dla `paintImageMaskXObject` analogicznie
       * dostepne w `args[0].width`/`args[0].height`. `paintImageXObjectRepeat`
       * (nigdy nie zaobserwowany w probkach, patrz CLAUDE.md) i
       * `paintInlineImageXObject` (dane inline, bez referencji obiektu) nie
       * niosa tej informacji w zebranej tu postaci — `null` w obu przypadkach.
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

/** Float32Array/Float64Array po serializacji JSON staja sie {0:n,1:n,...} — obsluz oba ksztalty. */
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
 * Argumenty constructPath: args[1] jest TABLICA PODSCIEZEK, kazda spakowana
 * jak Float32Array (jeden prosty `re` to zwykle 1 podsciezke) — NIE plaska
 * tablica punktow wprost, jak pierwotnie zalozono. Zweryfikowane empirycznie
 * (KROK-5 Z7, snapshot ksztaltow): prawdziwy pdf.js daje
 * `array(len=1)<{0:n,...,12:n}>`, nie plaski `{0:n,...,12:n}` sam w sobie.
 * Rozroznienie po typie PIERWSZEGO elementu: jesli to liczba, tablica jest juz
 * plaska (kompatybilnosc z istniejacymi testami jednostkowymi); w przeciwnym
 * razie kazdy element to osobna podsciezka do splaszczenia i polaczenia.
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
 * Argumenty operatora `cm` (transform) sa w praktyce 6 PLASKIMI elementami
 * `[a,b,c,d,e,f]` w argsArray[i] — NIE zagniezdzone w args[0] (w odroznieniu od
 * np. setTextMatrix, gdzie args[0] bywa jedna spakowana macierza). Zweryfikowane
 * empirycznie na realnym pliku (KROK-4) — pierwsza wersja zakladala zagniezdzenie
 * i liczyla bledny (tozsamosciowy) CTM, co ujawnily dopiero testy na fixture'ach,
 * nie testy jednostkowe na recznie napisanych tablicach (ktore powielaly to samo
 * bledne zalozenie).
 */
function matrixFromTransformArgs(args: unknown[]): Matrix {
  if (typeof args[0] === 'number') return toMatrix(args);
  return toMatrix(args[0]);
}

interface PathSegment {
  op: number;
  point: [number, number] | null; // punkt koncowy segmentu (dla moveTo/lineTo); null dla closePath
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
      // opcode spoza znanego zestawu — przerwij bezpiecznie, sciezka zostanie odrzucona jako nie-prostokat
      return segments;
    }
  }
  return segments;
}

/**
 * Czy sciezka to prostokat osiowo zorientowany — jedyny ksztalt interesujacy dla
 * regionow wektorowych (kandydat na ramke/tlo statblocku). Krzywe i dowolne
 * wieloboki sa odrzucane (KROK-4, Z4).
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
    if (dx > 1e-6 && dy > 1e-6) return null; // krawedz po przekatnej — nie osiowo zorientowany
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
 * Wyciaga id obiektu obrazu z argumentow opcode'u obrazowego. Ksztalt roznicuje
 * sie miedzy opcode'ami — zweryfikowane empirycznie (KROK-4):
 * - paintImageXObject / paintImageXObjectRepeat: args[0] to string (objId) wprost
 * - paintImageMaskXObject: args[0] to obiekt { data: objId, width, height, count }
 * - paintInlineImageXObject: brak referencji obiektu PDF (dane inline) — zawsze null
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
 * [KROK-16 Z1] Rozdzielczosc wewnetrzna — patrz komentarz przy `WalkEvent['image']`.
 * `paintImageXObject`: args[1]/args[2] to liczby `w`/`h` wprost. `paintImageMaskXObject`:
 * args[0].width/height. Pozostale opcode'y (repeat, inline) nie niosa tej informacji tutaj.
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

/** Tabela dispatch: KAZDY obslugiwany opcode musi tu wystapic jako klucz — `HANDLED_OPCODES` to jej klucze wprost, nie oddzielna lista. */
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
      // [KROK-7, odkrycie] Wykonanie Form XObject to wg specyfikacji PDF
      // niejawne q [macierz formy] cm [tresc] Q — pdf.js oddaje to jako
      // paintFormXObjectBegin/End, NIE jako save/restore. Bez tego wpisu
      // (traktujac je tak samo jak save: zapisz CTM, ewentualnie zloz z
      // /Matrix formy) kazdy `cm` WEWNATRZ formy (bardzo czeste — maski
      // luminancyjne, wzorce, powtarzalne tresci) TRWALE zmienial CTM dla
      // WSZYSTKIEGO narysowanego PO zakonczeniu formy na tej samej stronie,
      // az do najblizszego `restore` z zewnetrznego zakresu. Zmierzone
      // empirycznie: obraz namalowany PO masce luminancyjnej dostawal bbox
      // przemnozony przez CTM formy maski (10 000x zamiast 100x) — dwa
      // zupelnie niepowiazane obrazy koncza z IDENTYCZNYM, absurdalnym bboksem.
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
      // Przyblizenie: skala z samego CTM (bez macierzy tekstu Tm — ta jest sledzona
      // dopiero przy faktycznym rysowaniu tekstu, poza zakresem tego lekkiego przebiegu;
      // dokladny rozmiar per-glif liczy inventory.ts z getTextContent()).
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
 * [KROK-6 Z1c] Zbior opcode'ow FAKTYCZNIE obslugiwanych przez `walkOperators` —
 * mechanicznie `[...HANDLERS.keys()]`, nigdy recznie przepisana lista. Uzywane
 * przez test snapshotu ksztaltow (Z7 z KROK-5, teraz naprawiony), zeby dodanie
 * nowego handlera bez odpowiadajacego wpisu w snapshocie bylo wykrywalne
 * automatycznie, nie zalezne od pamieci autora.
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

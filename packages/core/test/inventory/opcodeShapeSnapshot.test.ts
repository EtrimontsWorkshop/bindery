import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { HANDLED_OPCODES } from '../../src/inventory/walkOperators.js';
import { fixtures } from '../synth/index.js';

/**
 * Closed exhaustively by construction — this test runs EVERY fixture through a real
 * `getOperatorList()` and dumps the arity/types (NOT the values) of argsArray for every opcode
 * handled in `walkOperators.ts`. An earlier version of this test had the opcode list COPIED BY
 * HAND (`HANDLED_OPCODE_NAMES`), independent of `walkOperators.ts` — exactly the same class of
 * bug as twice before, only at the level of "do we check this opcode at all", not "what shape
 * does it have". Now the list comes from `HANDLED_OPCODES`, exported DIRECTLY from the dispatch
 * table in `walkOperators.ts` (`[...HANDLERS.keys()]`) — adding support for a new opcode
 * without a snapshot entry is detected MECHANICALLY: the new key shows up in the report and
 * `toMatchSnapshot()` goes red against the approved `.snap` file until someone consciously
 * accepts it (and in passing sees whether it has any fixture coverage at all, or only an empty
 * array — see the paintImageXObjectRepeat case below).
 */

function opcodeNamesFromHandled(handled: ReadonlySet<number>): Map<number, string> {
  const OPS = pdfjs.OPS as unknown as Record<string, number>;
  const nameByNumber = new Map<number, string>();
  for (const [name, value] of Object.entries(OPS)) {
    if (handled.has(value)) nameByNumber.set(value, name);
  }
  return nameByNumber;
}

/** A value-shape signature — ONLY the type/arity, never the value itself. */
function shapeOf(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) {
    const elementShapes = [...new Set(value.map((v) => shapeOf(v)))].sort();
    return `array(len=${value.length})<${elementShapes.join('|')}>`;
  }
  if (value instanceof Uint8Array || value instanceof Uint8ClampedArray) {
    return `${value.constructor.name}(len=${value.length})`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${k}:${shapeOf(obj[k])}`).join(',')}}`;
  }
  return typeof value;
}

/** A shape signature of the whole `args` (argsArray[i]) — the top-level array + the shape of each element. */
function argsShape(args: unknown[]): string {
  return `arity=${args.length} [${args.map((a) => shapeOf(a)).join(', ')}]`;
}

async function collectShapesForBuffer(buf: Buffer, nameByNumber: ReadonlyMap<number, string>): Promise<Map<string, Set<string>>> {
  const shapesByOpcode = new Map<string, Set<string>>();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const { fnArray, argsArray } = await page.getOperatorList();
    for (let i = 0; i < fnArray.length; i++) {
      const name = nameByNumber.get(fnArray[i]!);
      if (!name) continue;
      const shape = argsShape(argsArray[i] ?? []);
      const set = shapesByOpcode.get(name) ?? new Set<string>();
      set.add(shape);
      shapesByOpcode.set(name, set);
    }
    page.cleanup();
  }
  return shapesByOpcode;
}

describe('an exhaustive snapshot of the argsArray shapes, closed by construction', () => {
  it('the arity/types of argsArray for EVERY opcode in HANDLED_OPCODES (not from a hand-written list), collected from ALL fixtures', async () => {
    const nameByNumber = opcodeNamesFromHandled(HANDLED_OPCODES);
    const merged = new Map<string, Set<string>>();

    for (const fixture of fixtures) {
      const shapes = await collectShapesForBuffer(fixture.build(), nameByNumber);
      for (const [opcode, set] of shapes) {
        const target = merged.get(opcode) ?? new Set<string>();
        for (const s of set) target.add(s);
        merged.set(opcode, target);
      }
    }

    const report: Record<string, string[]> = {};
    for (const name of [...nameByNumber.values()].sort()) {
      report[name] = [...(merged.get(name) ?? new Set<string>())].sort();
    }

    expect(report).toMatchSnapshot();
  });

  it('every number in HANDLED_OPCODES corresponds to a real, known pdf.js opcode (no drift between versions)', () => {
    const nameByNumber = opcodeNamesFromHandled(HANDLED_OPCODES);
    expect(nameByNumber.size).toBe(HANDLED_OPCODES.size);
  });

  it('[a negative test] the number of handled opcodes is frozen at 13 — a change signals adding/removing a handler in walkOperators.ts, which MUST go through the snapshot above', () => {
    // HANDLED_OPCODES is MECHANICALLY equal to the keys of the dispatch table (Map.keys()) in
    // walkOperators.ts — support for a new opcode can't be added without changing this number,
    // which also immediately changes the snapshot content above (a new key in the report = a
    // mismatch with the approved .snap = the test goes red).
    // 11->13: paintFormXObjectBegin/End were added (see walkOperators.ts — discovery: executing a
    // Form XObject was NOT scoped like save/restore, so the CTM from its inside leaked into
    // everything drawn after it on the page).
    expect(HANDLED_OPCODES.size).toBe(13);
  });
});

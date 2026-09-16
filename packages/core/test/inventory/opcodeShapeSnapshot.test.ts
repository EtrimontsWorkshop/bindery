import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { HANDLED_OPCODES } from '../../src/inventory/walkOperators.js';
import { fixtures } from '../synth/index.js';

/**
 * KROK-5 Z7, zamkniete wyczerpujaco w KROK-6 Z1c — ten test przepuszcza KAZDY
 * fixture przez prawdziwy `getOperatorList()` i zrzuca arnosc/typy (NIE
 * wartosci) argsArray dla kazdego opcode'u obslugiwanego w `walkOperators.ts`.
 *
 * KROK-5 wersja tego testu miala liste opcode'ow PRZEPISANA RECZNIE
 * (`HANDLED_OPCODE_NAMES`), niezalezna od `walkOperators.ts` — dokladnie ten
 * sam schemat bledu co dwa razy wczesniej (KROK-4: cm, KROK-5: constructPath),
 * tylko na poziomie "czy w ogole sprawdzamy ten opcode", nie "jaki ma ksztalt".
 * Teraz lista pochodzi z `HANDLED_OPCODES`, eksportowanego WPROST z tabeli
 * dispatch w `walkOperators.ts` (`[...HANDLERS.keys()]`) — dodanie obslugi
 * nowego opcode'u bez wpisu w snapshocie jest wykrywane MECHANICZNIE: nowy
 * klucz pojawi sie w raporcie i `toMatchSnapshot()` zaczerwieni sie na
 * niezgodnosci z zatwierdzonym plikiem `.snap`, dopoki ktos swiadomie go nie
 * zaakceptuje (i przy okazji zobaczy, czy ma jakiekolwiek pokrycie fixture'ami,
 * czy tylko pusta tablice — patrz przypadek paintImageXObjectRepeat nizej).
 */

function opcodeNamesFromHandled(handled: ReadonlySet<number>): Map<number, string> {
  const OPS = pdfjs.OPS as unknown as Record<string, number>;
  const nameByNumber = new Map<number, string>();
  for (const [name, value] of Object.entries(OPS)) {
    if (handled.has(value)) nameByNumber.set(value, name);
  }
  return nameByNumber;
}

/** Sygnatura ksztaltu wartosci — TYLKO typ/arnosc, nigdy sama wartosc. */
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

/** Sygnatura ksztaltu calego `args` (argsArray[i]) — tablica top-level + ksztalt kazdego elementu. */
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

describe('Z1c — snapshot ksztaltow argsArray wyczerpujacy z konstrukcji (KROK-6)', () => {
  it('arnosc/typy argsArray dla KAZDEGO opcode z HANDLED_OPCODES (nie z recznej listy), zebrane ze WSZYSTKICH fixturow', async () => {
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

  it('kazdy numer w HANDLED_OPCODES odpowiada realnemu, znanemu opcode pdf.js (brak driftu miedzy wersjami)', () => {
    const nameByNumber = opcodeNamesFromHandled(HANDLED_OPCODES);
    expect(nameByNumber.size).toBe(HANDLED_OPCODES.size);
  });

  it('[test negatywny Z1c] liczba obslugiwanych opcode-ow jest zamrozona na 13 — zmiana sygnalizuje dodanie/usuniecie handlera w walkOperators.ts, ktore MUSI przejsc przez powyzszy snapshot', () => {
    // HANDLED_OPCODES jest MECHANICZNIE rowne kluczom tabeli dispatch (Map.keys())
    // w walkOperators.ts — nie da sie dodac obslugi nowego opcode'u bez zmiany
    // tej liczby, co natychmiast zmienia tez zawartosc snapshotu powyzej (nowy
    // klucz w raporcie = niezgodnosc z zatwierdzonym .snap = test sie czerwieni).
    // [KROK-7] 11->13: dodano paintFormXObjectBegin/End (patrz walkOperators.ts —
    // odkrycie: wykonanie Form XObject NIE bylo scopowane jak save/restore, CTM
    // z jego wnetrza przeciekal do wszystkiego narysowanego po nim na stronie).
    expect(HANDLED_OPCODES.size).toBe(13);
  });
});

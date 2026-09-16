import { describe, expect, it } from 'vitest';
import { splitSpanningLines } from '../../src/layout/spanning.js';
import type { TextLine } from '../../src/layout/lineCluster.js';

function line(id: string, minX: number, maxX: number, y: number): TextLine {
  return {
    id,
    text: id,
    bbox: { minX, minY: y, maxX, maxY: y + 12 },
    columnIndex: -1,
    crossAxisPosition: y,
    fonts: [{ key: 'Body@12', size: 12 }],
    dominantFont: { key: 'Body@12', size: 12 },
    syntheticBold: false,
  };
}

describe('splitSpanningLines', () => {
  it('naglowek pelnowymiarowy nad dwiema kolumnami trafia do spanning, kolumny do columnar', () => {
    // Blok tekstu: x=50..550 (szerokosc 500). Naglowek pokrywa cala szerokosc.
    // Dwie kolumny: lewa x=50..280 (230, 46%), prawa x=320..550 (230, 46%) — obie ponizej 70%.
    const heading = line('heading', 50, 550, 700);
    const leftCol1 = line('left1', 50, 280, 650);
    const leftCol2 = line('left2', 50, 280, 630);
    const rightCol1 = line('right1', 320, 550, 650);
    const lines = [heading, leftCol1, leftCol2, rightCol1];

    const { spanning, columnar, textBlockWidth } = splitSpanningLines(lines);
    expect(textBlockWidth).toBe(500);
    expect(spanning.map((l) => l.id)).toEqual(['heading']);
    expect(columnar.map((l) => l.id).sort()).toEqual(['left1', 'left2', 'right1']);
  });

  it('[KROK-6, odkrycie] uklad jednokolumnowy: linie wypelniajace wiekszosc bloku sa "columnar", NIE "spanning" (brak baseline do porownania)', () => {
    // Blok = 50..540 (490), linie ~90-98% WLASNEJ szerokosci bloku — na
    // prawdziwie jednokolumnowej stronie KAZDA linia z definicji wyglada tak.
    // Prog 70% liczony wzgledem bloku zbudowanego z TYCH SAMYCH linii jest wiec
    // tautologiczny: gdyby wszystkie linie trafily do `spanning`, Z3 nie
    // dostalby ani jednej linii kolumnowej i nie moglby zwrocic poprawnej
    // odpowiedzi "1 kolumna" (zweryfikowane empirycznie na fixture layout-1col).
    const lines = [line('a', 50, 500, 700), line('b', 60, 540, 680)];
    const { columnar, spanning } = splitSpanningLines(lines);
    expect(spanning).toHaveLength(0);
    expect(columnar).toHaveLength(2);
  });

  it('pusta lista linii -> pusty wynik bez bledu', () => {
    const result = splitSpanningLines([]);
    expect(result).toEqual({ spanning: [], columnar: [], textBlockWidth: 0 });
  });

  it('prog jest konfigurowalny (parametr widthRatio)', () => {
    // Blok 50..450 (400). 1 linia szeroka (100%) + 1 srednia (50%) + 6 waskich
    // (30%, WYRAZNA wiekszosc linii) — tak, zeby nawet przy luznym progu
    // kandydaci "rozpinajacy" pozostali MNIEJSZOSCIA (patrz test wyzej: gdy
    // wiekszosc linii kwalifikuje sie, cala strona jest columnar z definicji).
    const narrows = Array.from({ length: 6 }, (_, i) => line(`narrow${i}`, 50, 170, 600 - i * 20)); // 120 = 30%
    const lines = [line('wide', 50, 450, 700), line('medium', 50, 250, 680), ...narrows];
    const strict = splitSpanningLines(lines, 0.99);
    expect(strict.spanning.map((l) => l.id)).toEqual(['wide']);
    const lenient = splitSpanningLines(lines, 0.4);
    expect(lenient.spanning.map((l) => l.id).sort()).toEqual(['medium', 'wide']);
  });
});

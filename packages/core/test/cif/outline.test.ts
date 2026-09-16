import { describe, expect, it } from 'vitest';
import { extractOutline, flattenOutline, type PdfDocumentForOutline, type PdfOutlineNode } from '../../src/cif/outline.js';

function fakeDoc(overrides: Partial<PdfDocumentForOutline> = {}): PdfDocumentForOutline {
  return {
    getOutline: async () => null,
    getDestination: async () => null,
    getPageIndex: async () => 0,
    ...overrides,
  };
}

describe('extractOutline', () => {
  it('brak outline (getOutline zwraca null) -> []', async () => {
    const result = await extractOutline(fakeDoc({ getOutline: async () => null }));
    expect(result).toEqual([]);
  });

  it('pusta tablica outline -> []', async () => {
    const result = await extractOutline(fakeDoc({ getOutline: async () => [] }));
    expect(result).toEqual([]);
  });

  it('getOutline rzuca wyjatek -> [] (degraduj, nie failuj, A7)', async () => {
    const result = await extractOutline(
      fakeDoc({
        getOutline: async () => {
          throw new Error('boom');
        },
      }),
    );
    expect(result).toEqual([]);
  });

  it('dest jako tablica jawna (bez getDestination) rozwiazuje sie przez getPageIndex', async () => {
    const nodes: PdfOutlineNode[] = [{ title: 'Rozdzial 1', dest: ['ref1'], items: [] }];
    const result = await extractOutline(fakeDoc({ getOutline: async () => nodes, getPageIndex: async () => 4 }));
    expect(result).toHaveLength(1);
    expect(result[0]!.pageNumber).toBe(5); // 0-indexed -> 1-indexed
    expect(result[0]!.title).toBe('Rozdzial 1');
    expect(result[0]!.depth).toBe(1);
  });

  it('dest jako string (nazwana destynacja) rozwiazuje sie przez getDestination potem getPageIndex', async () => {
    const nodes: PdfOutlineNode[] = [{ title: 'Rozdzial 1', dest: 'chapter1', items: [] }];
    const result = await extractOutline(
      fakeDoc({
        getOutline: async () => nodes,
        getDestination: async (id) => (id === 'chapter1' ? ['ref-chapter1'] : null),
        getPageIndex: async () => 9,
      }),
    );
    expect(result[0]!.pageNumber).toBe(10);
  });

  it('dest null (np. wpis grupujacy bez celu) -> pageNumber null, NIE failuje', async () => {
    const nodes: PdfOutlineNode[] = [{ title: 'Grupa', dest: null, items: [{ title: 'Podrozdzial', dest: ['ref'], items: [] }] }];
    const result = await extractOutline(fakeDoc({ getOutline: async () => nodes, getPageIndex: async () => 2 }));
    expect(result[0]!.pageNumber).toBeNull();
    expect(result[0]!.children).toHaveLength(1);
    expect(result[0]!.children[0]!.pageNumber).toBe(3);
    expect(result[0]!.children[0]!.depth).toBe(2);
  });

  it('dest nierozwiazywalny (getPageIndex rzuca, np. link zewnetrzny) -> pageNumber null, reszta drzewa dziala dalej', async () => {
    const nodes: PdfOutlineNode[] = [
      { title: 'Link zewnetrzny', dest: ['bad-ref'], items: [] },
      { title: 'Rozdzial normalny', dest: ['good-ref'], items: [] },
    ];
    const result = await extractOutline(
      fakeDoc({
        getOutline: async () => nodes,
        getPageIndex: async (ref) => {
          if (ref === 'bad-ref') throw new Error('unresolvable');
          return 0;
        },
      }),
    );
    expect(result[0]!.pageNumber).toBeNull();
    expect(result[1]!.pageNumber).toBe(1);
  });

  it('glebokosc wieloportziomowa zachowana poprawnie (depth 1/2/3)', async () => {
    const nodes: PdfOutlineNode[] = [
      {
        title: 'Czesc I',
        dest: ['a'],
        items: [
          {
            title: 'Rozdzial 1',
            dest: ['b'],
            items: [{ title: 'Sekcja 1.1', dest: ['c'], items: [] }],
          },
        ],
      },
    ];
    const result = await extractOutline(fakeDoc({ getOutline: async () => nodes, getPageIndex: async () => 0 }));
    expect(result[0]!.depth).toBe(1);
    expect(result[0]!.children[0]!.depth).toBe(2);
    expect(result[0]!.children[0]!.children[0]!.depth).toBe(3);
  });
});

describe('flattenOutline', () => {
  it('splaszcza drzewo w kolejnosci DFS', () => {
    const tree = [
      { title: 'A', pageNumber: 1, depth: 1, children: [{ title: 'A1', pageNumber: 2, depth: 2, children: [] }] },
      { title: 'B', pageNumber: 3, depth: 1, children: [] },
    ];
    const flat = flattenOutline(tree);
    expect(flat.map((n) => n.title)).toEqual(['A', 'A1', 'B']);
  });
});

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
  it('no outline (getOutline returns null) -> []', async () => {
    const result = await extractOutline(fakeDoc({ getOutline: async () => null }));
    expect(result).toEqual([]);
  });

  it('an empty outline array -> []', async () => {
    const result = await extractOutline(fakeDoc({ getOutline: async () => [] }));
    expect(result).toEqual([]);
  });

  it('getOutline throws -> [] (degrade, don\'t fail)', async () => {
    const result = await extractOutline(
      fakeDoc({
        getOutline: async () => {
          throw new Error('boom');
        },
      }),
    );
    expect(result).toEqual([]);
  });

  it('dest as an explicit array (without getDestination) resolves through getPageIndex', async () => {
    const nodes: PdfOutlineNode[] = [{ title: 'Rozdzial 1', dest: ['ref1'], items: [] }];
    const result = await extractOutline(fakeDoc({ getOutline: async () => nodes, getPageIndex: async () => 4 }));
    expect(result).toHaveLength(1);
    expect(result[0]!.pageNumber).toBe(5); // 0-indexed -> 1-indexed
    expect(result[0]!.title).toBe('Rozdzial 1');
    expect(result[0]!.depth).toBe(1);
  });

  it('dest as a string (a named destination) resolves through getDestination, then getPageIndex', async () => {
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

  it('dest null (e.g. a grouping entry with no target) -> pageNumber null, does NOT fail', async () => {
    const nodes: PdfOutlineNode[] = [{ title: 'Grupa', dest: null, items: [{ title: 'Podrozdzial', dest: ['ref'], items: [] }] }];
    const result = await extractOutline(fakeDoc({ getOutline: async () => nodes, getPageIndex: async () => 2 }));
    expect(result[0]!.pageNumber).toBeNull();
    expect(result[0]!.children).toHaveLength(1);
    expect(result[0]!.children[0]!.pageNumber).toBe(3);
    expect(result[0]!.children[0]!.depth).toBe(2);
  });

  it('an unresolvable dest (getPageIndex throws, e.g. an external link) -> pageNumber null, the rest of the tree keeps working', async () => {
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

  it('multi-level depth preserved correctly (depth 1/2/3)', async () => {
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
  it('flattens the tree in DFS order', () => {
    const tree = [
      { title: 'A', pageNumber: 1, depth: 1, children: [{ title: 'A1', pageNumber: 2, depth: 2, children: [] }] },
      { title: 'B', pageNumber: 3, depth: 1, children: [] },
    ];
    const flat = flattenOutline(tree);
    expect(flat.map((n) => n.title)).toEqual(['A', 'A1', 'B']);
  });
});

import { describe, expect, it } from 'vitest';
import { blocksToHtml, escapeHtml, type EmbeddedImageForHtml } from '../../src/cif/blocksToHtml.js';
import type { SemanticBlock, BlockKind } from '../../src/semantic/blockBuilder.js';
import type { TextLine } from '../../src/layout/lineCluster.js';

function line(id: string, text: string): TextLine {
  return {
    id,
    text,
    bbox: { minX: 72, minY: 700, maxX: 300, maxY: 710 },
    columnIndex: 0,
    crossAxisPosition: 700,
    fonts: [{ key: 'Body@10', size: 10 }],
    dominantFont: { key: 'Body@10', size: 10 },
    syntheticBold: false,
  };
}

function block(overrides: Partial<SemanticBlock> & { kind: BlockKind; rawText: string }): SemanticBlock {
  return {
    id: 'b0',
    confidence: 0.8,
    pageNumber: 1,
    bbox: { minX: 72, minY: 700, maxX: 300, maxY: 710 },
    angle: 0,
    lines: [line('l0', overrides.rawText)],
    ...overrides,
  };
}

describe('escapeHtml', () => {
  it('ucieka <, >, &, cudzyslowy', () => {
    expect(escapeHtml(`<script>alert("x")</script> & 'quote'`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quote&#39;',
    );
  });
});

describe('blocksToHtml — mapowanie BlockKind -> HTML (tabela z briefu)', () => {
  it('heading -> h1..h6 wg headingLevel', () => {
    const b = block({ kind: 'heading', rawText: 'Tytul rozdzialu', headingLevel: 3 });
    const { html } = blocksToHtml([b], []);
    expect(html).toBe('<h3>Tytul rozdzialu</h3>');
  });

  it('[kontrola zywa w Foundry] heading BARDZO KROTKI (ponizej progu) -> zwykly <p>, nie <h#>', () => {
    const b = block({ kind: 'heading', rawText: 'mn', headingLevel: 5 });
    const { html } = blocksToHtml([b], []);
    expect(html).toBe('<p>mn</p>');
    expect(html).not.toContain('<h5>');
  });

  it('heading bez headingLevel domyslnie h2', () => {
    const b = block({ kind: 'heading', rawText: 'Tytul' });
    const { html } = blocksToHtml([b], []);
    expect(html).toContain('<h2>Tytul</h2>');
  });

  it('body -> <p>', () => {
    const b = block({ kind: 'body', rawText: 'Akapit tresci.' });
    const { html } = blocksToHtml([b], []);
    expect(html).toBe('<p>Akapit tresci.</p>');
  });

  it('sidebar -> <aside> z klasa', () => {
    const b = block({ kind: 'sidebar', rawText: 'Dymek boczny.' });
    const { html } = blocksToHtml([b], []);
    expect(html).toContain('<aside class="bindery-sidebar">Dymek boczny.</aside>');
  });

  it('caption -> <figcaption>', () => {
    const b = block({ kind: 'caption', rawText: 'Rys. 1: opis.' });
    const { html } = blocksToHtml([b], []);
    expect(html).toBe('<figcaption>Rys. 1: opis.</figcaption>');
  });

  it('table -> zgrubna <table>, jeden wiersz na linie', () => {
    const b = block({
      kind: 'table',
      rawText: 'a\nb',
      lines: [line('l0', 'wiersz jeden'), line('l1', 'wiersz dwa')],
    });
    const { html } = blocksToHtml([b], []);
    expect(html).toBe('<table><tbody><tr><td>wiersz jeden</td></tr><tr><td>wiersz dwa</td></tr></tbody></table>');
  });

  it('header/footer pomijane w tresci', () => {
    const header = block({ id: 'h', kind: 'header', rawText: 'Naglowek biegnacy' });
    const body = block({ id: 'b', kind: 'body', rawText: 'Tresc', bbox: { minX: 72, minY: 600, maxX: 300, maxY: 610 } });
    const footer = block({ id: 'f', kind: 'footer', rawText: 'Stopka biegnaca', bbox: { minX: 72, minY: 20, maxX: 300, maxY: 30 } });
    const { html } = blocksToHtml([header, body, footer], []);
    expect(html).not.toContain('Naglowek');
    expect(html).not.toContain('Stopka');
    expect(html).toContain('Tresc');
  });

  it('marginalia zbierane do jednego <aside> NA KONCU strony, nie wplecione w tok', () => {
    const marg = block({ id: 'm', kind: 'marginalia', rawText: 'Notatka na marginesie' });
    const body1 = block({ id: 'b1', kind: 'body', rawText: 'Pierwszy akapit', bbox: { minX: 72, minY: 700, maxX: 300, maxY: 710 } });
    const body2 = block({ id: 'b2', kind: 'body', rawText: 'Drugi akapit', bbox: { minX: 72, minY: 600, maxX: 300, maxY: 610 } });
    const { html } = blocksToHtml([marg, body1, body2], []);
    const asideIndex = html.indexOf('<aside class="bindery-marginalia">');
    const body1Index = html.indexOf('Pierwszy akapit');
    const body2Index = html.indexOf('Drugi akapit');
    expect(asideIndex).toBeGreaterThan(body1Index);
    expect(asideIndex).toBeGreaterThan(body2Index);
    expect(html).toContain('Notatka na marginesie');
  });

  it('statblock i unknown dostaja bezpieczny fallback (nic nie ginie, A3)', () => {
    const s = block({ kind: 'statblock', rawText: 'Sila 12 Zrecznosc 14' });
    const u = block({ kind: 'unknown', rawText: 'Niesklasyfikowany fragment' });
    const { html } = blocksToHtml([s, u], []);
    expect(html).toContain('Sila 12 Zrecznosc 14');
    expect(html).toContain('Niesklasyfikowany fragment');
  });
});

describe('blocksToHtml — osadzanie obrazow (brief: "wymaga tego wprost")', () => {
  it('obraz miedzy dwoma blokami w kolejnosci czytania trafia MIEDZY odpowiadajace fragmenty', () => {
    const top = block({ id: 'top', kind: 'body', rawText: 'Tekst przed obrazem', bbox: { minX: 72, minY: 700, maxX: 300, maxY: 710 } });
    const bottom = block({ id: 'bottom', kind: 'body', rawText: 'Tekst po obrazie', bbox: { minX: 72, minY: 400, maxX: 300, maxY: 410 } });
    const img: EmbeddedImageForHtml = { id: 'img1', assetRef: 'path/to/img.webp', pageNumber: 1, bbox: { minX: 72, minY: 550, maxX: 300, maxY: 650 } };
    const { html, imageRefs } = blocksToHtml([top, bottom], [img]);
    const topIdx = html.indexOf('Tekst przed obrazem');
    const imgIdx = html.indexOf('<figure>');
    const bottomIdx = html.indexOf('Tekst po obrazie');
    expect(topIdx).toBeLessThan(imgIdx);
    expect(imgIdx).toBeLessThan(bottomIdx);
    expect(imageRefs).toEqual(['img1']);
    expect(html).toContain('src="path/to/img.webp"');
  });

  it('obraz z podpisem dostaje <figcaption> wewnatrz <figure>', () => {
    const img: EmbeddedImageForHtml = { id: 'img1', assetRef: 'x.webp', pageNumber: 1, bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, caption: 'Podpis <b>bold</b>' };
    const { html } = blocksToHtml([], [img]);
    expect(html).toContain('<figcaption>Podpis &lt;b&gt;bold&lt;/b&gt;</figcaption>');
  });

  it('obraz na stronie BEZ zadnego bloku tekstowego trafia na koniec, nie ginie (A3)', () => {
    const b = block({ pageNumber: 1, kind: 'body', rawText: 'Tresc strony 1' });
    const img: EmbeddedImageForHtml = { id: 'img-p2', assetRef: 'p2.webp', pageNumber: 2, bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 } };
    const { html, imageRefs } = blocksToHtml([b], [img]);
    expect(imageRefs).toContain('img-p2');
    expect(html).toContain('p2.webp');
  });

  it('sanityzacja: tekst z pliku uzytkownika zawierajacy znaki HTML jest escapowany', () => {
    const b = block({ kind: 'body', rawText: '<img src=x onerror=alert(1)> & "quotes"' });
    const { html } = blocksToHtml([b], []);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

import { describe, expect, it } from 'vitest';
import { groupByAngle } from '../../src/layout/angleStreams.js';

interface Item {
  transform: readonly number[];
  label: string;
}

function rotatedItem(degrees: number, label: string, size = 12, x = 0, y = 0): Item {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { transform: [size * cos, size * sin, -size * sin, size * cos, x, y], label };
}

describe('groupByAngle — kubelkowanie po kacie', () => {
  it('rozdziela 0°/90°/180°/270° do osobnych kubelkow, 0° jest isPrimary', () => {
    const items = [rotatedItem(0, 'a'), rotatedItem(90, 'b'), rotatedItem(180, 'c'), rotatedItem(270, 'd')];
    const { streams, diagnostics } = groupByAngle(items);
    expect(streams.map((s) => s.angle)).toEqual([0, 90, 180, 270]);
    expect(streams.find((s) => s.angle === 0)!.isPrimary).toBe(true);
    expect(streams.filter((s) => s.angle !== 0).every((s) => !s.isPrimary)).toBe(true);
    expect(diagnostics).toHaveLength(0);
  });

  it('kilka itemow tego samego kata trafia do jednego strumienia, w kolejnosci wejscia', () => {
    const items = [rotatedItem(0, 'a'), rotatedItem(0, 'b'), rotatedItem(90, 'c')];
    const { streams } = groupByAngle(items);
    expect(streams.find((s) => s.angle === 0)!.items.map((i) => i.label)).toEqual(['a', 'b']);
  });

  it('kat nietypowy (45°) NIE jest odrzucany — trafia do najblizszego kubelka i generuje Diagnostic', () => {
    const items = [rotatedItem(45, 'weird')];
    const { streams, diagnostics } = groupByAngle(items, 3);
    expect(streams).toHaveLength(1);
    expect(streams[0]!.items.map((i) => i.label)).toEqual(['weird']);
    expect(streams[0]!.angle).toBe(90); // 45° rowno miedzy 0 i 90 — Math.round(0.5)=1 (JS), deterministycznie w gore
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe('UNUSUAL_TEXT_ANGLE');
    expect(diagnostics[0]!.pageNumber).toBe(3);
  });

  it('kat blisko kubelka (np. 5° od 0°) NIE generuje diagnostyki', () => {
    const items = [rotatedItem(5, 'near-zero')];
    const { streams, diagnostics } = groupByAngle(items);
    expect(streams[0]!.angle).toBe(0);
    expect(diagnostics).toHaveLength(0);
  });

  it('deduplikuje diagnostyke dla powtarzajacego sie tego samego nietypowego kata', () => {
    const items = [rotatedItem(45, 'a'), rotatedItem(45, 'b'), rotatedItem(45, 'c')];
    const { diagnostics } = groupByAngle(items);
    expect(diagnostics).toHaveLength(1);
  });
});

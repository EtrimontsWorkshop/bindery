import { describe, expect, it } from 'vitest';
import { countPlayerCharacterKeywordHits, classifyPageRoute } from '../../src/profiles/pageRoute.js';
import type { ProfileToken } from '../../src/profiles/types.js';

function tokens(texts: readonly string[]): ProfileToken[] {
  return texts.map((text, i) => ({ text, bbox: { minX: i, maxX: i + 1, minY: 0, maxY: 1 } }));
}

describe('classifyPageRoute — [KROK-18 Z1, przemianowane w KROK-39 Z1]', () => {
  it('strona gotowego Badacza (slowa kluczowe chargenu) -> trasa playerCharacter', () => {
    // [Zmierzone na Zew_Cthulhu_Nie_czas_na_krzyk_v1_0.pdf, str. 33] wszystkie
    // 12 znanych stron pregenow trafialy >=3 z 5 slow kluczowych.
    const page = tokens(['Umiejętności', 'Uwaga:', 'Rozdysponuj', '50', 'punktów', 'Historia', 'Badacza', 'Przymioty:']);
    expect(classifyPageRoute(page)).toBe('playerCharacter');
    expect(countPlayerCharacterKeywordHits(page)).toBeGreaterThanOrEqual(3);
  });

  it('strona NPC/potwora (zero slow kluczowych chargenu) -> trasa npc', () => {
    // [Zmierzone na tym samym pliku, str. 30/31/55/56/57/84 — 0 trafien na kazdej z 6 stron.]
    const page = tokens(['Joshua', 'Thomas', 'S', '40', 'WYG', '25', 'ATAKI', 'Walka', 'Wręcz', '30%']);
    expect(classifyPageRoute(page)).toBe('npc');
    expect(countPlayerCharacterKeywordHits(page)).toBe(0);
  });

  it('prog domyslny to >=1 trafienie (margines 0 vs 3-5 zmierzony na realnej ksiazce)', () => {
    const page = tokens(['coś', 'coś', 'Przymioty', 'coś']);
    expect(countPlayerCharacterKeywordHits(page)).toBe(1);
    expect(classifyPageRoute(page)).toBe('playerCharacter');
  });

  it('pusta strona -> trasa npc', () => {
    expect(classifyPageRoute([])).toBe('npc');
  });

  it('niestandardowy prog respektowany', () => {
    const page = tokens(['Rozdysponuj', 'Przymioty']);
    expect(classifyPageRoute(page, { hitThreshold: 3 })).toBe('npc');
    expect(classifyPageRoute(page, { hitThreshold: 2 })).toBe('playerCharacter');
  });
});

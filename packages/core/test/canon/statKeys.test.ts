import { describe, expect, it } from 'vitest';
import { CANONICAL_STATS, CANONICAL_STAT_KEYS } from '../../src/canon/statKeys.js';

describe('CANONICAL_STATS — [KROK-23, MDD §5.4]', () => {
  it('każdy klucz ma niepustą listę podpowiedzi', () => {
    for (const key of CANONICAL_STAT_KEYS) {
      expect(CANONICAL_STATS[key].hints.length).toBeGreaterThan(0);
    }
  });

  it('CANONICAL_STAT_KEYS pokrywa dokładnie klucze CANONICAL_STATS', () => {
    expect(new Set(CANONICAL_STAT_KEYS)).toEqual(new Set(Object.keys(CANONICAL_STATS)));
  });

  it('zawiera znane klucze z profilu coc7-niczas-pl (strength, hitPoints, movement)', () => {
    expect(CANONICAL_STAT_KEYS).toContain('strength');
    expect(CANONICAL_STAT_KEYS).toContain('hitPoints');
    expect(CANONICAL_STAT_KEYS).toContain('movement');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
// The helper lives in the Foundry-facing package but has no Foundry dependency; it is tested here because only this package has a test setup.
import { withExtensibleMath } from '../../module/src/withExtensibleMath.js';

const realMath = globalThis.Math;

/** What the pdf.js polyfill does on load: add `Math.sumPrecise` to whatever `Math` is at that moment. */
async function simulatePolyfill(): Promise<string> {
  Object.defineProperty(globalThis.Math, 'sumPrecise', { value: () => 0, configurable: true, writable: true });
  return 'loaded';
}

/** A locked-down stand-in for `Math` that has no `sumPrecise`, whatever the Node version running the tests natively provides. */
function frozenMathWithoutSumPrecise(): Math {
  return Object.freeze(Object.create(Object.getPrototypeOf(realMath))) as Math;
}

describe('withExtensibleMath', () => {
  afterEach(() => {
    globalThis.Math = realMath;
    vi.restoreAllMocks();
  });

  it('a frozen Math makes the polyfill throw without the helper (the reported failure)', async () => {
    globalThis.Math = frozenMathWithoutSumPrecise();
    await expect(simulatePolyfill()).rejects.toThrow(/not extensible/);
  });

  it('lets the load succeed under a frozen Math, then puts the real Math back', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const frozen = frozenMathWithoutSumPrecise();
    globalThis.Math = frozen;
    await expect(withExtensibleMath(simulatePolyfill)).resolves.toBe('loaded');
    expect(globalThis.Math).toBe(frozen);
    expect(Object.isFrozen(globalThis.Math)).toBe(true);
  });

  it('restores the real Math even when the load fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const frozen = frozenMathWithoutSumPrecise();
    globalThis.Math = frozen;
    await expect(withExtensibleMath(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(globalThis.Math).toBe(frozen);
  });

  it('leaves Math alone when it is intact', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let seen: Math | undefined;
    await withExtensibleMath(async () => { seen = globalThis.Math; });
    expect(seen).toBe(realMath);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not substitute anything when a native Math.sumPrecise exists', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const frozenWithNative = Object.freeze(Object.create(realMath, { sumPrecise: { value: () => 0 } })) as Math;
    globalThis.Math = frozenWithNative;
    let seen: Math | undefined;
    await withExtensibleMath(async () => { seen = globalThis.Math; });
    expect(seen).toBe(frozenWithNative);
    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * Runs `load` (the first import of the PDF library) with a stand-in for `Math` when the real one is locked down.
 *
 * The legacy build of pdf.js ships a polyfill that, on load, adds `Math.sumPrecise` to `Math` when the browser has no native one. If something else in the page has frozen or sealed `Math` (another module, a browser extension, a hardening script), that definition throws "object is not extensible" and the whole library fails to load — even though pdf.js itself never needs `Math.sumPrecise` for what Bindery does.
 *
 * While `load` runs, `globalThis.Math` is replaced with an extensible object that inherits from the real `Math`, so the polyfill has somewhere to write; the real `Math` is put back as soon as the import settles, success or failure. When `Math` is intact nothing is replaced. The PDF worker runs in its own realm, which page scripts cannot freeze, so it needs no such treatment.
 */
export async function withExtensibleMath<T>(load: () => Promise<T>): Promise<T> {
  const realMath = globalThis.Math;
  const lockedDown = !Object.isExtensible(realMath) && typeof (realMath as { sumPrecise?: unknown }).sumPrecise !== 'function';
  if (!lockedDown) return load();

  console.warn('Bindery | Math is frozen by something else on this page (another module or a browser extension?); loading the PDF library with a temporary stand-in.');
  globalThis.Math = Object.create(realMath) as Math;
  try {
    return await load();
  } finally {
    globalThis.Math = realMath;
  }
}

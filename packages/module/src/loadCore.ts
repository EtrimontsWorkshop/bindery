import { withExtensibleMath } from './withExtensibleMath.js';

/**
 * The single way to load `@bindery/core` at runtime. Core imports pdf.js when it is evaluated, so the first load has to go through `withExtensibleMath`; every dynamic import of core uses this function so that none of them can forget it. (Windows opened later import core statically, which is safe because core has already been loaded by then.)
 */
export function loadCore(): Promise<typeof import('@bindery/core')> {
  return withExtensibleMath(() => import('@bindery/core'));
}

import type { FontRole } from '../inventory/fontRegistry.js';
import type { Diagnostic } from '../text/types.js';
import { buildCIFActor } from '../cif/buildCIFActor.js';
import type { CIFActor } from '../cif/types.js';
import { classifyPageRoute } from './pageRoute.js';
import { assembleStatblocksOnPage, resolvePatternSetForRoute } from './assembleStatblocks.js';
import { tokenizePage, type TextContentItemLike } from './tokenizePage.js';
import type { ProfileV2 } from './schema.js';

/**
 * [Step 20 Z2] Statblock orchestration over the WHOLE document — generalizes the
 * tokenization + page loop that had until now been DUPLICATED three
 * times as ad-hoc code in `tools/measure-statblocks.ts`,
 * `tools/verify-coc7-adapter.ts`, `tools/build-z4-measurement-macro.ts`
 * (Step 18/19). This file is the ONLY version used by the product
 * (`buildCIFFromDocument.ts`) — the measurement tools still have THEIR OWN copy
 * (predictable input data for measurement), but new production code
 * should call this instead of copying the loop a fourth time.
 *
 * Duck-typed `PdfDocumentLike`/`PdfPageLike` — the same pattern as
 * `inventory/inventory.ts`/`text/buildTextLayout.ts` (testable without
 * real pdf.js).
 */

export interface PdfPageLike {
  getOperatorList(): Promise<unknown>;
  getTextContent(): Promise<{ items: readonly unknown[] }>;
  commonObjs: { has(id: string): boolean; get(id: string): unknown };
  cleanup(): void;
}

export interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
}

export interface BuildActorsForDocumentOptions {
  profile: ProfileV2;
  fontRoles: ReadonlyMap<string, FontRole>;
  signal?: AbortSignal;
}

export interface BuildActorsForDocumentResult {
  actors: CIFActor[];
  diagnostics: Diagnostic[];
}

/**
 * `fontRoles` comes from an ALREADY-COMPLETED inventory pass (`buildInventory`, already
 * computed earlier in the same run by the caller) — this file does
 * NOT open its own, SECOND `getDocument()` for fonts; it accepts the
 * result as data, following the same pattern as the rest of
 * `buildCIFFromDocument.ts` (one inventory pass, many subsequent passes).
 *
 * [Step 39 Z1] EVERY page is now CLASSIFIED (`classifyPageRoute`), no longer
 * filtered binarily: the `npc` route builds entities from the root profile's patterns
 * (behavior identical to before this step), the `playerCharacter` route
 * builds from the optional `profile.playerCharacter` section, IF the profile has one.
 * When it doesn't — the page is skipped (like the former `isPregenPage`), but with
 * an explicit `Diagnostic` explaining why (A10 — don't guess, say so), instead of a
 * silent skip. EVERY profile without a `playerCharacter` section therefore
 * behaves EXACTLY as it does today: Investigator pages skipped, NPC/monster
 * pages built — without any flag.
 */
export async function buildActorsForDocument(doc: PdfDocumentLike, opts: BuildActorsForDocumentOptions): Promise<BuildActorsForDocumentResult> {
  const actors: CIFActor[] = [];
  const diagnostics: Diagnostic[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    if (opts.signal?.aborted) throw new DOMException('buildActorsForDocument aborted by AbortSignal', 'AbortError');

    const page = await doc.getPage(pageNumber);
    await page.getOperatorList();
    const tc = await page.getTextContent();
    const tokens = tokenizePage(tc.items as TextContentItemLike[], page, opts.fontRoles, pageNumber);
    page.cleanup();

    const route = classifyPageRoute(tokens);
    if (!resolvePatternSetForRoute(opts.profile, route)) {
      if (route === 'playerCharacter') {
        diagnostics.push({ severity: 'info', code: 'PLAYER_CHARACTER_ROUTE_UNSUPPORTED', pageNumber });
      }
      continue;
    }
    const entities = assembleStatblocksOnPage(tokens, opts.profile, pageNumber, route);
    for (const entity of entities) actors.push(buildCIFActor({ statblock: entity, page: pageNumber }));
  }
  return { actors, diagnostics };
}

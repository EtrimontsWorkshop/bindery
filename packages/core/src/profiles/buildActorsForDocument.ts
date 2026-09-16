import type { FontRole } from '../inventory/fontRegistry.js';
import type { Diagnostic } from '../text/types.js';
import { buildCIFActor } from '../cif/buildCIFActor.js';
import type { CIFActor } from '../cif/types.js';
import { classifyPageRoute } from './pageRoute.js';
import { assembleStatblocksOnPage, resolvePatternSetForRoute } from './assembleStatblocks.js';
import { tokenizePage, type TextContentItemLike } from './tokenizePage.js';
import type { ProfileV2 } from './schema.js';

/**
 * [KROK-20 Z2] Orkiestracja statblokow nad CALYM dokumentem — uogolnia
 * tokenizacje + petle po stronach, ktora do tej pory byla POWIELONA trzy
 * razy jako ad-hoc kod w `tools/measure-statblocks.ts`,
 * `tools/verify-coc7-adapter.ts`, `tools/build-z4-measurement-macro.ts`
 * (KROK-18/19). Ten plik to JEDYNA wersja uzywana przez produkt
 * (`buildCIFFromDocument.ts`) — narzedzia mierzace nadal maja WLASNA kopie
 * (przewidywalne dane wejsciowe do pomiaru), ale nowy kod produkcyjny
 * powinien wolac to, nie kopiowac petli po raz czwarty.
 *
 * Duck-typed `PdfDocumentLike`/`PdfPageLike` — ten sam wzorzec co
 * `inventory/inventory.ts`/`text/buildTextLayout.ts` (testowalne bez
 * prawdziwego pdf.js).
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
 * `fontRoles` przychodzi z GOTOWEJ inwentaryzacji (`buildInventory`, juz
 * policzonej wczesniej w tym samym przebiegu przez wywolujacego) — ten plik
 * NIE otwiera wlasnego, DRUGIEGO `getDocument()` po fonty; przyjmuje
 * wynik jako dane, zgodnie z tym samym wzorcem co reszta
 * `buildCIFFromDocument.ts` (jedna inwentaryzacja, wiele nastepnych przebiegow).
 *
 * [KROK-39 Z1] KAZDA strona jest KLASYFIKOWANA (`classifyPageRoute`), nie juz
 * filtrowana binarnie: trasa `npc` buduje encje z wzorcow root profilu
 * (zachowanie identyczne jak przed tym krokiem), trasa `playerCharacter`
 * buduje z opcjonalnej sekcji `profile.playerCharacter`, JESLI profil ja ma.
 * Gdy jej nie ma — strona jest pomijana (jak dawne `isPregenPage`), ale z
 * jawnym `Diagnostic` wyjasniajacym powod (A10 — nie zgaduj, powiedz), zamiast
 * cichego pominiecia. KAZDY profil bez sekcji `playerCharacter` zachowuje sie
 * WIEC dokladnie jak dzis: strony Badaczy pomijane, strony NPC/potworow
 * budowane — bez zadnej flagi.
 */
export async function buildActorsForDocument(doc: PdfDocumentLike, opts: BuildActorsForDocumentOptions): Promise<BuildActorsForDocumentResult> {
  const actors: CIFActor[] = [];
  const diagnostics: Diagnostic[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    if (opts.signal?.aborted) throw new DOMException('buildActorsForDocument przerwane przez AbortSignal', 'AbortError');

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

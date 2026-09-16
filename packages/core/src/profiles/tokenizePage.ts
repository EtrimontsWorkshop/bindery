import { resolveFontKey } from '../inventory/fontRegistry.js';
import type { FontRole } from '../inventory/fontRegistry.js';
import { fontSizeFromTransform } from '../layout/textGeometry.js';
import { splitMergedLabelValueTokens, stripStrayLeadingColonTokens } from './inferPatternFromSelection.js';
import type { ProfileToken } from './types.js';

/**
 * [KROK-22] Wydzielone z `buildActorsForDocument.ts` (tam byla to prywatna
 * `tokensForPage`) — Profile Studio (`analyzeProfileDocument.ts`) potrzebuje
 * DOKLADNIE tej samej tokenizacji, zeby diagnostyka widziala te same tokeny
 * co prawdziwy potok statblokow, nie wlasna, potencjalnie rozjezdzajaca sie
 * kopie. Duck-typed `PdfPageLike` — ten sam wzorzec co
 * `buildActorsForDocument.ts`/`inventory/inventory.ts`.
 *
 * [KROK-29, rozwazone i ODRZUCONE, naprawione w KROK-30 Z5] Scalanie slow
 * rozbitych przez pdf.js na styku znaku diakrytycznego (str. 23 "Zew Cthulhu
 * 7ed. Wrak.pdf": Hansen dostawal kandydata na nazwe "J" zamiast "Jørgen
 * Hansen"). Pierwsza proba (krok 29, `mergeTouchingTokens` z
 * `inferPatternFromSelection.ts`, wolane globalnie) zlapala REGRESJE na
 * synteycznym `buildActorsForDocument.test.ts`: wartosc "40" (dlugosc <=2
 * znaki, krotki fragment wedlug tamtego kryterium) zlaczyla sie z sasiednia
 * etykieta "WYG", bo jedynym warunkiem obok geometrii byla dlugosc jednej ze
 * stron — bezpieczne dla klikniecia POJEDYNCZEGO tokenu w UI (jego jedyny
 * dotychczasowy konsument), za szerokie dla WSZYSTKICH tokenow calego
 * dokumentu, gdzie krotkie wartosci liczbowe sa powszechne.
 *
 * [KROK-30 Z5, precyzyjniejsze kryterium z briefu] `mergeDiacriticSplitTokens`
 * ponizej dodaje DWA dodatkowe warunki ponad geometrie (styk bez odstepu, ten
 * sam wiersz): drugi token musi zaczynac sie od znaku SPOZA ASCII (sygnatura
 * prawdziwego rozbicia diakrytykiem — "ørgen" zaczyna sie od "ø", zwykla
 * etykieta typu "WYG" nie), i oba tokeny musza dzielic ta sama `fontRole`.
 * Zmierzone wprost na realnych danych (ta sama str. 23): "J" i "ørgen Hansen,"
 * maja RÓZNE `fontKey` (pdf.js uzyl dwoch roznych zasobow fontu dla jednego
 * wizualnie skladanego slowa — stad w ogole rozbicie), ALE ta sama `fontRole`
 * ('heading', bo oba sa pogrubionym naglowkiem) — kryterium z briefu
 * ("ten sam klucz fontu") NIE zadzialaloby na tym konkretnym przypadku,
 * dlatego uzyta jest `fontRole` (grubsza, bardziej stabilna klasyfikacja z
 * inwentaryzacji), nie `fontKey`. Regresyjny przypadek "40"+"WYG" ma RÓZNE
 * `fontRole` (`body` kontra `accent`) I "WYG" zaczyna sie od ASCII — oba
 * warunki niezaleznie go wykluczaja.
 */
const DIACRITIC_MERGE_GAP_PT = 1;
const DIACRITIC_MERGE_SHORT_FRAGMENT_MAX_LENGTH = 2;

function looksLikeDiacriticSplit(prev: ProfileToken, next: ProfileToken): boolean {
  const gap = next.bbox.minX - prev.bbox.maxX;
  const sameLine = Math.min(prev.bbox.maxY, next.bbox.maxY) - Math.max(prev.bbox.minY, next.bbox.minY) > 0;
  const shortFragment = prev.text.length <= DIACRITIC_MERGE_SHORT_FRAGMENT_MAX_LENGTH || next.text.length <= DIACRITIC_MERGE_SHORT_FRAGMENT_MAX_LENGTH;
  const nextStartsNonAscii = next.text.length > 0 && next.text.charCodeAt(0) > 127;
  const sameFontRole = prev.fontRole !== undefined && prev.fontRole === next.fontRole;
  return sameLine && gap <= DIACRITIC_MERGE_GAP_PT && shortFragment && nextStartsNonAscii && sameFontRole;
}

function mergeDiacriticSplitTokens(tokens: readonly ProfileToken[]): ProfileToken[] {
  const merged: ProfileToken[] = [];
  for (const t of tokens) {
    const prev = merged.at(-1);
    if (prev && looksLikeDiacriticSplit(prev, t)) {
      merged[merged.length - 1] = {
        ...prev,
        text: prev.text + t.text,
        bbox: { minX: prev.bbox.minX, maxX: t.bbox.maxX, minY: Math.min(prev.bbox.minY, t.bbox.minY), maxY: Math.max(prev.bbox.maxY, t.bbox.maxY) },
      };
      continue;
    }
    merged.push(t);
  }
  return merged;
}

export interface TokenizePagePdfPageLike {
  commonObjs: { has(id: string): boolean; get(id: string): unknown };
}

export interface TextContentItemLike {
  str?: string;
  transform?: number[];
  width?: number;
  fontName?: string;
}

export function tokenizePage(
  items: readonly TextContentItemLike[],
  page: TokenizePagePdfPageLike,
  fontRoles: ReadonlyMap<string, FontRole>,
  pageNumber: number,
): ProfileToken[] {
  const tokens: ProfileToken[] = [];
  for (const item of items) {
    const str = item.str;
    if (!str || !str.trim()) continue;
    const transform = item.transform;
    const size = transform ? fontSizeFromTransform(transform as [number, number, number, number, number, number]) : 0;
    const fontKey = item.fontName ? resolveFontKey(item.fontName, page.commonObjs, size) : undefined;
    const fontRole = fontKey ? fontRoles.get(fontKey) : undefined;
    const x = transform?.[4] ?? 0;
    const y = transform?.[5] ?? 0;
    const w = item.width ?? 0;
    tokens.push({ text: str.trim(), bbox: { minX: x, maxX: x + w, minY: y, maxY: y + (size || 10) }, fontRole, fontKey: fontKey ?? undefined, page: pageNumber });
  }
  // [KROK-42, zmierzony na zywo blad] Odwrotny problem od `mergeDiacriticSplitTokens`
  // powyzej: na niektorych PDF-ach pdf.js samo SKLEJA etykiete i wartosc
  // siatki cech w jeden TextItem ("S 40"), gdy sa wydrukowane bez dwukropka
  // i ciasno. `splitMergedLabelValueTokens` (`inferPatternFromSelection.ts`,
  // uzywana TEZ przez `ProfileStudio.ts`'s `#getBuildTokens`, zeby oba
  // miejsca widzialy ten sam podzial) rozdziela je z powrotem — patrz
  // komentarz przy jej definicji.
  //
  // [KROK-43, zmierzony na zywo blad] `stripStrayLeadingColonTokens`
  // (ten sam plik, ten sam wspoldzielony mechanizm) usuwa dwukropek, ktory
  // pdf.js czasem zostawia na POCZATKU wartosci zamiast na koncu etykiety —
  // patrz komentarz przy jej definicji ("Pancerz" / ": Brak.").
  return splitMergedLabelValueTokens(stripStrayLeadingColonTokens(mergeDiacriticSplitTokens(tokens)));
}

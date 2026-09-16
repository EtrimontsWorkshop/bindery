import type { Rect } from '../geometry.js';
import type { Diagnostic } from '../text/types.js';
import { normalizeDecodedImage, type DecodedImage } from './normalizeDecodedImage.js';
import type { PdfPageForRender, RegionRenderer, RenderRegionOptions } from './regionRenderer.js';

/**
 * Ekstrakcja bezposrednia (KROK-7 Z4, MDD faza 3 "Przebieg 2"). Sciezka
 * trzystopniowa w ustalonej kolejnosci: `page.objs` -> `page.commonObjs` ->
 * fallback renderu regionu (Z3). Kazdy wynik przez `normalizeDecodedImage()`
 * (U2). Nieudane dekodowanie -> `Diagnostic` (warning), NIGDY ciche pominiecie
 * (U6 — JPX bez `wasmUrl` cicho zwraca `undefined`, nie rzuca).
 *
 * [KROK-7, odkrycie] `objId` zasobow, ktore pdf.js z gory uznaje za
 * "wspoldzielone miedzy stronami" (np. ozdobnik z tego samego obiektu PDF w
 * Resources kilku stron), nosi prefiks `"g_"` (np. `"g_d0_img_p1_1"`) — pdf.js
 * SAM tak je rozroznia (`pdf.mjs`: `data.startsWith("g_") ? commonObjs.get(data)
 * : objs.get(data)`). Zmierzone empirycznie: PRAWO PO `getOperatorList()`
 * jednej strony `commonObjs` jest CALKOWICIE PUSTE dla takiego zasobu — obietnica
 * "promocji" (patrz U1/RAPORT-KROK-4.md) jeszcze sie nie ziscila (wymaga
 * dalszego przetwarzania — innych stron i/lub renderu). Dla takich zasobow
 * OBIE sciezki (`objs`/`commonObjs`) legalnie zawodza na tym etapie, i kod
 * poprawnie spada do renderu regionu — TO NIE JEST BLAD, to spodziewane
 * zachowanie udokumentowane tutaj, zeby przyszly czytelnik kalibracji (wysoki
 * udzial strategii `region-render` dla zasobow wielostronicowych) nie szukal
 * nieistniejacego buga.
 */

/**
 * Podzbior `PDFObjects` (pdf.js `page.objs`/`page.commonObjs`) faktycznie
 * uzywany tutaj. [U3] `get(objId, callback)` z callbackiem to JEDYNY bezpieczny
 * wariant — bez callbacku i bez uprzedniego rozwiazania rzuca
 * `"Requesting object that isn't resolved yet"`. Co WAZNIEJSZE, empirycznie
 * zweryfikowane wprost w zrodle (`PDFObjects.get` w pdf.mjs): wywolanie
 * `get(objId, callback)` dla objId, ktory NIGDY sie nie rozwiaze, WSTAWIA
 * pusty placeholder i CZEKA W NIESKONCZONOSC — `callback` nigdy nie zostanie
 * wywolany. Dlatego `has(objId)` MUSI byc sprawdzone PRZED wywolaniem `get`
 * z callbackiem; bez tego kazda probka na obiekt, ktorego nie ma w tym
 * rejestrze (bo jest w drugim), zawiesza cala ekstrakcje bezterminowo.
 */
export interface PdfObjectsLike {
  has(objId: string): boolean;
  get(objId: string, callback: (data: unknown) => void): void;
}

export interface PdfPageForExtract extends PdfPageForRender {
  objs: PdfObjectsLike;
  commonObjs: PdfObjectsLike;
  /** MUSI byc wywolane PRZED probami `objs.get()`/`commonObjs.get()` — wypelnia oba rejestry (patrz komentarz przy `PdfObjectsLike`). */
  getOperatorList(): Promise<unknown>;
}

export type ExtractSource = 'objs' | 'commonObjs' | 'region-render';

export interface ExtractDirectResult {
  image: DecodedImage;
  source: ExtractSource;
  diagnostics: Diagnostic[];
}

/** `null` gdy `objId` nie jest (jeszcze) obecny w tym rejestrze — wolajacy probuje nastepna sciezke, NIGDY nie czeka na `get()` bez tego sprawdzenia (patrz komentarz na gorze pliku). */
function resolveIfReady(objs: PdfObjectsLike, objId: string): Promise<unknown> | null {
  if (!objs.has(objId)) return null;
  return new Promise((resolve) => objs.get(objId, resolve));
}

interface ResolveAttemptResult {
  /** Sukces (piksele gotowe) LUB `null` — a jesli `null`, `attempted` odrozna
   * "probowalismy, dekodowanie zawiodlo" (retry po rozgrzewce bez sensu — te
   * same bajty daja ten sam wynik) od "zaden rejestr go jeszcze nie mial"
   * (retry po rozgrzewce MA sens — `has()` mogl sie zmienic po `page.render()`). */
  resolved: { image: DecodedImage; source: ExtractSource } | null;
  attempted: boolean;
}

/** Jedna proba przejscia `objs` -> `commonObjs` dla `objId`. */
async function tryResolveFromRegistries(page: PdfPageForExtract, objId: string, pageNumber: number, diagnostics: Diagnostic[]): Promise<ResolveAttemptResult> {
  const sources: readonly [ExtractSource, PdfObjectsLike][] = [
    ['objs', page.objs],
    ['commonObjs', page.commonObjs],
  ];
  let attempted = false;
  for (const [source, objs] of sources) {
    const pending = resolveIfReady(objs, objId);
    if (!pending) continue;
    attempted = true;
    try {
      const raw = await pending;
      if (raw == null) {
        // [U6] Dekodowanie cicho zwrocilo pustke (typowe dla JPX bez skonfigurowanego wasmUrl) — zgloszone, NIGDY pominiete bez sladu.
        diagnostics.push({
          severity: 'warning',
          code: 'IMAGE_DECODE_EMPTY',
          params: { objId, source },
          pageNumber,
        });
        continue;
      }
      return { resolved: { image: normalizeDecodedImage(raw), source }, attempted };
    } catch (err) {
      diagnostics.push({
        severity: 'warning',
        code: 'IMAGE_DECODE_FAILED',
        params: { objId, source, error: err instanceof Error ? err.message : String(err) },
        pageNumber,
      });
    }
  }
  return { resolved: null, attempted };
}

/**
 * Probuje wyciagnac obraz `objId` bezposrednio (przez `page.objs` albo
 * `page.commonObjs`), a jesli sie nie uda — renderuje `bbox` jako fallback
 * (Z3). Zawsze zwraca wynik (fallback renderu nie zawodzi z powodu braku
 * obiektu — dziala nawet dla grafiki czysto wektorowej, `objId=null`).
 *
 * [KROK-16 Z2, naprawa zgloszonego bledu na zywo] Miedzy pierwsza proba a
 * ostatecznym poddaniem sie na rzecz renderu regionu jest jeszcze JEDNA
 * proba, PO renderze rozgrzewajacym — zaobserwowane wprost na duzym
 * dokumencie (250+ stron, `Cienie_posrod_mgie.pdf`): dla zwyklych (nie-`g_`)
 * `objId`, ktore normalnie powinny rozwiazac sie przez `page.objs` od razu po
 * `getOperatorList()`, `has()` czasem zwraca `false` na obu sciezkach — pdf.js
 * "obiecuje" promocje zasobu do rejestru DOPIERO po pelnym renderze strony
 * (`page.render()`), nie po samej liscie operatorow (patrz komentarz na
 * gorze pliku, ta sama non-determinizm co udokumentowany dla zasobow `g_`
 * juz w fazie 0/MDD ryzyko R-13 — tu ujawniony rowniez dla zwyklych `objId`
 * na wystarczajaco duzych dokumentach). Zanim ten fakt byl znany, kod od razu
 * spadal na render REGIONU (fragmentu strony) jako ostateczny wynik — co
 * DZIALA (poprawny bbox), ale renderuje SKOMPONOWANA tresc strony (obraz +
 * cokolwiek jeszcze tam jest, np. sasiedni akapit tekstu), NIE izolowane
 * piksele samego zasobu obrazu. Render regionu I TAK musi sie odbyc jako
 * fallback (ten sam koszt, nie dodatkowy) — wykorzystany tu NAJPIERW jako
 * "rozgrzewka" (wymusza `page.render()`, a wiec i promocje), z PONOWNA proba
 * `objs`/`commonObjs` PO nim — ALE WYLACZNIE gdy pierwsza proba nie miala W
 * OGOLE czego probowac (`has()` false na obu rejestrach — "moze sie jeszcze
 * pojawi po renderze"). Jesli pierwsza proba COS probowala i dekodowanie
 * zawiodlo (`IMAGE_DECODE_EMPTY`/`IMAGE_DECODE_FAILED`), ponawianie jest bez
 * sensu — te same bajty po tym samym renderze dadza ten sam blad, retry
 * jedynie zdublowalby diagnostyki. Gdy sie powiedzie — zwracamy czyste
 * piksele zasobu zamiast skomponowanego zrzutu strony. Gdy nadal sie nie
 * powiedzie — uzywamy PIKSELI JUZ WYRENDEROWANYCH podczas rozgrzewki jako
 * wynik koncowy (zero dodatkowego renderu, identyczny koszt jak przed ta
 * zmiana).
 */
export async function extractDirect(
  page: PdfPageForExtract,
  objId: string | null,
  bbox: Rect,
  renderer: RegionRenderer,
  renderOpts: RenderRegionOptions,
  pageNumber: number,
): Promise<ExtractDirectResult> {
  const diagnostics: Diagnostic[] = [];

  let firstAttempted = false;
  if (objId !== null) {
    const first = await tryResolveFromRegistries(page, objId, pageNumber, diagnostics);
    if (first.resolved) return { ...first.resolved, diagnostics };
    firstAttempted = first.attempted;
  }

  const renderedImage = await renderer.renderRegion(page, bbox, renderOpts);

  if (objId !== null && !firstAttempted) {
    const afterWarmup = await tryResolveFromRegistries(page, objId, pageNumber, diagnostics);
    if (afterWarmup.resolved) return { ...afterWarmup.resolved, diagnostics };
  }

  return { image: renderedImage, source: 'region-render', diagnostics };
}

/**
 * [KROK-8 Z3] Sonduje NATYWNA (zrodlowa) dlugosc dluzszej krawedzi obrazu
 * `objId` w pikselach, bez decydowania o strategii ekstrakcji — uzywane przez
 * orkiestrator do wyznaczenia rozdzielczosci docelowej renderu regionu (patrz
 * `renderResolution.ts`), NIE do samej ekstrakcji. Ta sama sciezka `objs` ->
 * `commonObjs` co `extractDirect` (U3: `has()` przed `get()` z callbackiem),
 * ale NIGDY nie spada do renderu regionu — brak wyniku (null) oznacza po
 * prostu "nieznana natywna rozdzielczosc", nie blad; wolajacy uzyje wtedy
 * samych minimow/domyslnych z ustawien. `page.objs`/`commonObjs` KESZUJE juz
 * rozwiazane obiekty (patrz `PDFObjects.resolve` w pdf.mjs), wiec to
 * NIE jest dodatkowy koszt dekodowania ponad to, co pdf.js i tak wykonal przy
 * budowie listy operatorow tej strony — tylko odczyt juz gotowych wymiarow.
 */
export async function probeIntrinsicLongEdgePx(page: PdfPageForExtract, objId: string): Promise<number | null> {
  const sources: readonly PdfObjectsLike[] = [page.objs, page.commonObjs];
  for (const objs of sources) {
    const pending = resolveIfReady(objs, objId);
    if (!pending) continue;
    try {
      const raw = await pending;
      if (raw == null) continue;
      const image = normalizeDecodedImage(raw);
      return Math.max(image.width, image.height);
    } catch {
      continue; // sondaz jest "best-effort" — nieudane dekodowanie tutaj nie jest bledem, patrz komentarz funkcji.
    }
  }
  return null;
}

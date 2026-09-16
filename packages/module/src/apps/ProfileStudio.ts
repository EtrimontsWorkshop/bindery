import type {
  AttachGeometryMeasurement,
  DocumentAnalysis,
  EntityAnalysis,
  IndexedSelectionToken,
  ItemShapeCode,
  LabelledPairConfidence,
  OverlapWarning,
  PageAnalysis,
  PageRoute,
  PatternMatchCount,
  PreviewDocument,
  ProfileV2,
  Rect,
  RelationCheckResult,
  StudioRegionKind,
  ValueCandidate,
} from '@bindery/core';
import { ASSET_BASE_URL } from '../settings.js';
import { validateActorProfileFile } from '../api.js';
import {
  createEmptyProfileDraft,
  createPatternDraft,
  draftToProfileInput,
  escapeSectionBoundaryLiteral,
  profileToDraft,
  type AttachRuleDraft,
  type FontRoleCandidatePatternDraft,
  type LabelEntryDraft,
  type PatternDraft,
  type PatternEntryDraft,
  type ProfileDraft,
} from '../review/profileDraft.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * [KROK-22] Profile Studio — narzedzie autora profilu (osobne od
 * `ImportWizard`/`ReviewScreen`, ktore importuja). Cala analiza
 * (`analyzeProfileDocument` i inne funkcje `@bindery/core`) zyje w rdzeniu —
 * ten plik WYLACZNIE rysuje i obsluguje zdarzenia (`check:boundary`).
 *
 * [KROK-28, KOREKTA architektury ekranu] Poprzednia wersja (krok 22-27)
 * miala trzy zakladki mieszajace trzy rozne osie (Strona=widok materialu,
 * Cały dokument=widok wynikow, Edytor=tryb pracy), bez zadnej reprezentacji
 * czwartej, najwazniejszej osi: KTORA CZESC PROFILU wlasnie sie buduje. Stad
 * dwa zgloszone przez wlasciciela produktu problemy: panel pokazywal trzy
 * komunikaty naraz (bo nie wiedzial, w jakim jest stanie), i dalo sie dodac
 * WYLACZNIE cechy z widoku strony — zeby wskazac pochodna (np. PW), trzeba
 * bylo przejsc do Edytora, a nawet tam nie dalo sie jej kliknac na PDF-ie,
 * bo nie istnial stan "wskazuje pochodne".
 *
 * Nowa architektura: **ekran wejsciowy** (Nowy profil / Edycja profilu) ->
 * **ekran budowania** (PDF po lewej, panel po prawej). Zakladki panelu to
 * TERAZ WZORCE profilu — Cechy/Pochodne/Ataki/Umiejetnosci/Nazwa/Sprawdz —
 * nie widoki. Klikniecie w PDF dotyczy WYLACZNIE aktywnej zakladki: to
 * rozwiazuje problem nr 2 U ZRODLA (etykieta powstaje z klikniecia W
 * KONTEKSCIE zakladki, na ktorej autor stoi, nie z osobnego kroku "utworz
 * etykiete"). Mechanika Z1-Z6 z poprzedniej wersji (celowany redraw bez
 * pelnego `render()`, automatyczny odczyt wartosci obok etykiety, granice
 * sekcji przez przeciaganie, linia prowadzaca, ukryte ustawienia
 * zaawansowane) zostaje BEZ ZMIAN — korekta dotyczy WYLACZNIE tego, co je
 * hostuje.
 *
 * [I3] Statyczny import w `settings.ts` (`registerMenu` wymaga klasy
 * dostepnej synchronicznie) — dlatego ten plik NIGDY nie importuje
 * `@bindery/core` jako REALNEJ wartosci na poziomie modulu, WYLACZNIE
 * `import type` + dynamiczny `import()` wewnatrz metod. `check:size` (budzet
 * <40KB startu swiata) egzekwuje to w CI.
 */

interface ProfileSummary {
  title: string;
  publication: string;
  gameLine: string;
  language: string;
  patternCount: number;
}

type BuildTab = 'grid' | 'derived' | 'attacks' | 'skills' | 'notes' | 'name' | 'check';
type EntryMode = 'choose' | 'new' | 'edit';

const ROUTE_OPTIONS: readonly PageRoute[] = ['npc', 'playerCharacter'];

/**
 * [KROK-39 Z2] Pola `ProfileDraft` specyficzne dla JEDNEJ trasy — dokladnie
 * to, co w schemacie (`schema.ts`, `@bindery/core`) tworzy `PatternSet`
 * (`patterns`/`entityAssembly`), rozbite na plaski ksztalt szkicu. Reszta pol
 * `ProfileDraft` (metadane profilu) jest WSPOLNA dla obu tras — patrz
 * `#activeRoute` w `ProfileStudio`.
 */
type RoutePatternSlice = Pick<ProfileDraft, 'patterns' | 'anchor' | 'attach' | 'nameConfidenceThreshold' | 'namePlaceholder' | 'skillsPattern' | 'typeLabelPattern' | 'notesPatterns'>;

function extractRouteSlice(draft: ProfileDraft): RoutePatternSlice {
  return {
    patterns: draft.patterns,
    anchor: draft.anchor,
    attach: draft.attach,
    nameConfidenceThreshold: draft.nameConfidenceThreshold,
    namePlaceholder: draft.namePlaceholder,
    skillsPattern: draft.skillsPattern,
    typeLabelPattern: draft.typeLabelPattern,
    notesPatterns: draft.notesPatterns,
  };
}

function applyRouteSlice(draft: ProfileDraft, slice: RoutePatternSlice): void {
  draft.patterns = slice.patterns;
  draft.anchor = slice.anchor;
  draft.attach = slice.attach;
  draft.nameConfidenceThreshold = slice.nameConfidenceThreshold;
  draft.namePlaceholder = slice.namePlaceholder;
  draft.skillsPattern = slice.skillsPattern;
  draft.typeLabelPattern = slice.typeLabelPattern;
  draft.notesPatterns = slice.notesPatterns;
}

/** [KROK-39 Z2] Punkt startowy dla trasa `playerCharacter`, gdy autor przelacza sie na nia po raz pierwszy w tej sesji edycji — te same domyslne wartosci co `createEmptyProfileDraft`, ale WYLACZNIE dla pol per-trasa (`RoutePatternSlice`). */
function emptyRouteSlice(): RoutePatternSlice {
  return { patterns: [], anchor: '', attach: [], nameConfidenceThreshold: 0.7, namePlaceholder: 'Postać #{ordinal} (str. {page})', skillsPattern: '', typeLabelPattern: '', notesPatterns: [] };
}

interface StudioState {
  /**
   * [KROK-28 korekta] Ekran wejsciowy (dwie opcje, nic wiecej) vs ekran budowania (PDF + zakladki-wzorce).
   * [zgloszenie uzytkownika, "dobrze by bylo najpierw pokazac uzupelnienie
   * metadanych, a dopiero po uzupelnieniu przechodzic dalej"] `'metadata'`
   * wstawiony MIEDZY nimi — `#maybeEnterBuildScreen` (Nowy/Edycja profilu,
   * po zaladowaniu wymaganych plikow) laduje TU, nie od razu w `'build'`.
   * Bez tego kroku autor budujacy nowy profil trafial na "Sprawdz"/"Notatki"
   * (ktore waliduja CALY szkic, patrz `#onNoteTokenClick`) z domyslnie
   * pustymi `id`/`gameLine`/`language`/`title`/`publication` — pieciu polami
   * bez znaczenia dla samego dopasowania, ale wymaganymi przez schemat pliku
   * (`profileV2Schema`), i dowiadywal sie o tym dopiero z bledu walidacji
   * PRZY PROBIE uzycia zupelnie innej funkcji.
   */
  screen: 'entry' | 'metadata' | 'build';
  /** Ktora sciezka ekranu wejsciowego jest w toku — `'choose'` = same dwa przyciski, `'new'`/`'edit'` = odpowiedni(e) picker(y) plikow. */
  entryMode: EntryMode;
  pdfFileName: string | null;
  profileFileName: string | null;
  profileSummary: ProfileSummary | null;
  profileIssues: readonly string[] | null;
  isAnalyzing: boolean;
  analyzeProgress: { done: number; total: number } | null;
  analyzeError: string | null;
  currentPageNumber: number;
  pageCount: number;
  /** [KROK-28 korekta] Zakladka ekranu budowania — KAZDA to jeden wzorzec profilu, nie widok. `'check'` (dawne "Cały dokument") jest zawsze ostatnia. */
  buildTab: BuildTab;
  /** Bledy `validateProfile` po "Zapisz"/przebiegu — czytelne, nigdy wyjatek. */
  editorIssues: readonly string[] | null;
  rawJsonMode: boolean;
  rawJsonError: string | null;
  /** [KROK-24 Z1] Tryb "obrysuj obszar myszą" — dostepny WYLACZNIE na zakladkach Cechy/Pochodne (obrysowanie granic sekcji dzieje sie geometrycznie, Z3, nie przez zaznaczenie obszaru). */
  isSelectAreaMode: boolean;
}

/** [KROK-23 Z6] Cel biezacego "wskaz na stronie" z formularza zaawansowanego — klikniecie tokenu wstawia jego tekst do tego pola. `null` = tryb wskazywania nieaktywny. */
interface PickTarget {
  description: string;
  apply: (text: string) => void;
}

/** [KROK-24 Z1, uproszczone w KROK-28 korekcie] Propozycja z obrysowania obszaru — WYLACZNIE pary etykieta-wartosc (siatka/pochodne). Sekcje buduje sie geometrycznie (Z3), nie hurtowym zaznaczeniem, wiec `select area` jest dostepne tylko na zakladkach Cechy/Pochodne — `slot` mowi, ktora z nich. */
interface SelectionProposal {
  slot: 'grid' | 'derived';
  pairs: { label: string; value: string; canonicalKey: string; checked: boolean; confidence: LabelledPairConfidence }[];
  rawPreview: string;
}

/** [KROK-24 Z2] Stan pomiaru geometrii per wiersz reguly dolaczenia — kluczowany po REFERENCJI obiektu `AttachRuleDraft`, zeby przetrwac ponowne budowanie panelu przy kazdym celowanym redraw. */
type MeasurementState = { state: 'measuring' } | { state: 'error'; message: string } | { state: 'done'; result: AttachGeometryMeasurement };

const BUILD_TABS: readonly BuildTab[] = ['grid', 'derived', 'attacks', 'skills', 'notes', 'name', 'check'];

export class ProfileStudio extends HandlebarsApplicationMixin(ApplicationV2) {
  static override DEFAULT_OPTIONS = {
    id: 'bindery-profile-studio',
    classes: ['bindery', 'bindery-profile-studio'],
    window: {
      title: 'BINDERY.studio.title',
      resizable: true,
      icon: 'fa-solid fa-flask',
    },
    // [zgloszenie uzytkownika, "wyglada bardzo nieczytelnie"] Podniesione
    // razem z resztą redesignu, tym samym powodem co ReviewScreen (krok
    // "Zmiana wyglądu"): dwukolumnowy uklad podgladu strony (340px) + panel
    // budowania scisnietego w waskim oknie robil sie ciasny, zwlaszcza z
    // szerszymi kontrolkami (pigulki `.bindery-input`/`.bindery-select`,
    // ktore maja wieksze `min-width` niz stare, waskie inputy).
    position: { width: 1180, height: 720 },
    actions: {
      chooseNewProfile: ProfileStudio.#onChooseNewProfile,
      chooseEditProfile: ProfileStudio.#onChooseEditProfile,
      backToEntry: ProfileStudio.#onBackToEntry,
      continueFromMetadataStep: ProfileStudio.#onContinueFromMetadataStep,
      switchBuildTab: ProfileStudio.#onSwitchBuildTab,
      switchRoute: ProfileStudio.#onSwitchRoute,
      runFullScan: ProfileStudio.#onRunFullScan,
      exportDiagnostics: ProfileStudio.#onExportDiagnostics,
      prevPage: ProfileStudio.#onPrevPage,
      nextPage: ProfileStudio.#onNextPage,
      saveProfileJson: ProfileStudio.#onSaveProfileJson,
      toggleRawJsonMode: ProfileStudio.#onToggleRawJsonMode,
      toggleSelectArea: ProfileStudio.#onToggleSelectArea,
    },
  };

  static override PARTS = {
    main: { template: 'modules/bindery/templates/profile-studio.hbs' },
  };

  #state: StudioState = {
    screen: 'entry',
    entryMode: 'choose',
    pdfFileName: null,
    profileFileName: null,
    profileSummary: null,
    profileIssues: null,
    isAnalyzing: false,
    analyzeProgress: null,
    analyzeError: null,
    currentPageNumber: 1,
    pageCount: 0,
    buildTab: 'grid',
    editorIssues: null,
    rawJsonMode: false,
    rawJsonError: null,
    isSelectAreaMode: false,
  };

  #pdfBuffer: ArrayBuffer | null = null;
  #profile: ProfileV2 | null = null;
  #previewDocument: PreviewDocument | null = null;
  #docAnalysis: DocumentAnalysis | null = null;
  #scanController: AbortController | null = null;

  static readonly #PAGE_CACHE_SIZE = 6;
  #pageImageCache = new Map<number, string>();
  #pageImageOrder: number[] = [];
  #pageRenderToken = 0;

  /**
   * [Zmierzony na zywo blad] Powiekszenie/zmniejszenie okna zmienia
   * `img.clientWidth/clientHeight` (obraz jest `width:100%`), ale `#mountOverlay`/
   * `#mountPickableTokens` licza rozmiar nakladki SVG WYLACZNIE w momencie
   * wlasnego rysowania — bez tego obserwatora nic nie wywolywalo ponownego
   * rysowania PRZY SAMEJ zmianie rozmiaru okna (dopiero zmiana strony i powrot
   * wymuszaly redraw), wiec klikalne prostokaty na PDF-ie "rozjezdzaly sie" z
   * tekstem po zmianie rozmiaru okna. `ResizeObserver` na `<img>` (nie na
   * `<svg>`, ktory ten redraw sam modyfikuje — obserwowanie wlasnego celu
   * rysowania stworzyloby petle) wywoluje TEN SAM ciag rysowania co
   * `_onRender`, za kazdym razem, gdy realny rozmiar obrazu na ekranie sie
   * zmienia, niezaleznie od przyczyny.
   */
  #overlayResizeObserver: ResizeObserver | null = null;

  #highlighted: { entityOrdinal: number; kind: StudioRegionKind } | null = null;

  #draft: ProfileDraft | null = null;
  /**
   * [KROK-39 Z2] Ktora trasa (`pageRoute.ts`, `@bindery/core`) jest AKTUALNIE
   * edytowana. `#draft`'s pola specyficzne dla trasy (patrz `RoutePatternSlice`
   * nizej: `patterns`/`anchor`/`attach`/`nameConfidenceThreshold`/
   * `namePlaceholder`/`skillsPattern`/`typeLabelPattern`/`notesPatterns`)
   * ZAWSZE naleza do TEJ trasy — reszta pol `#draft` (metadane profilu:
   * id/gameLine/title/pages/images/...) jest WSPOLNA dla obu tras i NIGDY nie
   * jest podmieniana przy przelaczeniu, patrz `#switchRoute`.
   */
  #activeRoute: PageRoute = 'npc';
  /** [KROK-39 Z2] Wycinek wzorcow trasy `npc`, odlozony na bok gdy `#activeRoute !== 'npc'` — `null`, dopoki autor ani razu nie odwiedzil/opuscil trasy `npc` w tej sesji edycji (przy wczytaniu profilu jest ZAWSZE wypelniony, bo `#activeRoute` startuje jako `'npc'`). Patrz `#switchRoute`/`#extractRouteSlice`. */
  #npcRouteSlice: RoutePatternSlice | null = null;
  /** [KROK-39 Z2] Jak wyzej, dla trasy `playerCharacter` — `null`, gdy profil jej jeszcze nie ma (brak sekcji `playerCharacter` = trasa nieobslugiwana, `schema.ts`). */
  #playerCharacterRouteSlice: RoutePatternSlice | null = null;
  #rawJsonText = '';
  #pickTarget: PickTarget | null = null;

  // ---- [KROK-24 Z1] Inferencja wzorca z zaznaczenia myszą ----------------
  #dragState: { startScreen: { x: number; y: number }; rectEl: SVGRectElement } | null = null;
  #selectionProposal: SelectionProposal | null = null;

  // ---- [KROK-24 Z2] Pomiar geometrii per regula dolaczenia ---------------
  #measurements = new Map<AttachRuleDraft, MeasurementState>();

  // ---- [KROK-24 Z3] Weryfikacja mapowan mechanika ------------------------
  #mechanicalRelations: string[] = [''];
  #mechanicalResults: RelationCheckResult[] | null = null;

  // ---- [KROK-28, KOREKTA] Budowanie profilu wskazywaniem, per zakladka ---
  /** Tokeny CALEJ biezacej strony, z indeksem w strumieniu. */
  #buildTokensCache = new Map<number, IndexedSelectionToken[]>();
  /** [Korekta] Kazda zakladka-wzorzec ma WLASNY, jawny slot — inaczej niz w poprzedniej wersji (jeden "aktywny" wzorzec dzielony przez wszystko), co bylo dokladnie zrodlem zgloszonego problemu "da sie dodac tylko cechy". */
  #activeGridPatternId: string | null = null;
  #activeDerivedPatternId: string | null = null;
  #activeAttackPatternId: string | null = null;
  #activeSkillsPatternId: string | null = null;
  #activeNamePatternId: string | null = null;
  /** [ZGŁOSZENIE po kroku 30, "Rozdzielenie nazwy od typu/zawodu"] Drugi, niezalezny slot NA TEJ SAMEJ zakladce "Nazwa" — patrz `#nameSubMode`. */
  #activeTypeLabelPatternId: string | null = null;
  /** [ZGŁOSZENIE po kroku 30] Ktory z dwoch trybow wskazywania na zakladce "Nazwa" jest aktywny — jedna zakladka, dwa aspekty tej samej encji (nazwa/zawod), nie dwie osobne zakladki. */
  #nameSubMode: 'name' | 'typeLabel' = 'name';
  /**
   * [KROK-34 Z2] Zakladka "Notatki" jest INNA niz reszta — WIELE niezaleznych
   * blokow (`draft.notesPatterns`, kolejnosc = kolejnosc w liscie), nie jeden
   * slot per zakladka. Zamiast `#activeXPatternId`, ten stan sledzi KTORY
   * blok WLASNIE czeka na klikniecie w PDF-ie, zeby zmierzyc jego `offset`
   * (`null` = zaden, klikniecia na tej zakladce nic nie robia).
   */
  #notesPickPatternId: string | null = null;
  /**
   * [KROK-34 Z2] Podglad per blok notatki, liczony WYLACZNIE na zadanie
   * (klikniecie/"Odśwież podgląd"), nigdy automatycznie przy kazdym
   * przerysowaniu (unika petli renderowania) — patrz `#refreshNotePreview`.
   * `'loading'` w trakcie liczenia, `null` gdy jeszcze nie liczono ANI teraz
   * nie liczy, tablica `{ordinal,text}[]` (jeden wpis na encje znaleziona na
   * BIEZACEJ stronie) po zakonczeniu.
   */
  #notesPreview = new Map<string, 'loading' | { ordinal: number; text: string | null }[]>();
  /** [Z2] WYLACZNIE podglad w panelu ("S → Siła [140]") — wartosc NIGDY nie jest zapisywana w szkicu, klucz `patternId:label`. */
  #buildPairPreviewValues = new Map<string, string>();
  /** [Z2] Klikniecie etykiety dalo WIECEJ NIZ JEDNEGO kandydata na wartosc — czekamy na DRUGIE klikniecie, zamiast zgadywac (A10). */
  #pendingValueChoice: { slot: 'grid' | 'derived'; labelText: string; labelBbox: Rect; candidates: readonly ValueCandidate[] } | null = null;
  /** [Z3] Ktora sekcja (Ataki/Umiejetnosci) jest "w ognisku" przeciagania granicy — strona i indeks naglowka razem, bo nakladka ma sens WYLACZNIE na stronie, na ktorej kliknieto naglowek. */
  #sectionBoundaryFocus: { patternId: string; page: number; headerTokenIndex: number } | null = null;
  /** [Z3] Aktywne przeciaganie dolnej krawedzi zasiegu sekcji. */
  #boundaryDrag: {
    patternId: string;
    headerTokenIndex: number;
    startPdfY: number;
    pageWidthPx: number;
    pageHeightPx: number;
    overlapCheckBboxes: readonly Rect[];
  } | null = null;
  /** [KROK-29 Z1] Przykladowe teksty pozycji klikniete przez autora, klucz `patternId` -- wejscie do `inferItemPatternFromExamples`. Rosnie z kazdym klikniecim w fazie 3 (granica juz ustawiona), NIGDY nie jest zapisywane wprost do szkicu (tylko wygenerowany `itemPattern` jest). */
  #itemPatternExamples = new Map<string, string[]>();
  /** [KROK-29 Z1] Ostatnio rozpoznany ksztalt per wzorzec — WYLACZNIE do czytelnego komunikatu w panelu ("Rozpoznano: nazwa → procent → ..."), nigdy surowy regex. */
  #itemPatternShape = new Map<string, ItemShapeCode>();

  override async _prepareContext(): Promise<Record<string, unknown>> {
    const currentPageAnalysis = this.#docAnalysis?.pages[this.#state.currentPageNumber - 1] ?? null;
    return {
      isScreenEntry: this.#state.screen === 'entry',
      isScreenMetadata: this.#state.screen === 'metadata',
      isScreenBuild: this.#state.screen === 'build',
      isEntryChoose: this.#state.entryMode === 'choose',
      isEntryNew: this.#state.entryMode === 'new',
      isEntryEdit: this.#state.entryMode === 'edit',
      pdfFileName: this.#state.pdfFileName,
      profileFileName: this.#state.profileFileName,
      profileSummary: this.#state.profileSummary,
      hasProfile: this.#state.profileSummary !== null,
      profileIssues: this.#state.profileIssues,
      hasProfileError: this.#state.profileIssues !== null,
      hasPdf: this.#pdfBuffer !== null,
      canEnterBuild: this.#pdfBuffer !== null && (this.#state.entryMode === 'new' || this.#state.profileSummary !== null),
      isAnalyzing: this.#state.isAnalyzing,
      analyzeProgress: this.#state.analyzeProgress,
      analyzeError: this.#state.analyzeError,
      hasAnalysis: this.#docAnalysis !== null,
      currentPageNumber: this.#state.currentPageNumber,
      pageCount: this.#state.pageCount,
      canGoPrevPage: this.#state.currentPageNumber > 1,
      canGoNextPage: this.#state.currentPageNumber < this.#state.pageCount,
      currentPageImageUrl: this.#pageImageCache.get(this.#state.currentPageNumber) ?? null,
      // [KROK-39 Z2] Przelacznik trasy nad zakladkami — "NPC i potwory" /
      // "Postacie graczy" (brief). Zakladki ponizej (`buildTabs`) sa TE SAME
      // niezaleznie od trasy — budowane z innego zestawu danych (`#draft`
      // wskazuje aktualnie na wycinek AKTYWNEJ trasy, patrz `#switchRoute`).
      activeRoute: this.#activeRoute,
      routeOptions: ROUTE_OPTIONS.map((route) => ({ id: route, active: route === this.#activeRoute, label: this.#routeLabel(route) })),
      buildTab: this.#state.buildTab,
      buildTabs: BUILD_TABS.map((tab) => ({
        id: tab,
        active: tab === this.#state.buildTab,
        label: game.i18n!.localize(ProfileStudio.#BUILD_TAB_LABEL_KEYS[tab] as never),
        badge: this.#computeTabBadge(tab),
      })),
      isBuildTabCheck: this.#state.buildTab === 'check',
      canSelectArea: this.#draft !== null && (this.#state.buildTab === 'grid' || this.#state.buildTab === 'derived'),
      isSelectAreaMode: this.#state.isSelectAreaMode,
      rawJsonMode: this.#state.rawJsonMode,
      editorIssues: this.#state.editorIssues,
      hasEditorIssues: this.#state.editorIssues !== null,
      pickHint: this.#pickTarget?.description ?? null,
      docSummary: this.#docAnalysis
        ? {
            totalEntities: this.#docAnalysis.totalEntities,
            totalWarnings: this.#docAnalysis.totalWarnings,
            totalPlaceholderNames: this.#docAnalysis.totalPlaceholderNames,
            pageCount: this.#docAnalysis.pageCount,
          }
        : null,
      _pageAnalysis: currentPageAnalysis as unknown,
      _docAnalysis: this.#docAnalysis as unknown,
    };
  }

  static readonly #BUILD_TAB_LABEL_KEYS: Readonly<Record<BuildTab, string>> = {
    grid: 'BINDERY.studio.buildTabGrid',
    derived: 'BINDERY.studio.buildTabDerived',
    attacks: 'BINDERY.studio.buildTabAttacks',
    skills: 'BINDERY.studio.buildTabSkills',
    notes: 'BINDERY.studio.buildTabNotes',
    name: 'BINDERY.studio.buildTabName',
    check: 'BINDERY.studio.buildTabCheck',
  };

  /** [KROK-28 korekta] "Autor widzi na pierwszy rzut oka, co zostało do zrobienia, bez klikania po zakładkach." Pusta / liczba / ostrzeżenie — w tej kolejności pierwszenstwa (ostrzezenie przebija liczbe). */
  #computeTabBadge(tab: BuildTab): { kind: 'empty' } | { kind: 'count'; n: number } | { kind: 'warning' } {
    if (tab === 'check') {
      if (this.#docAnalysis && this.#docAnalysis.totalWarnings > 0) return { kind: 'warning' };
      if (this.#docAnalysis) return { kind: 'count', n: this.#docAnalysis.totalWarnings };
      return { kind: 'empty' };
    }
    // [KROK-34 Z2] Notatki maja WIELE wzorcow naraz (`draft.notesPatterns`),
    // nie jeden slot jak reszta zakladek — sama LICZBA skonfigurowanych
    // blokow, bez proby wywiedzenia ostrzezenia: `patternMatchTotals` dla
    // `proseBlock` jest ZAWSZE 0 (nie skanuje strony tekstowo, patrz
    // `studioAnalysis.ts`), wiec "0 trafien" nie niesie tu zadnej informacji
    // — prawdziwa skutecznosc widoczna jest w podgladzie per blok nizej, nie
    // w odznace zakladki.
    if (tab === 'notes') {
      const n = this.#draft?.notesPatterns.length ?? 0;
      if (n === 0) return { kind: 'empty' };
      // [ZGŁOSZENIE na żywo, patrz `#noteLooksTruncated`] W odroznieniu od
      // reszty komentarza wyzej ("0 trafien nie niesie tu informacji") — TEN
      // sygnal JEST znaczacy, bo pochodzi z prawdziwego podgladu tresci
      // (`#notesPreview`), nie z surowej liczby dopasowan wzorca.
      const looksTruncated = (this.#draft?.patterns ?? []).some(
        (e) => e.pattern.kind === 'proseBlock' && this.#draft!.notesPatterns.includes(e.id) && this.#noteLooksTruncated(e.pattern, this.#notesPreview.get(e.id)),
      );
      if (looksTruncated) return { kind: 'warning' };
      return { kind: 'count', n };
    }
    const patternId = this.#patternIdForTab(tab);
    const entry = this.#findPattern(patternId);
    if (!entry) return { kind: 'empty' };
    if (this.#tabHasWarning(tab, entry)) return { kind: 'warning' };
    if (entry.pattern.kind === 'labelledPairs') return entry.pattern.labels.length > 0 ? { kind: 'count', n: entry.pattern.labels.length } : { kind: 'empty' };
    return { kind: 'count', n: 1 };
  }

  /** Zero trafien wzorca na calej ksiazce ALBO zachodzenie odwolujace sie do regionu tego typu — WYLACZNIE gdy pelny przebieg juz istnieje (przed nim brak ostrzezen jest oczekiwany, nie "wszystko OK"). */
  #tabHasWarning(tab: Exclude<BuildTab, 'check'>, entry: PatternEntryDraft): boolean {
    // [ZGŁOSZENIE na żywo, powtórka bledu "do Name trafia Wiek:" na profilu
    // zbudowanym od zera na Forge] `#computeBuildGuidance` juz ostrzega o
    // brakujacym `requireFontKeys` tekstem — ale WYLACZNIE gdy autor akurat
    // stoi na zakladce Nazwa w tym konkretnym trybie (Name/Zawod). Kliknij
    // przyklad, przejdz dalej budowac Cechy/Ataki/Notatki, nigdy nie wroc na
    // Nazwe przed zapisem — nic nie ostrzega. Ten sam warunek trafia wiec
    // TEZ do odznaki zakladki (widocznej z KAZDEGO miejsca w Studiu),
    // niezaleznie od `#docAnalysis` (to fakt o WLASNEJ konfiguracji wzorca,
    // nie o wyniku skanu calej ksiazki — nie trzeba czekac na "Sprawdz").
    if (tab === 'name' && entry.pattern.kind === 'fontRoleCandidate' && entry.pattern.requireFontKeys.length === 0) return true;
    if (!this.#docAnalysis) return false;
    const zeroMatch = this.#docAnalysis.patternMatchTotals.some((p) => p.patternId === entry.id && p.matchCount === 0);
    if (zeroMatch) return true;
    const regionKind: StudioRegionKind | null =
      tab === 'grid'
        ? 'grid'
        : tab === 'derived'
          ? 'derived'
          : tab === 'attacks'
            ? 'attacks'
            : tab === 'skills'
              ? 'skills'
              : tab === 'name'
                ? this.#nameSubMode === 'typeLabel'
                  ? 'typeLabel'
                  : 'name'
                : null;
    if (!regionKind) return false;
    return this.#docAnalysis.pages.some((p) => p.overlaps.some((o) => o.regionKindA === regionKind || o.regionKindB === regionKind));
  }

  #patternIdForTab(tab: BuildTab): string | null {
    switch (tab) {
      case 'grid':
        return this.#activeGridPatternId;
      case 'derived':
        return this.#activeDerivedPatternId;
      case 'attacks':
        return this.#activeAttackPatternId;
      case 'skills':
        return this.#activeSkillsPatternId;
      // [KROK-34 Z2] Notatki maja WIELE wzorcow — nie ma jednego "aktywnego"
      // do zwrocenia, `#computeTabBadge` obsluguje ten przypadek OSOBNO,
      // wyzej, przed wywolaniem tej metody.
      case 'notes':
        return null;
      case 'name':
        // [ZGŁOSZENIE po kroku 30] Jedna zakladka, dwa sloty — plaszczyzna
        // (badge/ostrzezenie) pokazuje ten, ktory tryb jest aktualnie wybrany.
        return this.#nameSubMode === 'typeLabel' ? this.#activeTypeLabelPatternId : this.#activeNamePatternId;
      case 'check':
        return null;
    }
  }

  #findPattern(id: string | null): PatternEntryDraft | undefined {
    if (!id || !this.#draft) return undefined;
    return this.#draft.patterns.find((e) => e.id === id);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override async _onRender(context: any, options: any): Promise<void> {
    await super._onRender(context, options);

    const pdfInput = this.element.querySelector<HTMLInputElement>('input[type="file"][data-role="pdf"]');
    pdfInput?.addEventListener('change', () => {
      const file = pdfInput.files?.[0] ?? null;
      if (file) void this.#onPdfFileSelected(file);
    });

    const profileInput = this.element.querySelector<HTMLInputElement>('input[type="file"][data-role="profile"]');
    profileInput?.addEventListener('change', () => {
      const file = profileInput.files?.[0] ?? null;
      if (file) void this.#onProfileFileSelected(file);
    });

    if (this.#state.screen === 'metadata') {
      this.#mountMetadataScreen();
      return;
    }
    if (this.#state.screen !== 'build') return;

    this.#mountMetadataHeader();

    if (this.#state.rawJsonMode) {
      const textarea = this.element.querySelector<HTMLTextAreaElement>('textarea[data-raw-json]');
      if (textarea) {
        textarea.value = this.#rawJsonText;
        textarea.addEventListener('input', () => (this.#rawJsonText = textarea.value));
      }
      return;
    }

    // [zmierzony na zywo problem] Nawigacja WYLACZNIE przyciskami ◄/► byla
    // uciazliwa na wielostronicowej ksiazce — pole liczbowe pozwala wpisac
    // numer strony wprost.
    const pageNumberInput = this.element.querySelector<HTMLInputElement>('input[data-input="pageNumber"]');
    pageNumberInput?.addEventListener('change', () => {
      const parsed = Math.round(Number(pageNumberInput.value));
      const clamped = Math.min(Math.max(Number.isFinite(parsed) ? parsed : this.#state.currentPageNumber, 1), Math.max(this.#state.pageCount, 1));
      pageNumberInput.value = String(clamped);
      if (clamped !== this.#state.currentPageNumber) {
        this.#state.currentPageNumber = clamped;
        void this.render();
      }
    });
    pageNumberInput?.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') pageNumberInput.blur();
    });

    if (this.#state.buildTab === 'check') {
      this.#mountDocumentPanel(context._docAnalysis as DocumentAnalysis | null);
      return;
    }

    void this.#ensurePageImage(this.#state.currentPageNumber);
    this.#mountEntityPanel(context._pageAnalysis as PageAnalysis | null);
    this.#mountSelectionProposal();
    this.#mountBuildPanel();
    // Sekwencyjnie, NIE rownolegle — `#mountOverlay` czysci `svg.innerHTML`
    // przy KAZDYM (ponownym) rysowaniu; gdyby `#mountPickableTokens`/granica
    // sekcji dopisaly swoje elementy PRZED tym czyszczeniem, `#mountOverlay`
    // by je skasowal.
    void (async () => {
      await this.#mountOverlay(context._pageAnalysis as PageAnalysis | null);
      await this.#mountPickableTokens();
      await this.#mountSectionBoundaryOverlay();
    })();
    const svg = this.element.querySelector<SVGSVGElement>('[data-overlay]');
    if (svg) this.#wireAreaSelectDrag(svg);
    const img = this.element.querySelector<HTMLImageElement>('.bindery-page-image');
    if (img) this.#wireOverlayResize(img);
  }

  /** [Zmierzony na zywo blad, patrz komentarz przy `#overlayResizeObserver`] Przerysowuje nakladke SVG za kazdym razem, gdy renderowany rozmiar `<img>` faktycznie sie zmienia — WYLACZNIE nowy `img` (pelny render Handlebars zastepuje cale drzewo DOM starym elementem, wiec stary obserwator i tak przestalby cokolwiek widziec, ale jawne `disconnect()` unika trzymania odniesienia do odlaczonego elementu). */
  #wireOverlayResize(img: HTMLImageElement): void {
    this.#overlayResizeObserver?.disconnect();
    this.#overlayResizeObserver = new ResizeObserver(() => {
      void this.#mountOverlay(this.#docAnalysis?.pages[this.#state.currentPageNumber - 1] ?? null);
      void this.#mountPickableTokens();
      void this.#mountSectionBoundaryOverlay();
    });
    this.#overlayResizeObserver.observe(img);
  }

  override async close(options?: object): Promise<this> {
    this.#scanController?.abort();
    this.#overlayResizeObserver?.disconnect();
    for (const url of this.#pageImageCache.values()) URL.revokeObjectURL(url);
    await this.#previewDocument?.destroy();
    return super.close(options);
  }

  // ---- [KROK-28 korekta] Ekran wejsciowy ---------------------------------

  static #onChooseNewProfile(this: ProfileStudio): void {
    this.#state.entryMode = 'new';
    void this.render();
  }

  static #onChooseEditProfile(this: ProfileStudio): void {
    this.#state.entryMode = 'edit';
    void this.render();
  }

  /** [Korekta] Powrot z ekranu budowania do wejsciowego — resetuje WSZYSTKO (PDF, profil, szkic), zeby autor mogl zaczac od nowa z innym plikiem bez zamykania okna. Nie jest wprost wymagane przez brief, ale bez tego "zla decyzja na starcie" nie miala wyjscia poza zamknieciem calego okna. */
  static #onBackToEntry(this: ProfileStudio): void {
    for (const url of this.#pageImageCache.values()) URL.revokeObjectURL(url);
    this.#pageImageCache.clear();
    this.#pageImageOrder = [];
    this.#buildTokensCache.clear();
    void this.#previewDocument?.destroy();
    this.#previewDocument = null;
    this.#pdfBuffer = null;
    this.#profile = null;
    this.#draft = null;
    this.#docAnalysis = null;
    this.#resetBuildPointers();
    this.#state = {
      ...this.#state,
      screen: 'entry',
      entryMode: 'choose',
      pdfFileName: null,
      profileFileName: null,
      profileSummary: null,
      profileIssues: null,
      analyzeError: null,
      currentPageNumber: 1,
      pageCount: 0,
      buildTab: 'grid',
    };
    void this.render();
  }

  #resetBuildPointers(): void {
    this.#activeGridPatternId = null;
    this.#activeDerivedPatternId = null;
    this.#activeAttackPatternId = null;
    this.#activeSkillsPatternId = null;
    this.#activeNamePatternId = null;
    this.#activeTypeLabelPatternId = null;
    this.#resetEphemeralBuildState();
    this.#activeRoute = 'npc';
    this.#npcRouteSlice = null;
    this.#playerCharacterRouteSlice = null;
  }

  /**
   * [KROK-39 Z2, zgloszenie uzytkownika na zywo: "Name i zawód jest wspólny
   * dla NPC i Bohaterów... jak zaznaczę dla NPC to jest to widoczne w
   * Bohaterach"] `#switchRoute` (nizej) zamienia `#draft`'s POLA (patterns/
   * anchor/attach/...) na wycinek nowej trasy poprawnie (potwierdzone
   * bezposrednim testem izolowanym od Foundry — zero dzielenia referencji
   * miedzy `#npcRouteSlice`/`#playerCharacterRouteSlice`), ale WCZESNIEJSZA
   * wersja NIE czyscila kosmetycznych cache'y "ostatnie klikniecie" —
   * `#namePreviewText`/`#typeLabelPreviewText` (podglad w panelu "Wskazano
   * jako nazwę: ..."), `#buildPairPreviewValues` (podglad wartosci cech),
   * `#itemPatternExamples`/`#itemPatternShape` (rozpoznany ksztalt pozycji
   * Atakow/Umiejetnosci). Po przelaczeniu trasy te podglady dalej pokazywaly
   * WYNIK z POPRZEDNIEJ trasy (np. imie NPC-a w panelu Nazwy, mimo ze
   * WLASCIWY wzorzec `playerCharacter` byl juz — poprawnie — pusty) — z
   * perspektywy autora wygladalo to jak "to samo ustawienie" dzielone przez
   * obie trasy, mimo ze w SZKICU byly juz od poczatku rozdzielone. Wydzielone
   * tutaj, zeby TO SAMO czyszczenie dzialalo przy KAZDEJ zmianie kontekstu
   * (przelaczenie trasy PONIZEJ, powrot do ekranu wejsciowego wyzej), nie
   * tylko czesc z nich.
   */
  #resetEphemeralBuildState(): void {
    this.#nameSubMode = 'name';
    this.#pendingValueChoice = null;
    this.#sectionBoundaryFocus = null;
    this.#boundaryDrag = null;
    this.#buildPairPreviewValues.clear();
    this.#selectionProposal = null;
    this.#notesPickPatternId = null;
    this.#notesPreview.clear();
    this.#literalGenericityCache.clear();
    this.#namePreviewText = null;
    this.#typeLabelPreviewText = null;
    this.#itemPatternExamples.clear();
    this.#itemPatternShape.clear();
    this.#pickTarget = null;
    this.#state.isSelectAreaMode = false;
  }

  /**
   * [KROK-39 Z2] Rozdziela WLASNIE zwalidowany profil (`@bindery/core`
   * `ProfileV2`, ale przyjety jako `any` — TA SAMA konwencja co `profileToDraft`
   * samo, patrz jej komentarz) na `#draft` (metadane + wzorce trasy `npc`,
   * ZAWSZE na korzeniu profilu) i `#playerCharacterRouteSlice` (opcjonalna
   * druga sekcja, `null` gdy profil jej nie ma). Jedyne miejsce, ktore
   * powinno WCZYTYWAC profil do stanu edytora — trzy dawne wywolania
   * `profileToDraft` (wybor "Edycja profilu", udany "Zastosuj i sprawdz",
   * wyjscie z trybu surowego JSON) przechodza przez ta metode, zeby ZADNE z
   * nich nie zgubilo milczaco sekcji `playerCharacter` (A3).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #loadProfileIntoDraft(profile: any): void {
    this.#draft = profileToDraft(profile);
    this.#npcRouteSlice = extractRouteSlice(this.#draft);
    this.#playerCharacterRouteSlice = profile?.playerCharacter
      ? extractRouteSlice(profileToDraft({ ...profile, patterns: profile.playerCharacter.patterns, entityAssembly: profile.playerCharacter.entityAssembly }))
      : null;
    this.#activeRoute = 'npc';
  }

  /**
   * [KROK-39 Z2] Jak `#loadProfileIntoDraft`, ale BEZ resetowania
   * `#activeRoute` — do odswiezenia `#draft`/wycinkow OBU tras z kanonicznej,
   * znormalizowanej przez Zod postaci PO udanej walidacji (`#applyDraftAndScan`),
   * zeby zakladki-wzorce i zapisany .json byly spojne z tym, co faktycznie
   * napedza diagnostyke — bez przelaczania autora z powrotem na trase `npc`,
   * jesli akurat pracowal nad `playerCharacter`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #refreshDraftFromValidatedProfile(profile: any): void {
    this.#npcRouteSlice = extractRouteSlice(profileToDraft(profile));
    this.#playerCharacterRouteSlice = profile?.playerCharacter
      ? extractRouteSlice(profileToDraft({ ...profile, patterns: profile.playerCharacter.patterns, entityAssembly: profile.playerCharacter.entityAssembly }))
      : null;
    const fullDraft = profileToDraft(profile);
    const activeSlice = (this.#activeRoute === 'npc' ? this.#npcRouteSlice : this.#playerCharacterRouteSlice) ?? emptyRouteSlice();
    applyRouteSlice(fullDraft, activeSlice);
    this.#draft = fullDraft;
  }

  /**
   * [KROK-39 Z2] `#draft` niesie ZAWSZE metadane wspolne + wzorce
   * `#activeRoute` — ta metoda odklada biezacy wycinek, wczytuje docelowy
   * (albo pusty punkt startowy, gdy autor przelacza sie na trase, ktorej
   * jeszcze nie dotknal w tej sesji) i przebudowuje sloty zakladek
   * (`#deriveActivePatternSlotsFromDraft`) dla NOWEJ trasy — te same
   * zakladki (Cechy/Pochodne/Ataki/...), zbudowane teraz z innego zestawu
   * danych (brief: "Zakładki... te same, budowane osobno dla każdej trasy").
   */
  #switchRoute(route: PageRoute): void {
    if (!this.#draft || route === this.#activeRoute) return;
    const currentSlice = extractRouteSlice(this.#draft);
    if (this.#activeRoute === 'npc') this.#npcRouteSlice = currentSlice;
    else this.#playerCharacterRouteSlice = currentSlice;

    const targetSlice = (route === 'npc' ? this.#npcRouteSlice : this.#playerCharacterRouteSlice) ?? emptyRouteSlice();
    applyRouteSlice(this.#draft, targetSlice);
    this.#activeRoute = route;
    this.#deriveActivePatternSlotsFromDraft();
    this.#resetEphemeralBuildState();
    void this.render();
  }

  static #onSwitchRoute(this: ProfileStudio, _ev: Event, target: HTMLElement): void {
    const route = target.dataset['route'] as PageRoute | undefined;
    if (!route || !ROUTE_OPTIONS.includes(route)) return;
    this.#switchRoute(route);
  }

  #routeLabel(route: PageRoute): string {
    return game.i18n!.localize((route === 'npc' ? 'BINDERY.studio.routeNpc' : 'BINDERY.studio.routePlayerCharacter') as never);
  }

  /**
   * [KROK-39 Z2] Wejscie do `validateActorProfileFile`/zapisu — MERGE obu tras
   * w JEDEN obiekt profilu, dokladnie w ksztalcie `profileV2Schema`
   * (`schema.ts`): metadane + wzorce `npc` na korzeniu (`patterns`/
   * `entityAssembly`), wzorce `playerCharacter` (jesli skonfigurowane —
   * NIEPUSTA lista `patterns`) w opcjonalnym polu `playerCharacter`. W
   * odroznieniu od `draftToProfileInput(this.#draft)` uzywanego w
   * pojedynczych, WASKICH akcjach (klikniecie mierzace notatke, podglad
   * jednego wzorca — patrz `#refreshNotePreview`/`#onNoteTokenClick`, ktore
   * CELOWO dzialaja WYLACZNIE na aktywnej trasie), ta metoda jest jedynym
   * zrodlem prawdy dla PELNEGO przebiegu (`#applyDraftAndScan`) i zapisu do
   * pliku (`#onSaveProfileJson`) — obie MUSZA widziec OBIE trasy naraz, zeby
   * `classifyPageRoute` (`@bindery/core`) mogla poprawnie routowac KAZDA
   * strone dokumentu, nie tylko te akurat edytowana.
   */
  #buildMergedProfileInput(): unknown {
    if (!this.#draft) return null;
    const currentSlice = extractRouteSlice(this.#draft);
    const npcSlice = this.#activeRoute === 'npc' ? currentSlice : (this.#npcRouteSlice ?? emptyRouteSlice());
    const pcSlice = this.#activeRoute === 'playerCharacter' ? currentSlice : this.#playerCharacterRouteSlice;

    const npcDraft: ProfileDraft = { ...this.#draft, ...npcSlice };
    const base = draftToProfileInput(npcDraft) as Record<string, unknown>;
    if (pcSlice && pcSlice.patterns.length > 0) {
      const pcDraft: ProfileDraft = { ...this.#draft, ...pcSlice };
      const pcInput = draftToProfileInput(pcDraft) as { patterns: unknown; entityAssembly: unknown };
      base['playerCharacter'] = { patterns: pcInput.patterns, entityAssembly: pcInput.entityAssembly };
    }
    return base;
  }

  /** [Korekta] "Kazda zakladka-wzorzec ma jawny slot" — po wczytaniu/zbudowaniu szkicu, wywiedz KTORY istniejacy wzorzec nalezy do ktorego slotu, zeby zakladki od razu pokazaly poprawny stan (Edycja profilu) zamiast pustych. Wzorce spoza tych pieciu slotow (np. z recznie edytowanego surowego JSON-a) NIE gina — zostaja w `draft.patterns`, po prostu nie sa dostepne z zadnej zakladki-wzorca (nadal wyeksportowane poprawnie przy zapisie). */
  #deriveActivePatternSlotsFromDraft(): void {
    if (!this.#draft) {
      this.#resetBuildPointers();
      return;
    }
    const draft = this.#draft;
    this.#activeGridPatternId = draft.anchor || null;
    this.#activeSkillsPatternId = draft.skillsPattern || null;
    this.#activeTypeLabelPatternId = draft.typeLabelPattern || null;
    this.#activeNamePatternId = draft.patterns.find((e) => e.pattern.kind === 'fontRoleCandidate' && e.id !== draft.typeLabelPattern)?.id ?? null;
    this.#activeDerivedPatternId = draft.patterns.find((e) => e.pattern.kind === 'labelledPairs' && e.id !== draft.anchor)?.id ?? null;
    this.#activeAttackPatternId = draft.patterns.find((e) => e.pattern.kind === 'sectionList' && e.id !== draft.skillsPattern)?.id ?? null;
  }

  async #onPdfFileSelected(file: File): Promise<void> {
    this.#state.pdfFileName = file.name;
    this.#state.analyzeError = null;
    this.#docAnalysis = null;
    for (const url of this.#pageImageCache.values()) URL.revokeObjectURL(url);
    this.#pageImageCache.clear();
    this.#pageImageOrder = [];
    this.#buildTokensCache.clear();
    await this.#previewDocument?.destroy();
    this.#previewDocument = null;
    this.#pdfBuffer = await file.arrayBuffer();
    await this.render();

    try {
      const { openPreviewDocument } = await import('@bindery/core');
      this.#previewDocument = await openPreviewDocument(this.#pdfBuffer, { assetBaseUrl: ASSET_BASE_URL });
      this.#state.pageCount = this.#previewDocument.pageCount;
      this.#state.currentPageNumber = 1;
    } catch (err) {
      console.warn('Bindery | Profile Studio: nie udalo sie otworzyc PDF-a:', err);
      this.#state.analyzeError = game.i18n!.localize('BINDERY.studio.errorOpenPdf' as never);
      await this.render();
      return;
    }
    await this.#maybeEnterBuildScreen();
  }

  async #onProfileFileSelected(file: File): Promise<void> {
    this.#state.profileFileName = file.name;
    this.#state.profileSummary = null;
    this.#state.profileIssues = null;
    this.#profile = null;
    await this.render();

    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      this.#state.profileIssues = [game.i18n!.localize('BINDERY.studio.profileErrorNotJson' as never)];
      await this.render();
      return;
    }

    const result = await validateActorProfileFile(parsed);
    if (!result.ok) {
      this.#state.profileIssues = result.issues;
      await this.render();
      return;
    }

    this.#profile = result.profile;
    this.#state.profileSummary = {
      title: result.profile.title,
      publication: result.profile.publication,
      gameLine: result.profile.gameLine,
      language: result.profile.language,
      patternCount: Object.keys(result.profile.patterns).length + Object.keys(result.profile.playerCharacter?.patterns ?? {}).length,
    };
    await this.#maybeEnterBuildScreen();
  }

  /**
   * [Korekta] "Nowy profil" -> wybor PDF-a -> ekran budowania. "Edycja profilu" -> wybor PDF-a I PLIKU PROFILU -> ten sam ekran, wypelniony. Przejscie nastepuje automatycznie, gdy wszystkie wymagane pliki dla wybranej sciezki sa juz zaladowane — autor nie klika osobnego "Dalej".
   * [zgloszenie uzytkownika] "Ten sam ekran" TERAZ oznacza ekran metadanych
   * (`'metadata'`) — nie od razu budowanie. Dla Edycji profilu pola sa juz
   * wypelnione (wczytany plik przeszedl `validateActorProfileFile`, ktora
   * wymusza dokladnie te same 5 pol), wiec krok jest tu WYLACZNIE do
   * przegladu/poprawki przed wejsciem w budowanie -- "Dalej" przechodzi
   * natychmiast, jesli autor niczego nie zmienil.
   */
  async #maybeEnterBuildScreen(): Promise<void> {
    if (!this.#pdfBuffer) {
      await this.render();
      return;
    }
    if (this.#state.entryMode === 'edit' && !this.#profile) {
      await this.render();
      return;
    }
    if (this.#state.entryMode === 'edit' && this.#profile) {
      this.#loadProfileIntoDraft(this.#profile);
    } else {
      this.#draft = createEmptyProfileDraft();
      this.#npcRouteSlice = null;
      this.#playerCharacterRouteSlice = null;
      this.#activeRoute = 'npc';
    }
    this.#deriveActivePatternSlotsFromDraft();
    this.#state.screen = 'metadata';
    this.#state.buildTab = 'grid';
    await this.render();
  }

  /**
   * [zgloszenie uzytkownika] Piec pol wymaganych przez `profileV2Schema`
   * (`id`/`gameLine`/`language`/`title`/`publication`, patrz `schema.ts` —
   * TA SAMA piatka co `#friendlyMetadataValidationMessage` wyzej) — bez
   * znaczenia dla dopasowania, ale bez nich zapis/pelna walidacja i tak
   * odrzuci caly plik. Zwraca ETYKIETY widoczne w formularzu (nie surowe
   * klucze) do czytelnego komunikatu "uzupelnij: ...".
   */
  #missingMetadataFieldLabels(): string[] {
    const draft = this.#draft;
    if (!draft) return [];
    const missing: string[] = [];
    if (draft.id.trim().length < 1) missing.push('id');
    if (draft.title.trim().length < 1) missing.push(game.i18n!.localize('BINDERY.studio.fieldTitle' as never));
    if (draft.gameLine.trim().length < 1) missing.push('gameLine');
    if (draft.language.trim().length < 2) missing.push('language');
    if (draft.publication.trim().length < 1) missing.push('publication');
    return missing;
  }

  /** [zgloszenie uzytkownika] "Dalej" na ekranie metadanych — przepuszcza do budowania WYLACZNIE gdy wszystkie 5 pol jest wypelnionych; inaczej pokazuje, ktorych brakuje, zamiast cichego "nic sie nie dzieje". */
  static #onContinueFromMetadataStep(this: ProfileStudio): void {
    if (!this.#draft) return;
    const missing = this.#missingMetadataFieldLabels();
    if (missing.length > 0) {
      ui.notifications?.warn(`${game.i18n!.localize('BINDERY.studio.metadataStepMissingFields' as never)} ${missing.join(', ')}`);
      return;
    }
    this.#state.screen = 'build';
    void this.render();
  }

  static #onSwitchBuildTab(this: ProfileStudio, _ev: Event, target: HTMLElement): void {
    const tab = target.dataset['tab'] as BuildTab | undefined;
    if (!tab || !BUILD_TABS.includes(tab)) return;
    this.#state.buildTab = tab;
    // Opuszczenie zakladki przerywa oba tryby wskazywania (S4-podobnie: nigdy niejawny stan w tle).
    this.#pickTarget = null;
    this.#state.isSelectAreaMode = false;
    this.#selectionProposal = null;
    this.#pendingValueChoice = null;
    void this.render();
  }

  /** [KROK-24 Z1] Przelacza tryb "obrysuj obszar myszą". */
  static #onToggleSelectArea(this: ProfileStudio): void {
    this.#state.isSelectAreaMode = !this.#state.isSelectAreaMode;
    this.#selectionProposal = null;
    this.#pickTarget = null;
    void this.render();
  }

  // ---- [KROK-28 korekta] Pasek trwaly ekranu budowania -------------------

  static async #onRunFullScan(this: ProfileStudio): Promise<void> {
    await this.#applyDraftAndScan();
  }

  /**
   * [Korekta] Zakladka "Sprawdz" ma JEDEN przycisk — zamiast dawnego
   * dwuetapowego "Zastosuj i sprawdz" (Edytor) + "Sprawdz wszystkie strony"
   * (osobna zakladka). Waliduje BIEZACY szkic (Zod, nigdy zaufanie bez
   * sprawdzenia — ten sam wymog co przy wczytaniu pliku), i przy sukcesie od
   * razu uruchamia pelny przebieg z NOWO zwalidowanym profilem.
   */
  async #applyDraftAndScan(): Promise<void> {
    if (!this.#draft || !this.#pdfBuffer) return;

    let input: unknown;
    if (this.#state.rawJsonMode) {
      try {
        input = JSON.parse(this.#rawJsonText);
      } catch {
        this.#state.rawJsonError = game.i18n!.localize('BINDERY.studio.editorRawJsonInvalid' as never);
        await this.render();
        return;
      }
      this.#state.rawJsonError = null;
    } else {
      // [KROK-39 Z2] MERGE obu tras (nie tylko `#draft`, aktywnej) — "Sprawdz"
      // musi routowac KAZDA strone dokumentu, wiec profil wejsciowy musi
      // niesc OBIE sekcje wzorcow naraz, patrz `#buildMergedProfileInput`.
      input = this.#buildMergedProfileInput();
    }

    const result = await validateActorProfileFile(input);
    if (!result.ok) {
      this.#state.editorIssues = result.issues;
      await this.render();
      return;
    }

    this.#profile = result.profile;
    // Odswiez szkic z KANONICZNEJ, znormalizowanej przez Zod postaci — zeby
    // zakladki-wzorce i zapisany .json byly SPOJNE z tym, co faktycznie
    // napedza diagnostyke. Identyfikatory wzorcow sa zachowywane przez
    // `profileToDraft`/`draftToProfileInput`, wiec sloty NIE gubia sie.
    // [KROK-39 Z2] `#refreshDraftFromValidatedProfile`, NIE `#loadProfileIntoDraft`
    // — ta ostatnia resetuje `#activeRoute` na `'npc'`, co przelaczaloby autora
    // z powrotem na zakladki NPC przy KAZDYM "Sprawdz" wykonanym z aktywna
    // trasa Postaci graczy (mierzone jako oczywisty regres UX przy przegladzie).
    this.#refreshDraftFromValidatedProfile(result.profile);
    this.#deriveActivePatternSlotsFromDraft();
    this.#state.editorIssues = null;
    this.#state.rawJsonMode = false;
    this.#state.profileFileName = this.#state.profileFileName ?? `${result.profile.id || 'profil'}.json`;
    this.#state.profileSummary = {
      title: result.profile.title,
      publication: result.profile.publication,
      gameLine: result.profile.gameLine,
      language: result.profile.language,
      patternCount: Object.keys(result.profile.patterns).length + Object.keys(result.profile.playerCharacter?.patterns ?? {}).length,
    };

    await this.#runFullScan();
  }

  async #runFullScan(): Promise<void> {
    if (!this.#pdfBuffer || !this.#profile) return;
    this.#state.isAnalyzing = true;
    this.#state.analyzeError = null;
    this.#state.analyzeProgress = null;
    await this.render();

    this.#scanController = new AbortController();
    try {
      const { analyzeProfileDocument } = await import('@bindery/core');
      this.#docAnalysis = await analyzeProfileDocument(this.#pdfBuffer, this.#profile, {
        assetBaseUrl: ASSET_BASE_URL,
        signal: this.#scanController.signal,
        onProgress: (done, total) => {
          this.#state.analyzeProgress = { done, total };
          void this.render();
        },
      });
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        console.warn('Bindery | Profile Studio: analiza nieudana:', err);
        this.#state.analyzeError = game.i18n!.localize('BINDERY.studio.errorAnalyze' as never);
      }
    } finally {
      this.#state.isAnalyzing = false;
      this.#scanController = null;
      await this.render();
    }
  }

  static #onExportDiagnostics(this: ProfileStudio): void {
    if (!this.#docAnalysis) return;
    void (async () => {
      const { buildDiagnosticsExport } = await import('@bindery/core');
      const report = buildDiagnosticsExport(this.#docAnalysis!);
      const withMeta = { wygenerowano: new Date().toISOString(), plikProfilu: this.#state.profileFileName, plikPdf: this.#state.pdfFileName, ...report };
      const blob = new Blob([JSON.stringify(withMeta, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bindery-profile-studio-${(this.#state.profileFileName ?? 'diagnostyka').replace(/\.json$/i, '')}.json`;
      a.click();
      URL.revokeObjectURL(url);
    })();
  }

  static #onSaveProfileJson(this: ProfileStudio): void {
    if (!this.#draft) return;
    let input: unknown;
    if (this.#state.rawJsonMode) {
      try {
        input = JSON.parse(this.#rawJsonText);
      } catch {
        this.#state.rawJsonError = game.i18n!.localize('BINDERY.studio.editorRawJsonInvalid' as never);
        void this.render();
        return;
      }
    } else {
      // [KROK-39 Z2] MERGE obu tras — zapis do pliku musi niesc CALY profil,
      // nie tylko trase akurat otwarta na ekranie, patrz `#buildMergedProfileInput`.
      input = this.#buildMergedProfileInput();
    }
    const idPart = (this.#draft.id || 'profil').trim().replace(/[^a-zA-Z0-9_-]+/g, '-') || 'profil';
    const blob = new Blob([JSON.stringify(input, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${idPart}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  static #onToggleRawJsonMode(this: ProfileStudio): void {
    if (!this.#draft) return;
    if (!this.#state.rawJsonMode) {
      // [KROK-39 Z2] MERGE obu tras — tryb surowego JSON pokazuje/edytuje CALY
      // profil naraz (obie sekcje wzorcow), nie tylko trase akurat otwarta.
      this.#rawJsonText = JSON.stringify(this.#buildMergedProfileInput(), null, 2);
      this.#state.rawJsonMode = true;
      this.#state.rawJsonError = null;
      void this.render();
      return;
    }
    try {
      const parsed = JSON.parse(this.#rawJsonText);
      // [KROK-39 Z2] `#loadProfileIntoDraft`, nie goly `profileToDraft` —
      // surowy JSON mogl zmienic OBIE sekcje wzorcow (albo dodac/usunac
      // `playerCharacter` w calosci), wiec oba wycinki tras musza zostac
      // ponownie rozdzielone, nie tylko `#draft` samo. Resetuje `#activeRoute`
      // na `'npc'` — po wyjsciu z surowego JSON-a nie ma juz wiarygodnego
      // sygnalu, ktora trasa byla "aktywna" w dowolnie zmienionym tekscie.
      this.#loadProfileIntoDraft(parsed);
      this.#deriveActivePatternSlotsFromDraft();
      this.#state.rawJsonMode = false;
      this.#state.rawJsonError = null;
    } catch {
      this.#state.rawJsonError = game.i18n!.localize('BINDERY.studio.editorRawJsonInvalid' as never);
    }
    void this.render();
  }

  static async #onPrevPage(this: ProfileStudio): Promise<void> {
    if (this.#state.currentPageNumber > 1) {
      this.#state.currentPageNumber -= 1;
      await this.render();
    }
  }

  static async #onNextPage(this: ProfileStudio): Promise<void> {
    if (this.#state.currentPageNumber < this.#state.pageCount) {
      this.#state.currentPageNumber += 1;
      await this.render();
    }
  }

  async #ensurePageImage(pageNumber: number): Promise<void> {
    if (!this.#previewDocument || this.#pageImageCache.has(pageNumber)) return;
    const token = ++this.#pageRenderToken;
    try {
      const encoded = await this.#previewDocument.renderPage(pageNumber, { targetLongEdgePx: 1400, format: 'webp' });
      if (token !== this.#pageRenderToken) return;
      const url = URL.createObjectURL(new Blob([new Uint8Array(encoded.bytes)], { type: 'image/webp' }));
      this.#pageImageCache.set(pageNumber, url);
      this.#pageImageOrder.push(pageNumber);
      while (this.#pageImageOrder.length > ProfileStudio.#PAGE_CACHE_SIZE) {
        const evict = this.#pageImageOrder.shift()!;
        const evictUrl = this.#pageImageCache.get(evict);
        if (evictUrl) URL.revokeObjectURL(evictUrl);
        this.#pageImageCache.delete(evict);
      }
      if (this.#state.screen === 'build' && this.#state.buildTab !== 'check') await this.render();
    } catch (err) {
      console.warn('Bindery | Profile Studio: renderPage nieudany:', err);
    }
  }

  // ---- Panel strony (nakladka regionow, encje, zachodzenia) --------------

  static readonly #REGION_LABEL_KEYS: Readonly<Record<StudioRegionKind, string>> = {
    grid: 'BINDERY.studio.regionGrid',
    derived: 'BINDERY.studio.regionDerived',
    attacks: 'BINDERY.studio.regionAttacks',
    skills: 'BINDERY.studio.regionSkills',
    name: 'BINDERY.studio.regionName',
    typeLabel: 'BINDERY.studio.regionTypeLabel',
    notes: 'BINDERY.studio.regionNotes',
  };

  static #regionLabel(kind: StudioRegionKind): string {
    return game.i18n!.localize(ProfileStudio.#REGION_LABEL_KEYS[kind] as never);
  }

  /** [zgloszenie uzytkownika, "warning 'id: String must ...'"] Pola profilu-jako-pliku, ktore nie wplywaja na samo dopasowanie, tylko na tozsamosc profilu (patrz `.min(...)` w `profileV2Schema`, `schema.ts`) — wypelniane w zwijanym naglowku "Metadane i zakres stron". */
  static readonly #METADATA_ISSUE_FIELDS: ReadonlySet<string> = new Set(['id', 'gameLine', 'language', 'title', 'publication']);

  /**
   * [zgloszenie uzytkownika, "dostaje warningi 'id: String must contain at
   * least 1 character(s)'"] `result.issues` to stringi w formacie
   * `"<sciezka>: <komunikat Zod>"` (patrz `schema.ts`, `parseProfileV2`) —
   * gdy KAZDY biezacy blad dotyczy jednego z pieciu pol metadanych pliku
   * (bez znaczenia dla dopasowania notatki/kotwicy), autor NIE POTRZEBUJE
   * widziec surowej skladni Zod — potrzebuje wiedziec, gdzie klikonac. Gdy
   * choc jeden blad dotyczy czegos innego (np. faktycznie zepsuty wzorzec),
   * zwraca `null` — wywolujacy wraca do surowego pierwszego bledu, zeby NIE
   * ukryc prawdziwej przyczyny za myląco uspokajajacym komunikatem o metadanych.
   */
  static #friendlyMetadataValidationMessage(issues: readonly string[]): string | null {
    if (issues.length === 0) return null;
    const allMetadata = issues.every((issue) => ProfileStudio.#METADATA_ISSUE_FIELDS.has(issue.split(':')[0]?.trim() ?? ''));
    if (!allMetadata) return null;
    return game.i18n!.localize('BINDERY.studio.notesPickFailedMissingMetadata' as never);
  }

  /** Prosty test przeciecia dwoch prostokatow PDF — WYLACZNIE do ostrzezenia o zachodzeniu W TRAKCIE przeciagania granicy sekcji; nie eksportowane z `@bindery/core` (geometria UI, nie silnik dopasowan). */
  static #rectsOverlap(a: Rect, b: Rect): boolean {
    return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
  }

  /**
   * [KROK-29 Z5] Odwraca `escapeSectionBoundaryLiteral` (`^Jørgen$` ->
   * `Jørgen`) do wyswietlenia PRAWDZIWEGO tekstu granicy i do sprawdzenia,
   * czy to caly token, a nie pojedynczy znak. Usuwa TEZ opcjonalny koncowy
   * dwukropek (`:?$`, dopisany przez `escapeSectionBoundaryLiteral` — patrz
   * jej komentarz) PRZED proba usuniecia zwyklego `$`, zeby wyswietlony tekst
   * nie pokazywal surowej skladni regexu ("Umiejętności:?" zamiast "Umiejętności").
   */
  static #unescapeBoundaryText(pattern: string): string {
    return pattern
      .replace(/^\^/, '')
      .replace(/:\?\$$/, '')
      .replace(/\$$/, '')
      .replace(/\\([.*+?^${}()|[\]\\])/g, '$1');
  }

  #mountEntityPanel(analysis: PageAnalysis | null): void {
    const container = this.element.querySelector<HTMLElement>('[data-list="studio-page"]');
    if (!container) return;
    container.innerHTML = '';

    if (!this.#docAnalysis) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = game.i18n!.localize('BINDERY.studio.noAnalysisYet' as never);
      container.appendChild(p);
      return;
    }
    if (!analysis) return;

    // [KROK-39 Z2] Panel strony jest zakotwiczony w AKTYWNEJ trasie (autor
    // buduje/kalibruje WLASNIE ja) — ale `analysis` pochodzi z ostatniego
    // pelnego przebiegu (`#docAnalysis`), ktory routuje KAZDA strone
    // AUTOMATYCZNIE (`classifyPageRoute`, `@bindery/core`). Gdy te dwie trasy
    // sie roznia, pokazanie wynikow z `analysis.route` (INNEJ trasy niz ta,
    // ktora autor akurat edytuje) wygladaloby jak dzialajace dopasowanie tej,
    // ktora edytuje — dokladnie ostrzezenie z briefu Kroku 39 Z2 ("autor
    // kalibrujący postacie graczy nie może zobaczyć wyników dla NPC-ów i
    // uznać, że coś działa"). Jawny komunikat zamiast cichego, mylącego pokazu.
    if (analysis.route !== this.#activeRoute) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = game.i18n!.format('BINDERY.studio.routeMismatch' as never, { pageRoute: this.#routeLabel(analysis.route), activeRoute: this.#routeLabel(this.#activeRoute) });
      container.appendChild(p);
      return;
    }

    if (!analysis.routeSupported) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = game.i18n!.localize('BINDERY.studio.routeUnsupported' as never);
      container.appendChild(p);
      return;
    }

    if (analysis.entities.length === 0) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = game.i18n!.localize('BINDERY.studio.noEntitiesOnPage' as never);
      container.appendChild(p);
    }

    for (const entity of analysis.entities) container.appendChild(this.#buildEntityRow(entity));
    for (const overlap of analysis.overlaps) container.appendChild(this.#buildOverlapRow(overlap));
  }

  /**
   * [KROK-29, zmierzony na zywo blad] `outOfRange` MA DWA rozne powody
   * (patrz `OutOfRangeCandidate` w `entityAssembly.ts`): kandydat faktycznie
   * dalej niz limit (`'tooFar'`, komunikat "dystans > limit" ma tu sens), ALBO
   * kandydat byl w zasiegu, tylko przejety przez inna kotwice (`'claimedByOther'`)
   * — dla TEGO przypadku "87pt > 400pt" jest nonsensowne (87 < 400), wiec
   * dostaje WLASNY, uczciwy komunikat zamiast tej samej formuly arytmetycznej.
   */
  #buildAttachStatus<TMatch>(label: string, result: { match: TMatch | null; outOfRange: { distance: number; maxDistancePt: number; reason: 'tooFar' | 'claimedByOther' } | null }): HTMLElement {
    const row = document.createElement('div');
    row.className = 'bindery-studio-attach-status';
    const labelSpan = document.createElement('span');
    labelSpan.className = 'bindery-studio-attach-label';
    labelSpan.textContent = label;
    row.appendChild(labelSpan);
    const valueSpan = document.createElement('span');
    if (result.match) {
      valueSpan.className = 'bindery-studio-attach-ok';
      valueSpan.textContent = '✔';
    } else if (result.outOfRange?.reason === 'tooFar') {
      valueSpan.className = 'bindery-studio-attach-outofrange';
      valueSpan.textContent = `⚠ ${Math.round(result.outOfRange.distance)}pt > ${result.outOfRange.maxDistancePt}pt`;
    } else if (result.outOfRange) {
      valueSpan.className = 'bindery-studio-attach-outofrange';
      valueSpan.textContent = `⚠ ${Math.round(result.outOfRange.distance)}pt — ${game.i18n!.localize('BINDERY.studio.attachClaimedByOther' as never)}`;
    } else {
      valueSpan.className = 'bindery-studio-attach-missing';
      valueSpan.textContent = '—';
    }
    row.appendChild(valueSpan);
    return row;
  }

  #buildEntityRow(entity: EntityAnalysis): HTMLElement {
    const row = document.createElement('div');
    row.className = 'bindery-review-row bindery-studio-entity-row';

    const line1 = document.createElement('div');
    line1.className = 'bindery-studio-entity-line1';
    const nameSpan = document.createElement('span');
    nameSpan.className = entity.name.kind === 'confident' ? 'bindery-studio-name-confident' : 'bindery-studio-name-placeholder';
    nameSpan.textContent = entity.name.kind === 'confident' ? entity.name.text : entity.name.placeholder;
    line1.appendChild(nameSpan);
    row.appendChild(line1);

    if (entity.name.kind === 'placeholder' && entity.name.candidates.length > 0) {
      const cand = document.createElement('p');
      cand.className = 'hint bindery-studio-candidates';
      cand.textContent = `${game.i18n!.localize('BINDERY.studio.nameCandidatesLabel' as never)}: ${entity.name.candidates.join(' | ')}`;
      row.appendChild(cand);
    }

    row.appendChild(this.#buildAttachStatus(ProfileStudio.#regionLabel('derived'), entity.derived));
    row.appendChild(this.#buildAttachStatus(ProfileStudio.#regionLabel('attacks'), entity.attacks));
    row.appendChild(this.#buildAttachStatus(ProfileStudio.#regionLabel('skills'), entity.skills));

    row.addEventListener('click', () => {
      this.#highlighted = { entityOrdinal: entity.ordinal, kind: 'grid' };
      void this.#mountOverlay(this.#docAnalysis?.pages[this.#state.currentPageNumber - 1] ?? null);
    });

    return row;
  }

  #buildOverlapRow(overlap: OverlapWarning): HTMLElement {
    const row = document.createElement('div');
    row.className = 'bindery-diagnostic-row bindery-diagnostic-error bindery-studio-overlap-row';
    row.textContent = `${game.i18n!.localize('BINDERY.studio.overlapLabel' as never)}: #${overlap.entityOrdinalA + 1} (${ProfileStudio.#regionLabel(overlap.regionKindA)}) × #${overlap.entityOrdinalB + 1} (${ProfileStudio.#regionLabel(overlap.regionKindB)})`;
    row.addEventListener('click', () => {
      this.#highlighted = { entityOrdinal: overlap.entityOrdinalA, kind: overlap.regionKindA };
      void this.#mountOverlay(this.#docAnalysis?.pages[this.#state.currentPageNumber - 1] ?? null);
    });
    return row;
  }

  async #mountOverlay(analysis: PageAnalysis | null): Promise<void> {
    const svg = this.element.querySelector<SVGSVGElement>('[data-overlay]');
    const img = this.element.querySelector<HTMLImageElement>('.bindery-page-image');
    if (!svg || !img || !this.#previewDocument || !analysis) {
      if (svg) svg.innerHTML = '';
      return;
    }

    const { pdfRectToScreen } = await import('@bindery/core');
    const box = await this.#previewDocument.getPageBox(this.#state.currentPageNumber);
    const draw = () => {
      const width = img.naturalWidth || img.clientWidth;
      const height = img.naturalHeight || img.clientHeight;
      if (!width || !height) return;
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.style.width = `${img.clientWidth}px`;
      svg.style.height = `${img.clientHeight}px`;
      svg.innerHTML = '';

      for (const entity of analysis.entities) {
        for (const region of entity.regions) {
          const screen = pdfRectToScreen(region.bbox, { pageBox: box.box, imageWidthPx: width, imageHeightPx: height, rotation: box.rotation as never });
          const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          rect.setAttribute('x', String(screen.minX));
          rect.setAttribute('y', String(screen.minY));
          rect.setAttribute('width', String(Math.max(0, screen.maxX - screen.minX)));
          rect.setAttribute('height', String(Math.max(0, screen.maxY - screen.minY)));
          const classes = [`bindery-studio-region`, `bindery-studio-region-${region.kind}`];
          if (this.#highlighted && this.#highlighted.entityOrdinal === entity.ordinal) classes.push('bindery-studio-region-highlighted');
          rect.setAttribute('class', classes.join(' '));
          svg.appendChild(rect);
        }
      }
      for (const overlap of analysis.overlaps) {
        const screen = pdfRectToScreen(overlap.intersection, { pageBox: box.box, imageWidthPx: width, imageHeightPx: height, rotation: box.rotation as never });
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', String(screen.minX));
        rect.setAttribute('y', String(screen.minY));
        rect.setAttribute('width', String(Math.max(0, screen.maxX - screen.minX)));
        rect.setAttribute('height', String(Math.max(0, screen.maxY - screen.minY)));
        rect.setAttribute('class', 'bindery-studio-overlap');
        svg.appendChild(rect);
      }
    };
    if (img.complete) draw();
    else img.addEventListener('load', draw, { once: true });
  }

  // ---- [KROK-28, korekta] Panel budowania profilu wskazywaniem -----------

  /**
   * [Zmierzony na zywo blad, str. 23 "Zew Cthulhu 7ed. Wrak.pdf"] pdf.js
   * czasem rozbija JEDNO drukowane slowo na kilka `TextItem` w miejscu zmiany
   * fontu/kodowania glifu (typowo znak diakrytyczny: "Jørgen" -> "J"+"ørgen"
   * jako DWA stykajace sie tokeny) — bez `mergeTouchingTokens` klikniecie w
   * to, co wizualnie jest jednym slowem, moglo dac tylko jego fragment
   * ("J"), a ten fragment jako `terminateSectionBefore`/etykieta/naglowek
   * dopasowywal sie PRZYPADKOWO gdziekolwiek indziej w ksiazce. Scalanie
   * dzieje sie TUTAJ, RAZ, na pelnej liscie tokenow strony — kazdy
   * konsument (klikniecie etykiety/naglowka/granicy, tryb 📍) dostaje juz
   * scalone, "cale slowo" tokeny za darmo.
   */
  async #getBuildTokens(pageNumber: number): Promise<IndexedSelectionToken[]> {
    const cached = this.#buildTokensCache.get(pageNumber);
    if (cached) return cached;
    if (!this.#pdfBuffer) return [];
    const { getPageTextTokens, mergeTouchingTokens, splitMergedLabelValueTokens, stripStrayLeadingColonTokens } = await import('@bindery/core');
    const raw = await getPageTextTokens(this.#pdfBuffer, pageNumber, { assetBaseUrl: ASSET_BASE_URL });
    const merged = mergeTouchingTokens(raw);
    // [KROK-42/43] Ta sama naprawa co produkcyjne `tokenizePage.ts` — niektore
    // PDF-y skladaja etykiete siatki cech i jej wartosc w JEDEN token pdf.js
    // ("S 40"), a inne zostawiaja dwukropek na POCZATKU wartosci zamiast na
    // koncu etykiety (": Brak.") — patrz komentarze przy
    // `splitMergedLabelValueTokens`/`stripStrayLeadingColonTokens`.
    const split = splitMergedLabelValueTokens(stripStrayLeadingColonTokens(merged));
    const indexed: IndexedSelectionToken[] = split.map((t, i) => ({ ...t, tokenIndex: i }));
    this.#buildTokensCache.set(pageNumber, indexed);
    return indexed;
  }

  /** [U3] "Interfejs nie tłumaczy niczego" — jedna linia mówiąca dokładnie, co zrobić DALEJ, per aktywna zakladka-wzorzec. */
  #computeBuildGuidance(): string {
    const loc = (key: string) => game.i18n!.localize(`BINDERY.studio.${key}` as never);
    if (!this.#draft) return loc('guidanceNoDraft');
    if (this.#pendingValueChoice) return loc('guidanceAmbiguousValue');
    if (this.#boundaryDrag) return loc('guidanceDraggingBoundary');

    switch (this.#state.buildTab) {
      case 'grid': {
        const n = this.#labelCount(this.#activeGridPatternId);
        return n === 0 ? loc('guidanceGridEmpty') : loc('guidanceHasRows');
      }
      case 'derived': {
        const n = this.#labelCount(this.#activeDerivedPatternId);
        return n === 0 ? loc('guidanceDerivedEmpty') : loc('guidanceHasRows');
      }
      case 'attacks':
        return this.#sectionGuidance(this.#activeAttackPatternId, 'guidanceAttacksEmpty');
      case 'skills':
        return this.#sectionGuidance(this.#activeSkillsPatternId, 'guidanceSkillsEmpty');
      case 'notes':
        if (this.#notesPickPatternId) return loc('guidanceNotesPicking');
        return (this.#draft?.notesPatterns.length ?? 0) === 0 ? loc('guidanceNotesEmpty') : loc('guidanceNotesHasBlocks');
      case 'name': {
        const currentId = this.#nameSubMode === 'typeLabel' ? this.#activeTypeLabelPatternId : this.#activeNamePatternId;
        const entry = this.#findPattern(currentId);
        // [ZGŁOSZENIE na żywo po Kroku 39, "nadal do name trafia Wiek:"] Ten sam
        // blad co "Zawód: -> Zawód:" (draft-12 bez requireFontKeys przegrywa z
        // bliższą etykietą, patrz spike/bohaterowie/15-repro-wrak-name.ts),
        // ALE tym razem NIE naprawiony punktowo na pliku profilu — bo takie
        // punktowe naprawy nie przetrwaja kolejnego zapisu z samego Studio
        // (dokladnie zarzut autora: "jak zmiane zrobiles tylko w pliku, to
        // jak stworze nowy [profil], problem sie powtorzy"). Zamiast tego:
        // ostrzezenie strukturalne, WIDOCZNE OD RAZU po otwarciu zakladki
        // (nie dopiero po "Sprawdz"/imporcie), dla KAZDEGO profilu, ktory ma
        // wzorzec Nazwy/Zawodu bez zadnego wymaganego kroju — bo sama rola
        // fontu ma "fatalna precyzje" (patrz komentarz #onNameCandidateClick).
        if (entry?.pattern.kind === 'fontRoleCandidate' && entry.pattern.requireFontKeys.length === 0) {
          return loc(this.#nameSubMode === 'typeLabel' ? 'guidanceTypeLabelNoFontKey' : 'guidanceNameNoFontKey');
        }
        return loc(this.#nameSubMode === 'typeLabel' ? 'guidanceTypeLabel' : 'guidanceName');
      }
      case 'check':
        return loc('guidanceComplete');
    }
  }

  #labelCount(patternId: string | null): number {
    const entry = this.#findPattern(patternId);
    return entry?.pattern.kind === 'labelledPairs' ? entry.pattern.labels.length : 0;
  }

  #sectionGuidance(patternId: string | null, emptyKey: string): string {
    const loc = (key: string) => game.i18n!.localize(`BINDERY.studio.${key}` as never);
    const entry = this.#findPattern(patternId);
    if (!entry || entry.pattern.kind !== 'sectionList') return loc(emptyKey);
    if (!entry.pattern.terminateSectionBefore) return loc('guidanceSectionPicked');
    // [KROK-29 Z1] Trzecia faza — granica juz ustawiona, ale autor nie
    // kliknal jeszcze zadnej przykladowej pozycji (`itemPattern` nadal puste).
    if (!entry.pattern.itemPattern) return loc('guidanceItemPatternExamples');
    return loc('guidanceComplete');
  }

  /**
   * Dopasowanie nazwy klikniętej etykiety do słownika kluczy kanonicznych
   * (`CANONICAL_STATS`) — WYŁĄCZNIE podpowiedź, jedno kliknięcie zmienia.
   *
   * [zgłoszenie użytkownika, "Pancerz" nie dostawał sugestii "armour"]
   * Etykiety w tej i innych książkach CoC7 często kończą się dwukropkiem
   * ("Pancerz:", "Krzepa:", "Ruch:") — sam token kliknięty na stronie NIESIE
   * ten dwukropek, ale `CANONICAL_STATS`'s podpowiedzi (`statKeys.ts`) go NIE
   * mają (to warianty językowe/skróty, nie dosłowne tokeny z PDF-a), więc
   * dokładne porównanie nigdy nie trafiało dla żadnej etykiety z dwukropkiem —
   * autor musiał zawsze wpisywać klucz ręcznie, nawet dla dobrze znanych pól.
   */
  async #suggestCanonicalKey(labelText: string): Promise<string> {
    const { CANONICAL_STATS } = await import('@bindery/core');
    const needle = labelText.trim().replace(/:$/, '').toLowerCase();
    if (!needle) return '';
    for (const [key, def] of Object.entries(CANONICAL_STATS)) {
      if (def.hints.some((hint: string) => hint.toLowerCase() === needle)) return key;
    }
    return '';
  }

  static readonly #DEFAULT_ATTACH_MAX_DISTANCE_PT = 400;

  /**
   * [Korekta] Dodaje (albo odswieza) jedna pare etykieta-wartosc w slocie
   * `'grid'` (Cechy, kotwica) albo `'derived'` (Pochodne, drugi labelledPairs)
   * — TA SAMA logika co poprzednio, ale sparametryzowana slotem zamiast
   * jednego dzielonego "aktywnego wzorca", zeby klikniecie na kazdej z tych
   * dwoch zakladek trafialo do WLASCIWEGO wzorca (dokladnie zgloszony
   * problem: "z widoku strony da się dodać tylko cechy").
   */
  async #addOrUpdateGridPair(slot: 'grid' | 'derived', labelText: string, value: string): Promise<void> {
    if (!this.#draft) return;
    const currentId = slot === 'grid' ? this.#activeGridPatternId : this.#activeDerivedPatternId;
    let entry = this.#draft.patterns.find((e) => e.id === currentId);
    if (!entry || entry.pattern.kind !== 'labelledPairs') {
      entry = createPatternDraft(
        'labelledPairs',
        this.#draft.patterns.map((e) => e.id),
      );
      this.#draft.patterns.push(entry);
      if (slot === 'grid') {
        this.#activeGridPatternId = entry.id;
        if (!this.#draft.anchor) this.#draft.anchor = entry.id;
        // [KROK-28, odkrycie] `createEmptyProfileDraft` nie tworzy ZADNEGO
        // wzorca `fontRoleCandidate` (nazwa encji) — bez tego autor musialby
        // wrocic do surowego JSON-a po niego, lamiac "zero przelaczania
        // zakladek". Rozsadne wartosci domyslne (te same, ktorych uzywaja
        // oba istniejace profile CoC7) tworzone razem z PIERWSZA siatka.
        if (!this.#draft.patterns.some((e) => e.pattern.kind === 'fontRoleCandidate' && e.id !== this.#draft!.typeLabelPattern)) {
          const nameEntry = createPatternDraft(
            'fontRoleCandidate',
            this.#draft.patterns.map((e) => e.id),
          );
          this.#draft.patterns.push(nameEntry);
          this.#activeNamePatternId = nameEntry.id;
          this.#draft.attach.push({ pattern: nameEntry.id, strategy: 'nearestAbove', maxDistancePt: ProfileStudio.#DEFAULT_ATTACH_MAX_DISTANCE_PT });
        }
      } else {
        this.#activeDerivedPatternId = entry.id;
        if (this.#draft.anchor && !this.#draft.attach.some((a) => a.pattern === entry!.id)) {
          this.#draft.attach.push({ pattern: entry.id, strategy: 'nearest', maxDistancePt: ProfileStudio.#DEFAULT_ATTACH_MAX_DISTANCE_PT });
        }
      }
    }
    if (entry.pattern.kind !== 'labelledPairs') return;
    const canonicalKey = await this.#suggestCanonicalKey(labelText);
    const existing = entry.pattern.labels.find((l) => l.label === labelText);
    if (existing) {
      if (!existing.canonicalKey && canonicalKey) existing.canonicalKey = canonicalKey;
    } else {
      entry.pattern.labels.push({ label: labelText, canonicalKey });
    }
    this.#buildPairPreviewValues.set(`${entry.id}:${labelText}`, value);
    this.#refreshBuildPanel();
  }

  /**
   * [Korekta] Klikniecie naglowka sekcji w slocie `'attacks'` (Ataki) albo
   * `'skills'` (Umiejetnosci) — zakladka juz mowi, KTORA to sekcja, wiec (w
   * odroznieniu od poprzedniej wersji) nie trzeba tego zgadywac z "brak
   * kandydata na wartosc w poblizu". Tworzy (albo ponownie uzywa, jesli ten
   * slot juz ma wzorzec) `sectionList`, dodaje regule dolaczenia do kotwicy,
   * i wchodzi w "ognisko" przeciagania granicy.
   */
  #startSectionFromHeader(slot: 'attacks' | 'skills', tok: IndexedSelectionToken): void {
    if (!this.#draft) return;
    const escaped = escapeSectionBoundaryLiteral(tok.text);
    const currentId = slot === 'attacks' ? this.#activeAttackPatternId : this.#activeSkillsPatternId;
    let entry = this.#draft.patterns.find((e) => e.id === currentId && e.pattern.kind === 'sectionList');
    if (!entry) {
      entry = createPatternDraft(
        'sectionList',
        this.#draft.patterns.map((e) => e.id),
      );
      if (entry.pattern.kind === 'sectionList') entry.pattern.sectionHeader = escaped;
      this.#draft.patterns.push(entry);
      if (this.#draft.anchor) this.#draft.attach.push({ pattern: entry.id, strategy: 'nearest', maxDistancePt: ProfileStudio.#DEFAULT_ATTACH_MAX_DISTANCE_PT });
      if (slot === 'attacks') this.#activeAttackPatternId = entry.id;
      else {
        this.#activeSkillsPatternId = entry.id;
        this.#draft.skillsPattern = entry.id;
      }
    } else if (entry.pattern.kind === 'sectionList') {
      entry.pattern.sectionHeader = escaped;
    }
    this.#sectionBoundaryFocus = { patternId: entry.id, page: this.#state.currentPageNumber, headerTokenIndex: tok.tokenIndex };
    this.#refreshBuildPanel();
  }

  /**
   * [KROK-29 Z1, sedno kroku] Klikniecie w fazie 3 (naglowek + granica juz
   * ustawione) — WSKAZUJESZ, narzedzie WNIOSKUJE. `collectRowText` zbiera
   * tekst calego wizualnego wiersza wokol klikniecia (zwykle to i tak caly
   * tekst jednego tokenu — pdf.js czesciej niz nie skleja cala linie w jeden
   * `TextItem`, zmierzone wprost na str. 23 "Zew Cthulhu 7ed. Wrak.pdf"), a
   * `inferItemPatternFromExamples` dobiera i dostraja jeden z OGRANICZONEJ
   * rodziny ksztaltow (brief: nigdy dowolny regex od podstaw) na podstawie
   * WSZYSTKICH dotychczasowych przykladow dla TEGO wzorca — kolejne
   * klikniecie moze wiec ROZSZERZYC rozpoznany ksztalt (zmierzone: "Walka
   * wręcz 30%..." samo daje ksztalt procentowy, dopiero DRUGI przyklad
   * "pałka 1K4+1K4" bez procentu dodaje druga galaz alternatywy i pałka
   * zaczyna byc rozpoznawana jako osobna pozycja).
   */
  async #addItemPatternExample(slot: 'attacks' | 'skills', entry: PatternEntryDraft, tok: IndexedSelectionToken, allTokens: readonly IndexedSelectionToken[]): Promise<void> {
    if (entry.pattern.kind !== 'sectionList') return;
    const { collectRowText, inferItemPatternFromExamples } = await import('@bindery/core');
    const rowIndex = allTokens.findIndex((t) => t.tokenIndex === tok.tokenIndex);
    // [zgloszenie uzytkownika, "granica ustawiona, ale klikniecie przykladu
    // (np. Walka wrecz) nic nie robi"] Dwa wczesniejsze `return` ponizej byly
    // CALKOWICIE ciche — ten sam ksztalt bledu co juz raz naprawiony dla
    // `#onNoteTokenClick` (patrz `notesPickFailedNoToken` i siostrzane klucze)
    // — klikniecie, ktore z jakiegokolwiek powodu nie doda przykladu, MUSI
    // powiedziec dlaczego, zamiast wygladac jak martwy przycisk. Dokladna
    // przyczyna tego zgloszenia nie zostala jeszcze odtworzona wprost (brak
    // dostepu do zywego Foundry w tej sesji) — te ostrzezenia sa wiec
    // jednoczesnie naprawa UX (A3: nic nie ginie w ciszy) i diagnostyka na
    // wypadek nawrotu (`rowText` puste = `collectRowText` nie znalazlo
    // zadnego tekstu wokol klikniecia; brak `inferred` = przyklad ZOSTAL
    // przyjety, ale zaden ze znanych ksztaltow itemPattern jeszcze do niego
    // nie pasuje — inaczej niz calkowita cisza, oba stany sa teraz widoczne).
    if (rowIndex === -1) {
      ui.notifications?.warn(game.i18n!.localize('BINDERY.studio.itemExampleTokenNotFound' as never));
      return;
    }
    const rowText = collectRowText(allTokens, rowIndex).trim();
    if (!rowText) {
      ui.notifications?.warn(game.i18n!.localize('BINDERY.studio.itemExampleEmptyRowText' as never));
      return;
    }
    const examples = this.#itemPatternExamples.get(entry.id) ?? [];
    if (!examples.includes(rowText)) examples.push(rowText);
    this.#itemPatternExamples.set(entry.id, examples);
    const inferred = inferItemPatternFromExamples(slot, examples);
    if (inferred) {
      entry.pattern.itemPattern = inferred.itemPattern;
      this.#itemPatternShape.set(entry.id, inferred.shape);
    } else {
      ui.notifications?.info(game.i18n!.format('BINDERY.studio.itemExampleAcceptedNoShapeYet' as never, { count: String(examples.length) }));
    }
    this.#refreshBuildPanel();
  }

  /** [KROK-29 Z1] "Zacznij od nowa" dla przykladow itemPattern — NIE usuwa granicy/naglowka, WYLACZNIE nagromadzone przyklady i wygenerowany z nich wzorzec (recznie wpisany wzorzec pod "Zaawansowane" zostaje nietkniety, jesli autor sam go tam wpisal). */
  #clearItemPatternExamples(entry: PatternEntryDraft): void {
    this.#itemPatternExamples.delete(entry.id);
    this.#itemPatternShape.delete(entry.id);
    this.#refreshBuildPanel();
  }

  /**
   * [KROK-28 Z1, wymog krytyczny, bez zmian od poprzedniej wersji] Odswieza
   * WYLACZNIE zawartosc panelu budowania (i nakladke SVG) — NIGDY
   * `this.render()`. Pelny render ApplicationV2 przebudowuje CALY szablon
   * `.hbs` od zera, co gubi pozycje przewijania obu kolumn — dokladnie
   * zgloszony problem (U1).
   */
  #refreshBuildPanel(): void {
    this.#mountBuildPanel();
    void this.#mountPickableTokens();
    void this.#mountSectionBoundaryOverlay();
  }

  /** [Korekta] Klikniecie tokenu na PDF-ie w domyslnym trybie budowania — jedyna droga budowania, TERAZ jednoznacznie kierowana aktywna zakladka zamiast zgadywana z geometrii. */
  async #onBuildTokenClick(tok: IndexedSelectionToken, allTokens: readonly IndexedSelectionToken[]): Promise<void> {
    if (!this.#draft) return;

    if (this.#pendingValueChoice) {
      const chosen = this.#pendingValueChoice.candidates.find((c) => c.tokenIndex === tok.tokenIndex);
      const { slot, labelText } = this.#pendingValueChoice;
      this.#pendingValueChoice = null;
      if (chosen) {
        await this.#addOrUpdateGridPair(slot, labelText, chosen.text);
        return;
      }
      // Klikniecie POZA podswietlonymi kandydatami = rezygnacja — ten klik liczy sie jako NOWE klikniecie, ponizej.
    }

    const tab = this.#state.buildTab;
    if (tab === 'grid' || tab === 'derived') {
      const { estimateTypicalRowGapPt, findValueCandidatesNearLabel } = await import('@bindery/core');
      const gap = estimateTypicalRowGapPt(allTokens);
      const candidates = findValueCandidatesNearLabel(allTokens, tok.bbox, gap);
      if (candidates.length === 1) {
        await this.#addOrUpdateGridPair(tab, tok.text, candidates[0]!.text);
        return;
      }
      if (candidates.length > 1) {
        this.#pendingValueChoice = { slot: tab, labelText: tok.text, labelBbox: tok.bbox, candidates };
        this.#refreshBuildPanel();
        return;
      }
      // Brak kandydata na wartosc -- na tej zakladce to NIE oznacza juz automatycznie "wiec to naglowek sekcji" (to bylo zrodlem niejednoznacznosci w poprzedniej wersji) -- po prostu nic tu nie ma do sparowania.
      return;
    }
    if (tab === 'attacks' || tab === 'skills') {
      const currentId = tab === 'attacks' ? this.#activeAttackPatternId : this.#activeSkillsPatternId;
      const focus = this.#sectionBoundaryFocus;
      const entry = this.#draft.patterns.find((e) => e.id === currentId && e.pattern.kind === 'sectionList');
      // [Korekta uzytkownika] Gdy naglowek tej sekcji jest juz "w ognisku" na
      // TEJ stronie, KOLEJNE klikniecie (na cokolwiek innego niz sam token
      // naglowka) NIE jest juz nowym naglowkiem. Trzy fazy, w tej kolejnosci:
      // (1) brak naglowka -> to klikniecie NIM ZOSTAJE; (2) naglowek jest, ale
      // `terminateSectionBefore` jeszcze nie -> to klikniecie ustawia granice
      // (pierwszy element SPOZA sekcji, prostsze niz przeciaganie — ktore
      // zostaje dostepne OBOK, `#sectionBoundaryFocus` nie jest czyszczone,
      // wiec uchwyt na PDF-ie nadal sie rysuje); (3) granica JUZ ustawiona ->
      // [KROK-29 Z1] to klikniecie to PRZYKLAD pozycji do wyuczenia
      // `itemPattern` — brief wprost: "Po ustawieniu granicy sekcji panel
      // mowi: Kliknij 2-3 przykladowe pozycje w tej sekcji".
      if (entry?.pattern.kind === 'sectionList' && focus && focus.patternId === currentId && focus.page === this.#state.currentPageNumber && tok.tokenIndex !== focus.headerTokenIndex) {
        if (!entry.pattern.terminateSectionBefore) {
          entry.pattern.terminateSectionBefore = escapeSectionBoundaryLiteral(tok.text);
          this.#refreshBuildPanel();
          return;
        }
        await this.#addItemPatternExample(tab, entry, tok, allTokens);
        return;
      }
      this.#startSectionFromHeader(tab, tok);
      return;
    }
    if (tab === 'notes') {
      await this.#onNoteTokenClick(tok, allTokens);
      return;
    }
    if (tab === 'name') {
      await this.#onNameCandidateClick(this.#nameSubMode, tok);
    }
  }

  /**
   * [Korekta, "Nazwa: wskazuje kandydata na nazwę istoty"] `fontRoleCandidate`
   * dopasowuje po ROLI FONTU, nie po literalnym tekscie (w odroznieniu od
   * `labelledPairs`/`sectionList`) — klikniecie NIE MOZE wiec wpisac
   * dokladnie tego tekstu jako "akceptowana wartosc" tak jak dla etykiet.
   * Zamiast tego: klikniecie sluzy jako TEST na PRAWDZIWYCH danych (jesli
   * pelny przebieg juz istnieje dla tej strony, pokaz, czy TEN token zostal
   * rozpoznany jako kandydat) i jako podpowiedz do jedynego parametru
   * literalnie wywodliwego z klikniecia bez zmiany silnika: `maxLength`
   * (jesli klikniety tekst jest dluzszy niz obecny limit, podnosi go).
   *
   * [KROK-29 Z3] Drugi parametr wywodliwy z klikniecia: `fontKey` klikniętego
   * tokenu dopisywany do `requireFontKeys` (jesli jeszcze go tam nie ma).
   * Sama rola fontu ma fatalna precyzje (H2 kroku 12: 2401 kandydatow na 15
   * encji) — klucz fontu zawezenia o rzad wielkosci, bo w odroznieniu od roli
   * (rankingu per DOKUMENT) identyfikuje KONKRETNY kroj uzyty na nazwy.
   * Kolejne klikniecia DODAJA alternatywy (kilka krojow uzywanych na nazwy w
   * tej samej ksiazce), nigdy nie zastepuja. Reszta (`excludeRoles` i inne)
   * zostaje pod "Ustawienia zaawansowane" — swiadomie NIE zmieniamy silnika
   * dopasowan (brief, wprost).
   *
   * [ZGŁOSZENIE po kroku 30, "Rozdzielenie nazwy od typu/zawodu"] Sparametryzowane
   * `slot`iem, tak samo jak `#startSectionFromHeader` dla Ataki/Umiejetnosci —
   * jedna zakladka "Nazwa", DWA niezalezne sloty `fontRoleCandidate` (nazwa +
   * zawod/typ), kazdy z WLASNYM `requireFontKeys` (np. "John Calhoun," pogrubiony,
   * "kapitan jachtu" kursywa — dwa rozne kroje w tej samej ksiazce odrozniaja
   * pola, ktore wczesniej dzielily jeden wzorzec i konkurowaly o to samo pole).
   * Slot `typeLabel` dodatkowo zapisuje `draft.typeLabelPattern`, tak samo jak
   * `#startSectionFromHeader` zapisuje `draft.skillsPattern` dla Umiejetnosci.
   */
  async #onNameCandidateClick(slot: 'name' | 'typeLabel', tok: IndexedSelectionToken): Promise<void> {
    if (!this.#draft) return;
    const currentId = slot === 'typeLabel' ? this.#activeTypeLabelPatternId : this.#activeNamePatternId;
    let entry = this.#draft.patterns.find((e) => e.id === currentId);
    if (!entry || entry.pattern.kind !== 'fontRoleCandidate') {
      entry = createPatternDraft(
        'fontRoleCandidate',
        this.#draft.patterns.map((e) => e.id),
      );
      this.#draft.patterns.push(entry);
      if (this.#draft.anchor && !this.#draft.attach.some((a) => a.pattern === entry!.id)) {
        this.#draft.attach.push({ pattern: entry.id, strategy: 'nearestAbove', maxDistancePt: ProfileStudio.#DEFAULT_ATTACH_MAX_DISTANCE_PT });
      }
      if (slot === 'typeLabel') {
        this.#activeTypeLabelPatternId = entry.id;
        this.#draft.typeLabelPattern = entry.id;
      } else {
        this.#activeNamePatternId = entry.id;
      }
    }
    if (entry.pattern.kind !== 'fontRoleCandidate') return;
    if (tok.text.length > entry.pattern.maxLength) entry.pattern.maxLength = tok.text.length;
    if (tok.fontKey && !entry.pattern.requireFontKeys.includes(tok.fontKey)) entry.pattern.requireFontKeys.push(tok.fontKey);
    if (slot === 'typeLabel') this.#typeLabelPreviewText = tok.text;
    else this.#namePreviewText = tok.text;
    this.#refreshBuildPanel();
    this.#warnIfClickedTextLooksLikeFieldLabel(tok);
    await this.#warnIfClickedRoleIsExcluded(entry.pattern, tok);
  }

  /**
   * [ZGŁOSZENIE na żywo po naprawie draft-12, "Zawód: ma Wiek:"] Odrebny od
   * `#warnIfClickedRoleIsExcluded` blad tej samej rodziny: autor kliknal
   * SAMA ETYKIETE pola ("Zawód:"), nie jej wartosc — rola etykiety (`accent`)
   * NIE jest wykluczona, wiec TAMTO ostrzezenie sie nie odpala, ale wzorzec
   * fontRoleCandidate i tak nigdy nie zlapie WLASCIWEJ etykiety: kazda
   * etykieta pola w tej samej ksiazce dzieli ten sam krok/role ("Wiek:",
   * "Zawód:", skroty cech "S"/"KON"/...), wiec `nearestAbove` zawsze wygra
   * ta GEOMETRYCZNIE najblizsza kotwicy, nie ta, na ktora autor kliknal.
   * `fontRoleCandidate` jest zaprojektowany do lapania SAMODZIELNYCH naglowkow
   * (imie, tytul potwora) — nie etykiet zakonczonych dwukropkiem, ktore z
   * definicji naleza do `labelledPairs`. Sprawdzenie jest CZYSTO strukturalne
   * (koniec ":" LUB dokladne dopasowanie do etykiety juz uzytej w KTORYMKOLWIEK
   * `labelledPairs` w tym szkicu) — zero kosztu PDF, bo to juz mamy w pamieci.
   */
  #warnIfClickedTextLooksLikeFieldLabel(tok: IndexedSelectionToken): void {
    if (!this.#draft) return;
    const text = tok.text.trim();
    const looksLikeLabel =
      /[:：]\s*$/.test(text) ||
      this.#draft.patterns.some((e) => e.pattern.kind === 'labelledPairs' && e.pattern.labels.some((l) => l.label.trim().toLowerCase() === text.toLowerCase()));
    if (looksLikeLabel) ui.notifications?.warn(game.i18n!.format('BINDERY.studio.nameClickLooksLikeLabel' as never, { text }));
  }

  /**
   * [KROK-39, zgloszenie na zywo, "Zawód: trafia w pole Zawód"] `fontRoleCandidate`
   * ZAWSZE odrzuca role wymienione w `excludeRoles` (domyslnie `['body']`) —
   * PRZED sprawdzeniem `requireFontKeys`. Klikniecie na przyklad, ktorego
   * WLASNA rola fontu jest na tej liscie (np. wartosc pola "Zawód:" w tej
   * ksiazce, zwykly styl `body`, nie wyroznik jak u NPC-ow), tworzy wzorzec,
   * ktory NIGDY nie znajdzie NICZEGO — nie tylko tego jednego przykladu,
   * KAZDEGO tokenu tej samej roli, bez wzgledu na `requireFontKeys`. Ten sam
   * blad zdiagnozowany dopiero PO pelnym imporcie (Wrak.pdf, pole "Zawód"
   * Badaczy) — zamiast czekac na "Sprawdz"/import, ostrzega NATYCHMIAST po
   * klikniciu, bo wtedy autor jeszcze pamieta, na co dokladnie kliknal.
   *
   * [Koszt] `getFontRoleAwareTokensForPage` liczy PELNA inwentaryzacje
   * dokumentu (ten sam koszt co `#refreshNotePreview`) — ale klikniecie
   * przykladu Nazwy/Zawodu jest rzadkim, swiadomym dzialaniem autora (nie
   * per-render/per-klatka), wiec ten sam kompromis kosztu co notatki.
   */
  async #warnIfClickedRoleIsExcluded(pattern: FontRoleCandidatePatternDraft, tok: IndexedSelectionToken): Promise<void> {
    if (!this.#pdfBuffer) return;
    const { getFontRoleAwareTokensForPage } = await import('@bindery/core');
    const tokens = await getFontRoleAwareTokensForPage(this.#pdfBuffer, this.#state.currentPageNumber, { assetBaseUrl: ASSET_BASE_URL });
    const tcx = (tok.bbox.minX + tok.bbox.maxX) / 2;
    const tcy = (tok.bbox.minY + tok.bbox.maxY) / 2;
    let bestDist = Infinity;
    let matchedRole: string | undefined;
    for (const t of tokens) {
      const cx = (t.bbox.minX + t.bbox.maxX) / 2;
      const cy = (t.bbox.minY + t.bbox.maxY) / 2;
      const d = Math.hypot(cx - tcx, cy - tcy);
      if (d < bestDist) {
        bestDist = d;
        matchedRole = t.fontRole;
      }
    }
    if (matchedRole && pattern.excludeRoles.includes(matchedRole)) {
      ui.notifications?.warn(game.i18n!.format('BINDERY.studio.nameClickExcludedRole' as never, { role: matchedRole }));
    }
  }

  /** [Korekta] Ostatnio klikniety token na zakladce Nazwa (tryb "Wskaż nazwę") — WYLACZNIE podglad w panelu, nigdy zapisywany w szkicu. */
  #namePreviewText: string | null = null;
  /** [ZGŁOSZENIE po kroku 30] Jak wyzej, ale dla trybu "Wskaż zawód / typ" — osobne pole, zeby przelaczanie miedzy trybami nie nadpisywalo podgladu drugiego. */
  #typeLabelPreviewText: string | null = null;

  #mountBuildPanel(): void {
    const container = this.element.querySelector<HTMLElement>('[data-build-panel]');
    if (!container) return;
    container.innerHTML = '';
    if (!this.#draft) return;

    const guidance = document.createElement('p');
    guidance.className = 'bindery-studio-build-guidance';
    guidance.textContent = this.#computeBuildGuidance();
    container.appendChild(guidance);

    switch (this.#state.buildTab) {
      case 'grid':
        container.appendChild(this.#buildPairTabContent('grid', this.#activeGridPatternId));
        break;
      case 'derived':
        container.appendChild(this.#buildPairTabContent('derived', this.#activeDerivedPatternId));
        break;
      case 'attacks':
        container.appendChild(this.#buildSectionTabContent('attacks', this.#activeAttackPatternId));
        break;
      case 'skills':
        container.appendChild(this.#buildSectionTabContent('skills', this.#activeSkillsPatternId));
        break;
      case 'notes':
        container.appendChild(this.#buildNotesTabContent());
        break;
      case 'name':
        container.appendChild(this.#buildNameTabContent());
        break;
      case 'check':
        break;
    }

    if (this.#pendingValueChoice) {
      const hint = document.createElement('p');
      hint.className = 'notification bindery-studio-build-ambiguous-hint';
      hint.textContent = `${game.i18n!.localize('BINDERY.studio.guidanceAmbiguousValue' as never)} (${this.#pendingValueChoice.candidates.length})`;
      container.appendChild(hint);
    }

    void this.#populateCanonicalKeyDatalist();
  }

  #buildPairTabContent(slot: 'grid' | 'derived', patternId: string | null): HTMLElement {
    const wrap = document.createElement('div');
    const entry = this.#findPattern(patternId);
    wrap.appendChild(this.#buildGridSummary(entry, patternId));
    if (entry?.pattern.kind === 'labelledPairs') {
      const details = document.createElement('details');
      details.className = 'bindery-studio-advanced-details';
      const summary = document.createElement('summary');
      summary.textContent = game.i18n!.localize('BINDERY.studio.advancedSettings' as never);
      details.appendChild(summary);
      details.appendChild(this.#buildLabelledPairsForm(entry.pattern, entry.id));
      if (slot === 'derived') details.appendChild(this.#buildSingleAttachEditor(entry.id));
      wrap.appendChild(details);
    }
    return wrap;
  }

  #buildGridSummary(entry: PatternEntryDraft | undefined, patternId: string | null): HTMLElement {
    const section = document.createElement('div');
    section.className = 'bindery-studio-build-section';
    if (!entry || entry.pattern.kind !== 'labelledPairs') return section;
    const p = entry.pattern;
    for (const labelEntry of p.labels) {
      const row = document.createElement('div');
      row.className = 'bindery-studio-build-pair-row';
      const text = document.createElement('span');
      const preview = this.#buildPairPreviewValues.get(`${patternId}:${labelEntry.label}`);
      text.textContent = preview ? `${labelEntry.label} → ${preview}` : labelEntry.label;
      row.appendChild(text);
      const keyInput = document.createElement('input');
      keyInput.type = 'text';
      keyInput.className = 'bindery-input';
      keyInput.value = labelEntry.canonicalKey;
      keyInput.setAttribute('list', 'bindery-canonical-keys');
      keyInput.placeholder = game.i18n!.localize('BINDERY.studio.canonicalKeyPlaceholder' as never);
      keyInput.addEventListener('change', () => (labelEntry.canonicalKey = keyInput.value));
      row.appendChild(keyInput);
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'bindery-btn bindery-btn--icon';
      delBtn.textContent = '×';
      delBtn.addEventListener('click', () => {
        p.labels = p.labels.filter((l) => l !== labelEntry);
        this.#refreshBuildPanel();
      });
      row.appendChild(delBtn);
      section.appendChild(row);
    }
    return section;
  }

  #buildSectionTabContent(slot: 'attacks' | 'skills', patternId: string | null): HTMLElement {
    const wrap = document.createElement('div');
    const entry = this.#findPattern(patternId);
    if (!entry || entry.pattern.kind !== 'sectionList') return wrap;
    const pattern = entry.pattern;

    const section = document.createElement('div');
    section.className = 'bindery-studio-build-section bindery-studio-build-section-active';
    const h = document.createElement('h4');
    h.textContent = ProfileStudio.#unescapeBoundaryText(pattern.sectionHeader);
    section.appendChild(h);
    // [KROK-37 Z2] Sam naglowek sekcji jest TEZ literalnym tokenem wzietym z
    // JEDNEJ strony materialu — tej samej klasy ryzyko co `terminateSectionBefore`
    // (patrz `#checkBoundaryGenericity`/`#checkLiteralGenericity`): jesli
    // wystepuje wylacznie tam, gdzie autor go kliknal, sekcja nie rozpozna
    // sie u zadnej innej postaci w ksiazce.
    if (pattern.sectionHeader) {
      const headerGenericityWarn = document.createElement('p');
      headerGenericityWarn.className = 'notification error';
      headerGenericityWarn.hidden = true;
      section.appendChild(headerGenericityWarn);
      void this.#checkLiteralGenericity(`sectionHeader:${entry.id}`, pattern.sectionHeader, headerGenericityWarn, 'BINDERY.studio.buildValueTooSpecific', () =>
        entry.pattern.kind === 'sectionList' ? entry.pattern.sectionHeader : undefined,
      );
    }
    const status = document.createElement('p');
    status.className = 'hint';
    const boundaryText = pattern.terminateSectionBefore ? ProfileStudio.#unescapeBoundaryText(pattern.terminateSectionBefore) : null;
    status.textContent = boundaryText ? `${game.i18n!.localize('BINDERY.studio.buildSectionEndsAt' as never)}: ${boundaryText}` : game.i18n!.localize('BINDERY.studio.buildSectionNoBoundary' as never);
    section.appendChild(status);
    // [KROK-29 Z5, zmierzony na zywo blad] Granica ktora wyszla jako pojedynczy
    // znak ("^J$" zamiast "^Jørgen$") dopasuje sie PRZYPADKOWO gdziekolwiek w
    // calej ksiazce -- ostrzez zamiast milczaco zapisac (brief kroku wprost).
    if (boundaryText && boundaryText.trim().length < 2) {
      const warn = document.createElement('p');
      warn.className = 'notification error';
      warn.textContent = `${game.i18n!.localize('BINDERY.studio.buildSectionBoundarySuspicious' as never)} ("${boundaryText}")`;
      section.appendChild(warn);
    }
    // [Zmierzony na zywo blad, str. 23 "Zew Cthulhu 7ed. Wrak.pdf"] Granica
    // dopasowujaca sie do tokenu SPOZA kolumny naglowka (typowo: kilkanascie
    // wierszy prozy z sasiedniej lamy zassane do sekcji) jest sygnalem, ze
    // cos jest nie tak, nawet gdy sama dlugosc tekstu granicy jest w porzadku
    // (Z5 lapie WYLACZNIE przypadek pojedynczego znaku). Sprawdzenie wymaga
    // tokenow strony (`#getBuildTokens`, asynchroniczne) — dopisywane do JUZ
    // wyrenderowanego wiersza ostrzezenia, ten sam wzorzec co
    // `#populateCanonicalKeyDatalist` nizej w tym pliku.
    if (boundaryText) {
      const columnWarn = document.createElement('p');
      columnWarn.className = 'notification error';
      columnWarn.hidden = true;
      section.appendChild(columnWarn);
      void this.#checkBoundaryColumnMismatch(entry, columnWarn);

      // [zgloszenie uzytkownika, "granica ustawiona na Sciapodzie zepsula
      // Ataki Calhouna/Hansena"] Ten sam wzorzec renderowania co ostrzezenie
      // o kolumnie powyzej — hidden <p>, wypelniany asynchronicznie.
      const genericityWarn = document.createElement('p');
      genericityWarn.className = 'notification error';
      genericityWarn.hidden = true;
      section.appendChild(genericityWarn);
      void this.#checkBoundaryGenericity(entry, genericityWarn);
    }
    if (!pattern.itemPattern) {
      const warn = document.createElement('p');
      warn.className = 'hint bindery-studio-build-itempattern-hint';
      warn.textContent = game.i18n!.localize('BINDERY.studio.buildSectionNeedsItemPattern' as never);
      section.appendChild(warn);
    }
    // [KROK-29 Z1] "Ksztalt pokazany zrozumiale, nie jako surowy regex" —
    // WYLACZNIE gdy autor faktycznie klikal przyklady (dla recznie wpisanego
    // pod "Zaawansowane" `itemPattern` nie ma z czego wywnioskowac ksztaltu,
    // wiec nic tu sie nie pokazuje — pole samo w sobie zostaje dostepne tam).
    const shape = this.#itemPatternShape.get(entry.id);
    if (shape) {
      const shapeRow = document.createElement('div');
      shapeRow.className = 'bindery-studio-itempattern-shape';
      const shapeText = document.createElement('p');
      shapeText.className = 'hint';
      shapeText.textContent = `${game.i18n!.localize('BINDERY.studio.itemShapeRecognized' as never)}: ${game.i18n!.localize(`BINDERY.studio.itemShape.${shape}` as never)}`;
      shapeRow.appendChild(shapeText);
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'bindery-btn bindery-btn--secondary';
      clearBtn.textContent = game.i18n!.localize('BINDERY.studio.itemShapeClearButton' as never);
      clearBtn.addEventListener('click', () => this.#clearItemPatternExamples(entry));
      shapeRow.appendChild(clearBtn);
      section.appendChild(shapeRow);
    }
    wrap.appendChild(section);

    const details = document.createElement('details');
    details.className = 'bindery-studio-advanced-details';
    const summary = document.createElement('summary');
    summary.textContent = game.i18n!.localize('BINDERY.studio.advancedSettings' as never);
    details.appendChild(summary);
    details.appendChild(this.#buildSectionListForm(pattern));
    details.appendChild(this.#buildSingleAttachEditor(entry.id));
    if (slot === 'skills') {
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = game.i18n!.localize('BINDERY.studio.skillsPatternAutoNote' as never);
      details.appendChild(hint);
    }
    wrap.appendChild(details);
    return wrap;
  }

  /**
   * [Zmierzony na zywo blad, str. 23 "Zew Cthulhu 7ed. Wrak.pdf"] Granica
   * dopasowujaca sie do tokenu SPOZA kolumny naglowka (dla ktorego zostala
   * ustawiona) niemal na pewno oznacza, ze sekcja zassala tresc z sasiedniej
   * lamy — ostrzez, zamiast pokazywac wynik jako poprawny (brief: "narzedzie
   * mogloby to zauwazyc"). Uzywa `focus.page` (strona, na ktorej naglowek
   * zostal kliknięty), NIE biezaco ogladanej strony — `terminateSectionBefore`
   * to WSPOLNY regex dla calej ksiazki, ale sprawdzenie musi sie odbyc na
   * KONKRETNEJ, znanej geometrii jednej strony.
   */
  async #checkBoundaryColumnMismatch(entry: PatternEntryDraft, warnEl: HTMLElement): Promise<void> {
    if (entry.pattern.kind !== 'sectionList' || !entry.pattern.terminateSectionBefore) return;
    const focus = this.#sectionBoundaryFocus;
    if (!focus || focus.patternId !== entry.id) return;
    const allTokens = await this.#getBuildTokens(focus.page);
    const headerToken = allTokens.find((t) => t.tokenIndex === focus.headerTokenIndex);
    if (!headerToken) return;
    let re: RegExp;
    try {
      re = new RegExp(entry.pattern.terminateSectionBefore, 'u');
    } catch {
      return;
    }
    const boundaryToken = allTokens.find((t) => t.tokenIndex > headerToken.tokenIndex && re.test(t.text));
    if (!boundaryToken) return;
    const { findColumnBand, isWithinColumnBand } = await import('@bindery/core');
    const band = findColumnBand(allTokens, headerToken.bbox);
    if (!isWithinColumnBand(boundaryToken.bbox, band)) {
      warnEl.hidden = false;
      warnEl.textContent = game.i18n!.localize('BINDERY.studio.buildSectionBoundaryWrongColumn' as never);
    }
  }

  /**
   * [zgloszenie uzytkownika, "Wrak.pdf": granica sekcji Ataki skalibrowana na
   * Sciapodzie ("Chwyt i miażdżenie (manewr):" — WLASNY podnaglowek opisu
   * JEGO ataku) zepsula Ataki Calhouna/Hansena — u nich ten tekst nigdy nie
   * wystepuje, wiec sekcja nie miala gdzie sie zatrzymac i wchlonela cala
   * ich liste Umiejetnosci jako falszywe pozycje ataku] `terminateSectionBefore`
   * to JEDEN, wspolny regex dla WSZYSTKICH postaci w calej ksiazce (nie tylko
   * tej, na ktorej autor akurat przeciaga granice) — token trafiony
   * przeciagnieciem na JEDNEJ stronie moze byc idealnie trafny dla TEJ
   * encji, a jednoczesnie kompletnie unikalny dla niej (podnaglowek jej
   * WLASNEGO opisu, a nie generyczny naglowek typu "Umiejętności:", ktory
   * powtarza sie identycznie po kazdej postaci). Sprawdza, czy ustawiona
   * granica dopasowuje sie CHOCIAZ RAZ na KTOREJKOLWIEK innej stronie
   * dokumentu — jesli nie trafia NIGDZIE poza strona, na ktorej zostala
   * skalibrowana, to silny sygnal, ze jest zbyt specyficzna, zanim autor
   * zapisze profil i odkryje to dopiero po zaimportowaniu innej postaci.
   * Cache po (id wzorca + tekst granicy) — bez tego kazdy re-render panelu
   * (kazde klikniecie na tej zakladce) powtarzalby przejscie po CALYM
   * dokumencie od zera.
   */
  #literalGenericityCache = new Map<string, boolean>();

  /**
   * [KROK-37 Z2, rozszerzenie Kroku 36] Uogolniona wersja pierwszej wersji
   * tej kontroli (WYLACZNIE `terminateSectionBefore`) — TEN SAM mechanizm
   * (skanuj cala ksiazke, cache po wartosci) zastosowany do KAZDEGO pola
   * wzorca przechowujacego literalny token wzieciony z materialu, nie tylko
   * granicy sekcji: `sectionHeader`, `trailingWordsStopBefore`, i kazde
   * kolejne tego rodzaju. Liczy, na ilu ROZNYCH stronach dokumentu podany
   * regex trafia na choc jeden token — mniej niz dwie (tylko jedna strona,
   * na ktorej autor go ustawil, albo wcale) jest sygnalem "prawdopodobnie
   * zbyt specyficzne dla jednej encji/strony".
   *
   * [uproszczenie wzgledem pierwszej wersji] Nie wymaga znajomosci "strony
   * kalibracji" (w Kroku 36 to byl `#sectionBoundaryFocus.page`, wykluczany
   * z przeszukiwania) — liczenie WSZYSTKICH trafien (>=2, zamiast "trafienie
   * GDZIEKOLWIEK POZA jedna znana strone") daje TEN SAM wynik dla pol
   * pochodzacych z klikniecia (strona kalibracji zawsze trafia sama w sobie,
   * wiec potrzeba >=1 wiecej = >=2 razem), a DODATKOWO dziala dla pol
   * wpisywanych recznie bez zadnego sladu, ktora strona byla wzorcem
   * (`trailingWordsStopBefore` — zwykly `<input>` pod "Zaawansowane", nie
   * klikniecie na PDF-ie).
   *
   * `getCurrentValue` sprawdzane PO asynchronicznym skanie calego dokumentu
   * — autor mogl w miedzyczasie zmienic wartosc / przelaczyc zakladke /
   * usunac wzorzec; wynik z NIEAKTUALNEGO skanu nie moze nadpisac
   * aktualnego stanu panelu.
   */
  async #checkLiteralGenericity(cacheKeyPrefix: string, source: string, warnEl: HTMLElement, messageKey: string, getCurrentValue: () => string | undefined): Promise<void> {
    if (!this.#previewDocument || this.#previewDocument.pageCount <= 1) return;
    const cacheKey = `${cacheKeyPrefix}::${source}`;
    const cached = this.#literalGenericityCache.get(cacheKey);
    if (cached !== undefined) {
      warnEl.hidden = cached;
      if (!cached) warnEl.textContent = game.i18n!.localize(messageKey as never);
      return;
    }
    let re: RegExp;
    try {
      re = new RegExp(source, 'u');
    } catch {
      return;
    }
    let matchingPages = 0;
    for (let page = 1; page <= this.#previewDocument.pageCount; page++) {
      const tokens = await this.#getBuildTokens(page);
      if (tokens.some((t) => re.test(t.text))) {
        matchingPages++;
        if (matchingPages >= 2) break;
      }
    }
    if (getCurrentValue() !== source) return;
    const generic = matchingPages >= 2;
    this.#literalGenericityCache.set(cacheKey, generic);
    warnEl.hidden = generic;
    if (!generic) warnEl.textContent = game.i18n!.localize(messageKey as never);
  }

  /** [Krok 36] `terminateSectionBefore` — wlasny tekst komunikatu (mowi wprost o "granicy"), reszta deleguje do `#checkLiteralGenericity`. */
  async #checkBoundaryGenericity(entry: PatternEntryDraft, warnEl: HTMLElement): Promise<void> {
    if (entry.pattern.kind !== 'sectionList' || !entry.pattern.terminateSectionBefore) return;
    await this.#checkLiteralGenericity(`terminateSectionBefore:${entry.id}`, entry.pattern.terminateSectionBefore, warnEl, 'BINDERY.studio.buildSectionBoundaryTooSpecific', () =>
      entry.pattern.kind === 'sectionList' ? entry.pattern.terminateSectionBefore : undefined,
    );
  }

  // ---- [KROK-34 Z2] Zakladka "Notatki" — bloki prozy dolaczane geometrycznie ----

  /**
   * [KROK-34 Z2] W odroznieniu od reszty zakladek (jeden wzorzec na slot),
   * Notatki pokazuja LISTE niezaleznych blokow (`draft.notesPatterns`) plus
   * przycisk dodania kolejnego — "Autor może wskazać więcej niż jeden [blok],
   * z własną etykietą" (brief kroku 34).
   */
  #buildNotesTabContent(): HTMLElement {
    const draft = this.#draft!;
    const wrap = document.createElement('div');
    wrap.className = 'bindery-studio-notes-tab';

    for (const patternId of draft.notesPatterns) {
      const entry = draft.patterns.find((e) => e.id === patternId);
      if (!entry || entry.pattern.kind !== 'proseBlock') continue;
      wrap.appendChild(this.#buildNoteBlockRow(entry));
    }

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'bindery-btn bindery-btn--secondary bindery-studio-notes-add-button';
    addBtn.textContent = game.i18n!.localize('BINDERY.studio.notesAddButton' as never);
    addBtn.addEventListener('click', () => {
      const newEntry = createPatternDraft(
        'proseBlock',
        draft.patterns.map((e) => e.id),
      );
      if (newEntry.pattern.kind === 'proseBlock') newEntry.pattern.label = game.i18n!.localize('BINDERY.studio.notesDefaultLabel' as never);
      draft.patterns.push(newEntry);
      draft.notesPatterns.push(newEntry.id);
      // [Korekta wzorowana na innych zakladkach] Nowy blok od razu w trybie
      // wskazywania — autor nie musi klikac "Wskaż przykład" osobno zaraz po dodaniu.
      this.#notesPickPatternId = newEntry.id;
      this.#refreshBuildPanel();
    });
    wrap.appendChild(addBtn);
    return wrap;
  }

  /** [KROK-34 Z2] Jeden wiersz = jeden blok notatki: etykieta, przycisk wskazywania, usuwanie, status pomiaru, podglad per encja na biezacej stronie, "Zaawansowane" (limit dlugosci/promien wyszukiwania). */
  #buildNoteBlockRow(entry: PatternEntryDraft): HTMLElement {
    const row = document.createElement('div');
    if (entry.pattern.kind !== 'proseBlock') return row;
    const pattern = entry.pattern;
    const draft = this.#draft!;
    row.className = 'bindery-studio-note-block-row';

    const header = document.createElement('div');
    header.className = 'bindery-studio-note-block-header';
    header.appendChild(this.#textInput(pattern.label, (v) => (pattern.label = v), game.i18n!.localize('BINDERY.studio.notesLabelPlaceholder' as never)));

    const isPicking = this.#notesPickPatternId === entry.id;
    const pickBtn = document.createElement('button');
    pickBtn.type = 'button';
    pickBtn.className = 'bindery-btn bindery-btn--ghost bindery-studio-note-pick-button';
    pickBtn.classList.toggle('active', isPicking);
    pickBtn.textContent = game.i18n!.localize('BINDERY.studio.notesPickButton' as never);
    pickBtn.addEventListener('click', () => {
      this.#notesPickPatternId = isPicking ? null : entry.id;
      this.#refreshBuildPanel();
    });
    header.appendChild(pickBtn);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'bindery-btn bindery-btn--icon';
    delBtn.textContent = '×';
    delBtn.title = game.i18n!.localize('BINDERY.studio.notesRemoveButton' as never);
    delBtn.addEventListener('click', () => {
      draft.patterns = draft.patterns.filter((e) => e.id !== entry.id);
      draft.notesPatterns = draft.notesPatterns.filter((id) => id !== entry.id);
      if (this.#notesPickPatternId === entry.id) this.#notesPickPatternId = null;
      this.#notesPreview.delete(entry.id);
      this.#refreshBuildPanel();
    });
    header.appendChild(delBtn);
    row.appendChild(header);

    const status = document.createElement('p');
    status.className = 'hint';
    status.textContent = pattern.measured
      ? `${game.i18n!.localize('BINDERY.studio.notesMeasuredPrefix' as never)} dx=${pattern.offsetDxPt.toFixed(1)}pt, dy=${pattern.offsetDyPt.toFixed(1)}pt`
      : game.i18n!.localize('BINDERY.studio.notesNotMeasuredYet' as never);
    row.appendChild(status);

    row.appendChild(this.#buildNotePreviewSection(entry.id, pattern));

    const details = document.createElement('details');
    details.className = 'bindery-studio-advanced-details';
    const summary = document.createElement('summary');
    summary.textContent = game.i18n!.localize('BINDERY.studio.advancedSettings' as never);
    details.appendChild(summary);
    details.appendChild(
      this.#formRow(
        game.i18n!.localize('BINDERY.studio.notesMaxLengthLabel' as never),
        this.#numberInput(pattern.maxLengthChars, (v) => (pattern.maxLengthChars = v), { min: 1 }),
      ),
    );
    details.appendChild(
      this.#formRow(
        game.i18n!.localize('BINDERY.studio.notesSearchRadiusLabel' as never),
        this.#numberInput(pattern.searchRadiusPt, (v) => (pattern.searchRadiusPt = v), { min: 1 }),
      ),
    );
    // [ZGŁOSZENIE na zywo po Kroku 39, "Wrak.pdf" Badacze] Wlacz, gdy pola
    // notatek ukladaja sie jedno pod drugim ze ZMIENNA dlugoscia miedzy nimi
    // (np. rozna dlugosc biografii u roznych postaci przesuwa WSZYSTKIE
    // kolejne pola) — patrz komentarz przy `chainFromPrevious` w `schema.ts`.
    // Zmiana tego przelacznika wymaga PONOWNEGO klikniecia (`#onNoteTokenClick`
    // liczy offset wzgledem INNEGO punktu odniesienia w zaleznosci od tej
    // wartosci), wiec resetuje `measured`, zamiast zostawic stary pomiar,
    // ktory po przelaczeniu wskazywalby zle miejsce.
    details.appendChild(
      this.#checkboxInput(
        pattern.chainFromPrevious,
        (v) => {
          pattern.chainFromPrevious = v;
          pattern.measured = false;
          this.#refreshBuildPanel();
        },
        game.i18n!.localize('BINDERY.studio.notesChainFromPrevious' as never),
      ),
    );
    // [ZGŁOSZENIE na zywo, "zaznaczam tylko te dwa, a do nich wpisywane sa
    // wszystkie informacje z tych akapitow"] Wlacz, gdy TEN blok ma zbierac
    // WIECEJ niz do najblizszego podnaglowka — az do NASTEPNEGO naglowka
    // TEGO SAMEGO stylu co klikniety przyklad (patrz `stopAtSameFontRole` w
    // `schema.ts`). Nie wymaga ponownego pomiaru (nie zmienia PUNKTU
    // odniesienia, tylko warunek zatrzymania), wiec `measured` zostaje.
    details.appendChild(
      this.#checkboxInput(
        pattern.stopAtSameFontRole,
        (v) => {
          pattern.stopAtSameFontRole = v;
          this.#refreshBuildPanel();
        },
        game.i18n!.localize('BINDERY.studio.notesStopAtSameFontRole' as never),
      ),
    );
    // [ZGŁOSZENIE na zywo, "Wrak.pdf" Badacze, "Twoi przyjaciele" w osobnej
    // kolumnie] Wlacz, gdy ten blok lezy w kolumnie NIEZALEZNEJ od dlugosci
    // atakow/umiejetnosci — patrz `anchorGridOnly` w `schema.ts`. Zmienia
    // punkt odniesienia, wiec (jak `chainFromPrevious`) resetuje `measured`.
    details.appendChild(
      this.#checkboxInput(
        pattern.anchorGridOnly,
        (v) => {
          pattern.anchorGridOnly = v;
          pattern.measured = false;
          this.#refreshBuildPanel();
        },
        game.i18n!.localize('BINDERY.studio.notesAnchorGridOnly' as never),
      ),
    );
    row.appendChild(details);

    return row;
  }

  /** [KROK-34 Z2] Podglad tekstu, ktory TEN blok notatki znajduje dla kazdej encji na BIEZACEJ stronie — liczony WYLACZNIE na zadanie (nigdy automatycznie przy kazdym przerysowaniu, zeby nie petlic renderowania), przez PRAWDZIWY silnik (`analyzeProfilePage`, ten sam, ktory napedza pelny przebieg), nie wlasna, potencjalnie rozjezdzajaca sie kopie logiki dopasowania. */
  // [ZGŁOSZENIE na żywo, "Historia Badacza łapie tylko pierwszy akapit,
  // Twoi przyjaciele puste" — mimo poprawnie zmierzonego offsetu] Oba
  // objawy mialy TA SAMA przyczyne: `stopAtSameFontRole` nie zostal
  // zaznaczony — blok zaczynajacy sie na WLASNYM naglowku (`heading`)
  // zatrzymuje sie na PIERWSZYM mniejszym podnaglowku (`accent`) w srodku
  // (np. "Wygląd:"/kolejny wpis znajomego), zamiast przez niego przelecieć.
  // Podglad juz POKAZYWAL prawdziwy (obciety/pusty) wynik od kroku 34 —
  // problem byl WYLACZNIE w tym, ze nic nie tlumaczylo autorowi, CZEMU
  // wynik jest taki krotki, ani gdzie szukac naprawy. Heurystyka: gdy
  // znaleziony tekst jest ledwie dluzszy niz sama etykieta (czyli praktycznie
  // sam naglowek, nic po nim) I `stopAtSameFontRole` jeszcze wylaczony —
  // podpowiedz wprost, zamiast liczyc na to, ze autor sam zgadnie. Wspoldzielone
  // przez podglad per-blok i odznake zakladki (`#computeTabBadge`), zeby oba
  // zgadzaly sie co do tego, co znaczy "wyglada na obciete".
  static readonly #NOTE_TRUNCATION_MARGIN_CHARS = 15;
  #noteLooksTruncated(pattern: Extract<PatternDraft, { kind: 'proseBlock' }>, preview: { ordinal: number; text: string | null }[] | 'loading' | undefined): boolean {
    if (pattern.stopAtSameFontRole || !preview || preview === 'loading') return false;
    const labelLength = pattern.label.trim().length;
    return preview.some((item) => item.text !== null && item.text.trim().length <= labelLength + ProfileStudio.#NOTE_TRUNCATION_MARGIN_CHARS);
  }

  #buildNotePreviewSection(patternId: string, pattern: Extract<PatternDraft, { kind: 'proseBlock' }>): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'bindery-studio-note-preview';
    const preview = this.#notesPreview.get(patternId);
    if (preview === 'loading') {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = game.i18n!.localize('BINDERY.studio.notesPreviewLoading' as never);
      wrap.appendChild(p);
    } else if (preview) {
      if (preview.length === 0) {
        const p = document.createElement('p');
        p.className = 'hint';
        p.textContent = game.i18n!.localize('BINDERY.studio.notesPreviewNoEntities' as never);
        wrap.appendChild(p);
      }
      for (const item of preview) {
        const p = document.createElement('p');
        p.className = item.text ? 'bindery-studio-note-preview-hit' : 'hint';
        const prefix = `${game.i18n!.localize('BINDERY.studio.notesPreviewEntityPrefix' as never)} ${item.ordinal + 1}:`;
        p.textContent = `${prefix} ${item.text ?? game.i18n!.localize('BINDERY.studio.notesPreviewNoMatch' as never)}`;
        wrap.appendChild(p);
      }
    }
    if (this.#noteLooksTruncated(pattern, preview)) {
      const hint = document.createElement('p');
      hint.className = 'notification warning';
      hint.textContent = game.i18n!.localize('BINDERY.studio.notesLooksTruncatedHint' as never);
      wrap.appendChild(hint);
    }
    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'bindery-btn bindery-btn--secondary';
    refreshBtn.textContent = game.i18n!.localize('BINDERY.studio.notesRefreshPreviewButton' as never);
    refreshBtn.disabled = !pattern.measured || !this.#pdfBuffer || preview === 'loading';
    refreshBtn.addEventListener('click', () => void this.#refreshNotePreview(patternId));
    wrap.appendChild(refreshBtn);
    return wrap;
  }

  /**
   * [KROK-34 Z2] Waliduje BIEZACY szkic i liczy `analyzeProfilePage` WYLACZNIE
   * dla biezacej strony — REALNY silnik, ale bez uruchamiania pelnego,
   * wielostronicowego przebiegu (`#runFullScan`) tylko po to, zeby zobaczyc
   * jeden podglad. Cichy powrot przy niepoprawnym szkicu — bledy walidacji i
   * tak sa widoczne na zakladce "Sprawdz".
   *
   * [Zmierzony na zywo blad] `#getBuildTokens` (Krok 23 Z6) CELOWO nie liczy
   * `fontRole` — `proseBlock`/Krok-33 Z4 potrzebuja go do rozpoznania
   * podnaglowkow, wiec podglad tutaj uzywa `getFontRoleAwareTokensForPage`
   * (kosztowniejsze — pelna inwentaryzacja dokumentu — ale liczone WYLACZNIE
   * na to klikniecie, nie przy kazdym przerysowaniu), patrz jej dokumentacja.
   */
  async #refreshNotePreview(patternId: string): Promise<void> {
    if (!this.#draft || !this.#pdfBuffer) return;
    this.#notesPreview.set(patternId, 'loading');
    this.#refreshBuildPanel();

    const result = await validateActorProfileFile(draftToProfileInput(this.#draft));
    if (!result.ok) {
      this.#notesPreview.delete(patternId);
      this.#refreshBuildPanel();
      return;
    }
    const notePattern = result.profile.patterns[patternId];
    if (!notePattern || notePattern.kind !== 'proseBlock') {
      this.#notesPreview.delete(patternId);
      this.#refreshBuildPanel();
      return;
    }

    const { analyzeProfilePage, getFontRoleAwareTokensForPage } = await import('@bindery/core');
    const tokens = await getFontRoleAwareTokensForPage(this.#pdfBuffer, this.#state.currentPageNumber, { assetBaseUrl: ASSET_BASE_URL });
    // [KROK-39 Z1/Z2] `result.profile` pochodzi z `draftToProfileInput(this.#draft)`
    // (WYLACZNIE aktywna trasa, na korzeniu) — WYMUS trase `'npc'`, zeby
    // `resolvePatternSetForRoute` rozwiazalo ja do TYCH wzorcow, niezaleznie
    // od tego, ktora trasa jest faktycznie aktywna w edytorze (`#activeRoute`).
    const analysis = analyzeProfilePage(tokens, result.profile, this.#state.currentPageNumber, 'npc');
    const label = notePattern.label;
    this.#notesPreview.set(
      patternId,
      analysis.entities.map((e, i) => ({ ordinal: i, text: e.notes.find((n) => n.label === label)?.text ?? null })),
    );
    this.#refreshBuildPanel();
  }

  /**
   * [KROK-34 Z2] Klikniecie na zakladce "Notatki", WYLACZNIE gdy jakis blok
   * czeka na wskazanie (`#notesPickPatternId`) — poza tym klikniecia na tej
   * zakladce nic nie robia. Liczy `offset` (przesuniecie WZGLEDEM konca
   * WLASNEJ tresci "wlascicielskiej" encji — `lastClaimedTokenBbox`, ta sama
   * funkcja co prawdziwy silnik, patrz `proseBlock.ts`) i zapisuje go w
   * szkicu; NIGDY nie zapamietuje literalnego tekstu (R2).
   *
   * [Zmierzony na zywo blad, "Wrak.pdf" str. 24] `tok`/`allTokens` (parametry
   * tej funkcji) pochodza z `#getBuildTokens` (klikalne prostokaty na PDF-ie)
   * — CELOWO bez `fontRole` (Krok 23 Z6), wiec `matchSectionList`'s
   * rozpoznawanie podnaglowkow (`fontRole === 'accent'`) i przez to CALY
   * mechanizm Krok-33 Z4 (opisy pod atakami) milczaly, mimo poprawnego
   * `offset` — zmierzone wprost: node'owy skrypt weryfikacyjny (Krok 34,
   * `tokenizePage` z pelna inwentaryzacja) znajdowal notatke Sciapoda
   * poprawnie, TA SAMA funkcja w Profile Studio (`#getBuildTokens`) — nie.
   * Naprawa: `allTokens` (parametr) UZYWANY WYLACZNIE do namierzenia bboxa
   * klikniętego tokenu (do niego fontRole jest bez znaczenia) — CALE
   * dopasowanie geometrii liczone na SWIEZO pobranych, fontRole-aware
   * tokenach (`getFontRoleAwareTokensForPage`), z dopasowaniem klikniętego
   * tokenu PO BBOXIE (nie po `tok.tokenIndex` — dwie rozne tokenizacje moga
   * dzielic/laczyc tokeny INACZEJ, wiec te same indeksy mogłyby wskazywac na
   * rozne tokeny w kazdej z list).
   */
  async #onNoteTokenClick(tok: IndexedSelectionToken, allTokens: readonly IndexedSelectionToken[]): Promise<void> {
    void allTokens;
    if (!this.#draft || !this.#notesPickPatternId || !this.#pdfBuffer) return;
    const patternId = this.#notesPickPatternId;
    const entry = this.#draft.patterns.find((e) => e.id === patternId);
    if (!entry || entry.pattern.kind !== 'proseBlock') return;

    // Waliduje przez PRAWDZIWY schemat (`@bindery/core`), zeby dostac wzorce
    // w ksztalcie, ktorego oczekuja `matchLabelledPairs`/`matchSectionList`
    // (etykiety jako Record, nie lista draftu) — jedno zrodlo prawdy zamiast
    // wlasnej, rownoleglej konwersji.
    // [Zmierzony na zywo problem, zgloszenie uzytkownika "klikam, nic sie nie
    // dzieje"] Wszystkie ponizsze wczesne wyjscia byly CALKOWICIE ciche —
    // skopiowane z `#refreshNotePreview` (gdzie cichy powrot jest celowy,
    // bo bledy walidacji i tak sa widoczne na zakladce "Sprawdz"), ale TU, w
    // WLASCIWYM klikniciu mierzacym offset, brak jakiegokolwiek komunikatu
    // wyglada jak calkowicie zepsuty przycisk — autor nie ma zadnego sposobu
    // dowiedziec sie, ze np. szkic ma gdzie indziej blad walidacji, albo ze
    // biezaca strona po prostu nie ma pasujacej siatki cech. Kazda galaz
    // dostaje teraz wlasny, konkretny komunikat (`ui.notifications`).
    const result = await validateActorProfileFile(draftToProfileInput(this.#draft));
    if (!result.ok) {
      // [Zmierzony na zywo problem, zgloszenie uzytkownika: blad wystapil na
      // szkicu, ktory — zapisany NATYCHMIAST przez ten sam `draftToProfileInput`
      // ("Zapisz jako .json", zero walidacji/normalizacji po drodze) — po
      // ponownym wczytaniu waliduje sie CZYSTO. Przyczyna zrodlowa pozostaje
      // niezreprodukowana; zamiast zgadywac dalej, komunikat teraz NIESIE
      // sam tresc bledu Zod (pierwszy z `result.issues`) plus pelna liste w
      // konsoli (F12) — nastepnym razem da sie zdiagnozowac z PIERWSZEGO
      // wystapienia, bez potrzeby odtwarzania przez zgadywanie.
      //
      // [Zmierzony na zywo problem, zgloszenie uzytkownika: "dostaje warningi
      // 'id: String must contain at least 1 character(s)'"] Ten SUROWY komunikat
      // Zod jest bez znaczenia dla autora budujacego nowy profil od zera —
      // `id`/`gameLine`/`language`/`title`/`publication` (5 pol ze `.min(...)`
      // w `profileV2Schema`, patrz `schema.ts`) sa domyslnie puste
      // (`createEmptyProfileDraft`) i NIE MAJA znaczenia dla samego
      // dopasowania notatki — sa tylko metadanymi pliku. Gdy WSZYSTKIE
      // biezace bledy naleza do tej piatki, komunikat wskazuje wprost, gdzie
      // je uzupelnic (zwijany naglowek "Metadane i zakres stron" nad
      // zakladkami), zamiast surowego tekstu walidatora.
      const metadataIssue = ProfileStudio.#friendlyMetadataValidationMessage(result.issues);
      console.warn('Bindery | Profile Studio: notatki, blad walidacji szkicu przy probie zmierzenia:', result.issues);
      ui.notifications?.warn(metadataIssue ?? `${game.i18n!.localize('BINDERY.studio.notesPickFailedInvalidProfile' as never)} (${result.issues[0] ?? '?'})`);
      return;
    }
    const anchorPattern = result.profile.patterns[result.profile.entityAssembly.anchor];
    if (!anchorPattern || anchorPattern.kind !== 'labelledPairs') {
      ui.notifications?.warn(game.i18n!.localize('BINDERY.studio.notesPickFailedNoAnchor' as never));
      return;
    }

    const { matchLabelledPairs, matchSectionList, matchProseBlock, lastClaimedTokenBbox, lastClaimedTokenIndex, getFontRoleAwareTokensForPage } = await import('@bindery/core');
    const tokens = await getFontRoleAwareTokensForPage(this.#pdfBuffer, this.#state.currentPageNumber, { assetBaseUrl: ASSET_BASE_URL });

    // Dopasowanie klikniętego tokenu w NOWO pobranej liscie po BBOXIE
    // (najblizszy srodek) — patrz komentarz przy funkcji, dlaczego nie po indeksie.
    let clickedIndex = -1;
    let bestDist = Infinity;
    const tcx = (tok.bbox.minX + tok.bbox.maxX) / 2;
    const tcy = (tok.bbox.minY + tok.bbox.maxY) / 2;
    tokens.forEach((t, i) => {
      const cx = (t.bbox.minX + t.bbox.maxX) / 2;
      const cy = (t.bbox.minY + t.bbox.maxY) / 2;
      const d = Math.hypot(cx - tcx, cy - tcy);
      if (d < bestDist) {
        bestDist = d;
        clickedIndex = i;
      }
    });
    if (clickedIndex === -1) {
      ui.notifications?.warn(game.i18n!.localize('BINDERY.studio.notesPickFailedNoToken' as never));
      return;
    }
    const clickedToken = tokens[clickedIndex]!;

    const grids = matchLabelledPairs(tokens, anchorPattern);
    if (grids.length === 0) {
      ui.notifications?.warn(game.i18n!.localize('BINDERY.studio.notesPickFailedNoGridOnPage' as never));
      return;
    }

    // "Wlascicielka" klikniecia: kotwica NAJBLIZSZA klikniętemu tokenowi W
    // STRUMIENIU, ktora nie jest PO nim (ta sama zasada co reszta silnika —
    // encja "posiada" wszystko od WLASNEJ kotwicy do poczatku NASTEPNEJ).
    const owningGrid = [...grids].reverse().find((g) => g.startIndex <= clickedIndex) ?? grids[0]!;
    const hardStopTokenIndices = grids.map((g) => g.startIndex);

    const attackPattern = this.#activeAttackPatternId ? result.profile.patterns[this.#activeAttackPatternId] : undefined;
    const skillsPattern = this.#activeSkillsPatternId ? result.profile.patterns[this.#activeSkillsPatternId] : undefined;
    const attacksMatches = attackPattern?.kind === 'sectionList' ? matchSectionList(tokens, attackPattern, hardStopTokenIndices) : [];
    const skillsMatches = skillsPattern?.kind === 'sectionList' ? matchSectionList(tokens, skillsPattern, hardStopTokenIndices) : [];
    const ownAttacks = attacksMatches.filter((m) => m.headerTokenIndex >= owningGrid.startIndex).sort((a, b) => a.headerTokenIndex - b.headerTokenIndex)[0] ?? null;
    const ownSkills = skillsMatches.filter((m) => m.headerTokenIndex >= owningGrid.startIndex).sort((a, b) => a.headerTokenIndex - b.headerTokenIndex)[0] ?? null;

    const fixedReferenceBbox = lastClaimedTokenBbox(tokens, { grid: owningGrid, attacks: ownAttacks, skills: ownSkills }, hardStopTokenIndices);
    // [ZGŁOSZENIE na zywo, "Wrak.pdf" Badacze, "Twoi przyjaciele" w osobnej
    // kolumnie, `anchorGridOnly`] Ta sama zasada co `chainFromPrevious`
    // ponizej: klikniecie musi liczyc TAK SAMO, jak policzy silnik. Wariant
    // BEZ atakow/umiejetnosci w punkcie odniesienia — patrz komentarz przy
    // `anchorGridOnly` w `schema.ts`.
    const fixedReferenceBboxGridOnly = lastClaimedTokenBbox(tokens, { grid: owningGrid }, hardStopTokenIndices);
    const fixedReferenceFor = (p: { anchorGridOnly?: boolean }) => (p.anchorGridOnly ? fixedReferenceBboxGridOnly : fixedReferenceBbox);
    // [ZGŁOSZENIE na zywo po Kroku 39, "Wrak.pdf" Badacze, `chainFromPrevious`]
    // Klikniecie MUSI liczyc offset WZGLEDEM TEGO SAMEGO punktu, ktorego
    // silnik uzyje przy imporcie (`assembleStatblocksOnPage`) — inaczej
    // zapisana wartosc dzialalaby na tej stronie (gdzie akurat kliknieto), ale
    // nigdzie indziej. Gdy TEN wzorzec ma `chainFromPrevious`, powtarza wiec
    // TU DOKLADNIE ten sam lancuch, co silnik: dopasowuje po kolei KAZDY
    // wczesniejszy wzorzec `notesPatterns` na tej stronie (kazdy wzgledem
    // WLASNEGO stalego/lancuchowego punktu, zaleznie od JEGO wlasnej flagi),
    // koncowy bbox ostatniego udanego dopasowania jest punktem odniesienia.
    const referenceTokenIndex = lastClaimedTokenIndex(tokens, { grid: owningGrid, attacks: ownAttacks, skills: ownSkills }, hardStopTokenIndices);
    let referenceBbox = fixedReferenceFor(entry.pattern);
    if (entry.pattern.chainFromPrevious) {
      const notePatternIds = result.profile.entityAssembly.notesPatterns ?? [];
      const priorIds = notePatternIds.slice(0, notePatternIds.indexOf(patternId));
      const claimedForChain = new Set<number>();
      let chainBbox = fixedReferenceBbox;
      for (const priorId of priorIds) {
        const priorPattern = result.profile.patterns[priorId];
        if (!priorPattern || priorPattern.kind !== 'proseBlock') continue;
        const priorMatch = matchProseBlock(tokens, priorPattern, priorPattern.chainFromPrevious ? chainBbox : fixedReferenceFor(priorPattern), {
          hardStopTokenIndices,
          excludedTokenIndices: claimedForChain,
          referenceTokenIndex,
        });
        if (priorMatch) {
          for (let t = priorMatch.startIndex; t < priorMatch.endIndex; t++) claimedForChain.add(t);
          chainBbox = tokens[priorMatch.endIndex - 1]!.bbox;
        }
      }
      referenceBbox = chainBbox;
    }
    entry.pattern.offsetDxPt = Math.round((clickedToken.bbox.minX - referenceBbox.minX) * 100) / 100;
    entry.pattern.offsetDyPt = Math.round((clickedToken.bbox.minY - referenceBbox.minY) * 100) / 100;
    entry.pattern.measured = true;
    // [zgloszenie uzytkownika, "klikam na Niewidzialność i sam dobiera nazwę"]
    // Etykieta bloku to WOLNY TEKST WYSWIETLANY (nie bierze udzialu w
    // dopasowaniu geometrycznym — R2 dotyczy WYLACZNIE offsetu), wiec
    // podpowiedzenie jej z klikniętego tokenu nie lamie zasady "nigdy
    // literalnej tresci" (ta zasada chroni MECHANIZM DOPASOWANIA, nie
    // kosmetyczna nazwe widoczna tylko autorowi profilu). Podpowiadamy
    // WYLACZNIE gdy autor jeszcze NIE nazwal bloku sam (puste albo wciaz
    // domyslne "Opis"/"Description") — nie nadpisuje recznie wpisanej nazwy
    // przy PONOWNYM klikniciu (np. poprawka offsetu).
    const defaultLabel = game.i18n!.localize('BINDERY.studio.notesDefaultLabel' as never);
    if (!entry.pattern.label.trim() || entry.pattern.label === defaultLabel) {
      const suggested = clickedToken.text.replace(/:\s*$/, '').trim();
      if (suggested) entry.pattern.label = suggested;
    }
    this.#notesPickPatternId = null;
    this.#refreshBuildPanel();
    void this.#refreshNotePreview(patternId);
  }

  /**
   * [ZGŁOSZENIE po kroku 30, "Rozdzielenie nazwy od typu/zawodu"] Jedna
   * zakladka, DWA niezalezne tryby wskazywania — "Nazwa" i "Zawód/typ" sa
   * dwoma aspektami TEJ SAMEJ encji, wskazywane zwykle jednym ciagiem klikniec
   * (np. "John Calhoun" -> "kapitan jachtu"), wiec zostaja w jednej zakladce
   * zamiast dwoch osobnych — w odroznieniu od Ataki/Umiejetnosci (dwie ODREBNE
   * sekcje na stronie, kazda zasluguje na wlasna zakladke).
   */
  #buildNameTabContent(): HTMLElement {
    const wrap = document.createElement('div');

    const modeRow = document.createElement('div');
    modeRow.className = 'bindery-studio-name-submode-row';
    const nameModeBtn = document.createElement('button');
    nameModeBtn.type = 'button';
    nameModeBtn.className = 'bindery-btn bindery-btn--secondary bindery-studio-name-submode-toggle';
    nameModeBtn.classList.toggle('active', this.#nameSubMode === 'name');
    nameModeBtn.textContent = game.i18n!.localize('BINDERY.studio.nameSubModeName' as never);
    nameModeBtn.addEventListener('click', () => {
      this.#nameSubMode = 'name';
      // Pelny render (nie `#refreshBuildPanel`) — zmiana trybu wplywa TEZ na
      // znacznik zakladki "Nazwa" na pasku (`#computeTabBadge`), liczony w
      // `_prepareContext`, nie tylko na sam panel budowania.
      void this.render();
    });
    modeRow.appendChild(nameModeBtn);

    const typeLabelModeBtn = document.createElement('button');
    typeLabelModeBtn.type = 'button';
    typeLabelModeBtn.className = 'bindery-btn bindery-btn--secondary bindery-studio-name-submode-toggle';
    typeLabelModeBtn.classList.toggle('active', this.#nameSubMode === 'typeLabel');
    typeLabelModeBtn.textContent = game.i18n!.localize('BINDERY.studio.nameSubModeTypeLabel' as never);
    typeLabelModeBtn.addEventListener('click', () => {
      this.#nameSubMode = 'typeLabel';
      void this.render();
    });
    modeRow.appendChild(typeLabelModeBtn);
    wrap.appendChild(modeRow);

    const isTypeLabel = this.#nameSubMode === 'typeLabel';
    const entry = this.#findPattern(isTypeLabel ? this.#activeTypeLabelPatternId : this.#activeNamePatternId);
    const previewText = isTypeLabel ? this.#typeLabelPreviewText : this.#namePreviewText;

    if (previewText) {
      const preview = document.createElement('p');
      preview.className = 'bindery-studio-build-name-preview';
      const previewLabelKey = isTypeLabel ? 'BINDERY.studio.buildTypeLabelPreviewLabel' : 'BINDERY.studio.buildNamePreviewLabel';
      preview.textContent = `${game.i18n!.localize(previewLabelKey as never)}: „${previewText}”`;
      wrap.appendChild(preview);
    }

    if (entry?.pattern.kind === 'fontRoleCandidate') {
      const details = document.createElement('details');
      details.className = 'bindery-studio-advanced-details';
      const summary = document.createElement('summary');
      summary.textContent = game.i18n!.localize('BINDERY.studio.advancedSettings' as never);
      details.appendChild(summary);
      details.appendChild(this.#buildFontRoleCandidateForm(entry.pattern));
      // `nameConfidenceThreshold`/`namePlaceholder` dotycza WYLACZNIE rozwiazywania
      // nazwy (`resolveEntityNames`) — `typeLabel` uzywa `attachNearest`, bez
      // pojecia pewnosci/placeholdera (patrz `assembleStatblocks.ts`).
      if (!isTypeLabel) details.appendChild(this.#buildNameAssemblyFields());
      wrap.appendChild(details);
    }
    return wrap;
  }

  /** [Korekta] `nameConfidenceThreshold`/`namePlaceholder` nie maja zadnego naturalnego odpowiednika "klikniecia" — zostaja pod Zaawansowane zakladki Nazwa, bo tematycznie tam naleza (dawniej: osobna sekcja `entityAssembly` w Edytorze). */
  #buildNameAssemblyFields(): HTMLElement {
    const wrap = document.createElement('div');
    const draft = this.#draft!;
    wrap.appendChild(
      this.#formRow(
        game.i18n!.localize('BINDERY.studio.fieldNameConfidence' as never),
        this.#numberInput(draft.nameConfidenceThreshold, (v) => (draft.nameConfidenceThreshold = v), { min: 0, max: 1, step: 0.05 }),
      ),
    );
    wrap.appendChild(this.#formRow(game.i18n!.localize('BINDERY.studio.fieldNamePlaceholder' as never), this.#textInput(draft.namePlaceholder, (v) => (draft.namePlaceholder = v))));
    return wrap;
  }

  /** [Korekta] Jeden wiersz reguly dolaczenia (strategia/dystans/Zmierz) dla WSKAZANEGO wzorca — bez listy/dropdownu "ktory wzorzec" (dawne `#buildAttachRuleRow`), bo w nowej architekturze kazdy slot ma DOKLADNIE jedna, automatycznie utworzona regule. */
  #buildSingleAttachEditor(patternId: string): HTMLElement {
    const draft = this.#draft!;
    const wrap = document.createElement('div');
    wrap.className = 'bindery-studio-attach-rule-wrap';
    let rule = draft.attach.find((r) => r.pattern === patternId);
    if (!rule) {
      rule = { pattern: patternId, strategy: 'nearest', maxDistancePt: ProfileStudio.#DEFAULT_ATTACH_MAX_DISTANCE_PT };
      draft.attach.push(rule);
    }

    const row = document.createElement('div');
    row.className = 'bindery-studio-attach-rule-row';
    row.appendChild(
      this.#selectInput(
        rule.strategy,
        [
          { value: 'nearestBelow', label: 'nearestBelow' },
          { value: 'nearestAbove', label: 'nearestAbove' },
          { value: 'nearest', label: 'nearest' },
        ],
        (v) => (rule!.strategy = v as AttachRuleDraft['strategy']),
      ),
    );
    row.appendChild(this.#numberInput(rule.maxDistancePt, (v) => (rule!.maxDistancePt = v), { min: 0 }));
    wrap.appendChild(row);

    const anchorEntry = this.#findPattern(draft.anchor);
    const candidateEntry = this.#findPattern(patternId);
    // [KROK-29 Z3, "przy okazji"] `fontRoleCandidate` (Nazwa) wlaczone od tego
    // kroku — `measureAttachGeometry` (core) juz to obsluguje, wykluczenie
    // bylo tylko tutaj (odkrycie #3 kroku 28: regula dolaczenia dla nazwy
    // powstawala automatycznie ze STALYM, niezmierzonym `maxDistancePt`).
    const canMeasure =
      this.#pdfBuffer !== null &&
      anchorEntry?.pattern.kind === 'labelledPairs' &&
      (candidateEntry?.pattern.kind === 'labelledPairs' || candidateEntry?.pattern.kind === 'sectionList' || candidateEntry?.pattern.kind === 'fontRoleCandidate');
    if (canMeasure) wrap.appendChild(this.#buildMeasureSection(draft, rule));
    return wrap;
  }

  // ---- Panel calego dokumentu (zakladka "Sprawdz") -----------------------

  #mountDocumentPanel(doc: DocumentAnalysis | null): void {
    const container = this.element.querySelector<HTMLElement>('[data-list="studio-document"]');
    if (!container) return;
    container.innerHTML = '';

    const runBtn = document.createElement('button');
    runBtn.type = 'button';
    runBtn.className = 'bindery-btn bindery-btn--primary';
    runBtn.textContent = game.i18n!.localize('BINDERY.studio.runFullScanButton' as never);
    runBtn.disabled = !this.#pdfBuffer || !this.#draft || this.#state.isAnalyzing;
    runBtn.addEventListener('click', () => ProfileStudio.#onRunFullScan.call(this));
    container.appendChild(runBtn);

    if (this.#state.isAnalyzing) {
      const p = document.createElement('span');
      p.className = 'hint';
      p.textContent = `${game.i18n!.localize('BINDERY.studio.analyzing' as never)}${this.#state.analyzeProgress ? ` (${this.#state.analyzeProgress.done}/${this.#state.analyzeProgress.total})` : ''}`;
      container.appendChild(p);
    }
    if (this.#state.analyzeError) {
      const p = document.createElement('span');
      p.className = 'notification error';
      p.textContent = this.#state.analyzeError;
      container.appendChild(p);
    }
    if (this.#state.editorIssues) {
      const list = document.createElement('ul');
      list.className = 'bindery-actor-profile-issues';
      for (const issue of this.#state.editorIssues) {
        const li = document.createElement('li');
        li.textContent = issue;
        list.appendChild(li);
      }
      container.appendChild(list);
    }

    if (!doc) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = game.i18n!.localize('BINDERY.studio.noAnalysisYet' as never);
      container.appendChild(p);
      return;
    }

    const summary = document.createElement('p');
    summary.className = 'bindery-studio-summary-bar';
    summary.textContent = `${game.i18n!.localize('BINDERY.studio.summaryEntities' as never)}: ${doc.totalEntities} · ${game.i18n!.localize('BINDERY.studio.summaryWarnings' as never)}: ${doc.totalWarnings} · ${game.i18n!.localize('BINDERY.studio.summaryPlaceholders' as never)}: ${doc.totalPlaceholderNames}`;
    container.appendChild(summary);
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'bindery-btn bindery-btn--secondary';
    exportBtn.textContent = game.i18n!.localize('BINDERY.studio.exportButton' as never);
    exportBtn.addEventListener('click', () => ProfileStudio.#onExportDiagnostics.call(this));
    container.appendChild(exportBtn);

    const zeroPatterns = doc.patternMatchTotals.filter((p) => p.matchCount === 0);
    if (zeroPatterns.length > 0) {
      const warn = document.createElement('div');
      warn.className = 'bindery-diagnostic-row bindery-diagnostic-warning';
      warn.textContent = `${game.i18n!.localize('BINDERY.studio.zeroMatchPatterns' as never)}: ${zeroPatterns.map((p) => this.#patternDisplayName(p.patternId)).join(', ')}`;
      container.appendChild(warn);
    }

    const table = document.createElement('table');
    table.className = 'bindery-result bindery-studio-pattern-table';
    const tbody = document.createElement('tbody');
    for (const p of doc.patternMatchTotals) {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.textContent = this.#patternDisplayName(p.patternId);
      const td = document.createElement('td');
      td.textContent = String(p.matchCount);
      if (p.matchCount === 0) td.classList.add('bindery-studio-zero-count');
      // [KROK-29 Z4, O3] "549 trafien przy trzech encjach pokazane tak samo
      // neutralnie jak 3" — wzorzec `sectionList` (itemPattern) trafiajacy
      // WIELOKROTNIE czesciej niz liczba encji jest PODEJRZANY, nie skuteczny
      // (typowo zbyt luzny itemPattern lapiacy tez tresc spoza pozycji).
      // WYLACZNIE `sectionList`: `fontRoleCandidate` z zalozenia ma wielu
      // kandydatow na token (H2 kroku 12 — to WEJSCIE do parowania
      // geometrycznego, nie wynik), wysoka liczba tam jest NORMALNA, nie podejrzana.
      if (this.#isSuspiciousMatchCount(p)) {
        td.classList.add('bindery-studio-suspicious-count');
        td.title = game.i18n!.localize('BINDERY.studio.suspiciousMatchCountHint' as never);
      }
      tr.append(th, td);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    container.appendChild(table);

    container.appendChild(this.#buildMechanicalCheckSection(doc));
    container.appendChild(this.#buildDocEntityList(doc));
  }

  /**
   * [KROK-29 Z4] `draft-1`…`draft-5` -> nazwy zakladek, ktorymi je zbudowano
   * ("Cechy"/"Ataki"/...) — te same identyfikatory, ktore autor JUZ widzi na
   * kartach zakladek. Wzorzec spoza piatki slotow (nie powinien wystapic w tym
   * UI) po prostu zostaje swoim surowym id — bezpieczny brak dzialania, nie blad.
   *
   * [ZGŁOSZENIE po kroku 30] Nazwa/zawod sprawdzane OSOBNO, PRZED petla po
   * `BUILD_TABS`, WPROST po `#activeNamePatternId`/`#activeTypeLabelPatternId`
   * — `#patternIdForTab('name')` zwraca WYLACZNIE ten slot, ktory akurat jest
   * aktywnym trybem (`#nameSubMode`), wiec uzycie go tutaj mylnie nie
   * rozpoznaloby jednego z dwoch wzorcow, zaleznie od tego, ktory tryb autor
   * akurat ogladal w chwili wywolania tej funkcji.
   */
  #patternDisplayName(patternId: string): string {
    if (patternId === this.#activeNamePatternId) return game.i18n!.localize('BINDERY.studio.nameSubModeName' as never);
    if (patternId === this.#activeTypeLabelPatternId) return game.i18n!.localize('BINDERY.studio.nameSubModeTypeLabel' as never);
    for (const tab of BUILD_TABS) {
      if (tab !== 'check' && tab !== 'name' && this.#patternIdForTab(tab) === patternId) return game.i18n!.localize(ProfileStudio.#BUILD_TAB_LABEL_KEYS[tab] as never);
    }
    return patternId;
  }

  static readonly #SUSPICIOUS_MATCH_RATIO = 20;

  #isSuspiciousMatchCount(p: PatternMatchCount): boolean {
    const entry = this.#findPattern(p.patternId);
    if (entry?.pattern.kind !== 'sectionList') return false;
    if (!this.#docAnalysis || this.#docAnalysis.totalEntities === 0) return false;
    return p.matchCount > this.#docAnalysis.totalEntities * ProfileStudio.#SUSPICIOUS_MATCH_RATIO;
  }

  /** [KROK-29 Z4, O3/O4] Lista znalezionych encji CALEGO dokumentu — dla kazdej: nazwa albo placeholder, strona, kategoria (kompletna/z brakami/nienazwana), czego brakuje, przejscie do strony jednym kliknieciem. Zastepuje dawne agregaty-per-strone ("3 · 1 ostrzezenie"), z ktorych trzeba bylo samemu wywnioskowac, o KTORE trzy encje chodzi. */
  #buildDocEntityList(doc: DocumentAnalysis): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'bindery-studio-entity-list';
    for (const page of doc.pages) {
      // [KROK-39 Z1] Dawne `page.isPregen` (binarne "pomin") zastapione przez
      // `route`+`routeSupported` — strona MOZE byc pominieta z DWOCH innych
      // powodow niz dawniej (trasa `playerCharacter` bez sekcji wzorcow W TYM
      // profilu), wiec komunikat teraz nazywa WPROST, ktorej trasy dotyczy.
      if (!page.routeSupported) {
        const row = document.createElement('div');
        row.className = 'bindery-diagnostic-row';
        row.textContent = `${game.i18n!.localize('BINDERY.studio.pageLabel' as never)} ${page.page} (${this.#routeLabel(page.route)}): ${game.i18n!.localize('BINDERY.studio.routeUnsupportedSkipped' as never)}`;
        wrap.appendChild(row);
        continue;
      }
      for (const entity of page.entities) {
        wrap.appendChild(this.#buildDocEntityRow(page.page, page.route, entity));
      }
    }
    return wrap;
  }

  static readonly #ENTITY_CATEGORY_LABEL_KEYS = {
    complete: 'entityCategoryComplete',
    partial: 'entityCategoryPartial',
    unnamed: 'entityCategoryUnnamed',
  } as const;

  /** [KROK-29 Z4] Odrebne od `#buildEntityRow` (panel encji na zakladce strony, ZUPELNIE inny ksztalt wiersza) — nazwa `Doc` podkresla, ze to widok CALEGO dokumentu (zakladka "Sprawdz"), nie jednej strony. */
  #buildDocEntityRow(page: number, route: PageRoute, entity: EntityAnalysis): HTMLElement {
    // [KROK-29 Z4] Ta sama definicja "z brakami" co juz istniejace
    // `pageSummaries.warningCount`/`fullCount` (`aggregateDocumentAnalysis`,
    // `@bindery/core`) — `outOfRange`, NIE `match === null` — zeby liczby w
    // pasku podsumowania i kategorie w tej liscie NIGDY sobie nie przeczyly.
    // `match === null` BEZ `outOfRange` (wzorzec w ogole nie skonfigurowany
    // dla tego profilu — np. brak `skillsPattern`) to NIE brak, to po prostu
    // "ta czesc nie dotyczy tego profilu".
    const hasGap = Boolean(entity.derived.outOfRange || entity.attacks.outOfRange || entity.skills.outOfRange);
    const category: 'complete' | 'partial' | 'unnamed' = entity.name.kind !== 'confident' ? 'unnamed' : hasGap ? 'partial' : 'complete';

    const row = document.createElement('div');
    row.className = `bindery-diagnostic-row bindery-studio-entity-row bindery-studio-entity-row-${category}`;

    const nameText = entity.name.kind === 'confident' ? entity.name.text : entity.name.placeholder;
    // [KROK-29 Z4] Role pojeciowe (Pochodne/Ataki/Umiejetnosci), NIE literalne
    // id wzorca — `entity.derived`/`.attacks`/`.skills` sa wynikami REGUL
    // dolaczenia, nie niosa ze soba `patternId` uzytego wzorca, a id w tym
    // UI to zwykle wygenerowane "draft-N", nie nazwane klucze — `#patternDisplayName`
    // tutaj nie mialoby czego znalezc.
    const missing: BuildTab[] = [];
    if (entity.derived.match === null) missing.push('derived');
    if (entity.attacks.match === null) missing.push('attacks');
    if (entity.skills.match === null) missing.push('skills');

    const header = document.createElement('div');
    header.className = 'bindery-studio-entity-row-header';
    const nameEl = document.createElement('span');
    nameEl.textContent = nameText;
    header.appendChild(nameEl);
    const pageEl = document.createElement('span');
    pageEl.className = 'hint';
    pageEl.textContent = `${game.i18n!.localize('BINDERY.studio.pageLabel' as never)} ${page}`;
    header.appendChild(pageEl);
    // [KROK-39 Z2] Znacznik trasy — "Sprawdz" miesza encje OBU tras w
    // jednej liscie (auto-routowane per strona), wiec kazdy wiersz musi
    // WPROST nazywac, ktorej trasy dotyczy (brief: "Podgląd i Sprawdź muszą
    // pokazywać, której trasy dotyczą").
    const routeEl = document.createElement('span');
    routeEl.className = `bindery-studio-route-tag bindery-studio-route-tag-${route}`;
    routeEl.textContent = this.#routeLabel(route);
    header.appendChild(routeEl);
    const categoryEl = document.createElement('span');
    categoryEl.className = `bindery-studio-entity-category bindery-studio-entity-category-${category}`;
    categoryEl.textContent = game.i18n!.localize(`BINDERY.studio.${ProfileStudio.#ENTITY_CATEGORY_LABEL_KEYS[category]}` as never);
    header.appendChild(categoryEl);
    row.appendChild(header);

    if (missing.length > 0) {
      const missingEl = document.createElement('p');
      missingEl.className = 'hint';
      missingEl.textContent = `${game.i18n!.localize('BINDERY.studio.entityMissingLabel' as never)}: ${missing.map((tab) => game.i18n!.localize(ProfileStudio.#BUILD_TAB_LABEL_KEYS[tab] as never)).join(', ')}`;
      row.appendChild(missingEl);
    }

    row.addEventListener('click', () => {
      this.#state.currentPageNumber = page;
      this.#state.buildTab = 'grid';
      // [KROK-39 Z2] Przelacz na trase TEJ encji — bez tego skok z listy
      // calego dokumentu na strone innej trasy niz akurat edytowana od razu
      // pokazywalby komunikat "trasa niezgodna" (`#mountEntityPanel`) zamiast
      // encji, ktora autor WLASNIE kliknal.
      this.#switchRoute(route);
      void this.render();
    });
    return row;
  }

  // ---- [KROK-24 Z3] Weryfikacja mapowan mechanika ------------------------

  #buildMechanicalCheckSection(doc: DocumentAnalysis): HTMLElement {
    const section = document.createElement('div');
    section.className = 'bindery-studio-mechanical-section';
    const h = document.createElement('h3');
    h.textContent = game.i18n!.localize('BINDERY.studio.mechanicalSectionTitle' as never);
    section.appendChild(h);
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = game.i18n!.localize('BINDERY.studio.mechanicalHint' as never);
    section.appendChild(hint);

    const rowsWrap = document.createElement('div');
    rowsWrap.className = 'bindery-studio-relation-rows';
    this.#mechanicalRelations.forEach((text, i) => {
      const row = document.createElement('div');
      row.className = 'bindery-studio-relation-row';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'bindery-input';
      input.value = text;
      input.placeholder = game.i18n!.localize('BINDERY.studio.relationPlaceholder' as never);
      input.addEventListener('change', () => (this.#mechanicalRelations[i] = input.value));
      row.appendChild(input);
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'bindery-btn bindery-btn--icon';
      delBtn.textContent = '×';
      delBtn.addEventListener('click', () => {
        this.#mechanicalRelations.splice(i, 1);
        if (this.#mechanicalRelations.length === 0) this.#mechanicalRelations.push('');
        this.#mechanicalResults = null;
        void this.render();
      });
      row.appendChild(delBtn);
      rowsWrap.appendChild(row);
    });
    section.appendChild(rowsWrap);

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'bindery-btn bindery-btn--secondary';
    addBtn.textContent = game.i18n!.localize('BINDERY.studio.addRelationButton' as never);
    addBtn.addEventListener('click', () => {
      this.#mechanicalRelations.push('');
      void this.render();
    });
    section.appendChild(addBtn);

    const checkBtn = document.createElement('button');
    checkBtn.type = 'button';
    checkBtn.className = 'bindery-btn bindery-btn--primary';
    checkBtn.textContent = game.i18n!.localize('BINDERY.studio.checkRelationsButton' as never);
    checkBtn.addEventListener('click', () => void this.#runMechanicalCheck(doc));
    section.appendChild(checkBtn);

    if (this.#mechanicalResults) section.appendChild(this.#buildMechanicalResults(this.#mechanicalResults));

    return section;
  }

  async #runMechanicalCheck(doc: DocumentAnalysis): Promise<void> {
    const texts = this.#mechanicalRelations.filter((t) => t.trim().length > 0);
    if (texts.length === 0) {
      this.#mechanicalResults = null;
      await this.render();
      return;
    }
    const { extractCanonicalValues, checkRelations } = await import('@bindery/core');
    const entities = doc.pages.flatMap((p) => p.entities).map((e) => extractCanonicalValues(e));
    this.#mechanicalResults = checkRelations(texts, entities);
    await this.render();
  }

  #buildMechanicalResults(results: readonly RelationCheckResult[]): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'bindery-studio-relation-results';
    for (const r of results) {
      const row = document.createElement('div');
      row.className = 'bindery-diagnostic-row';
      if (!r.ok) {
        row.classList.add('bindery-diagnostic-error');
        row.textContent = `${r.text}: ${game.i18n!.localize('BINDERY.studio.relationErrorUnparseable' as never)}`;
        wrap.appendChild(row);
        continue;
      }
      if (r.warning) row.classList.add('bindery-diagnostic-warning');
      const warningText =
        r.warning === 'low-match-rate'
          ? ` ⚠ ${game.i18n!.localize('BINDERY.studio.relationWarningLowMatch' as never)}`
          : r.warning === 'suspiciously-perfect-equality'
            ? ` ⚠ ${game.i18n!.localize('BINDERY.studio.relationWarningPerfect' as never)}`
            : '';
      row.textContent = `${r.text}: ${r.matchCount}/${r.totalChecked}${warningText}`;
      wrap.appendChild(row);
      if (r.mismatches.length > 0) {
        const list = document.createElement('ul');
        list.className = 'bindery-studio-relation-mismatches';
        for (const m of r.mismatches) {
          const li = document.createElement('li');
          li.textContent = `${m.label}: ${r.lhsKey}=${m.actual}, ${game.i18n!.localize('BINDERY.studio.relationExpected' as never)} ${r.op}${m.expected}`;
          list.appendChild(li);
        }
        wrap.appendChild(list);
      }
    }
    return wrap;
  }

  async #populateCanonicalKeyDatalist(): Promise<void> {
    let datalist = this.element.querySelector<HTMLDataListElement>('#bindery-canonical-keys');
    if (!datalist) {
      datalist = document.createElement('datalist');
      datalist.id = 'bindery-canonical-keys';
      this.element.appendChild(datalist);
    }
    if (datalist.childElementCount > 0) return;
    const { CANONICAL_STAT_KEYS } = await import('@bindery/core');
    for (const key of CANONICAL_STAT_KEYS) {
      const opt = document.createElement('option');
      opt.value = key;
      datalist.appendChild(opt);
    }
  }

  // ---- Elementy formularza — male pomocnicze budowniczowie ----------------

  #formRow(labelText: string, input: HTMLElement): HTMLElement {
    const row = document.createElement('label');
    row.className = 'bindery-studio-form-row';
    const span = document.createElement('span');
    span.textContent = labelText;
    row.append(span, input);
    return row;
  }

  #textInput(value: string, onChange: (v: string) => void, placeholder?: string): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'bindery-input';
    input.value = value;
    if (placeholder) input.placeholder = placeholder;
    input.addEventListener('change', () => onChange(input.value));
    return input;
  }

  /**
   * [KROK-29 Z2, O2/O2-ciag dalszy] Wspolna budowa pola regexowego (input albo
   * textarea) — walidacja SKLADNI na biezaco (`input`), zapis do szkicu
   * dopiero na `change` (utrata fokusu/Enter). Przestaje "milczec": bledny
   * regex dostaje CZYTELNY komunikat POD polem (nie tylko czerwona ramka —
   * autor nie ma konsoli DevTools), a `\\d` (zapis skopiowany z pliku JSON,
   * gdzie kazdy ukosnik jest podwojony) dostaje wprost podpowiedz z
   * przyciskiem naprawy, zamiast ciche `Nothing to repeat` gdzies indziej.
   * Zwraca `{ el, input }` zamiast SAMEGO pola — `el` (input + komunikaty)
   * idzie do `#formRow`, `input` zostaje do przypadkow, gdzie wywolujacy
   * musi ustawic wartosc programowo (przycisk 📍).
   */
  #buildRegexField(value: string, onChange: (v: string) => void, opts: { multiline: boolean }): { el: HTMLElement; input: HTMLInputElement | HTMLTextAreaElement } {
    const wrap = document.createElement('div');
    wrap.className = 'bindery-studio-regex-field';
    const input = opts.multiline ? document.createElement('textarea') : document.createElement('input');
    if (input instanceof HTMLInputElement) input.type = 'text';
    else input.rows = 3;
    input.className = 'bindery-input bindery-studio-regex-input';
    input.value = value;

    const errorEl = document.createElement('p');
    errorEl.className = 'notification error bindery-studio-regex-error';
    errorEl.hidden = true;

    const jsonHint = document.createElement('p');
    jsonHint.className = 'hint bindery-studio-regex-json-hint';
    jsonHint.hidden = true;
    const jsonHintText = document.createElement('span');
    jsonHintText.textContent = game.i18n!.localize('BINDERY.studio.regexJsonHint' as never);
    const fixBtn = document.createElement('button');
    fixBtn.type = 'button';
    fixBtn.className = 'bindery-btn bindery-btn--secondary';
    fixBtn.textContent = game.i18n!.localize('BINDERY.studio.regexJsonFixButton' as never);
    jsonHint.append(jsonHintText, fixBtn);

    const validate = (): void => {
      const raw = input.value;
      if (!raw) {
        input.classList.remove('bindery-studio-regex-invalid');
        errorEl.hidden = true;
        jsonHint.hidden = true;
        return;
      }
      try {
        new RegExp(raw, opts.multiline ? 'gu' : 'u');
        input.classList.remove('bindery-studio-regex-invalid');
        errorEl.hidden = true;
      } catch (err) {
        input.classList.add('bindery-studio-regex-invalid');
        errorEl.hidden = false;
        errorEl.textContent = err instanceof Error ? err.message : String(err);
      }
      jsonHint.hidden = !/\\\\/.test(raw);
    };
    fixBtn.addEventListener('click', () => {
      input.value = input.value.replace(/\\\\/g, '\\');
      onChange(input.value);
      validate();
    });
    validate();
    input.addEventListener('input', validate);
    input.addEventListener('change', () => onChange(input.value));

    wrap.append(input, errorEl, jsonHint);
    return { el: wrap, input };
  }

  #regexInput(value: string, onChange: (v: string) => void): { el: HTMLElement; input: HTMLInputElement } {
    return this.#buildRegexField(value, onChange, { multiline: false }) as { el: HTMLElement; input: HTMLInputElement };
  }

  #regexTextarea(value: string, onChange: (v: string) => void): { el: HTMLElement; input: HTMLTextAreaElement } {
    return this.#buildRegexField(value, onChange, { multiline: true }) as { el: HTMLElement; input: HTMLTextAreaElement };
  }

  #numberInput(value: number, onChange: (v: number) => void, opts?: { min?: number; max?: number; step?: number }): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'bindery-input bindery-input--narrow';
    input.value = String(value);
    if (opts?.min !== undefined) input.min = String(opts.min);
    if (opts?.max !== undefined) input.max = String(opts.max);
    if (opts?.step !== undefined) input.step = String(opts.step);
    input.addEventListener('change', () => {
      const n = Number(input.value);
      if (!Number.isNaN(n)) onChange(n);
    });
    return input;
  }

  #checkboxInput(checked: boolean, onChange: (v: boolean) => void, labelText: string): HTMLElement {
    const wrapper = document.createElement('label');
    wrapper.className = 'bindery-studio-checkbox-row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'bindery-check';
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    const span = document.createElement('span');
    span.textContent = labelText;
    wrapper.append(input, span);
    return wrapper;
  }

  #selectInput(value: string, options: { value: string; label: string }[], onChange: (v: string) => void): HTMLSelectElement {
    const select = document.createElement('select');
    select.className = 'bindery-select';
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === value) o.selected = true;
      select.appendChild(o);
    }
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }

  // ---- [Korekta] Nagłówek trwały: metadane i zakres stron ----------------

  /** [Korekta] "Zakres stron i metadane nie zasługują na własną zakładkę — idą do zwijanego nagłówka nad zakładkami." Dosłownie reużyty formularz metadanych sprzed korekty. */
  #mountMetadataHeader(): void {
    const container = this.element.querySelector<HTMLElement>('[data-metadata-header]');
    if (!container || !this.#draft) return;
    container.innerHTML = '';
    container.appendChild(this.#buildMetadataSection());
  }

  /** [zgloszenie uzytkownika] Ten sam formularz co `#mountMetadataHeader` (`#buildMetadataSection` — jedno zrodlo prawdy dla pol/walidacji), zamontowany w kontenerze ekranu metadanych zamiast zwijanego naglowka ekranu budowania. */
  #mountMetadataScreen(): void {
    const container = this.element.querySelector<HTMLElement>('[data-metadata-screen]');
    if (!container || !this.#draft) return;
    container.innerHTML = '';
    container.appendChild(this.#buildMetadataSection());
  }

  #buildMetadataSection(): HTMLElement {
    const draft = this.#draft!;
    const section = document.createElement('div');

    section.appendChild(this.#formRow('id', this.#textInput(draft.id, (v) => (draft.id = v))));
    section.appendChild(this.#formRow(game.i18n!.localize('BINDERY.studio.fieldTitle' as never), this.#textInput(draft.title, (v) => (draft.title = v))));
    section.appendChild(this.#formRow('gameLine', this.#textInput(draft.gameLine, (v) => (draft.gameLine = v))));
    section.appendChild(this.#formRow('language', this.#textInput(draft.language, (v) => (draft.language = v))));
    section.appendChild(this.#formRow('publication', this.#textInput(draft.publication, (v) => (draft.publication = v))));
    section.appendChild(this.#formRow(game.i18n!.localize('BINDERY.studio.fieldAuthor' as never), this.#textInput(draft.author ?? '', (v) => (draft.author = v || undefined))));
    section.appendChild(
      this.#formRow(game.i18n!.localize('BINDERY.studio.fieldMinScore' as never), this.#numberInput(draft.fingerprintMinScore, (v) => (draft.fingerprintMinScore = v), { min: 0, max: 1, step: 0.05 })),
    );

    // [KROK-37 Z3, odkrycie kroku 36] Checkboxy `provides` (Actors/Scenes/
    // Images/Journals) CELOWO ukryte — pole istnieje w schemacie i jest
    // nadal zapisywane do pliku (`draftToProfileInput`, `draft.provides`
    // ponizej CELOWO nietkniete: domyslnie `['actors']` z
    // `createEmptyProfileDraft`, albo wartosc wczytana z pliku dla
    // istniejacych profili), ale nie jest podlaczone do ZADNEJ sciezki
    // importu — `resolve()`/`buildCompatibilityBanner` (§6.8, `@bindery/core`)
    // istnieja i sa przetestowane, lecz nigdzie w `packages/module` nie sa
    // wolane. Checkbox, ktory nic nie robi, uczy autora, ze interfejs klamie
    // — odznaczy "Scenes", zobaczy, ze sceny i tak powstaja, i przestanie
    // ufac pozostalym ustawieniom. Przywroc formularz (byl tu: span+row
    // czterech checkboxow nad `draft.provides`), gdy `resolve()` zostanie
    // faktycznie podlaczone w ekranie przegladu — osobny, wiekszy zakres
    // (baner niezgodnosci §6.5, cztery warianty `reason`), NIE robic tego
    // przy okazji tego kroku.

    section.appendChild(
      this.#checkboxInput(
        draft.treatFullBleedAsContent,
        (v) => (draft.treatFullBleedAsContent = v),
        game.i18n!.localize('BINDERY.studio.fieldTreatFullBleedAsContent' as never),
      ),
    );
    const treatFullBleedHint = document.createElement('p');
    treatFullBleedHint.className = 'hint';
    treatFullBleedHint.textContent = game.i18n!.localize('BINDERY.studio.fieldTreatFullBleedAsContentHint' as never);
    section.appendChild(treatFullBleedHint);

    section.appendChild(
      this.#checkboxInput(
        draft.autoCropUniformMargins,
        (v) => (draft.autoCropUniformMargins = v),
        game.i18n!.localize('BINDERY.studio.fieldAutoCropUniformMargins' as never),
      ),
    );
    const autoCropHint = document.createElement('p');
    autoCropHint.className = 'hint';
    autoCropHint.textContent = game.i18n!.localize('BINDERY.studio.fieldAutoCropUniformMarginsHint' as never);
    section.appendChild(autoCropHint);

    section.appendChild(
      this.#checkboxInput(
        draft.brightenAutoCroppedImages,
        (v) => (draft.brightenAutoCroppedImages = v),
        game.i18n!.localize('BINDERY.studio.fieldBrightenAutoCroppedImages' as never),
      ),
    );
    const brightenHint = document.createElement('p');
    brightenHint.className = 'hint';
    brightenHint.textContent = game.i18n!.localize('BINDERY.studio.fieldBrightenAutoCroppedImagesHint' as never);
    section.appendChild(brightenHint);

    section.appendChild(
      this.#checkboxInput(
        draft.removeTokenBackgroundDefault,
        (v) => (draft.removeTokenBackgroundDefault = v),
        game.i18n!.localize('BINDERY.studio.fieldRemoveTokenBackgroundDefault' as never),
      ),
    );
    const removeTokenBgHint = document.createElement('p');
    removeTokenBgHint.className = 'hint';
    removeTokenBgHint.textContent = game.i18n!.localize('BINDERY.studio.fieldRemoveTokenBackgroundDefaultHint' as never);
    section.appendChild(removeTokenBgHint);

    const rangesWrap = document.createElement('div');
    rangesWrap.className = 'bindery-studio-page-ranges';
    const rangesLabel = document.createElement('span');
    rangesLabel.textContent = game.i18n!.localize('BINDERY.studio.fieldPageRanges' as never);
    rangesWrap.appendChild(rangesLabel);
    draft.pageRanges.forEach((range, i) => {
      const row = document.createElement('div');
      row.className = 'bindery-studio-page-range-row';
      // [KROK-28 Z5, "Nigdy -1 w interfejsie"] Wewnetrznie `-1` znaczy "do
      // konca dokumentu" — w formularzu to po prostu PUSTE pole "do".
      const fromInput = this.#numberInput(range[0], (v) => (draft.pageRanges[i]![0] = Math.max(1, Math.trunc(v))), { min: 1 });
      row.appendChild(this.#formRow(game.i18n!.localize('BINDERY.studio.pageRangeFrom' as never), fromInput));
      const toInput = document.createElement('input');
      toInput.type = 'number';
      toInput.className = 'bindery-input bindery-input--narrow';
      toInput.min = '1';
      toInput.placeholder = game.i18n!.localize('BINDERY.studio.pageRangeToLast' as never);
      toInput.value = range[1] === -1 ? '' : String(range[1]);
      toInput.addEventListener('change', () => {
        const trimmed = toInput.value.trim();
        draft.pageRanges[i]![1] = trimmed === '' ? -1 : Math.max(1, Math.trunc(Number(trimmed)));
      });
      row.appendChild(this.#formRow(game.i18n!.localize('BINDERY.studio.pageRangeTo' as never), toInput));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'bindery-btn bindery-btn--icon';
      del.textContent = '×';
      del.addEventListener('click', () => {
        draft.pageRanges.splice(i, 1);
        void this.render();
      });
      row.appendChild(del);
      rangesWrap.appendChild(row);
    });
    const addRange = document.createElement('button');
    addRange.type = 'button';
    addRange.className = 'bindery-btn bindery-btn--secondary';
    addRange.textContent = game.i18n!.localize('BINDERY.studio.addPageRangeButton' as never);
    addRange.addEventListener('click', () => {
      draft.pageRanges.push([1, -1]);
      void this.render();
    });
    rangesWrap.appendChild(addRange);
    section.appendChild(rangesWrap);

    return section;
  }

  #buildLabelledPairsForm(p: Extract<PatternDraft, { kind: 'labelledPairs' }>, patternId: string): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'bindery-studio-pattern-form';

    wrap.appendChild(this.#formRow('valuePattern', this.#regexInput(p.valuePattern, (v) => (p.valuePattern = v)).el));
    wrap.appendChild(this.#formRow('minPairs', this.#numberInput(p.minPairs, (v) => (p.minPairs = Math.max(1, Math.trunc(v))), { min: 1 })));
    wrap.appendChild(this.#formRow('maxPairs', this.#numberInput(p.maxPairs ?? 12, (v) => (p.maxPairs = Math.trunc(v)), { min: 1 })));
    wrap.appendChild(this.#checkboxInput(p.onRepeatedLabel, (v) => (p.onRepeatedLabel = v), game.i18n!.localize('BINDERY.studio.fieldOnRepeatedLabel' as never)));
    wrap.appendChild(this.#checkboxInput(p.allowTrailingWords, (v) => (p.allowTrailingWords = v), game.i18n!.localize('BINDERY.studio.fieldAllowTrailingWords' as never)));
    wrap.appendChild(this.#formRow('trailingWordsStopBefore', this.#regexInput(p.trailingWordsStopBefore ?? '', (v) => (p.trailingWordsStopBefore = v || undefined)).el));
    // [KROK-37 Z2] `trailingWordsStopBefore` jest wpisywane recznie (brak
    // klikniecia na PDF-ie, wiec brak znanej "strony kalibracji"), ale to
    // WCIAZ literalny token wzieciony z materialu — ta sama kontrola co
    // `sectionHeader`/`terminateSectionBefore`, dziala tu identycznie, bo
    // `#checkLiteralGenericity` liczy TRAFIENIA W CALYM dokumencie, nie
    // wymaga znajomosci, ktora strona byla wzorcem.
    if (p.trailingWordsStopBefore) {
      const trailingWarn = document.createElement('p');
      trailingWarn.className = 'notification error';
      trailingWarn.hidden = true;
      wrap.appendChild(trailingWarn);
      void this.#checkLiteralGenericity(`trailingWordsStopBefore:${patternId}`, p.trailingWordsStopBefore, trailingWarn, 'BINDERY.studio.buildValueTooSpecific', () => p.trailingWordsStopBefore);
    }

    const labelsWrap = document.createElement('div');
    labelsWrap.className = 'bindery-studio-labels-list';
    const labelsHeader = document.createElement('span');
    labelsHeader.textContent = game.i18n!.localize('BINDERY.studio.fieldLabels' as never);
    labelsWrap.appendChild(labelsHeader);
    p.labels.forEach((entry, i) => labelsWrap.appendChild(this.#buildLabelRow(p, entry, i)));
    const addLabelBtn = document.createElement('button');
    addLabelBtn.type = 'button';
    addLabelBtn.className = 'bindery-btn bindery-btn--secondary';
    addLabelBtn.textContent = game.i18n!.localize('BINDERY.studio.addLabelButton' as never);
    addLabelBtn.addEventListener('click', () => {
      p.labels.push({ label: '', canonicalKey: '' });
      void this.render();
    });
    labelsWrap.appendChild(addLabelBtn);
    wrap.appendChild(labelsWrap);

    return wrap;
  }

  #buildLabelRow(p: Extract<PatternDraft, { kind: 'labelledPairs' }>, entry: LabelEntryDraft, index: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'bindery-studio-label-row';

    const labelInput = this.#textInput(entry.label, (v) => {
      entry.label = v;
    });
    labelInput.placeholder = game.i18n!.localize('BINDERY.studio.labelPlaceholder' as never);
    row.appendChild(labelInput);

    const pickBtn = document.createElement('button');
    pickBtn.type = 'button';
    pickBtn.className = 'bindery-btn bindery-btn--ghost bindery-studio-pick-btn';
    pickBtn.textContent = '📍';
    pickBtn.dataset['tooltip'] = game.i18n!.localize('BINDERY.studio.pickTokenButton' as never);
    pickBtn.addEventListener('click', () => {
      this.#pickTarget = {
        description: game.i18n!.localize('BINDERY.studio.pickLabelHint' as never),
        // [zgloszenie uzytkownika, "dodaje sie pole ale bez nazwy... pole
        // pancerz jest puste"] Ten pin (formularz "Zaawansowane") ustawial
        // WYLACZNIE `entry.label`, NIGDY `entry.canonicalKey` — w
        // odroznieniu od domyslnego trybu budowania (`#onBuildTokenClick`
        // -> `#addOrUpdateGridPair`), ktory od razu proponuje klucz. Autor
        // widzial poprawnie wypelniona etykiete ("Pancerz:"), ale PUSTY
        // klucz kanoniczny — bez klucza silnik nigdy nie zapisuje wartosci
        // do zadnego pola na karcie, wiec pancerz zostawal pusty mimo
        // poprawnie dodanej etykiety. Ten sam mechanizm podpowiedzi co tam,
        // TYLKO gdy klucz jest jeszcze pusty (nie nadpisuje recznego wyboru
        // autora).
        apply: (text) => {
          entry.label = text;
          labelInput.value = text;
          if (!entry.canonicalKey) {
            void this.#suggestCanonicalKey(text).then((key) => {
              if (key && !entry.canonicalKey) {
                entry.canonicalKey = key;
                keyInput.value = key;
              }
            });
          }
        },
      };
      void this.render();
    });
    row.appendChild(pickBtn);

    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.className = 'bindery-input';
    keyInput.value = entry.canonicalKey;
    keyInput.setAttribute('list', 'bindery-canonical-keys');
    keyInput.placeholder = game.i18n!.localize('BINDERY.studio.canonicalKeyPlaceholder' as never);
    keyInput.addEventListener('change', () => {
      entry.canonicalKey = keyInput.value;
    });
    row.appendChild(keyInput);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'bindery-btn bindery-btn--icon';
    delBtn.textContent = '×';
    delBtn.addEventListener('click', () => {
      p.labels.splice(index, 1);
      void this.render();
    });
    row.appendChild(delBtn);

    return row;
  }

  #buildSectionListForm(p: Extract<PatternDraft, { kind: 'sectionList' }>): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'bindery-studio-pattern-form';

    const headerRow = document.createElement('div');
    headerRow.className = 'bindery-studio-label-row';
    const headerField = this.#regexInput(p.sectionHeader, (v) => (p.sectionHeader = v));
    headerRow.appendChild(this.#formRow('sectionHeader', headerField.el));
    const pickBtn = document.createElement('button');
    pickBtn.type = 'button';
    pickBtn.className = 'bindery-btn bindery-btn--ghost bindery-studio-pick-btn';
    pickBtn.textContent = '📍';
    pickBtn.dataset['tooltip'] = game.i18n!.localize('BINDERY.studio.pickTokenButton' as never);
    pickBtn.addEventListener('click', () => {
      this.#pickTarget = {
        description: game.i18n!.localize('BINDERY.studio.pickSectionHeaderHint' as never),
        apply: (text) => {
          const escaped = escapeSectionBoundaryLiteral(text);
          p.sectionHeader = escaped;
          headerField.input.value = escaped;
        },
      };
      void this.render();
    });
    headerRow.appendChild(pickBtn);
    wrap.appendChild(headerRow);

    wrap.appendChild(this.#formRow('itemPattern', this.#buildItemPatternField(p)));
    wrap.appendChild(this.#checkboxInput(p.rejoinHyphenated, (v) => (p.rejoinHyphenated = v), game.i18n!.localize('BINDERY.studio.fieldRejoinHyphenated' as never)));
    wrap.appendChild(this.#formRow('skipAfterHeader', this.#regexInput(p.skipAfterHeader ?? '', (v) => (p.skipAfterHeader = v || undefined)).el));
    wrap.appendChild(this.#formRow('terminateSectionBefore', this.#regexInput(p.terminateSectionBefore ?? '', (v) => (p.terminateSectionBefore = v || undefined)).el));

    const rangedRow = document.createElement('div');
    rangedRow.className = 'bindery-studio-label-row';
    rangedRow.appendChild(
      this.#formRow(
        'rangedKeywords',
        this.#textInput(p.rangedKeywords.join(','), (v) => (p.rangedKeywords = v.split(',').map((s) => s.trim()).filter(Boolean))),
      ),
    );
    const rangedPickBtn = document.createElement('button');
    rangedPickBtn.type = 'button';
    rangedPickBtn.className = 'bindery-btn bindery-btn--ghost bindery-studio-pick-btn';
    rangedPickBtn.textContent = '📍';
    rangedPickBtn.dataset['tooltip'] = game.i18n!.localize('BINDERY.studio.pickTokenButton' as never);
    rangedPickBtn.addEventListener('click', () => {
      this.#pickTarget = {
        description: game.i18n!.localize('BINDERY.studio.pickRangedExampleHint' as never),
        apply: (text) => {
          const keyword = this.#extractRangedKeyword(p, text);
          if (!keyword) {
            ui.notifications?.warn(game.i18n!.localize('BINDERY.studio.rangedKeywordEmpty' as never));
            return;
          }
          if (!p.rangedKeywords.some((k) => k.toLowerCase() === keyword.toLowerCase())) p.rangedKeywords = [...p.rangedKeywords, keyword];
        },
      };
      void this.render();
    });
    rangedRow.appendChild(rangedPickBtn);
    wrap.appendChild(rangedRow);

    return wrap;
  }

  /**
   * [KROK-40 Z2, na prosbe uzytkownika po naprawie "pistolet trafia do
   * melee"] Klikniecie przykladowej broni dystansowej (📍 przy
   * `rangedKeywords`) -> slowo kluczowe do zapisania w profilu, zamiast
   * recznego wpisywania. `text` to CALY klikniety token (`PickTarget.apply`
   * dostaje wylacznie tekst, bez `collectRowText`/indeksu tokenu — ta sama
   * granica co pozostale przyciski 📍 w tym pliku, patrz `pickSectionHeaderHint`
   * powyzej) — w tej ksiazce (i zwykle w tego typu ukladach, patrz komentarz
   * przy `PICKABLE_MAX_LENGTH`/`isAttacksOrSkillsTab` w `#mountPickableTokens`)
   * to i tak CALA pozycja ataku w jednym tokenie pdf.js. Jesli `itemPattern`
   * juz cos rozpoznaje, wyciaga z niego SAMA grupe `name` (dokladnie tak samo,
   * jak zrobilby to prawdziwy import) zamiast calego wiersza z procentem i
   * obrazeniami; potem odcina nawiasowy dopisek kalibru/podtypu ("Broń Palna
   * (pistolet .22)" -> "Broń Palna"), zeby slowo kluczowe pasowalo do KAZDEJ
   * broni tej kategorii, nie tylko do kliknietego przykladu.
   */
  #extractRangedKeyword(pattern: Extract<PatternDraft, { kind: 'sectionList' }>, text: string): string {
    let keyword = text.trim();
    if (pattern.itemPattern) {
      try {
        const m = new RegExp(pattern.itemPattern, 'u').exec(keyword);
        if (m?.groups?.['name']) keyword = m.groups['name'];
      } catch {
        // itemPattern jeszcze niepoprawny (w trakcie edycji) -- uzyj calego klikniecia jak jest, ponizej.
      }
    }
    return keyword
      .replace(/\([^()]*\)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** [KROK-29 Z2] `itemPattern` z podgladem liczby trafien w sekcji na BIEZACO OGLADANEJ stronie — jedyne pole, ktore autor musi umiec przeczytac samodzielnie (Z1), wiec dostaje najwiecej natychmiastowej informacji zwrotnej. */
  #buildItemPatternField(p: Extract<PatternDraft, { kind: 'sectionList' }>): HTMLElement {
    const field = this.#regexTextarea(p.itemPattern, (v) => (p.itemPattern = v));
    const countEl = document.createElement('p');
    countEl.className = 'hint bindery-studio-itempattern-count';
    field.el.appendChild(countEl);
    const recount = (): void => void this.#updateItemPatternMatchCount(field.input.value, p, countEl);
    recount();
    field.input.addEventListener('input', recount);
    return field.el;
  }

  /** Liczy trafienia `candidateItemPattern` (WARTOSC Z POLA, jeszcze niezapisana do szkicu) w sekcji `p` na biezaco ogladanej stronie — `matchSectionList` z `@bindery/core`, ta sama funkcja co prawdziwy przebieg, zeby liczba byla PRAWDZIWA, nie przyblizona. */
  async #updateItemPatternMatchCount(candidateItemPattern: string, p: Extract<PatternDraft, { kind: 'sectionList' }>, countEl: HTMLElement): Promise<void> {
    if (!candidateItemPattern || !p.sectionHeader) {
      countEl.textContent = '';
      return;
    }
    try {
      new RegExp(candidateItemPattern, 'gu');
    } catch {
      countEl.textContent = '';
      return;
    }
    const tokens = await this.#getBuildTokens(this.#state.currentPageNumber);
    const { matchSectionList } = await import('@bindery/core');
    try {
      const tempPattern = {
        kind: 'sectionList' as const,
        sectionHeader: p.sectionHeader,
        itemPattern: candidateItemPattern,
        rejoinHyphenated: p.rejoinHyphenated,
        skipAfterHeader: p.skipAfterHeader,
        terminateSectionBefore: p.terminateSectionBefore,
        rangedKeywords: p.rangedKeywords,
      };
      const matches = matchSectionList(tokens, tempPattern);
      const count = matches.reduce((sum, m) => sum + m.items.length, 0);
      countEl.textContent = `${game.i18n!.localize('BINDERY.studio.itemPatternMatchCount' as never)}: ${count}`;
    } catch {
      countEl.textContent = '';
    }
  }

  #buildFontRoleCandidateForm(p: Extract<PatternDraft, { kind: 'fontRoleCandidate' }>): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'bindery-studio-pattern-form';
    wrap.appendChild(
      this.#formRow(
        'excludeRoles',
        this.#textInput(p.excludeRoles.join(','), (v) => (p.excludeRoles = v.split(',').map((s) => s.trim()).filter(Boolean))),
      ),
    );
    wrap.appendChild(this.#formRow('maxLength', this.#numberInput(p.maxLength, (v) => (p.maxLength = Math.max(1, Math.trunc(v))), { min: 1 })));
    wrap.appendChild(this.#checkboxInput(p.excludeRepeatedAcrossPages, (v) => (p.excludeRepeatedAcrossPages = v), game.i18n!.localize('BINDERY.studio.fieldExcludeRepeated' as never)));
    wrap.appendChild(this.#checkboxInput(p.excludeHyphenContinuations, (v) => (p.excludeHyphenContinuations = v), game.i18n!.localize('BINDERY.studio.fieldExcludeHyphen' as never)));
    wrap.appendChild(this.#buildRequireFontKeysList(p));
    return wrap;
  }

  /** [KROK-29 Z3] Lista kluczy fontu wyuczonych klikniecim (zakladka "Nazwa") — edytowalna i usuwalna, jak kazde inne pole "Zaawansowane". Puste = brak wpisow, zero zmiany w opisie pola (DoD: "pole opcjonalne"). */
  #buildRequireFontKeysList(p: Extract<PatternDraft, { kind: 'fontRoleCandidate' }>): HTMLElement {
    const section = document.createElement('div');
    section.className = 'bindery-studio-build-section';
    const label = document.createElement('p');
    label.className = 'hint';
    label.textContent = 'requireFontKeys';
    section.appendChild(label);
    p.requireFontKeys.forEach((key, index) => {
      const row = document.createElement('div');
      row.className = 'bindery-studio-build-pair-row';
      const keyInput = document.createElement('input');
      keyInput.type = 'text';
      keyInput.className = 'bindery-input bindery-studio-regex-input';
      keyInput.value = key;
      keyInput.addEventListener('change', () => (p.requireFontKeys[index] = keyInput.value));
      row.appendChild(keyInput);
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'bindery-btn bindery-btn--icon';
      delBtn.textContent = '×';
      delBtn.addEventListener('click', () => {
        p.requireFontKeys = p.requireFontKeys.filter((_, i) => i !== index);
        this.#refreshBuildPanel();
      });
      row.appendChild(delBtn);
      section.appendChild(row);
    });
    return section;
  }

  #renderMeasurementResult(box: HTMLElement, rule: AttachRuleDraft): void {
    box.innerHTML = '';
    const state = this.#measurements.get(rule);
    if (!state) return;
    if (state.state === 'measuring') {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = game.i18n!.localize('BINDERY.studio.measuring' as never);
      box.appendChild(p);
      return;
    }
    if (state.state === 'error') {
      const p = document.createElement('p');
      p.className = 'notification error';
      p.textContent = state.message;
      box.appendChild(p);
      return;
    }
    const r = state.result;
    if (r.measuredPairCount === 0) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = `${game.i18n!.localize('BINDERY.studio.measureNoData' as never)} (${r.pagesWithBoth} ${game.i18n!.localize('BINDERY.studio.pages' as never)})`;
      box.appendChild(p);
      return;
    }
    const summary = document.createElement('p');
    summary.className = 'bindery-studio-measure-summary';
    summary.textContent = `${r.pagesWithBoth} ${game.i18n!.localize('BINDERY.studio.pages' as never)} · ${r.measuredPairCount} par · ${game.i18n!.localize('BINDERY.studio.measureBelow' as never)} ${r.belowCount} / ${game.i18n!.localize('BINDERY.studio.measureAbove' as never)} ${r.aboveCount} / ${game.i18n!.localize('BINDERY.studio.measureBeside' as never)} ${r.besideCount}`;
    box.appendChild(summary);

    const min = r.distances[0]!;
    const max = r.distances.at(-1)!;
    const median = r.distances[Math.floor(r.distances.length / 2)]!;
    const distText = document.createElement('p');
    distText.className = 'hint';
    distText.textContent = `${game.i18n!.localize('BINDERY.studio.measureDistances' as never)}: min ${min.toFixed(0)}pt · mediana ${median.toFixed(0)}pt · max ${max.toFixed(0)}pt`;
    box.appendChild(distText);

    const suggestion = document.createElement('p');
    suggestion.textContent = `${game.i18n!.localize('BINDERY.studio.measureSuggestion' as never)}: ${r.suggestedStrategy}, maxDistancePt ≈ ${r.suggestedMaxDistancePt}`;
    box.appendChild(suggestion);

    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'bindery-btn bindery-btn--ghost';
    applyBtn.textContent = game.i18n!.localize('BINDERY.studio.measureApplyButton' as never);
    applyBtn.addEventListener('click', () => {
      rule.strategy = r.suggestedStrategy;
      if (r.suggestedMaxDistancePt !== null) rule.maxDistancePt = r.suggestedMaxDistancePt;
      void this.render();
    });
    box.appendChild(applyBtn);
  }

  #buildMeasureSection(draft: ProfileDraft, rule: AttachRuleDraft): HTMLElement {
    const section = document.createElement('div');
    section.className = 'bindery-studio-measure-section';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bindery-btn bindery-btn--secondary';
    btn.textContent = game.i18n!.localize('BINDERY.studio.measureButton' as never);
    const resultBox = document.createElement('div');
    resultBox.className = 'bindery-studio-measure-result';

    btn.addEventListener('click', () => void this.#runMeasurement(draft, rule, resultBox));
    section.append(btn, resultBox);
    this.#renderMeasurementResult(resultBox, rule);
    return section;
  }

  async #runMeasurement(draft: ProfileDraft, rule: AttachRuleDraft, resultBox: HTMLElement): Promise<void> {
    if (!this.#pdfBuffer) return;
    this.#measurements.set(rule, { state: 'measuring' });
    this.#renderMeasurementResult(resultBox, rule);

    try {
      const input = draftToProfileInput(draft);
      const validated = await validateActorProfileFile(input);
      if (!validated.ok) {
        this.#measurements.set(rule, { state: 'error', message: validated.issues.join('; ') });
        this.#renderMeasurementResult(resultBox, rule);
        return;
      }
      const anchorPattern = validated.profile.patterns[draft.anchor];
      const candidatePattern = validated.profile.patterns[rule.pattern];
      if (anchorPattern?.kind !== 'labelledPairs') {
        this.#measurements.set(rule, { state: 'error', message: game.i18n!.localize('BINDERY.studio.measureBadPatterns' as never) });
        this.#renderMeasurementResult(resultBox, rule);
        return;
      }
      if (candidatePattern?.kind !== 'labelledPairs' && candidatePattern?.kind !== 'sectionList' && candidatePattern?.kind !== 'fontRoleCandidate') {
        this.#measurements.set(rule, { state: 'error', message: game.i18n!.localize('BINDERY.studio.measureBadPatterns' as never) });
        this.#renderMeasurementResult(resultBox, rule);
        return;
      }
      const { measureAttachGeometryForDocument } = await import('@bindery/core');
      const result = await measureAttachGeometryForDocument(this.#pdfBuffer, anchorPattern, candidatePattern, { assetBaseUrl: ASSET_BASE_URL });
      this.#measurements.set(rule, { state: 'done', result });
    } catch (err) {
      console.warn('Bindery | Profile Studio: pomiar geometrii nieudany:', err);
      this.#measurements.set(rule, { state: 'error', message: game.i18n!.localize('BINDERY.studio.measureFailed' as never) });
    }
    this.#renderMeasurementResult(resultBox, rule);
  }

  // ---- [KROK-23 Z6] Punkt zaczepienia: klik na stronie wypelnia pole -----

  /**
   * [KROK-23 Z6, KROK-28] Dwa tryby klikniecia tokenu na PDF-ie: (1) jawny
   * `#pickTarget` (📍 z formularza zaawansowanego) — klikniecie wypelnia TO
   * KONKRETNE pole; (2) domyslny tryb budowania (`#draft` istnieje, brak (1),
   * select-area WYLACZONE) — klikniecie to JEDYNA droga budowania profilu,
   * kierowana AKTYWNA ZAKLADKA (`#onBuildTokenClick`).
   */
  async #mountPickableTokens(): Promise<void> {
    const buildModeActive = !this.#pickTarget && this.#draft !== null && !this.#state.isSelectAreaMode && this.#state.buildTab !== 'check';
    if (!this.#pickTarget && !buildModeActive) return;
    if (!this.#pdfBuffer || !this.#previewDocument) return;
    const svg = this.element.querySelector<SVGSVGElement>('[data-overlay]');
    const img = this.element.querySelector<HTMLImageElement>('.bindery-page-image');
    if (!svg || !img) return;

    const { pdfRectToScreen } = await import('@bindery/core');
    const [tokens, box] = await Promise.all([this.#getBuildTokens(this.#state.currentPageNumber), this.#previewDocument.getPageBox(this.#state.currentPageNumber)]);

    // [zmierzony na zywo problem] Wskazywane pola sa ZAWSZE krotkim,
    // pojedynczym tokenem — zaden realny cel wskazywania nie jest calym
    // zdaniem prozy. Prog liczony w PRAWDZIWYCH znakach, hojny wzgledem
    // najdluzszych realnych celow.
    //
    // [zmierzony na zywo blad, str. 23 "Wrak.pdf", Calhoun] WYJATEK: przy
    // wybieraniu przykladow itemPattern (zakladka Ataki/Umiejetnosci)
    // pojedyncza pozycja bywa GENUINE JEDNYM tokenem dluzszym niz ten prog —
    // "Walka wręcz (Bijatyka) 30% (15/6), obrażenia 1K3+1K4 lub" to
    // ZMIERZONE WPROST 56 znakow (jednorazowy skrypt w Node repliku jacy
    // `getPageTextTokens`+`mergeTouchingTokens`, ta sama tokenizacja co
    // produkcyjna `#getBuildTokens`, usuniety po uzyciu), pdf.js NIE
    // rozbil tej linii na wiecej tokenow. Prog dlugosci ukrywalby TAKI token
    // calkowicie z nakladki — nie dawalby drugorzednego, krotszego fragmentu
    // do klikniecia w zastepstwie, po prostu nie byloby czym kliknac tej
    // pozycji (zgloszone na zywo: "klikam Walka wręcz, nic sie nie dzieje" —
    // dokladnie ten objaw: brak prostokata = klikniecie nigdy nie dociera do
    // ZADNEGO listenera, wiec nawet ostrzezenia w `#addItemPatternExample`
    // milcza, bo nigdy nie zostaja wywolane).
    //
    // [Naprawa zawezenia] Poprzednia wersja ograniczala ten wyjatek do
    // WASKIEJ "fazy 3" (naglowek+granica juz ustawione, na TEJ SAMEJ stronie,
    // z dopasowaniem `patternId` co do joty) — cztery niezalezne warunki na
    // ZYWYM, mutowalnym stanie, ktorych zadnego nie dalo sie zweryfikowac na
    // zywo w tej sesji (brak dostepu do uruchomionego Foundry). Kazdy z nich,
    // gdyby akurat NIE byl spelniony w momencie przerysowania (a nie tylko w
    // momencie klikniecia granicy — te dwa momenty dzieli asynchroniczne
    // `await`), cicho przywracal filtr dlugosci i kasowal jedyny klikalny
    // prostokat dla pozycji, ktora akurat trzeba kliknac. Wyjatek dziala
    // wiec teraz dla CALEJ zakladki Ataki/Umiejetnosci, niezaleznie od fazy —
    // koszt to nieco wiecej klikalnych (dluzszych) kandydatow widocznych juz
    // przy wskazywaniu naglowka/granicy (fazy 1-2), zysk to brak zaleznosci
    // od czterech warunkow scigajacych sie z asynchronicznym przerysowaniem.
    const isAttacksOrSkillsTab = this.#state.buildTab === 'attacks' || this.#state.buildTab === 'skills';
    // [KROK-34 Z2, ta sama klasa bledu co PICKABLE_MAX_LENGTH powyzej — krok
    // 32] Poczatek bloku notatki bywa CALYM zdaniem prozy ("Niewidzialność:
    // zdolność przestaje działać..." to jeden token dluzszy niz 40 znakow) —
    // prog dlugosci ukrywalby dokladnie te tokeny, ktore autor MA kliknac.
    const PICKABLE_MAX_LENGTH = 40;
    // [Zmierzony na zywo blad, zgloszenie uzytkownika: "Wiecej niz jedna
    // mozliwa wartosc... ale zadnej podswietlonej nie mam"] Kandydat wartosci
    // dla Pochodnych bywa DLUGIM, scalonym przez pdf.js tokenem — liczba PLUS
    // opis w jednym ("5, niezwykle gruba skóra. Pamiętaj, że obrażenia..." —
    // dokladnie ksztalt, ktory KROK-34 Z1 mial obslugiwac) — dluzszym niz
    // `PICKABLE_MAX_LENGTH`. Bez wyjatku ten token byl calkowicie usuwany z
    // nakladki (zero prostokata do klikniecia), mimo ze komunikat
    // `#pendingValueChoice` wprost mowil "kliknij podswietlona" — podswietlic
    // nie bylo czego. Ten sam blad co juz naprawiony dla fazy przykladow
    // itemPattern i zakladki Notatek (`isAttacksOrSkillsTab`/`buildTab ===
    // 'notes'` ponizej) — teraz wyjatek obejmuje TEZ czas trwania wyboru
    // niejednoznacznej wartosci, niezaleznie od aktywnej zakladki.
    const lengthFilterExempt = isAttacksOrSkillsTab || this.#state.buildTab === 'notes' || !!this.#pendingValueChoice;
    const pickableTokens = lengthFilterExempt ? tokens : tokens.filter((t) => t.text.length <= PICKABLE_MAX_LENGTH);
    const pendingCandidateIndices = new Set(this.#pendingValueChoice?.candidates.map((c) => c.tokenIndex) ?? []);

    const draw = () => {
      const width = img.naturalWidth || img.clientWidth;
      const height = img.naturalHeight || img.clientHeight;
      if (!width || !height) return;
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.style.width = `${img.clientWidth}px`;
      svg.style.height = `${img.clientHeight}px`;
      for (const tok of pickableTokens) {
        const screen = pdfRectToScreen(tok.bbox, { pageBox: box.box, imageWidthPx: width, imageHeightPx: height, rotation: box.rotation as never });
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', String(screen.minX));
        rect.setAttribute('y', String(screen.minY));
        rect.setAttribute('width', String(Math.max(0, screen.maxX - screen.minX)));
        rect.setAttribute('height', String(Math.max(0, screen.maxY - screen.minY)));
        const classes = ['bindery-studio-pickable-token'];
        if (pendingCandidateIndices.has(tok.tokenIndex)) classes.push('bindery-studio-pickable-candidate');
        rect.setAttribute('class', classes.join(' '));
        const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        title.textContent = tok.text;
        rect.appendChild(title);
        rect.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (this.#pickTarget) {
            this.#pickTarget.apply(tok.text);
            this.#pickTarget = null;
            void this.render();
            return;
          }
          void this.#onBuildTokenClick(tok, tokens);
        });
        svg.appendChild(rect);
      }
    };
    if (img.complete) draw();
    else img.addEventListener('load', draw, { once: true });
  }

  /**
   * [KROK-28 Z3, bez zmian od poprzedniej wersji] Zasięg aktywnej sekcji jako
   * obszar na PDF-ie, z przeciagalna dolna krawedzia. Rysuje WYLACZNIE gdy
   * przegladana strona to strona, na ktorej kliknieto naglowek.
   */
  async #mountSectionBoundaryOverlay(): Promise<void> {
    const svg = this.element.querySelector<SVGSVGElement>('[data-overlay]');
    const img = this.element.querySelector<HTMLImageElement>('.bindery-page-image');
    if (!svg || !img || !this.#draft || !this.#previewDocument) return;
    const existing = svg.querySelector('[data-section-boundary]');
    if (existing) existing.remove();
    const focus = this.#sectionBoundaryFocus;
    if (!focus || focus.page !== this.#state.currentPageNumber) return;
    const entry = this.#draft.patterns.find((e) => e.id === focus.patternId);
    if (!entry || entry.pattern.kind !== 'sectionList') return;
    const pattern = entry.pattern;

    const allTokens = await this.#getBuildTokens(this.#state.currentPageNumber);
    const headerToken = allTokens.find((t) => t.tokenIndex === focus.headerTokenIndex);
    if (!headerToken) return;

    const { pdfRectToScreen, screenRectToPdf, matchSectionList, findColumnBand, isWithinColumnBand } = await import('@bindery/core');
    const unionRect = (a: Rect, b: Rect): Rect => ({ minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX), minY: Math.min(a.minY, b.minY), maxY: Math.max(a.maxY, b.maxY) });
    const box = await this.#previewDocument.getPageBox(this.#state.currentPageNumber);
    // [Zmierzony na zywo blad, str. 23 "Zew Cthulhu 7ed. Wrak.pdf"] Obszar
    // sekcji rysowany PELNA szerokoscia strony (`box.box.minX`/`maxX`) na
    // stronie dwulamowej obejmowal OBIE kolumny naraz (O5 z kroku 29,
    // potwierdzone jako dotyczace KAZDEJ strony dwulamowej, nie tylko
    // "dwoch postaci obok siebie") — zawezone do kolumny naglowka.
    const columnBand = findColumnBand(allTokens, headerToken.bbox);
    const extentMinX = columnBand?.minX ?? box.box.minX;
    const extentMaxX = columnBand?.maxX ?? box.box.maxX;

    const gridRegionsOnPage: Rect[] =
      this.#docAnalysis?.pages[this.#state.currentPageNumber - 1]?.entities.flatMap((e) => e.regions.filter((r) => r.kind === 'grid').map((r) => r.bbox)) ?? [];

    /**
     * [KROK-29 Z1, "natychmiastowy podglad na PDF-ie"] Ktore pozycje w
     * sekcji `itemPattern` zlapal, a ktore nie — liczone przez PRAWDZIWY
     * silnik dopasowan (`matchSectionList`, ta sama funkcja co produkcyjny
     * przebieg), nie wlasna, potencjalnie rozjezdzajaca sie kopie logiki
     * granicy sekcji. Puste/niepoprawne `itemPattern` (autor jeszcze nie
     * kliknal zadnego przykladu, albo edytuje recznie pod "Zaawansowane")
     * po prostu nie rysuje nic tutaj — nie przerywa reszty overlayu.
     */
    let matchedItemRects: Rect[] = [];
    const unmatchedItemRects: Rect[] = [];
    if (pattern.itemPattern) {
      try {
        const matches = matchSectionList(allTokens, pattern);
        const match = matches.find((m) => m.headerTokenIndex === headerToken.tokenIndex);
        if (match) {
          matchedItemRects = match.items.map((it) => it.bbox);
          const covered = new Set<number>();
          for (const it of match.items) for (let idx = it.startTokenIndex; idx <= it.endTokenIndex; idx++) covered.add(idx);
          const tokenByIndex = new Map(allTokens.map((t) => [t.tokenIndex, t] as const));
          let runBbox: Rect | null = null;
          const flushRun = (): void => {
            if (runBbox) unmatchedItemRects.push(runBbox);
            runBbox = null;
          };
          for (let idx = headerToken.tokenIndex + 1; idx < match.endIndex; idx++) {
            const t = tokenByIndex.get(idx);
            if (!t) continue;
            if (covered.has(idx)) {
              flushRun();
              continue;
            }
            runBbox = runBbox ? unionRect(runBbox, t.bbox) : t.bbox;
          }
          flushRun();
        }
      } catch {
        /* itemPattern niepoprawny (edytowany recznie) -- brak podgladu, reszta overlayu rysuje sie normalnie */
      }
    }

    const draw = (): void => {
      const width = img.naturalWidth || img.clientWidth;
      const height = img.naturalHeight || img.clientHeight;
      if (!width || !height) return;

      // [Zmierzony na zywo blad] `Rect` w tym projekcie zyje w przestrzeni PDF
      // (Y ROSNIE W GORE strony — potwierdzone wprost w `directionalDistance`,
      // `entityAssembly.ts`: kandydat "ponizej" ma MNIEJSZY Y niz kotwica).
      // Poprzednia wersja mylila to z konwencja ekranu (Y rosnie w dol) —
      // efekt zmierzony na str. 23 "Zew Cthulhu 7ed. Wrak.pdf": obszar sekcji
      // "Walka" rysowal sie NAD naglowkiem (siatka cech Johna Calhouna) zamiast
      // pod nim. `extentMinY` to DOLNA granica PDF (mniejszy Y = nizej na
      // stronie) — domyslnie dol strony (`box.box.minY`), albo GORNA krawedz
      // znalezionego tokenu granicznego (`found.bbox.maxY`) — `headerToken.bbox.minY`
      // (WLASNA dolna krawedz naglowka, wiekszy Y niz cokolwiek pod nim) jest
      // GORNA granica calego zakresu.
      let extentMinY = box.box.minY;
      if (pattern.terminateSectionBefore) {
        try {
          const re = new RegExp(pattern.terminateSectionBefore, 'u');
          // [Zmierzony na zywo blad] Ten sam zakres kolumn co reszta tego
          // podgladu — token PASUJACY do granicy, ale lezacy w SASIEDNIEJ
          // kolumnie (np. przypadkowe dopasowanie w prozie), nie powinien
          // "ciagnac" podgladu poza wlasna kolumne naglowka.
          const found = allTokens.find((t) => t.tokenIndex > headerToken.tokenIndex && re.test(t.text) && isWithinColumnBand(t.bbox, columnBand));
          if (found) extentMinY = found.bbox.maxY;
        } catch {
          /* regex niepoprawny (edytowany recznie pod "Zaawansowane") -- rysuj do konca strony, nie przerywaj */
        }
      }

      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('data-section-boundary', '1');

      const drawExtent = (candidateMinY: number, overlapping: boolean): { rect: SVGRectElement; handle: SVGLineElement } => {
        const pdfRect: Rect = { minX: extentMinX, maxX: extentMaxX, minY: candidateMinY, maxY: headerToken.bbox.minY };
        const screen = pdfRectToScreen(pdfRect, { pageBox: box.box, imageWidthPx: width, imageHeightPx: height, rotation: box.rotation as never });
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', String(screen.minX));
        rect.setAttribute('y', String(screen.minY));
        rect.setAttribute('width', String(Math.max(0, screen.maxX - screen.minX)));
        rect.setAttribute('height', String(Math.max(0, screen.maxY - screen.minY)));
        rect.setAttribute('class', `bindery-studio-section-extent${overlapping ? ' bindery-studio-section-extent-overlap' : ''}`);
        const handle = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        handle.setAttribute('x1', String(screen.minX));
        handle.setAttribute('x2', String(screen.maxX));
        handle.setAttribute('y1', String(screen.maxY));
        handle.setAttribute('y2', String(screen.maxY));
        handle.setAttribute('class', `bindery-studio-section-handle${overlapping ? ' bindery-studio-section-handle-overlap' : ''}`);
        return { rect, handle };
      };

      const { rect, handle } = drawExtent(extentMinY, false);
      g.append(rect, handle);

      const drawItemRect = (pdfRect: Rect, cssClass: string): void => {
        const screen = pdfRectToScreen(pdfRect, { pageBox: box.box, imageWidthPx: width, imageHeightPx: height, rotation: box.rotation as never });
        const itemRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        itemRect.setAttribute('x', String(screen.minX));
        itemRect.setAttribute('y', String(screen.minY));
        itemRect.setAttribute('width', String(Math.max(0, screen.maxX - screen.minX)));
        itemRect.setAttribute('height', String(Math.max(0, screen.maxY - screen.minY)));
        itemRect.setAttribute('class', cssClass);
        g.appendChild(itemRect);
      };
      for (const r of matchedItemRects) drawItemRect(r, 'bindery-studio-item-matched');
      for (const r of unmatchedItemRects) drawItemRect(r, 'bindery-studio-item-unmatched');

      svg.appendChild(g);

      handle.addEventListener('pointerdown', (e: PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        handle.setPointerCapture(e.pointerId);
        this.#boundaryDrag = {
          patternId: entry!.id,
          headerTokenIndex: headerToken.tokenIndex,
          startPdfY: extentMinY,
          pageWidthPx: width,
          pageHeightPx: height,
          overlapCheckBboxes: gridRegionsOnPage,
        };
        this.#mountBuildPanel();

        // [Zmierzony na zywo blad, ta sama przyczyna co wyzej] Przeciagniecie
        // W DOL na ekranie musi DAWAC MNIEJSZY Y w przestrzeni PDF (Y rosnie w
        // gore strony) — dolna granica przeciagniecia to `box.box.minY` (sam
        // dol strony), gorna to `headerToken.bbox.minY` (wlasna dolna krawedz
        // naglowka — nie da sie przeciagnac granicy NAD naglowek).
        const onMove = (ev: PointerEvent): void => {
          const overlayPt = this.#svgToOverlayPoint(svg, ev.clientX, ev.clientY);
          const pdfPt = screenRectToPdf({ minX: overlayPt.x, maxX: overlayPt.x + 1, minY: overlayPt.y, maxY: overlayPt.y + 1 }, { pageBox: box.box, imageWidthPx: width, imageHeightPx: height, rotation: box.rotation as never });
          const candidateY = Math.min(headerToken.bbox.minY, Math.max(pdfPt.minY, box.box.minY));
          const candidateRect: Rect = { minX: extentMinX, maxX: extentMaxX, minY: candidateY, maxY: headerToken.bbox.minY };
          const overlapping = gridRegionsOnPage.some((r) => ProfileStudio.#rectsOverlap(r, candidateRect));
          g.innerHTML = '';
          const redrawn = drawExtent(candidateY, overlapping);
          g.append(redrawn.rect, redrawn.handle);
        };
        // [naprawa zgloszonego bledu — recenzja calego designu] `cleanup`
        // usuwa WSZYSTKIE trzy nasluchiwacze (nie tylko te "spodziewane" dla
        // danej sciezki) — bez tego przerwany gest (`pointercancel` zamiast
        // `pointerup`) zostawial `onMove`/`onUp` na `svg` NA ZAWSZE (ten sam
        // `svg` przetrwa wielokrotne montowanie nakladki), gdzie mogly
        // pozniej "wystrzelic" z zupelnie niepowiazanego zdarzenia na tym
        // samym elemencie (np. konczac inne przeciagniecie) i cicho
        // przestawic te granice sekcji.
        const cleanup = (): void => {
          svg.removeEventListener('pointermove', onMove);
          svg.removeEventListener('pointerup', onUp);
          svg.removeEventListener('pointercancel', onCancel);
          if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
        };
        const onUp = (ev: PointerEvent): void => {
          cleanup();
          const overlayPt = this.#svgToOverlayPoint(svg, ev.clientX, ev.clientY);
          const pdfPt = screenRectToPdf({ minX: overlayPt.x, maxX: overlayPt.x + 1, minY: overlayPt.y, maxY: overlayPt.y + 1 }, { pageBox: box.box, imageWidthPx: width, imageHeightPx: height, rotation: box.rotation as never });
          const finalY = Math.min(headerToken.bbox.minY, Math.max(pdfPt.minY, box.box.minY));
          void this.#commitSectionBoundary(entry!, headerToken.tokenIndex, finalY);
        };
        const onCancel = (): void => {
          cleanup();
          this.#boundaryDrag = null;
          g.innerHTML = '';
          const restored = drawExtent(extentMinY, false);
          g.append(restored.rect, restored.handle);
          this.#mountBuildPanel();
        };
        svg.addEventListener('pointermove', onMove);
        svg.addEventListener('pointerup', onUp);
        svg.addEventListener('pointercancel', onCancel);
      });
    };
    if (img.complete) draw();
    else img.addEventListener('load', draw, { once: true });
  }

  /**
   * [KROK-28 Z3] Koniec przeciagniecia -> token GEOMETRYCZNIE najblizszy
   * puszczonej krawedzi staje sie `terminateSectionBefore`. Brak tokenu
   * ponizej usuwa granice -- sekcja czyta do konca strumienia, poprawna
   * odpowiedz, nie blad.
   *
   * [Zmierzony na zywo blad, str. 23 "Zew Cthulhu 7ed. Wrak.pdf"] "Geometrycznie
   * najblizszy PO Y" bez znajomosci kolumn na stronie dwulamowej czesto
   * oznacza token PROZY Z SASIEDNIEJ KOLUMNY (ta sama wysokosc, zupelnie inna
   * tresc) zamiast prawdziwego naglowka konczacego sekcje we WLASNEJ kolumnie
   * — zgloszone wprost jako blad, nie waski przypadek (O5 z kroku 29
   * potwierdzone jako dotyczace KAZDEJ strony dwulamowej). Szukanie zawezone
   * do `findColumnBand` naglowka sekcji — na stronie jednolamowej pasmo
   * obejmuje cala tresc, zero zmiany zachowania.
   */
  async #commitSectionBoundary(entry: PatternEntryDraft, headerTokenIndex: number, finalPdfY: number): Promise<void> {
    this.#boundaryDrag = null;
    if (entry.pattern.kind !== 'sectionList') return;
    const allTokens = await this.#getBuildTokens(this.#state.currentPageNumber);
    const { findTerminateTokenAtY, findColumnBand, isWithinColumnBand } = await import('@bindery/core');
    const headerToken = allTokens.find((t) => t.tokenIndex === headerTokenIndex);
    const band = headerToken ? findColumnBand(allTokens, headerToken.bbox) : null;
    const candidateTokens = band ? allTokens.filter((t) => isWithinColumnBand(t.bbox, band)) : allTokens;
    const found = findTerminateTokenAtY(candidateTokens, headerTokenIndex, finalPdfY);
    entry.pattern.terminateSectionBefore = found ? escapeSectionBoundaryLiteral(found.text) : undefined;
    this.#refreshBuildPanel();
  }

  // ---- [KROK-24 Z1] Inferencja wzorca z zaznaczenia myszą (Cechy/Pochodne) ---

  /**
   * [Zmierzony na zywo blad, "zaznaczam obszar, ale trafiam dużo niżej niż
   * statblock", pogorszone po pierwszej (cofnietej) probie naprawy przez CSS]
   * `svg.getBoundingClientRect()` odzwierciedla FAKTYCZNY, WYRENDEROWANY
   * rozmiar CSS elementu `<svg>` — ktory NIE MUSI pokrywac sie z rozmiarem
   * faktycznie wyswietlanego obrazu strony (`.bindery-page-image`), bo
   * `.bindery-page-overlay { width:100%; height:100% }` liczy sie wzgledem
   * `.bindery-page-canvas-wrap` (kontener `flex:1; overflow:auto` — jego
   * wlasny rozmiar to dostepne miejsce w panelu, NIE wysokosc obrazu dla
   * wysokiej, przewijanej strony PDF). Reszta kodu (`#mountOverlay`/
   * `#mountPickableTokens`) naprawia to NADPISUJAC `svg.style.width/height`
   * na `img.clientWidth/clientHeight` PRZED rysowaniem — ale TYLKO gdy akurat
   * dziala (np. `#mountPickableTokens` jawnie NIC nie rysuje, gdy
   * `isSelectAreaMode` jest wlaczone, czyli DOKLADNIE wtedy, gdy uzytkownik
   * probuje uzyc "Zaznacz obszar"). Naprawa: WYMUS TO SAMO nadpisanie TUTAJ,
   * przy KAZDYM przeliczeniu punktu — niezaleznie od tego, czy jakakolwiek
   * inna funkcja rysujaca zdazyla to juz zrobic. Bezpieczne (`img.clientWidth`
   * ejst zawsze poprawny, niezalezny od przewijania rodzica) i tanie
   * (przypisanie identycznej wartosci stylu, ktore juz tam jest, nie
   * wymusza dodatkowego przeplywu ukladu poza tym, co i tak nastapi przy
   * odczycie `getBoundingClientRect()` ponizej).
   *
   * [Drugi, glebszy zmierzony blad] Z TEGO SAMEGO powodu (`#mountPickableTokens`
   * jawnie NIC nie rysuje w trybie `isSelectAreaMode`) `viewBox` tez mogl
   * NIGDY nie zostac ustawiony na swiezym elemencie `<svg>` (po pelnym
   * renderze, ktory tworzy go od nowa, bez atrybutow) — `vb.width/height`
   * wtedy to `0`, a `scaleX/scaleY` ponizej cichy spada na fallback `1`
   * zamiast prawdziwej skali (~4-5x miedzy pikselami CSS a natywnymi
   * pikselami PDF), przez co PRAWIE KAZDE przeciagniecie mapowalo sie w
   * ciasny obszar kolo lewego-gornego rogu strony w przestrzeni PDF —
   * gorzej niz zwykle przesuniecie, bo to blad SKALI, nie tylko przesuniecia.
   * Ustawiany rowniez tutaj, z tych samych, zawsze wiarygodnych
   * `img.naturalWidth/naturalHeight`.
   */
  #svgToOverlayPoint(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } {
    const img = this.element.querySelector<HTMLImageElement>('.bindery-page-image');
    if (img && img.clientWidth > 0 && img.clientHeight > 0) {
      svg.style.width = `${img.clientWidth}px`;
      svg.style.height = `${img.clientHeight}px`;
    }
    if (img && img.naturalWidth > 0 && img.naturalHeight > 0 && (svg.viewBox.baseVal.width === 0 || svg.viewBox.baseVal.height === 0)) {
      svg.setAttribute('viewBox', `0 0 ${img.naturalWidth} ${img.naturalHeight}`);
    }
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const scaleX = rect.width > 0 && vb.width > 0 ? vb.width / rect.width : 1;
    const scaleY = rect.height > 0 && vb.height > 0 ? vb.height / rect.height : 1;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
  }

  #wireAreaSelectDrag(svg: SVGSVGElement): void {
    if (svg.dataset['areaSelectWired']) return;
    svg.dataset['areaSelectWired'] = '1';

    const toOverlayPoint = (clientX: number, clientY: number): { x: number; y: number } => this.#svgToOverlayPoint(svg, clientX, clientY);

    svg.addEventListener('pointerdown', (e: PointerEvent) => {
      if (!this.#state.isSelectAreaMode || e.button !== 0) return;
      e.preventDefault();
      const start = toOverlayPoint(e.clientX, e.clientY);
      const rectEl = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rectEl.setAttribute('class', 'bindery-select-drag-rect');
      rectEl.setAttribute('x', String(start.x));
      rectEl.setAttribute('y', String(start.y));
      rectEl.setAttribute('width', '0');
      rectEl.setAttribute('height', '0');
      svg.appendChild(rectEl);
      this.#dragState = { startScreen: start, rectEl };
      svg.setPointerCapture(e.pointerId);
    });

    svg.addEventListener('pointermove', (e: PointerEvent) => {
      if (!this.#dragState) return;
      const { startScreen, rectEl } = this.#dragState;
      const cur = toOverlayPoint(e.clientX, e.clientY);
      rectEl.setAttribute('x', String(Math.min(startScreen.x, cur.x)));
      rectEl.setAttribute('y', String(Math.min(startScreen.y, cur.y)));
      rectEl.setAttribute('width', String(Math.abs(cur.x - startScreen.x)));
      rectEl.setAttribute('height', String(Math.abs(cur.y - startScreen.y)));
    });

    const MIN_DRAG_PX = 8;
    const finishDrag = (e: PointerEvent): void => {
      if (!this.#dragState) return;
      const { startScreen, rectEl } = this.#dragState;
      this.#dragState = null;
      rectEl.remove();
      const cur = toOverlayPoint(e.clientX, e.clientY);
      const screenRect: Rect = {
        minX: Math.min(startScreen.x, cur.x),
        maxX: Math.max(startScreen.x, cur.x),
        minY: Math.min(startScreen.y, cur.y),
        maxY: Math.max(startScreen.y, cur.y),
      };
      if (screenRect.maxX - screenRect.minX < MIN_DRAG_PX || screenRect.maxY - screenRect.minY < MIN_DRAG_PX) return;
      void this.#onAreaSelected(screenRect);
    };
    svg.addEventListener('pointerup', finishDrag);
    // [naprawa zgloszonego bledu — recenzja calego designu] Brakowalo tego,
    // co `#wireSelectDrag` w ReviewScreen.ts ma explicite (z komentarzem):
    // przerwany gest (`pointercancel`, np. gestem systemowym) nigdy nie
    // wywolywal `finishDrag`, wiec `#dragState` i tymczasowy `<rect>`
    // zostawaly osierocone w DOM na zawsze (kolejny `pointerdown` nadpisywal
    // `#dragState` bez usuniecia starego elementu).
    svg.addEventListener('pointercancel', finishDrag);
  }

  /**
   * [Korekta] "Obrysowanie obszaru dziala tak samo, tylko hurtowo" — WYLACZNIE
   * na zakladkach Cechy/Pochodne (sekcje buduje sie geometrycznie, Z3, nie
   * hurtowym zaznaczeniem — patrz `canSelectArea` w `_prepareContext`).
   * Zaznaczenie bez zadnej wykrytej pary po prostu nie daje propozycji —
   * sekcje NIE sa juz zgadywane z "0 par" jak w poprzedniej wersji.
   */
  async #onAreaSelected(screenRect: Rect): Promise<void> {
    if (!this.#pdfBuffer || !this.#previewDocument) return;
    const slot = this.#state.buildTab;
    if (slot !== 'grid' && slot !== 'derived') return;
    const img = this.element.querySelector<HTMLImageElement>('.bindery-page-image');
    const width = img?.naturalWidth || img?.clientWidth || 0;
    const height = img?.naturalHeight || img?.clientHeight || 0;
    if (!width || !height) return;

    const { screenRectToPdf, inferLabelledPairsFromTokens } = await import('@bindery/core');
    const box = await this.#previewDocument.getPageBox(this.#state.currentPageNumber);
    const pdfRect = screenRectToPdf(screenRect, { pageBox: box.box, imageWidthPx: width, imageHeightPx: height, rotation: box.rotation as never });

    // [Ta sama naprawa co #getBuildTokens] scalone, "cale slowo" tokeny -- bulk zaznaczenie obszaru nie powinno cierpiec na to samo rozbicie co pojedyncze klikniecie.
    const allTokens = await this.#getBuildTokens(this.#state.currentPageNumber);
    const selected = allTokens.filter((t) => {
      const cx = (t.bbox.minX + t.bbox.maxX) / 2;
      const cy = (t.bbox.minY + t.bbox.maxY) / 2;
      return cx >= pdfRect.minX && cx <= pdfRect.maxX && cy >= pdfRect.minY && cy <= pdfRect.maxY;
    });

    const pairs = inferLabelledPairsFromTokens(selected);
    // [Zmierzony na zywo zgloszony brak] `pairs.length === 0` ustawialo
    // `null` -- panel po prostu czyscil sie bez sladu, wiec autor widzial
    // TYLKO znikniecie prostokata przeciagania, bez zadnej informacji o tym,
    // CO poszlo nie tak (brak tokenow w zaznaczeniu? sa tokeny, ale nie
    // uklad "etykieta-wartosc"?). Propozycja jest teraz ZAWSZE ustawiana (z
    // ewentualnie PUSTA lista par) — `#mountSelectionProposal` pokazuje
    // czytelny komunikat zamiast ciszy, wraz z surowym podgladem zaznaczonego
    // tekstu, zeby autor od razu widzial, czy w ogole trafil w tresc.
    // [zgloszenie uzytkownika, "Pancerz" bez sugestii klucza w panelu
    // zaznaczenia] Ta sama podpowiedz co przy pojedynczym klikniecu etykiety
    // (`#addOrUpdateGridPair`) — poprzednio ZAWSZE `''`, autor musial wpisac
    // recznie nawet dobrze znane pola (np. "Pancerz" -> "armour").
    const suggestedCanonicalKeys = await Promise.all(pairs.map((p) => this.#suggestCanonicalKey(p.label)));
    this.#selectionProposal = {
      slot,
      pairs: pairs.map((p, i) => ({ label: p.label, value: p.value, canonicalKey: suggestedCanonicalKeys[i]!, checked: true, confidence: p.confidence })),
      rawPreview: selected.map((t) => t.text).join(' '),
    };
    await this.render();
  }

  #mountSelectionProposal(): void {
    const container = this.element.querySelector<HTMLElement>('[data-selection-proposal]');
    if (!container) return;
    container.innerHTML = '';
    const proposal = this.#selectionProposal;
    if (!proposal || !this.#draft) return;

    const panel = document.createElement('div');
    panel.className = 'bindery-studio-selection-proposal';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'bindery-btn bindery-btn--icon bindery-studio-proposal-close';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => {
      this.#selectionProposal = null;
      void this.render();
    });

    const h = document.createElement('h4');
    h.textContent = `${game.i18n!.localize('BINDERY.studio.selectionFoundPairs' as never)}: ${proposal.pairs.length}`;
    panel.append(h, closeBtn);

    if (proposal.pairs.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = proposal.rawPreview
        ? game.i18n!.localize('BINDERY.studio.selectionNoPairsFound' as never)
        : game.i18n!.localize('BINDERY.studio.selectionEmptyArea' as never);
      panel.appendChild(empty);
    }

    for (const pair of proposal.pairs) {
      const row = document.createElement('div');
      row.className = 'bindery-studio-proposal-pair-row';
      if (pair.confidence === 'low') row.classList.add('bindery-studio-proposal-low-confidence');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'bindery-check';
      cb.checked = pair.checked;
      cb.addEventListener('change', () => (pair.checked = cb.checked));
      row.appendChild(cb);
      const labelSpan = document.createElement('span');
      labelSpan.className = 'bindery-studio-proposal-label';
      labelSpan.textContent = `${pair.label} → ${pair.value}`;
      row.appendChild(labelSpan);
      if (pair.confidence === 'low') {
        const badge = document.createElement('span');
        badge.className = 'bindery-studio-proposal-confidence-badge';
        badge.textContent = '?';
        badge.dataset['tooltip'] = game.i18n!.localize('BINDERY.studio.selectionLowConfidenceHint' as never);
        row.appendChild(badge);
      }
      const keyInput = document.createElement('input');
      keyInput.type = 'text';
      keyInput.className = 'bindery-input';
      keyInput.setAttribute('list', 'bindery-canonical-keys');
      keyInput.placeholder = game.i18n!.localize('BINDERY.studio.canonicalKeyPlaceholder' as never);
      keyInput.value = pair.canonicalKey;
      keyInput.addEventListener('change', () => (pair.canonicalKey = keyInput.value));
      row.appendChild(keyInput);
      panel.appendChild(row);
    }

    if (proposal.pairs.length > 0) {
      const applyBtn = document.createElement('button');
      applyBtn.type = 'button';
      applyBtn.className = 'bindery-btn bindery-btn--ghost';
      applyBtn.textContent = game.i18n!.localize('BINDERY.studio.selectionApplyButton' as never);
      applyBtn.addEventListener('click', () => this.#applySelectionProposal(proposal));
      panel.appendChild(applyBtn);
    }

    const preview = document.createElement('p');
    preview.className = 'hint bindery-studio-proposal-preview';
    preview.textContent = `${game.i18n!.localize('BINDERY.studio.selectionRawPreview' as never)}: „${proposal.rawPreview}”`;
    panel.appendChild(preview);

    container.appendChild(panel);
  }

  #applySelectionProposal(proposal: SelectionProposal): void {
    const checked = proposal.pairs.filter((p) => p.checked);
    this.#selectionProposal = null;
    this.#state.isSelectAreaMode = false;
    if (checked.length === 0) {
      void this.render();
      return;
    }
    void (async () => {
      for (const p of checked) await this.#addOrUpdateGridPair(proposal.slot, p.label, p.value);
      // `#addOrUpdateGridPair` sugeruje klucz kanoniczny automatycznie — nadpisz
      // WYLACZNIE jesli autor recznie zmienil podpowiedz w checkliscie.
      const entry = this.#findPattern(proposal.slot === 'grid' ? this.#activeGridPatternId : this.#activeDerivedPatternId);
      if (entry?.pattern.kind === 'labelledPairs') {
        for (const p of checked) {
          if (!p.canonicalKey) continue;
          const labelEntry = entry.pattern.labels.find((l) => l.label === p.label);
          if (labelEntry) labelEntry.canonicalKey = p.canonicalKey;
        }
      }
      await this.render();
    })();
  }
}

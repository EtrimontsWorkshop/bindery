import type { CIFDocument, CIFImage, CIFScene, CIFJournal, CIFActor, AdapterResult, Diagnostic, PreviewDocument, Rect, RotatedRect, RegionCrop } from '@bindery/core';
import { classifyTargetKind, pdfRectToScreen, screenRotatedRectToPdf, rotatedRectBounds, inscribedRotatedRectScale, DEFAULT_WEBP_QUALITY } from '@bindery/core';
import { MODULE_ID, type ImportTargets } from '../settings.js';
import { ReviewSelection, defaultImageDestination, sortImagesForReview, type ImageDestination } from '../review/selectionState.js';
import { ActorReviewSelection, computeActorCompleteness, applyActorOverrides } from '../review/actorSelectionState.js';
import { VirtualList } from '../review/VirtualList.js';
import { uploadImage } from '../documents/uploadImages.js';
import { createSceneFromImage } from '../documents/createSceneFromImage.js';
import { createJournalsFromCIF, type CIFJournalForCreation } from '../documents/createJournalFromCIF.js';
import { createJournalHandoutFromImage } from '../documents/createJournalHandoutFromImage.js';
import { createJournalHandoutFromImages } from '../documents/createJournalHandoutFromImages.js';
import { createActorsFromAdapterResults } from '../documents/createActors.js';
import { coc7Adapter, type Coc7ActorPayload } from '../adapters/coc7.js';
import { ensureFolder } from '../documents/ensureFolder.js';
import { pickGrid, type GridConfig } from './GridPicker.js';
import { prepareToken } from './TokenPrepApp.js';
import { STATBLOCKS_ENABLED } from '../features.js';
import { localizeMessage } from '../i18n.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** [KROK-17] Ponizej tego progu sugestia auto-detekcji siatki (`detectGrid.ts`) jest zbyt slaba, zeby cokolwiek zgadywac — patrz `#pickGridForImage`. */
const MIN_GRID_SUGGESTION_CONFIDENCE = 0.4;

/**
 * [KROK-20, na zyczenie uzytkownika] Auto-detekcja core'a "to jest cala
 * scena/mapa" (`doc.scenes`, CIFScene) i "to jest pelny tekst ksiazki jako
 * journal" (`doc.journals`, CIFJournal z hierarchii zakladek PDF) wylaczona
 * "na razie" — flaga zamiast usuwania kodu, zeby latwo przywrocic pozniej.
 * Zakladki "Sceny"/"Journale" ukryte w `review-screen.hbs`; ta sama flaga
 * pomija ich tworzenie w `#runImport` (bez tego, obrazy uzyte przez
 * `doc.scenes` bylyby "uzyte" — patrz `usedImageIds` — mimo ukrytej zakladki,
 * i NIE trafialyby do zakladki Obrazy jako zwykly wybor Przeznaczenia).
 * Te same obrazy nadal dostepne w zakladce Obrazy z Przeznaczeniem
 * Scena/Journal, obsluzone per-obraz zamiast przez ten potok.
 */
const SCENES_JOURNALS_FROM_CIF_ENABLED = false;

type ReviewTab = 'images' | 'scenes' | 'journals' | 'actors' | 'diagnostics';
type ReviewStep = 'review' | 'target' | 'summary';
/** [zgloszenie uzytkownika, "dwie zakladki: automatycznie i recznie"] Zrodlo obrazu — WYLACZNIE prezentacyjny podzial listy zakladki Obrazy, nie nowe pole `CIFImage`: `manual` rozpoznawane po prefiksie `id` (`manual-crop-`, patrz `#createManualCrop`). */
type ImageSourceTab = 'auto' | 'manual';
/** [zgloszenie uzytkownika] Podzakladka WEWNATRZ kazdej z `ImageSourceTab` — filtruje wedlug JUZ istniejacego `ReviewSelection.imageDestination` (ten sam wybor co dropdown "Przeznaczenie" per wiersz), nie nowego stanu. */
type ImageDestTab = ImageDestination;

interface JournalRow {
  kind: 'journal' | 'page';
  journal: CIFJournal;
  pageId?: string;
  pageName?: string;
  pageIndex?: number;
}

interface DiagnosticGroup {
  code: string;
  severity: Diagnostic['severity'];
  count: number;
  examples: Diagnostic[];
}

export interface ReviewScreenData {
  document: CIFDocument;
  imageBytesById: ReadonlyMap<string, { bytes: Uint8Array; format: string }>;
  previewDocument: PreviewDocument;
  fileName: string;
  /** [KROK-42 Z1] Wartosc startowa przelacznika "usun tlo" w `TokenPrepApp` — patrz `images.removeTokenBackgroundDefault` w `schema.ts` (`@bindery/core`). */
  removeTokenBackgroundDefault?: boolean;
}

export interface ReviewScreenResult {
  confirmed: boolean;
}

/**
 * [KROK-11] Ekran przegladu (faza 9) — split-pane ApplicationV2, wirtualizowane
 * listy (Z2), podglad strony + nakladki bbox (Z3), model zaznaczenia (Z4),
 * drzewo journali tylko-do-odczytu (Z5), ekran celu (Z6), panel diagnostyki
 * (Z7). CZYSTA prezentacja/selekcja nad juz-gotowym `CIFDocument` — zero
 * logiki decyzyjnej (klasyfikacja/CIF budowane WYLACZNIE w `packages/core`,
 * check:boundary A1).
 *
 * Otwierany dynamicznie (patrz `ImportWizard.ts`) — NIE statycznie
 * importowany z `main.ts`, zeby nie obciazac budzetu <40KB startu swiata (I3).
 */
export class ReviewScreen extends HandlebarsApplicationMixin(ApplicationV2) {
  static override DEFAULT_OPTIONS = {
    id: 'bindery-review',
    classes: ['bindery', 'bindery-review-app'],
    window: {
      title: 'BINDERY.review.title',
      resizable: true,
      icon: 'fa-solid fa-magnifying-glass',
    },
    // [redesign 2a, naprawa zgloszona na zywo] Split podgladu (340px stale) +
    // tabeli obrazow (kolumny 22/36/74/148px stale z README) potrzebuje
    // znacznie wiecej miejsca niz dawny pojedynczy label — przy starej
    // szerokosci 960 kolumna nazwy dostawala ok. 14px (praktycznie niewidoczna).
    position: { width: 1180, height: 720 },
    actions: {
      cancelReview: ReviewScreen.#onCancelReview,
      proceedToTarget: ReviewScreen.#onProceedToTarget,
      backToReview: ReviewScreen.#onBackToReview,
      confirmImport: ReviewScreen.#onConfirmImport,
      closeReview: ReviewScreen.#onCloseReview,
      switchTab: ReviewScreen.#onSwitchTab,
      switchImageSourceTab: ReviewScreen.#onSwitchImageSourceTab,
      switchImageDestTab: ReviewScreen.#onSwitchImageDestTab,
      selectAllImages: ReviewScreen.#onSelectAllImages,
      selectNoImages: ReviewScreen.#onSelectNoImages,
      selectOnlyContent: ReviewScreen.#onSelectOnlyContent,
      selectAllJournals: ReviewScreen.#onSelectAllJournals,
      selectNoJournals: ReviewScreen.#onSelectNoJournals,
      selectAllActors: ReviewScreen.#onSelectAllActors,
      selectNoActors: ReviewScreen.#onSelectNoActors,
      applyBulkSettings: ReviewScreen.#onApplyBulkSettings,
      prevPage: ReviewScreen.#onPrevPage,
      nextPage: ReviewScreen.#onNextPage,
      openDocument: ReviewScreen.#onOpenDocument,
      toggleSelectMode: ReviewScreen.#onToggleSelectMode,
      zoomIn: ReviewScreen.#onZoomIn,
      zoomOut: ReviewScreen.#onZoomOut,
    },
  };

  static override PARTS = {
    main: {
      template: 'modules/bindery/templates/review-screen.hbs',
      // [zgloszenie uzytkownika, "klikniecie obrazu przewija liste na gore"]
      // Klikniecie wiersza na innej stronie niz aktualnie wyswietlana
      // (`#buildImageRow`) i wiele innych akcji (zaznacz wszystko/nic,
      // zastosuj ustawienia zbiorcze, ...) wola `this.render()` — ten sam
      // mechanizm co w `ImportWizard.ts` (patrz komentarz tam): ApplicationV2
      // podmienia caly korzen tej czesci na nowy element, wiec KAZDY
      // przewijany kontener w srodku (w tym `VirtualList`, ktora czyta
      // `container.scrollTop` wprost przy montowaniu — `VirtualList.ts`)
      // dostaje swiezy element ze `scrollTop` zerowanym z definicji.
      // `scrollable` to udokumentowany mechanizm samego Foundry
      // (`handlebars-application.mjs`) na dokladnie ten przypadek —
      // zapamietuje `scrollTop` PRZED podmiana i przywraca go PO niej, ZANIM
      // `_onRender` (a wiec i `#mountImageList`/`VirtualList`'s konstruktor)
      // w ogole sie wykona, wiec wirtualizacja od razu widzi poprawna pozycje.
      // Wszystkie piec przewijanych list ekranu przegladu, nie tylko Obrazy.
      scrollable: [
        '[data-list="images"]',
        '[data-list="actors"]',
        '[data-list="scenes"]',
        '[data-list="journals"]',
        '[data-list="diagnostics"]',
        '[data-list="summaryDiagnostics"]',
      ],
    },
  };

  static open(data: ReviewScreenData): Promise<ReviewScreenResult> {
    return new Promise((resolve) => {
      const app = new ReviewScreen(data);
      app.#resolve = resolve;
      void app.render(true);
    });
  }

  #data: ReviewScreenData;
  #selection: ReviewSelection;
  #resolve: ((result: ReviewScreenResult) => void) | null = null;
  #settled = false;

  #step: ReviewStep = 'review';
  #tab: ReviewTab = 'images';
  /** [zgloszenie uzytkownika] Podzakladki WEWNATRZ zakladki Obrazy — patrz `ImageSourceTab`/`ImageDestTab`. */
  #imageSourceTab: ImageSourceTab = 'auto';
  // [zgloszenie uzytkownika, "wszystkie obrazy trafiaja do Nieprzydzielone"]
  // Domyslna podzakladka to teraz `unassigned` (nie `scene`) — skoro KAZDY
  // obraz startuje z tym przeznaczeniem, otwieranie na "Scena" pokazywaloby
  // pusta liste za kazdym razem.
  #imageDestTab: ImageDestTab = 'unassigned';

  #currentPageNumber = 1;
  #pageImageCache = new Map<number, string>();
  #pageImageOrder: number[] = [];
  static readonly #PAGE_CACHE_SIZE = 5;
  #pageRenderToken = 0;

  /** [KROK-11 Z3] Id obrazu podswietlonego przez klik NA LIScie LUB na nakladce bbox — dziala w obie strony. */
  #highlightedImageId: string | null = null;
  #overlayImages: readonly CIFImage[] = [];

  // ---- [zgloszenie uzytkownika, "przybliżenie PDFa w importerze"] --------
  /**
   * Przyblizenie podgladu strony — WSPOLNE dla zakladek Obrazy/Aktorzy (ten
   * sam wzorzec co `#currentPageNumber`). 100 = domyslna, stala ramka 3:4
   * z letterboxingiem (`bindery.css`, "NIETKNIETE" — literalny wymiar z
   * design-handoffu) — POWYZEJ 100 przelacza `.bindery-page-canvas-wrap` w
   * tryb przewijany (mirror `.bindery-profile-studio`'s juz istniejacego,
   * sprawdzonego uzycia tego samego uktladu: `overflow:auto`, obraz
   * skalowany WYLACZNIE szerokoscia). Zmiana zoomu jest CELOWO surgical
   * (`#setZoom`, bez `void this.render()`) — pelny render podmienilby caly
   * korzen czesci i zresetowal przewijanie listy obrazow (ten sam mechanizm
   * co `scrollable` powyzej naprawia dla INNYCH akcji, ale zoom nie musi w
   * ogole przez niego przechodzic, skoro to czysto wizualna zmiana stylu).
   */
  static readonly #MIN_ZOOM = 100;
  static readonly #MAX_ZOOM = 300;
  static readonly #ZOOM_STEP = 25;
  #zoomPercent = ReviewScreen.#MIN_ZOOM;
  /** [zgloszenie uzytkownika, "wolalbym mniejszy kat niz 90 stopni, np. co 10"] Krok pojedynczego klikniecia `#rotateImage` — drobna korekta (np. lekko krzywo zeskanowana mapa), nie pelny obrot o cwiartke. */
  static readonly #IMAGE_ROTATE_STEP_DEG = 10;

  // ---- [KROK-18] "Zaznacz i wytnij" — reczny wybor fragmentu strony --------
  /** Tryb wlaczony/wylaczony przyciskiem w toolbarze podgladu strony — patrz `#onToggleSelectMode`. */
  #isSelectMode = false;
  /** Licznik dla `id` reczne dodanych obrazow (`manual-crop-N`) — unikalne w obrebie TEJ sesji przegladu, to jedyne wymaganie (patrz `buildCIFImages` w core: `id` jest jedynie kluczem lokalnym dla tego dokumentu). */
  #manualCropSeq = 0;
  /** Stan trwajacego przeciagniecia (miedzy pointerdown a pointerup) — `null` gdy nic sie nie przeciaga. Wspolrzedne w przestrzeni viewBox nakladki SVG (te same piksele co wyrenderowany podglad strony). */
  #dragState: { startScreen: { x: number; y: number }; rectEl: SVGRectElement } | null = null;
  /** Chroni przed rownoleglymi/nachodzacymi na siebie wycieciami (np. drugi drag zanim pierwszy render regionu sie skonczyl). */
  #isCropping = false;
  /**
   * [zgloszenie uzytkownika, "obrocic zaznaczony obszar przed wycieciem"] Po
   * zakonczeniu przeciagniecia (`finishDrag`) NIE wycinamy juz od razu —
   * przechodzimy w stan "dostrajania obrotu": ten prostokat (wspolrzedne w
   * TEJ SAMEJ przestrzeni viewBox co `#dragState`) jest rysowany z uchwytem
   * do przeciagniecia (`#renderPendingCropOverlay`) i paskiem
   * zatwierdz/anuluj (`#showPendingCropToolbar`), az uzytkownik potwierdzi
   * (`#confirmPendingCrop`) lub anuluje (`#cancelPendingCrop`). `null` gdy
   * nic nie jest w trakcie dostrajania.
   */
  #pendingCrop: RotatedRect | null = null;
  /** Numer strony, NA KTOREJ powstal `#pendingCrop` — wspolrzedne pikselowe maja sens WYLACZNIE dla tej konkretnej strony/podgladu. Kazde miejsce zmieniajace `#currentPageNumber` (nawigacja ◄/►, klik na wierszu obrazu/aktora z innej strony, wpisanie numeru strony) musi wyzerowac `#pendingCrop` — `draw()` w `#mountOverlay` sprawdza to jako dodatkowa siatka bezpieczenstwa, patrz nizej. */
  #pendingCropPageNumber: number | null = null;
  /** Element paska zatwierdz/anuluj dodany DYNAMICZNIE do `.bindery-page-canvas-wrap` (jak `rectEl` w `#dragState` — nie ma go w markupie Handlebars) — trzymany tu, zeby go usunac przy zatwierdzeniu/anulowaniu/zmianie strony. */
  #pendingCropToolbar: HTMLElement | null = null;
  /**
   * [zgloszenie uzytkownika, "mozliwosc obrocenia zaznaczonego automatycznie
   * obrazu"] Obrot NA ZYWO dostrajany uchwytem w `#renderResizeHandles` dla
   * PODSWIETLONEGO obrazu — trzymany osobno od `image.provenance.bbox`
   * (ktory jest ZAWSZE rownolegly do osi w calym projekcie) i skopowany do
   * `imageId`, zeby przypadkowo nie "przeciekl" na inny obraz, gdyby
   * podswietlenie sie zmienilo bez pelnego renderu. Zerowany po udanym
   * `#resizeImage` (patrz tam) — inaczej NASTEPNA edycja tego samego obrazu
   * zaczelaby od bledna, "podwojonej" rotacji.
   */
  #imageAdjustRotation: { imageId: string; rotationRad: number } | null = null;
  /**
   * [KROK-19, zgloszony na zywo blad "wybiore Journal i zmienie strone, a
   * wraca Scena"] Pasek operacji zbiorczych (`bulkDestination`/
   * `bulkJournalGroup`) to zwykly `<select>`/`<input>` w markupie Handlebars,
   * BEZ zadnego `{{value}}` bindowanego do trwalego stanu (w odroznieniu od
   * np. `targets.namePrefix`) — kazdy `render()` (w tym zwykla nawigacja
   * podgladu strony ◄/►) odtwarza je OD ZERA, a przegladarka domyslnie
   * zaznacza PIERWSZA opcje `<select>` ("Scena"), cicho gubiac wybor
   * uzytkownika. Te dwa pola pamietaja ostatni wybor i sa przywracane w
   * `#wireBulkImageControls` po kazdym montowaniu zakladki Obrazy.
   */
  #bulkDestinationValue: ImageDestination = 'scene';
  #bulkJournalGroupValue = '';
  #imageList: VirtualList<CIFImage> | null = null;
  #sceneList: VirtualList<CIFScene> | null = null;
  #journalRows: JournalRow[] = [];
  #journalList: VirtualList<JournalRow> | null = null;
  #diagnosticGroups: DiagnosticGroup[] = [];
  #diagnosticList: VirtualList<DiagnosticGroup> | null = null;
  #thumbnailUrls = new Map<string, string>();
  /**
   * [naprawa zgloszonego bledu, "po 36 obrotach po 10° obraz powinien wrocic
   * do poczatkowej postaci (360°), a kurczy sie z kazdym obrotem"] Kazde
   * `#rotateImage` PRZED ta naprawa obracalo juz-przyciety WYNIK poprzedniego
   * obrotu, wiec strata przy przycinaniu (`inscribedRotatedRectScale` < 1 dla
   * kazdego kata poza wielokrotnoscia 180°) KUMULOWALA SIE wykladniczo mimo
   * ze sumaryczny kat wracal do 0°. Naprawa: pamietaj PIERWOTNE bajty (z
   * momentu PIERWSZEGO klikniecia obrotu dla danego obrazu, jeszcze przed
   * jakimkolwiek przycieciem) + sumaryczny kat W STOPNIACH (int, modulo
   * 360 — zero dryfu zmiennoprzecinkowego z wielokrotnego dodawania radianow)
   * i ZAWSZE obracaj PIERWOTNE bajty o CALY sumaryczny kat od zera, nigdy
   * wynik poprzedniego obrotu. Przy sumarycznym kacie 0° (kazda wielokrotnosc
   * 360°) `inscribedRotatedRectScale` zwraca DOKLADNIE 1 — pelny, dokladny
   * powrot do oryginalu. Czyszczone w `#resizeImage` (swiezy crop z PDF-a to
   * NOWY punkt odniesienia "0°", stare `originalBytes` juz nie obowiazuja).
   */
  #imageRotationState = new Map<string, { originalBytes: Uint8Array; originalFormat: string; totalDeg: number }>();
  /**
   * [zgloszenie uzytkownika, "wybieram obraz z listy, przeskakuje na
   * początek"] Pozycja przewijania KAZDEJ wirtualizowanej listy, sledzona
   * NA ZYWO (patrz `VirtualList`'s `onScroll`) i przywracana przy kazdym
   * ponownym montowaniu (`initialScrollTop`) — Foundry'owy `scrollable`
   * (`PARTS.main` wyzej) NIE dziala dla tych list, patrz uzasadnienie przy
   * `initialScrollTop` w `VirtualList.ts`. Klucz = ten sam string co
   * `data-list="..."` w szablonie, WYLACZNIE do czytelnosci (nie odczytywany
   * z DOM-u).
   */
  #listScrollTop: Record<string, number> = {};

  // ---- [KROK-20 Z2] Zakladka aktorow --------------------------------------
  #actorSelection: ActorReviewSelection;
  /** [KROK-20 Z3] Id aktora podswietlonego przez klik na liscie LUB na nakladce bbox — mirror `#highlightedImageId`. */
  #highlightedActorId: string | null = null;
  /**
   * [KROK-20 Z2] `coc7Adapter.fromActor` policzony NAD PRZEGLADANYMI danymi
   * (nadpisania uzytkownika juz wliczone przez `applyActorOverrides`) — WYLACZNIE
   * do PODGLADU `notes`/`issues` w tym ekranie (A3/A10: "pola nieparsowane
   * widoczne, nie ukryte"). `#runImport` liczy WLASNY, niezalezny wynik tuz
   * przed zapisem (na najswiezszym stanie `#actorSelection`) — ta mapa to
   * WYLACZNIE cache do wyswietlenia, nigdy zrodlo prawdy dla importu.
   */
  #actorAdapterPreview = new Map<string, AdapterResult<Coc7ActorPayload>>();

  #targets: ImportTargets;
  #isImporting = false;
  #importError: string | null = null;
  #summaryEntries: { label: string; uuid?: string }[] = [];
  #summaryDiagnostics: Diagnostic[] = [];

  constructor(data: ReviewScreenData) {
    super();
    this.#data = data;
    this.#selection = ReviewSelection.fromDocument(data.document);
    this.#actorSelection = ActorReviewSelection.fromDocument(data.document);
    this.#rebuildJournalRows();
    this.#rebuildDiagnosticGroups();
    this.#rebuildActorAdapterPreview();
    const stored = game.settings!.get(MODULE_ID, 'importTargets') as ImportTargets;
    // [KROK-19 Z3] `actorFolder` moze byc `undefined` w ustawieniach
    // zapisanych PRZED tym krokiem (stary domyslny obiekt nie mial tego pola)
    // — ten ekran (jeszcze) nie zarzadza aktorami, wiec wystarczy defensywny
    // fallback, zeby nie zlamac `ImportTargets` na starszych swiatach.
    this.#targets = { sceneFolder: stored.sceneFolder, journalFolder: stored.journalFolder, actorFolder: stored.actorFolder ?? '', namePrefix: stored.namePrefix };
  }

  #rebuildJournalRows(): void {
    const rows: JournalRow[] = [];
    for (const journal of this.#data.document.journals) {
      rows.push({ kind: 'journal', journal });
      journal.pages.forEach((page, index) => {
        rows.push({ kind: 'page', journal, pageId: page.id, pageName: page.name, pageIndex: index });
      });
    }
    this.#journalRows = rows;
  }

  /**
   * [KROK-20 Z2] Przelicza `notes`/`issues` PODGLADOWE dla WSZYSTKICH
   * aktorow, nad danymi PO nadpisaniach uzytkownika (`applyActorOverrides`)
   * — wywolywane po kazdej edycji nazwy/wartosci/ataku, zeby lista notatek w
   * wierszu odzwierciedlala TO, co user wlasnie zmienil (A3/A10: aktor
   * ukrywajacy wlasna niepewnosc jest "szybszy do przejrzenia i mniej
   * bezpieczny" — MDD P6, przestroga wprost z tego kroku).
   */
  #rebuildActorAdapterPreview(): void {
    this.#actorAdapterPreview.clear();
    for (const actor of this.#data.document.actors ?? []) {
      const patched = applyActorOverrides(actor, this.#actorSelection);
      const ctx = { folderId: null, imagePathResolver: () => null, language: null, profileId: null };
      // `coc7Adapter` jest typowany jako `SystemAdapter` (kontrakt §5.6, `fromActor` zwraca `AdapterResult<object>`)
      // — bezpieczny rzut na konkretny ksztalt WLASNEJ implementacji (`coc7.ts`), tak jak `createActors.ts` juz robi.
      this.#actorAdapterPreview.set(actor.id, coc7Adapter.fromActor(patched, ctx) as AdapterResult<Coc7ActorPayload>);
    }
  }

  #rebuildDiagnosticGroups(): void {
    const byCode = new Map<string, Diagnostic[]>();
    for (const d of this.#data.document.diagnostics) {
      const arr = byCode.get(d.code) ?? [];
      arr.push(d);
      byCode.set(d.code, arr);
    }
    this.#diagnosticGroups = [...byCode.entries()]
      .map(([code, examples]) => ({ code, severity: examples[0]!.severity, count: examples.length, examples: examples.slice(0, 20) }))
      .sort((a, b) => b.count - a.count);
  }

  /** [zgloszenie uzytkownika] `manual-crop-` to JEDYNY miejsce, gdzie ten prefiks jest nadawany (`#createManualCrop`) — bezpieczne rozpoznanie zrodla bez dodatkowego pola na `CIFImage`. */
  static #isManualImage(image: CIFImage): boolean {
    return image.id.startsWith('manual-crop-');
  }

  /** Lista Obrazow PO obu poziomach filtrowania (zrodlo + przeznaczenie), w tej samej kolejnosci co `sortImagesForReview` — jedyne miejsce, ktore `#mountImageList`/`#mountOverlay` faktycznie widza. */
  #visibleImages(): CIFImage[] {
    return sortImagesForReview(this.#data.document.images).filter(
      (i) => (ReviewScreen.#isManualImage(i) ? 'manual' : 'auto') === this.#imageSourceTab && this.#selection.imageDestination(i.id) === this.#imageDestTab,
    );
  }

  /** Liczniki dla podzakladek zrodla ("Automatycznie wykryte"/"Zaznaczone ręcznie") — CALY dokument, niezaleznie od aktywnej podzakladki przeznaczenia. */
  #imageSourceCounts(): { auto: number; manual: number } {
    let auto = 0;
    let manual = 0;
    for (const image of this.#data.document.images) {
      if (ReviewScreen.#isManualImage(image)) manual++;
      else auto++;
    }
    return { auto, manual };
  }

  /** Liczniki dla podzakladek przeznaczenia (Scena/Journal/Token/Nieprzydzielone) — WYLACZNIE w obrebie aktywnej podzakladki zrodla. */
  #imageDestCounts(): Record<ImageDestTab, number> {
    const counts: Record<ImageDestTab, number> = { scene: 0, journal: 0, token: 0, unassigned: 0 };
    for (const image of this.#data.document.images) {
      if ((ReviewScreen.#isManualImage(image) ? 'manual' : 'auto') !== this.#imageSourceTab) continue;
      counts[this.#selection.imageDestination(image.id)]++;
    }
    return counts;
  }

  override async _prepareContext(): Promise<Record<string, unknown>> {
    const doc = this.#data.document;
    const sortedImages = this.#visibleImages();
    const sourceCounts = this.#imageSourceCounts();
    const destCounts = this.#imageDestCounts();
    return {
      isStepReview: this.#step === 'review',
      isStepTarget: this.#step === 'target',
      isStepSummary: this.#step === 'summary',
      // [redesign 2a] Tor krokow w lewej kolumnie — "Plik" jest ZAWSZE
      // ukonczony (PDF zostal juz wybrany w ImportWizard, zanim ten ekran
      // w ogole istnieje), "Przeglad"/"Import" przechodza done/active/future
      // wzgledem `#step`.
      step2Done: this.#step !== 'review',
      step2Active: this.#step === 'review',
      step3Done: this.#step === 'summary',
      step3Active: this.#step === 'target',
      step3Future: this.#step === 'review',
      // [KROK-44 Z1] Patrz `features.ts` — pierwsze wydanie publiczne
      // obejmuje wylacznie obrazy. Zakladka Aktorzy ukryta w szablonie
      // (`{{#if statblocksEnabled}}`), wiec `this.#tab` nigdy faktycznie nie
      // stanie sie `'actors'` przez UI, ale kontekst i tak przekazuje flage
      // wprost zamiast polegac na tym posrednio.
      statblocksEnabled: STATBLOCKS_ENABLED,
      isTabImages: this.#tab === 'images',
      isTabScenes: this.#tab === 'scenes',
      isTabJournals: this.#tab === 'journals',
      isTabActors: this.#tab === 'actors',
      isTabDiagnostics: this.#tab === 'diagnostics',
      // [zgloszenie uzytkownika, "dwie zakladki: automatycznie i recznie" +
      // podzakladki Scena/Journal/Token] Patrz `#visibleImages`/`ImageSourceTab`/
      // `ImageDestTab` — CZYSTA prezentacja nad juz istniejacym stanem
      // (`ReviewSelection.imageDestination`, `id` obrazu), zero nowej logiki
      // decyzyjnej.
      isImageSourceAuto: this.#imageSourceTab === 'auto',
      isImageSourceManual: this.#imageSourceTab === 'manual',
      autoImageCount: sourceCounts.auto,
      manualImageCount: sourceCounts.manual,
      isImageDestScene: this.#imageDestTab === 'scene',
      isImageDestJournal: this.#imageDestTab === 'journal',
      isImageDestToken: this.#imageDestTab === 'token',
      isImageDestUnassigned: this.#imageDestTab === 'unassigned',
      imageDestSceneCount: destCounts.scene,
      imageDestJournalCount: destCounts.journal,
      imageDestTokenCount: destCounts.token,
      imageDestUnassignedCount: destCounts.unassigned,
      imageCount: doc.images.length,
      sceneCount: doc.scenes.length,
      journalCount: doc.journals.length,
      actorCount: doc.actors?.length ?? 0,
      // [KROK-21 Z1] `doc.actors === undefined` = zaden profil nie zostal
      // przekazany do budowy tego dokumentu (patrz `buildCIFFromDocument`,
      // `profile` opcjonalne) — odrebne od "profil byl, ale nic nie
      // znalazl" (`doc.actors === []`, `hasActorProfile` wtedy `true`).
      // Rozroznienie potrzebne, zeby zakladka Aktorow mogla wyjasnic
      // uzytkownikowi CO sie stalo zamiast pokazywac pusta liste bez powodu.
      hasActorProfile: doc.actors !== undefined,
      diagnosticGroupCount: this.#diagnosticGroups.length,
      selectedImageCount: this.#selection.selectedImageCount,
      selectedSceneCount: this.#selection.selectedSceneCount,
      selectedJournalCount: this.#selection.selectedJournalCount,
      selectedActorCount: this.#actorSelection.selectedCount,
      // [zgloszenie uzytkownika, "nie da sie importowac NPC bez tokena,
      // przycisk Next jest wyszarzony"] Przycisk "Dalej" na ekranie przegladu
      // byl zablokowany WYLACZNIE warunkiem `selectedImageCount` (patrz
      // `review-screen.hbs`) — autor chcacy zaimportowac SAME aktory (bez
      // zaznaczania zadnego obrazu jako token/scene/journal) nie mial jak
      // przejsc dalej, mimo ze `selectedActorCount` byl > 0. Suma WSZYSTKICH
      // czterech niezaleznych kategorii ("czy jest COKOLWIEK do zaimportowania"),
      // nie tylko obrazow.
      totalSelectedCount: this.#selection.selectedImageCount + this.#selection.selectedSceneCount + this.#selection.selectedJournalCount + this.#actorSelection.selectedCount,
      currentPageNumber: this.#currentPageNumber,
      pageCount: this.#data.previewDocument.pageCount,
      canGoPrevPage: this.#currentPageNumber > 1,
      canGoNextPage: this.#currentPageNumber < this.#data.previewDocument.pageCount,
      currentPageImageUrl: this.#pageImageCache.get(this.#currentPageNumber) ?? null,
      isSelectMode: this.#isSelectMode,
      zoomPercent: this.#zoomPercent,
      isZoomed: this.#zoomPercent > ReviewScreen.#MIN_ZOOM,
      canZoomIn: this.#zoomPercent < ReviewScreen.#MAX_ZOOM,
      canZoomOut: this.#zoomPercent > ReviewScreen.#MIN_ZOOM,
      targets: this.#targets,
      isImporting: this.#isImporting,
      importError: this.#importError,
      summaryEntries: this.#summaryEntries,
      summaryHasIssues: this.#summaryDiagnostics.length > 0,
      _sortedImages: sortedImages,
      _actors: doc.actors ?? [],
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override async _onRender(context: any, options: any): Promise<void> {
    await super._onRender(context, options);

    // [na zyczenie uzytkownika, ten sam wzorzec co Profile Studio] Nawigacja
    // WYLACZNIE przyciskami ◄/► byla uciazliwa na dlugich dokumentach — pole
    // liczbowe pozwala wpisac numer strony wprost. Wspolne dla zakladek
    // Obrazy/Aktorzy (`#currentPageNumber` to JEDNO, dzielone pole) — w DOM
    // istnieje najwyzej jeden `[data-input="pageNumber"]` naraz (druga
    // zakladka nie jest wyrenderowana), wiec zapytanie zawsze trafia we
    // wlasciwy input niezaleznie od aktywnej zakladki.
    const pageNumberInput = this.element.querySelector<HTMLInputElement>('input[data-input="pageNumber"]');
    pageNumberInput?.addEventListener('change', () => {
      const parsed = Math.round(Number(pageNumberInput.value));
      const pageCount = this.#data.previewDocument.pageCount;
      const clamped = Math.min(Math.max(Number.isFinite(parsed) ? parsed : this.#currentPageNumber, 1), Math.max(pageCount, 1));
      pageNumberInput.value = String(clamped);
      if (clamped !== this.#currentPageNumber) {
        this.#currentPageNumber = clamped;
        void this.render();
      }
    });
    pageNumberInput?.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') pageNumberInput.blur();
    });

    this.#imageList?.destroy();
    this.#imageList = null;
    this.#sceneList?.destroy();
    this.#sceneList = null;
    this.#journalList?.destroy();
    this.#journalList = null;
    this.#diagnosticList?.destroy();
    this.#diagnosticList = null;

    // [zgloszenie uzytkownika] Zastosowane PRZED montowaniem nakladki
    // (`#mountOverlay`/`#mountActorOverlay` nizej) — `draw()` tam czyta
    // `img.clientWidth` do wyskalowania SVG, wiec obraz musi juz miec
    // docelowa (ewentualnie przyblizona) szerokosc, zanim to sie stanie.
    // Bez tego kazda nawigacja miedzy stronami (pelny `render()`, nowy
    // element `<img>` od zera) cicho gubilaby aktualny poziom przyblizenia.
    this.#applyZoomToDom();

    if (this.#step === 'review') {
      if (this.#tab === 'images') {
        void this.#ensurePageImage(this.#currentPageNumber);
        this.#mountImageList(context._sortedImages as CIFImage[]);
        void this.#mountOverlay(context._sortedImages as CIFImage[]);
        this.#wireBulkImageControls();
      } else if (this.#tab === 'scenes') {
        this.#mountSceneList();
      } else if (this.#tab === 'journals') {
        this.#mountJournalList();
      } else if (this.#tab === 'actors') {
        void this.#ensurePageImage(this.#currentPageNumber);
        this.#mountActorList(context._actors as CIFActor[]);
        void this.#mountActorOverlay(context._actors as CIFActor[]);
      } else if (this.#tab === 'diagnostics') {
        this.#mountDiagnosticList(this.element.querySelector<HTMLElement>('[data-list="diagnostics"]'));
      }
      this.#wireTargetInputs();
    } else if (this.#step === 'target') {
      this.#wireTargetInputs();
    } else if (this.#step === 'summary') {
      this.#mountDiagnosticList(this.element.querySelector<HTMLElement>('[data-list="summaryDiagnostics"]'), this.#summaryDiagnostics);
    }
  }

  override async close(options?: object): Promise<this> {
    this.#imageList?.destroy();
    this.#sceneList?.destroy();
    this.#journalList?.destroy();
    this.#diagnosticList?.destroy();
    for (const url of this.#pageImageCache.values()) URL.revokeObjectURL(url);
    for (const url of this.#thumbnailUrls.values()) URL.revokeObjectURL(url);
    await this.#data.previewDocument.destroy();
    if (!this.#settled) {
      this.#settled = true;
      this.#resolve?.({ confirmed: false });
    }
    return super.close(options);
  }

  // ---- Podglad strony (Z3) ----------------------------------------------

  async #ensurePageImage(pageNumber: number): Promise<void> {
    if (this.#pageImageCache.has(pageNumber)) return;
    const token = ++this.#pageRenderToken;
    try {
      const encoded = await this.#data.previewDocument.renderPage(pageNumber, { targetLongEdgePx: 1400, format: 'webp' });
      if (token !== this.#pageRenderToken) return; // uzytkownik juz przeszedl dalej — porzuc przestarzaly wynik
      const url = URL.createObjectURL(new Blob([new Uint8Array(encoded.bytes)], { type: 'image/webp' }));
      this.#pageImageCache.set(pageNumber, url);
      this.#pageImageOrder.push(pageNumber);
      while (this.#pageImageOrder.length > ReviewScreen.#PAGE_CACHE_SIZE) {
        const evict = this.#pageImageOrder.shift()!;
        const evictUrl = this.#pageImageCache.get(evict);
        if (evictUrl) URL.revokeObjectURL(evictUrl);
        this.#pageImageCache.delete(evict);
      }
      if (this.#tab === 'images' && this.#step === 'review') await this.render();
    } catch (err) {
      console.warn('Bindery | renderPage nieudany:', err);
    }
  }

  /** Ponowny rysunek nakladki na TEJ SAMEJ (juz zaladowanej) stronie — bez pelnego `render()`, wiec nie gubi przewijania listy. `getPageBox` jest cache'owane w `PreviewDocument`, wiec to tanie. */
  async #redrawOverlay(): Promise<void> {
    await this.#mountOverlay(this.#overlayImages);
  }

  async #mountOverlay(images: readonly CIFImage[]): Promise<void> {
    this.#overlayImages = images;
    const svg = this.element.querySelector<SVGSVGElement>('[data-overlay]');
    const img = this.element.querySelector<HTMLImageElement>('.bindery-page-image');
    if (!svg || !img) return;

    // [naprawa zgloszonego bledu — recenzja calego designu] `_onRender`
    // wywoluje `#mountOverlay` bez `await` (celowo — nie chcemy blokowac
    // zakonczenia renderu na doladowaniu geometrii strony), wiec KOLEJNY
    // pelny render (np. drugi klik "nastepna strona" zanim `getPageBox`
    // ponizej sie rozwiaze) moze podmienic `#currentPageNumber` ZANIM ten
    // `await` wroci. Bez tej sprawdzajacej flagi nakladka rysowalaby
    // prostokaty policzone dla NIEAKTUALNEJ juz strony na obrazie strony
    // BIEZACEJ — kolejny (juz w locie) `#mountOverlay` i tak zaraz narysuje
    // poprawna nakladke, wiec bezpiecznie po prostu pomijamy rysowanie tutaj.
    const requestedPageNumber = this.#currentPageNumber;
    const box = await this.#data.previewDocument.getPageBox(requestedPageNumber);
    if (this.#currentPageNumber !== requestedPageNumber) return;
    const draw = () => {
      const width = img.naturalWidth || img.clientWidth;
      const height = img.naturalHeight || img.clientHeight;
      if (!width || !height) return;
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      // [KROK-18, naprawa zgloszonego bledu "nie trafia, jest przesuniete w
      // prawo"] Nakladka MUSI miec CSS box o dokladnie takich samych
      // proporcjach co viewBox, inaczej domyslne `preserveAspectRatio` SVG
      // ("xMidYMid meet") dokleja niewidoczne listwy i centruje/skaluje
      // tresc SVG wewnatrz swojego pudelka — `width:100%;height:100%` z CSS
      // liczy sie wzgledem `.bindery-page-canvas-wrap` (wysokosc ograniczona
      // przez layout), NIE wzgledem faktycznie wyrenderowanego `<img>`
      // (ktory dla wysokiej strony jest wyzszy i przewijany), wiec proporcje
      // sie nie zgadzaly i naiwne przeliczenie w `toOverlayPoint` (proste
      // `viewBox/rect`) dawalo bledny wynik.
      svg.style.width = `${img.clientWidth}px`;
      svg.style.height = `${img.clientHeight}px`;
      svg.innerHTML = '';
      for (const image of images) {
        if (image.provenance.pageNumber !== this.#currentPageNumber) continue;
        const screen = pdfRectToScreen(image.provenance.bbox, { pageBox: box.box, imageWidthPx: width, imageHeightPx: height, rotation: box.rotation as never });
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', String(screen.minX));
        rect.setAttribute('y', String(screen.minY));
        rect.setAttribute('width', String(Math.max(0, screen.maxX - screen.minX)));
        rect.setAttribute('height', String(Math.max(0, screen.maxY - screen.minY)));
        const isHighlighted = image.id === this.#highlightedImageId;
        const classes = [this.#selection.isImageSelected(image.id) ? 'bindery-overlay-selected' : 'bindery-overlay-unselected'];
        if (isHighlighted) classes.push('bindery-overlay-highlighted');
        rect.setAttribute('class', classes.join(' '));
        rect.dataset['imageId'] = image.id;
        rect.addEventListener('click', () => {
          this.#highlightedImageId = image.id;
          this.#imageList?.scrollToIndex(images.findIndex((i) => i.id === image.id));
          this.#refreshImageRowHighlights();
          draw();
        });
        svg.appendChild(rect);
        // [zgloszenie uzytkownika, "mozliwosc zmiany rozmiaru automatycznie
        // znalezionego obrazu"] Uchwyty pojawiaja sie WYLACZNIE na aktualnie
        // podswietlonym obrazie (ten sam mechanizm co klik na wierszu listy/
        // prostokacie — nic nowego do wlaczania) — reuzycie `#highlightedImageId`
        // zamiast osobnego trybu.
        if (isHighlighted && !this.#pendingCrop) this.#renderResizeHandles(svg, image, rect, screen);
      }
      if (this.#pendingCrop && this.#pendingCropPageNumber !== this.#currentPageNumber) {
        // Zabezpieczenie: przejscie na inna strone (nawigacja ◄/►, klik na
        // wierszu obrazu/aktora z innej strony) juz powinno wyzerowac
        // `#pendingCrop` u zrodla — to dodatkowa siatka, zeby PRZYPADKOWO
        // nie wyciac fragmentu jednej strony na podstawie wspolrzednych
        // narysowanych na zupelnie innej.
        this.#pendingCrop = null;
        this.#pendingCropPageNumber = null;
        this.#teardownPendingCropUi();
      }
      this.#renderPendingCropOverlay(svg);
    };
    if (img.complete) draw();
    else img.addEventListener('load', draw, { once: true });

    this.#wireSelectDrag(svg, img, draw);
  }

  // ---- [KROK-18] "Zaznacz i wytnij" ---------------------------------------

  static async #onToggleSelectMode(this: ReviewScreen): Promise<void> {
    this.#isSelectMode = !this.#isSelectMode;
    this.#dragState = null;
    this.#pendingCrop = null;
    this.#pendingCropPageNumber = null;
    this.#teardownPendingCropUi();
    await this.render();
  }

  /**
   * Podpina przeciaganie myszka NA `svg` (nie na pojedynczych prostokatach
   * nakladki) — `pointerdown` na dziecku i tak wypluje sie do rodzica przez
   * bubbling, wiec jeden zestaw nasluchiwaczy na calej nakladce wystarcza.
   * Flaga `dataset['dragWired']` chroni przed powtornym podpieciem przy
   * KAZDYM wywolaniu `#mountOverlay`/`#redrawOverlay` (klik na istniejacym
   * prostokacie odswieza nakladke bez pelnego `render()`, wiec ten sam
   * element `<svg>` moze przejsc przez `#mountOverlay` wielokrotnie) —
   * element `<svg>` PRZETRWA `svg.innerHTML = ''` w `draw()` (czysci tylko
   * dzieci), wiec flaga na nim samym jest bezpiecznym, trwalym znacznikiem.
   */
  #wireSelectDrag(svg: SVGSVGElement, img: HTMLImageElement, redraw: () => void): void {
    if (svg.dataset['dragWired']) return;
    svg.dataset['dragWired'] = '1';

    // Rozmiar okna Foundry (a wiec i wyrenderowanego <img>) moze sie zmienic
    // PO pierwszym `draw()` (przeciaganie/resize okna ApplicationV2) — bez
    // tego nakladka zostalaby przy starym rozmiarze i letterboxing/przesuniecie
    // wrocilyby po kazdej zmianie rozmiaru okna.
    new ResizeObserver(() => redraw()).observe(img);

    svg.addEventListener('pointerdown', (e: PointerEvent) => {
      if (!this.#isSelectMode || this.#isCropping || this.#pendingCrop || e.button !== 0) return;
      e.preventDefault();
      const start = this.#toOverlayPoint(svg, e.clientX, e.clientY);
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
      const cur = this.#toOverlayPoint(svg, e.clientX, e.clientY);
      rectEl.setAttribute('x', String(Math.min(startScreen.x, cur.x)));
      rectEl.setAttribute('y', String(Math.min(startScreen.y, cur.y)));
      rectEl.setAttribute('width', String(Math.abs(cur.x - startScreen.x)));
      rectEl.setAttribute('height', String(Math.abs(cur.y - startScreen.y)));
    });

    const MIN_DRAG_PX = 8; // ponizej tego traktujemy jako przypadkowy klik, nie swiadome zaznaczenie
    const finishDrag = (e: PointerEvent): void => {
      if (!this.#dragState) return;
      const { startScreen, rectEl } = this.#dragState;
      this.#dragState = null;
      rectEl.remove();
      const cur = this.#toOverlayPoint(svg, e.clientX, e.clientY);
      const screenRect: Rect = {
        minX: Math.min(startScreen.x, cur.x),
        maxX: Math.max(startScreen.x, cur.x),
        minY: Math.min(startScreen.y, cur.y),
        maxY: Math.max(startScreen.y, cur.y),
      };
      if (screenRect.maxX - screenRect.minX < MIN_DRAG_PX || screenRect.maxY - screenRect.minY < MIN_DRAG_PX) return;
      // [zgloszenie uzytkownika, "obrocic zaznaczony obszar przed wycieciem"]
      // NIE wycinamy juz od razu — przechodzimy w stan "dostrajania obrotu"
      // (uchwyt + pasek zatwierdz/anuluj), patrz `#pendingCrop`.
      this.#pendingCrop = {
        centerX: (screenRect.minX + screenRect.maxX) / 2,
        centerY: (screenRect.minY + screenRect.maxY) / 2,
        width: screenRect.maxX - screenRect.minX,
        height: screenRect.maxY - screenRect.minY,
        rotationRad: 0,
      };
      this.#pendingCropPageNumber = this.#currentPageNumber;
      this.#renderPendingCropOverlay(svg);
      const wrap = svg.closest<HTMLElement>('.bindery-page-canvas-wrap');
      if (wrap) this.#showPendingCropToolbar(wrap);
    };
    svg.addEventListener('pointerup', finishDrag);
    svg.addEventListener('pointercancel', finishDrag);
  }

  /**
   * [zgloszenie uzytkownika, "obszar jest przesuniety w prawo wzgledem
   * kursora"] `rect` to CALY box `<svg>` — rozmiar RAMKI (`img.clientWidth/
   * Height`, patrz komentarz przy `.bindery-page-canvas-wrap`), NIE
   * rozmiar faktycznie widocznej (letterboxowanej) tresci. `viewBox`'s
   * domyslne `preserveAspectRatio="xMidYMid meet"` skaluje SWOJA TRESC
   * (prostokaty nakladki) do NAJWIEKSZEGO fragmentu `rect` o proporcjach
   * `viewBox`, WYSRODKOWANEGO — dokladnie to samo, co `object-fit: contain`
   * robi z samym `<img>` (stad puste paski widoczne na ekranie za kazdym
   * razem, gdy proporcje strony PDF nie sa DOKLADNIE 3:4). Prostokaty
   * nakladki (rysowane w jednostkach `viewBox`) trafiaja wiec poprawnie —
   * ten sam mechanizm SVG je pozycjonuje. Naiwne dzielenie `vb.width/
   * rect.width` (bez tej samej korekty) zakladalo, ze tresc wypelnia CALY
   * `rect`, wiec KAZDY klik/przeciagniecie bylo przesuniete o polowe
   * szerokosci paska litery-boxingu — male, ale realne przesuniecie w
   * prawo (lub w dol) przy kazdej stronie, ktorej proporcje nie sa
   * dokladnie 3:4 (czyli niemal kazdej). Przy zoomie (`bindery-zoomed`,
   * `object-fit:none`, `<img>` skalowany wylacznie szerokoscia) `rect` i
   * `viewBox` maja te sama proporcje z definicji — formula ponizej wtedy
   * degeneruje sie do dawnego (poprawnego w tym przypadku) zachowania.
   */
  #toOverlayPoint(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } {
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    if (rect.width <= 0 || rect.height <= 0 || vb.width <= 0 || vb.height <= 0) {
      return { x: clientX - rect.left, y: clientY - rect.top };
    }
    const rectAspect = rect.width / rect.height;
    const vbAspect = vb.width / vb.height;
    let contentWidth = rect.width;
    let contentHeight = rect.height;
    let offsetX = 0;
    let offsetY = 0;
    if (vbAspect > rectAspect) {
      contentHeight = rect.width / vbAspect;
      offsetY = (rect.height - contentHeight) / 2;
    } else if (vbAspect < rectAspect) {
      contentWidth = rect.height * vbAspect;
      offsetX = (rect.width - contentWidth) / 2;
    }
    const scaleX = vb.width / contentWidth;
    const scaleY = vb.height / contentHeight;
    return { x: (clientX - rect.left - offsetX) * scaleX, y: (clientY - rect.top - offsetY) * scaleY };
  }

  /**
   * [zgloszenie uzytkownika, "obrocic zaznaczony obszar przed wycieciem",
   * uchwyt do przeciagniecia] Rysuje `#pendingCrop` jako `<g>` z
   * `transform="rotate(deg cx cy)"` (SVG-owy `rotate` uzywa DOKLADNIE tej
   * samej macierzy `[cos,-sin; sin,cos]` co `screenRotatedRectToPdf` po
   * stronie core — wiec to, co widac na ekranie, jest z definicji zgodne z
   * tym, co pozniej faktycznie zostanie wyciete). Uchwyt to prosty okrag NAD
   * srodkiem gornej krawedzi, W LOKALNYM (nieobroconym) ukladzie `<g>` —
   * obraca sie razem z prostokatem wylacznie dzieki transformowi rodzica,
   * bez osobnej algebry. Promien/odstep uchwytu przeliczone na jednostki
   * `viewBox` tak, zeby na EKRANIE mial stala wielkosc niezaleznie od
   * rozdzielczosci strony/poziomu przyblizenia (inaczej na wysokorozdzielczej
   * stronie uchwyt bylby niewidocznie maly).
   *
   * [kierunek obrotu] `rotationRad = atan2(dy, dx) + PI/2` (gdzie `dx,dy` to
   * wektor kursora wzgledem srodka) — wyprowadzone tak, zeby po zastosowaniu
   * DOKLADNIE tej samej macierzy obrotu co SVG `rotate()`, uchwyt (lokalnie
   * prosto NAD srodkiem) wyladowal DOKLADNIE pod kursorem: przeciaganie
   * uchwytu jest wiec z definicji WYSIWYG na ekranie. Czy koncowy, wycięty
   * PIKSELOWO obraz obraca sie w te sama strone co podglad na ekranie, NIE
   * bylo mozliwe zweryfikowac bez zywego testu w Foundry (patrz
   * `renderRotatedRegion.test.ts`) — jesli po zywym tescie okaze sie
   * odwrotnie, jedyna poprawka to negacja kata TU (w `rotationRad = ...`
   * ponizej), nie w warstwie `core`.
   */
  #renderPendingCropOverlay(svg: SVGSVGElement): void {
    svg.querySelector('.bindery-pending-crop')?.remove();
    const pending = this.#pendingCrop;
    if (!pending) return;

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const vb = svg.viewBox.baseVal;
    const svgRect = svg.getBoundingClientRect();
    const scale = vb.width > 0 && svgRect.width > 0 ? vb.width / svgRect.width : 1;
    const HANDLE_OFFSET_SCREEN_PX = 32;
    const HANDLE_RADIUS_SCREEN_PX = 8;
    const handleOffset = HANDLE_OFFSET_SCREEN_PX * scale;
    const handleRadius = HANDLE_RADIUS_SCREEN_PX * scale;

    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'bindery-pending-crop');
    const deg = (pending.rotationRad * 180) / Math.PI;
    g.setAttribute('transform', `rotate(${deg} ${pending.centerX} ${pending.centerY})`);

    const rectEl = document.createElementNS(SVG_NS, 'rect');
    rectEl.setAttribute('x', String(pending.centerX - pending.width / 2));
    rectEl.setAttribute('y', String(pending.centerY - pending.height / 2));
    rectEl.setAttribute('width', String(pending.width));
    rectEl.setAttribute('height', String(pending.height));
    rectEl.setAttribute('class', 'bindery-pending-crop-rect');
    g.appendChild(rectEl);

    const topY = pending.centerY - pending.height / 2;
    const handleY = topY - handleOffset;

    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', String(pending.centerX));
    line.setAttribute('y1', String(topY));
    line.setAttribute('x2', String(pending.centerX));
    line.setAttribute('y2', String(handleY));
    line.setAttribute('class', 'bindery-pending-crop-handle-line');
    g.appendChild(line);

    const handle = document.createElementNS(SVG_NS, 'circle');
    handle.setAttribute('cx', String(pending.centerX));
    handle.setAttribute('cy', String(handleY));
    handle.setAttribute('r', String(handleRadius));
    handle.setAttribute('class', 'bindery-pending-crop-handle');
    g.appendChild(handle);

    handle.addEventListener('pointerdown', (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e: PointerEvent) => {
      if (!this.#pendingCrop || !handle.hasPointerCapture(e.pointerId)) return;
      e.stopPropagation();
      const pt = this.#toOverlayPoint(svg, e.clientX, e.clientY);
      const angle = Math.atan2(pt.y - this.#pendingCrop.centerY, pt.x - this.#pendingCrop.centerX);
      this.#pendingCrop = { ...this.#pendingCrop, rotationRad: angle + Math.PI / 2 };
      // [zgloszenie uzytkownika, "bardzo opornie, kilka stopni na raz"]
      // NIE wolno tu wywolywac calego `#renderPendingCropOverlay` — ono
      // USUWA i TWORZY OD NOWA `handle` (przez `svg.querySelector(...)
      // .remove()` na poczatku), a usuniecie elementu z DOM ciagnacego
      // `setPointerCapture` cicho zwalnia te capture (przegladarka
      // automatycznie wysyla `lostpointercapture`). Nowy, swiezo utworzony
      // `handle` NIE ma capture, wiec KOLEJNE `pointermove` (kursor juz
      // daleko od jego pozycji) nie trafialy w niego wcale — stad "dziala
      // tylko o kilka stopni na raz" (jeden ruch = jedno zdarzenie zanim
      // handle zostal podmieniony). Podczas przeciagania zmienia sie
      // WYLACZNIE kat obrotu — geometria lokalna (rect/line/handle) jest
      // stala — wiec wystarczy podmienic `transform` na ISTNIEJACYM `g`,
      // bez przebudowy calej grupy/utraty capture.
      const deg = (this.#pendingCrop.rotationRad * 180) / Math.PI;
      g.setAttribute('transform', `rotate(${deg} ${this.#pendingCrop.centerX} ${this.#pendingCrop.centerY})`);
    });
    const releaseHandle = (e: PointerEvent): void => {
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    };
    handle.addEventListener('pointerup', releaseHandle);
    handle.addEventListener('pointercancel', releaseHandle);

    svg.appendChild(g);
  }

  /** Pasek zatwierdz/anuluj dodany DYNAMICZNIE do `.bindery-page-canvas-wrap` (jak `rectEl`/`#pendingCrop` — nie ma go w markupie Handlebars, patrz `#pendingCropToolbar`). */
  #showPendingCropToolbar(wrap: HTMLElement): void {
    this.#pendingCropToolbar?.remove();
    const toolbar = document.createElement('div');
    toolbar.className = 'bindery-pending-crop-toolbar';
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'bindery-btn bindery-btn--primary';
    confirmBtn.textContent = game.i18n!.localize('BINDERY.review.selectModeConfirmCrop' as never);
    confirmBtn.addEventListener('click', () => void this.#confirmPendingCrop());
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'bindery-btn';
    cancelBtn.textContent = game.i18n!.localize('BINDERY.review.selectModeCancelCrop' as never);
    cancelBtn.addEventListener('click', () => this.#cancelPendingCrop());
    toolbar.append(confirmBtn, cancelBtn);
    wrap.appendChild(toolbar);
    this.#pendingCropToolbar = toolbar;
  }

  #teardownPendingCropUi(): void {
    this.#pendingCropToolbar?.remove();
    this.#pendingCropToolbar = null;
  }

  async #confirmPendingCrop(): Promise<void> {
    const pending = this.#pendingCrop;
    if (!pending || this.#isCropping) return;
    this.#pendingCrop = null;
    this.#pendingCropPageNumber = null;
    this.#teardownPendingCropUi();
    await this.#createManualCropRotated(pending);
  }

  #cancelPendingCrop(): void {
    if (!this.#pendingCrop) return;
    this.#pendingCrop = null;
    this.#pendingCropPageNumber = null;
    this.#teardownPendingCropUi();
    void this.#redrawOverlay();
  }

  /**
   * [zgloszenie uzytkownika, "mozliwosc zmiany rozmiaru automatycznie
   * znalezionego obrazu — jest za duzy/za maly, zeby recznie zwiekszyc lub
   * zmniejszyc"] Osiem uchwytow (4 rogi + 4 srodki krawedzi) na prostokacie
   * PODSWIETLONEGO obrazu — dziala tak samo dla obrazu automatycznie
   * wykrytego jak i recznie wycietego, bo mechanizm dopasowania nie zalezy
   * od zrodla obrazu. Rogi zmieniaja obie osie naraz, srodki krawedzi tylko
   * jedna (`dx`/`dy` = -1 minX/minY, 0 = bez zmiany, +1 = maxX/maxY).
   *
   * [nauka z wczesniejszego bledu w tej samej sesji, "uchwyt obrotu dziala
   * tylko o kilka stopni"] W TRAKCIE przeciagania NIE wolno wywolywac
   * pelnego przerysowania nakladki (ono niszczy i tworzy uchwyty od nowa,
   * cicho gubiac `setPointerCapture`) — `updateAll` tylko PODMIENIA atrybuty
   * juz istniejacych elementow (`rectEl` + uchwyty), wiec ten sam element
   * `<circle>` trzyma capture przez cala gestykulacje.
   */
  #renderResizeHandles(svg: SVGSVGElement, image: CIFImage, rectEl: SVGRectElement, initialScreen: Rect): void {
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const vb = svg.viewBox.baseVal;
    const svgRect = svg.getBoundingClientRect();
    const scale = vb.width > 0 && svgRect.width > 0 ? vb.width / svgRect.width : 1;
    const handleRadius = 6 * scale;
    const minSize = 12 * scale; // minimalny rozmiar w px viewBox — chroni przed sciagnieciem prostokata do zera/odwroceniem osi
    const rotateHandleOffset = 32 * scale;
    const initialRotation = this.#imageAdjustRotation?.imageId === image.id ? this.#imageAdjustRotation.rotationRad : 0;

    const HANDLE_DEFS: Array<{ dx: -1 | 0 | 1; dy: -1 | 0 | 1; cursor: string }> = [
      { dx: -1, dy: -1, cursor: 'nwse-resize' },
      { dx: 0, dy: -1, cursor: 'ns-resize' },
      { dx: 1, dy: -1, cursor: 'nesw-resize' },
      { dx: 1, dy: 0, cursor: 'ew-resize' },
      { dx: 1, dy: 1, cursor: 'nwse-resize' },
      { dx: 0, dy: 1, cursor: 'ns-resize' },
      { dx: -1, dy: 1, cursor: 'nesw-resize' },
      { dx: -1, dy: 0, cursor: 'ew-resize' },
    ];

    // [zgloszenie uzytkownika, "mozliwosc obrocenia zaznaczonego automatycznie
    // obrazu"] Grupa nosi obrot — DOKLADNIE ten sam wzorzec co
    // `#renderPendingCropOverlay` (SVG `rotate()` to ta sama macierz co
    // `screenRotatedRectToPdf`, wiec ekran = to, co faktycznie zostanie
    // wyciete). `rectEl` jest juz dolaczony do `svg` (przez wywolujacego w
    // `draw()`) — `appendChild` PRZENOSI go do tej grupy, nie klonuje.
    const g = document.createElementNS(SVG_NS, 'g');
    svg.appendChild(g);
    g.appendChild(rectEl);

    const resizeHandleEls = HANDLE_DEFS.map(({ cursor }) => {
      const el = document.createElementNS(SVG_NS, 'circle');
      el.setAttribute('r', String(handleRadius));
      el.setAttribute('class', 'bindery-resize-handle');
      el.style.cursor = cursor;
      g.appendChild(el);
      return el;
    });
    const rotateLine = document.createElementNS(SVG_NS, 'line');
    rotateLine.setAttribute('class', 'bindery-pending-crop-handle-line');
    g.appendChild(rotateLine);
    const rotateHandle = document.createElementNS(SVG_NS, 'circle');
    rotateHandle.setAttribute('r', String(handleRadius));
    rotateHandle.setAttribute('class', 'bindery-pending-crop-handle');
    g.appendChild(rotateHandle);

    // [nauka z wczesniejszego bledu w tej samej sesji, "uchwyt obrotu dziala
    // tylko o kilka stopni"] `currentRect`/`currentRotation` sa DZIELONE
    // (closure) przez WSZYSTKIE uchwyty (8 do zmiany rozmiaru + 1 obrotu) —
    // W TRAKCIE przeciagania NIE wolno wywolywac pelnego przerysowania
    // nakladki (ono niszczy i tworzy uchwyty od nowa, cicho gubiac
    // `setPointerCapture`) — `updateAll` tylko PODMIENIA atrybuty juz
    // istniejacych elementow, wiec ten sam element `<circle>` trzyma capture
    // przez cala gestykulacje, niezaleznie od tego, ile razy sie odpali.
    let currentRect = initialScreen;
    let currentRotation = initialRotation;

    // [zgloszenie uzytkownika, "nie mozna zmienic rozmiaru z lewej strony
    // obrazu automatycznie wybranego"] Gdy zaznaczenie siega niemal do
    // krawedzi strony (typowe dla automatycznie wykrytych obrazow zajmujacych
    // cala/prawie cala strone), uchwyt narysowany DOKLADNIE na krawedzi
    // prostokata ma POLOWE swojego kola poza `viewBox` — SVG domyslnie
    // przycina (`overflow: hidden` z definicji na korzeniu `<svg>`) wszystko
    // poza wlasnym pudelkiem, wiec ta polowa jest niewidoczna I niekliakalna;
    // gdy krawedz jest WYSTARCZAJACO blisko brzegu, MOZE zniknac caly uchwyt.
    // `clampX`/`clampY` odsuwaja WYLACZNIE narysowana/klikalna pozycje
    // (nigdy dane `currentRect`, ktore nadal odzwierciedlaja PRAWDZIWA
    // krawedz) o promien uchwytu od brzegow `viewBox`, wiec kazdy uchwyt
    // zawsze miesci sie w calosci w widocznym/klikalnym obszarze.
    const clampX = (x: number): number => Math.min(Math.max(x, handleRadius), Math.max(handleRadius, vb.width - handleRadius));
    const clampY = (y: number): number => Math.min(Math.max(y, handleRadius), Math.max(handleRadius, vb.height - handleRadius));

    const updateAll = (): void => {
      rectEl.setAttribute('x', String(currentRect.minX));
      rectEl.setAttribute('y', String(currentRect.minY));
      rectEl.setAttribute('width', String(Math.max(0, currentRect.maxX - currentRect.minX)));
      rectEl.setAttribute('height', String(Math.max(0, currentRect.maxY - currentRect.minY)));
      const cx = (currentRect.minX + currentRect.maxX) / 2;
      const cy = (currentRect.minY + currentRect.maxY) / 2;
      HANDLE_DEFS.forEach(({ dx, dy }, i) => {
        resizeHandleEls[i]!.setAttribute('cx', String(clampX(dx === -1 ? currentRect.minX : dx === 1 ? currentRect.maxX : cx)));
        resizeHandleEls[i]!.setAttribute('cy', String(clampY(dy === -1 ? currentRect.minY : dy === 1 ? currentRect.maxY : cy)));
      });
      // Ten sam problem/naprawa co uchwyty zmiany rozmiaru wyzej — dla
      // zaznaczenia siegajacego blisko GORNEJ krawedzi strony uchwyt obrotu
      // (zawsze nad srodkiem gornej krawedzi) moglby wypasc poza `viewBox`.
      // Linia laczaca MUSI konczyc sie w TYM SAMYM (przyciemtym) punkcie co
      // uchwyt, inaczej wizualnie "odlaczy sie" od niego.
      const rotateHandleX = clampX(cx);
      const rotateHandleY = clampY(currentRect.minY - rotateHandleOffset);
      rotateLine.setAttribute('x1', String(cx));
      rotateLine.setAttribute('y1', String(currentRect.minY));
      rotateLine.setAttribute('x2', String(rotateHandleX));
      rotateLine.setAttribute('y2', String(rotateHandleY));
      rotateHandle.setAttribute('cx', String(rotateHandleX));
      rotateHandle.setAttribute('cy', String(rotateHandleY));
      const deg = (currentRotation * 180) / Math.PI;
      g.setAttribute('transform', `rotate(${deg} ${cx} ${cy})`);
    };
    updateAll();

    /** Punkt ekranu (nieobrocony uklad nakladki) -> LOKALNY uklad prostokata (odwrotnosc biezacego `currentRotation` wokol `cx,cy`) — potrzebne, zeby przeciaganie uchwytow zmiany rozmiaru dzialalo poprawnie takze wtedy, gdy obraz jest JUZ obrocony. */
    const toLocalPoint = (screenPt: { x: number; y: number }, cx: number, cy: number): { x: number; y: number } => {
      const dx0 = screenPt.x - cx;
      const dy0 = screenPt.y - cy;
      const cos = Math.cos(-currentRotation);
      const sin = Math.sin(-currentRotation);
      return { x: cx + dx0 * cos - dy0 * sin, y: cy + dx0 * sin + dy0 * cos };
    };

    const commitOrRevert = (changed: boolean): void => {
      if (!changed) return;
      const centerX = (currentRect.minX + currentRect.maxX) / 2;
      const centerY = (currentRect.minY + currentRect.maxY) / 2;
      void this.#resizeImage(image, { centerX, centerY, width: currentRect.maxX - currentRect.minX, height: currentRect.maxY - currentRect.minY, rotationRad: currentRotation });
    };

    HANDLE_DEFS.forEach(({ dx, dy }, i) => {
      const handle = resizeHandleEls[i]!;
      handle.addEventListener('pointerdown', (e: PointerEvent) => {
        if (this.#isCropping) return;
        e.preventDefault();
        e.stopPropagation();
        handle.setPointerCapture(e.pointerId);
        const startRect = currentRect;
        const startCx = (startRect.minX + startRect.maxX) / 2;
        const startCy = (startRect.minY + startRect.maxY) / 2;
        let changed = false;

        const onMove = (ev: PointerEvent): void => {
          if (!handle.hasPointerCapture(ev.pointerId)) return;
          const pt = this.#toOverlayPoint(svg, ev.clientX, ev.clientY);
          const local = toLocalPoint(pt, startCx, startCy);
          const next: Rect = { ...startRect };
          if (dx === -1) next.minX = Math.min(local.x, startRect.maxX - minSize);
          if (dx === 1) next.maxX = Math.max(local.x, startRect.minX + minSize);
          if (dy === -1) next.minY = Math.min(local.y, startRect.maxY - minSize);
          if (dy === 1) next.maxY = Math.max(local.y, startRect.minY + minSize);
          currentRect = next;
          changed = true;
          updateAll();
        };
        const cleanup = (): void => {
          handle.removeEventListener('pointermove', onMove);
          handle.removeEventListener('pointerup', onUp);
          handle.removeEventListener('pointercancel', onCancel);
          if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
        };
        const onUp = (): void => {
          cleanup();
          commitOrRevert(changed);
        };
        const onCancel = (): void => {
          cleanup();
          currentRect = startRect;
          updateAll();
        };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onCancel);
      });
    });

    rotateHandle.addEventListener('pointerdown', (e: PointerEvent) => {
      if (this.#isCropping) return;
      e.preventDefault();
      e.stopPropagation();
      rotateHandle.setPointerCapture(e.pointerId);
      const startRotation = currentRotation;
      let changed = false;

      const onMove = (ev: PointerEvent): void => {
        if (!rotateHandle.hasPointerCapture(ev.pointerId)) return;
        const pt = this.#toOverlayPoint(svg, ev.clientX, ev.clientY);
        const cx = (currentRect.minX + currentRect.maxX) / 2;
        const cy = (currentRect.minY + currentRect.maxY) / 2;
        const angle = Math.atan2(pt.y - cy, pt.x - cx);
        currentRotation = angle + Math.PI / 2;
        this.#imageAdjustRotation = { imageId: image.id, rotationRad: currentRotation };
        changed = true;
        updateAll();
      };
      const cleanup = (): void => {
        rotateHandle.removeEventListener('pointermove', onMove);
        rotateHandle.removeEventListener('pointerup', onUp);
        rotateHandle.removeEventListener('pointercancel', onCancel);
        if (rotateHandle.hasPointerCapture(e.pointerId)) rotateHandle.releasePointerCapture(e.pointerId);
      };
      const onUp = (): void => {
        cleanup();
        commitOrRevert(changed);
      };
      const onCancel = (): void => {
        cleanup();
        currentRotation = startRotation;
        this.#imageAdjustRotation = startRotation !== 0 ? { imageId: image.id, rotationRad: startRotation } : null;
        updateAll();
      };
      rotateHandle.addEventListener('pointermove', onMove);
      rotateHandle.addEventListener('pointerup', onUp);
      rotateHandle.addEventListener('pointercancel', onCancel);
    });
  }

  /**
   * [zgloszenie uzytkownika, "zmiana rozmiaru" + "mozliwosc obrocenia
   * zaznaczonego automatycznie obrazu"] Jak `#createManualCropRotated` (ten
   * sam `screenRotatedRectToPdf` -> `previewDocument.renderRotatedRegion`),
   * ale NADPISUJE istniejacy obraz W MIEJSCU (to samo `id`, ten sam wpis w
   * `doc.images` — `image` to bezposrednia referencja, nie kopia) zamiast
   * tworzyc nowy — obraz NIE zmienia zakladki/podzakladki (klasyfikacja/
   * przeznaczenie sie nie zmieniaja), zmienia sie WYLACZNIE wycinany obszar
   * (rozmiar i/lub obrot) i renderowane bajty/wymiary. `screenRect.rotationRad`
   * moze byc 0 (czysta zmiana rozmiaru) — to tylko szczegolny przypadek tej
   * samej funkcji core'a, dokladnie jak przy nowym wycieciu.
   */
  async #resizeImage(image: CIFImage, screenRect: RotatedRect): Promise<void> {
    if (this.#isCropping) return;
    this.#isCropping = true;
    try {
      const img = this.element.querySelector<HTMLImageElement>('.bindery-page-image');
      const width = img?.naturalWidth ?? 0;
      const height = img?.naturalHeight ?? 0;
      if (!width || !height) return;
      const box = await this.#data.previewDocument.getPageBox(this.#currentPageNumber);
      const pdfRegion = screenRotatedRectToPdf(screenRect, { pageBox: box.box, imageWidthPx: width, imageHeightPx: height, rotation: box.rotation as never });
      const crop = await this.#data.previewDocument.renderRotatedRegion(this.#currentPageNumber, pdfRegion, { targetLongEdgePx: 2048, format: 'webp' });
      image.width = crop.width;
      image.height = crop.height;
      image.format = crop.format;
      image.provenance = { ...image.provenance, bbox: rotatedRectBounds(pdfRegion) };
      this.#imageAdjustRotation = null;
      // [naprawa zgloszonego bledu, kumulujace sie kurczenie przy obrocie
      // tresci] Swiezy crop z PDF-a to NOWY punkt odniesienia "0°" dla
      // `#rotateImage` — stary `originalBytes` (jesli byl) juz nie
      // reprezentuje biezacej tresci obrazu.
      this.#imageRotationState.delete(image.id);
      const oldThumbUrl = this.#thumbnailUrls.get(image.id);
      if (oldThumbUrl) {
        URL.revokeObjectURL(oldThumbUrl);
        this.#thumbnailUrls.delete(image.id);
      }
      (this.#data.imageBytesById as Map<string, { bytes: Uint8Array; format: string }>).set(image.id, { bytes: crop.bytes, format: crop.format });
      await this.render();
    } catch (err) {
      console.warn('Bindery | zmiana rozmiaru/obrotu obrazu nieudana:', err);
      ui.notifications?.error(game.i18n!.localize('BINDERY.review.resizeFailed' as never));
    } finally {
      this.#isCropping = false;
    }
  }

  /**
   * [KROK-42, "token jako produkt"] Otwiera `TokenPrepApp` na BIEZACYCH
   * bajtach obrazu (`this.#data.imageBytesById`, NIE PDF-ie — usuwanie tla,
   * kadr/zoom, maska i ramka dzialaja na juz-wycietej tresci, dokladnie tak
   * jak `#rotateImage`), na zatwierdzeniu podmienia bajty/wymiary/format —
   * mirror `#resizeImage`'s wzorca podmiany, patrz tam.
   */
  async #prepareToken(image: CIFImage): Promise<void> {
    if (this.#isCropping) return;
    const entry = this.#data.imageBytesById.get(image.id);
    if (!entry) return;
    this.#isCropping = true;
    try {
      const result = await prepareToken({
        bytes: entry.bytes,
        format: entry.format,
        width: image.width,
        height: image.height,
        removeBackgroundDefault: this.#data.removeTokenBackgroundDefault ?? false,
      });
      if (!result) return;
      image.width = result.width;
      image.height = result.height;
      image.format = result.format;
      this.#imageRotationState.delete(image.id);
      const oldThumbUrl = this.#thumbnailUrls.get(image.id);
      if (oldThumbUrl) {
        URL.revokeObjectURL(oldThumbUrl);
        this.#thumbnailUrls.delete(image.id);
      }
      (this.#data.imageBytesById as Map<string, { bytes: Uint8Array; format: string }>).set(image.id, { bytes: result.bytes, format: result.format });
      await this.render();
    } catch (err) {
      console.warn('Bindery | przygotowanie tokenu nieudane:', err);
      ui.notifications?.error(game.i18n!.localize('BINDERY.review.resizeFailed' as never));
    } finally {
      this.#isCropping = false;
    }
  }

  /**
   * [zgloszenie uzytkownika, "chodzi o obrocenie JUZ wycietego obrazu — mapa
   * zajmuje cala strone, obrocenie zaznaczenia wytnie ja zle"; potem "wolalbym
   * mniejszy kat niz 90 stopni, np. co 10"; potem "obraz mocno sie zmniejsza
   * po obrocie, duzo pustego miejsca w ramce"; potem "po 36 obrotach powinien
   * wrocic do poczatkowej postaci (360°), a kurczy sie z kazdym obrotem"]
   * Obraca SAMA TRESC — PDF w ogole nie jest odpytywany ponownie (w
   * odroznieniu od `#resizeImage`, ktory zawsze wraca do PDF-a po swiezy
   * render). KAZDE wywolanie obraca `#imageRotationState`'s `originalBytes`
   * (PIERWOTNE, NIGDY nie nadpisywane bajty sprzed jakiegokolwiek obrotu) o
   * CALY nowy sumaryczny kat od zera — NIE obraca wyniku poprzedniego
   * wywolania — inaczej strata przy przycinaniu do `inscribedRotatedRectScale`
   * (NAJWIEKSZY prostokat o tych samych proporcjach, ktory miesci sie CALY
   * wewnatrz obroconej tresci, zero przezroczystych rogow) kumulowalaby sie
   * z kazdym klikniedciem, mimo ze sumaryczny kat wraca do 0°/360°.
   */
  async #rotateImage(image: CIFImage, direction: 1 | -1): Promise<void> {
    if (this.#isCropping) return;
    this.#isCropping = true;
    try {
      let state = this.#imageRotationState.get(image.id);
      if (!state) {
        const entry = this.#data.imageBytesById.get(image.id);
        if (!entry) return;
        state = { originalBytes: entry.bytes, originalFormat: entry.format, totalDeg: 0 };
        this.#imageRotationState.set(image.id, state);
      }
      const mime = state.originalFormat === 'png' ? 'image/png' : 'image/webp';
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(state.originalBytes)], { type: mime }));
      const totalDeg = (((state.totalDeg + direction * ReviewScreen.#IMAGE_ROTATE_STEP_DEG) % 360) + 360) % 360;
      const angleRad = (totalDeg * Math.PI) / 180;
      const scale = inscribedRotatedRectScale(bitmap.width, bitmap.height, angleRad);
      const outWidth = Math.max(1, Math.round(bitmap.width * scale));
      const outHeight = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = new OffscreenCanvas(outWidth, outHeight);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('brak kontekstu 2D dla OffscreenCanvas');
      ctx.translate(outWidth / 2, outHeight / 2);
      ctx.rotate(angleRad);
      ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
      bitmap.close();
      const outBlob = await canvas.convertToBlob({ type: mime, quality: mime === 'image/webp' ? DEFAULT_WEBP_QUALITY : undefined });
      const newBytes = new Uint8Array(await outBlob.arrayBuffer());

      state.totalDeg = totalDeg;
      image.width = outWidth;
      image.height = outHeight;
      const oldThumbUrl = this.#thumbnailUrls.get(image.id);
      if (oldThumbUrl) {
        URL.revokeObjectURL(oldThumbUrl);
        this.#thumbnailUrls.delete(image.id);
      }
      (this.#data.imageBytesById as Map<string, { bytes: Uint8Array; format: string }>).set(image.id, { bytes: newBytes, format: state.originalFormat });
      await this.render();
    } catch (err) {
      console.warn('Bindery | obrot obrazu nieudany:', err);
      ui.notifications?.error(game.i18n!.localize('BINDERY.review.imageRotateFailed' as never));
    } finally {
      this.#isCropping = false;
    }
  }

  /**
   * [zgloszenie uzytkownika, "obrocic zaznaczony obszar przed wycieciem"]
   * Bbox EKRANU OBROCONY (`#pendingCrop`, `rotationRad` moze byc 0 — nieobrocony
   * to po prostu szczegolny przypadek, patrz test "rotationRad=0 -> ten sam
   * wynik co zwykly screenRectToPdf" w `pageOverlayGeometry.test.ts`, dlatego
   * NIE MA juz osobnej, "prostej" sciezki dla przypadku bez obrotu) ->
   * `screenRotatedRectToPdf` -> `previewDocument.renderRotatedRegion` -> nowy
   * `CIFImage` wstawiony do `doc.images` — TEN SAM ksztalt danych co obraz z
   * automatycznej ekstrakcji core'a, wiec cala reszta ekranu (lista, wybor
   * przeznaczenia, `#runImport`) obsluguje go bez zadnych specjalnych
   * przypadkow (patrz `#finalizeManualCrop`). `provenance.bbox` (ZAWSZE
   * rownolegly do osi w calym projekcie) to otoczka obroconego regionu PDF
   * (`rotatedRectBounds`) — dla obroconego wyciecia podglad na liscie/nakladce
   * pokaze wiec nieco WIEKSZY, nieobrocony prostokat wokol faktycznie
   * zapisanego (poprawnie obroconego i wycietego) obrazu; sam zapisany obraz
   * jest wycinany poprawnie niezaleznie od tego uproszczenia.
   */
  async #createManualCropRotated(screenRect: RotatedRect): Promise<void> {
    if (this.#isCropping) return;
    this.#isCropping = true;
    try {
      const img = this.element.querySelector<HTMLImageElement>('.bindery-page-image');
      const width = img?.naturalWidth ?? 0;
      const height = img?.naturalHeight ?? 0;
      if (!width || !height) return;
      const box = await this.#data.previewDocument.getPageBox(this.#currentPageNumber);
      const pdfRegion = screenRotatedRectToPdf(screenRect, { pageBox: box.box, imageWidthPx: width, imageHeightPx: height, rotation: box.rotation as never });
      const crop = await this.#data.previewDocument.renderRotatedRegion(this.#currentPageNumber, pdfRegion, { targetLongEdgePx: 2048, format: 'webp' });
      await this.#finalizeManualCrop(rotatedRectBounds(pdfRegion), crop);
    } catch (err) {
      console.warn('Bindery | reczne wyciecie obroconego fragmentu nieudane:', err);
      ui.notifications?.error(game.i18n!.localize('BINDERY.review.selectModeCropFailed' as never));
    } finally {
      this.#isCropping = false;
    }
  }

  /**
   * Bbox PDF + wynik renderu -> nowy `CIFImage` wstawiony do `doc.images` —
   * TEN SAM ksztalt danych co obraz z automatycznej ekstrakcji core'a, wiec
   * cala reszta ekranu (lista, wybor przeznaczenia, `#runImport`) obsluguje
   * go bez zadnych specjalnych przypadkow. Wspolna dla `#createManualCrop`
   * (osiowy) i `#createManualCropRotated` (obrocony) — jedyna roznica miedzy
   * nimi to SPOSOB obliczenia `pdfBbox`/renderu, nie to, co sie dzieje z
   * wynikiem.
   */
  async #finalizeManualCrop(pdfBbox: Rect, crop: RegionCrop): Promise<void> {
    const id = `manual-crop-${++this.#manualCropSeq}`;
    const targetKind = classifyTargetKind({ width: crop.width, height: crop.height, classification: 'content', nearStatblockOrHeading: false });
    const newImage: CIFImage = {
      id,
      targetKind,
      width: crop.width,
      height: crop.height,
      format: crop.format,
      assetRef: id,
      classification: 'content',
      confidence: 1,
      rawText: '',
      provenance: { pageNumber: this.#currentPageNumber, bbox: pdfBbox, blockIds: [] },
    };
    this.#data.document.images.push(newImage);
    (this.#data.imageBytesById as Map<string, { bytes: Uint8Array; format: string }>).set(id, { bytes: crop.bytes, format: crop.format });
    const destination = defaultImageDestination();
    this.#selection.addManualImage(id, destination);
    this.#highlightedImageId = id;
    // [zgloszenie uzytkownika, podzakladki Scena/Journal/Token/Nieprzydzielone]
    // Nowo wyciety fragment idzie do podzakladki "Zaznaczone ręcznie" pod
    // WLASNYM przeznaczeniem — bez tego, przy innej aktywnej podzakladce
    // (np. domyslnej "Scena", gdy crop trafil do "Journal"), efekt
    // "Zaznacz i wytnij" byl niewidoczny: obraz istnial, ale w INNEJ,
    // niepokazanej wlasnie zakladce.
    this.#imageSourceTab = 'manual';
    this.#imageDestTab = destination;
    await this.render();
  }

  static async #onPrevPage(this: ReviewScreen): Promise<void> {
    if (this.#currentPageNumber <= 1) return;
    this.#currentPageNumber--;
    this.#pendingCrop = null;
    this.#pendingCropPageNumber = null;
    this.#teardownPendingCropUi();
    await this.render();
  }
  static async #onNextPage(this: ReviewScreen): Promise<void> {
    if (this.#currentPageNumber >= this.#data.previewDocument.pageCount) return;
    this.#currentPageNumber++;
    this.#pendingCrop = null;
    this.#pendingCropPageNumber = null;
    this.#teardownPendingCropUi();
    await this.render();
  }

  static #onZoomIn(this: ReviewScreen): void {
    this.#setZoom(Math.min(ReviewScreen.#MAX_ZOOM, this.#zoomPercent + ReviewScreen.#ZOOM_STEP));
  }
  static #onZoomOut(this: ReviewScreen): void {
    this.#setZoom(Math.max(ReviewScreen.#MIN_ZOOM, this.#zoomPercent - ReviewScreen.#ZOOM_STEP));
  }

  /**
   * [zgloszenie uzytkownika, "możliwość przybliżenia PDFa w importerze"]
   * CELOWO surgical (bez `void this.render()`) — zoom to czysto wizualna
   * zmiana stylu istniejacego `<img>`/nakladki, nie wymaga odtwarzania
   * calego szablonu. Mirror `#refreshImageRowHighlights`/`#redrawOverlay`
   * (ten sam powod: pelny render zresetowalby przewijanie listy obrazow).
   */
  #setZoom(percent: number): void {
    if (percent === this.#zoomPercent) return;
    this.#zoomPercent = percent;
    this.#applyZoomToDom();
    for (const el of this.element.querySelectorAll<HTMLElement>('[data-zoom-readout]')) el.textContent = `${percent}%`;
    for (const btn of this.element.querySelectorAll<HTMLButtonElement>('[data-action="zoomOut"]')) btn.disabled = percent <= ReviewScreen.#MIN_ZOOM;
    for (const btn of this.element.querySelectorAll<HTMLButtonElement>('[data-action="zoomIn"]')) btn.disabled = percent >= ReviewScreen.#MAX_ZOOM;
    if (this.#tab === 'images') void this.#redrawOverlay();
    else if (this.#tab === 'actors') void this.#redrawActorOverlay();
  }

  /**
   * Stosuje aktualny `#zoomPercent` do JUZ ISTNIEJACYCH elementow podgladu —
   * wywolywane zarowno z `#setZoom` (klik +/−), jak i z `_onRender` (KAZDY
   * pelny render, np. nawigacja stron, tworzy `<img>` OD ZERA, wiec zoom
   * trzeba nalozyc ponownie, inaczej cicho wraca do 100%). Ponizej progu
   * (`#MIN_ZOOM`) przywraca DOKLADNIE domyslny uklad (`bindery.css`: stala
   * ramka 3:4 z letterboxingiem) — pusty `style.width` (nie jawna wartosc)
   * daje WYZSZY priorytet zwyklej regule CSS, ktora go ustawia.
   *
   * [zgloszenie uzytkownika, "rośnie też okno w którym jest pdf" — PIERWSZA
   * proba naprawy TUTAJ (reczny pomiar+blokada wysokosci w JS) zepsula
   * kolejne kliknieta "+", patrz teraz juz USUNIETY komentarz i
   * `bindery.css`'s aktualne uzasadnienie przy `.bindery-zoomed`] Ramka
   * zostaje STALEGO rozmiaru dzieki SAMEMU CSS (`aspect-ratio: 3/4` na
   * `.bindery-page-canvas-wrap`, CELOWO nieusuwane przez `.bindery-zoomed`)
   * — wysokosc ramki jest wyliczana WYLACZNIE z jej szerokosci (ktora zoom
   * nigdy nie rusza), nigdy z tresci w srodku, wiec `overflow:auto` ma
   * zawsze DOKLADNIE ten sam, staly viewport do przewijania. Zero pomiaru
   * w JS potrzebne.
   */
  #applyZoomToDom(): void {
    const zoomed = this.#zoomPercent > ReviewScreen.#MIN_ZOOM;
    for (const wrap of this.element.querySelectorAll<HTMLElement>('.bindery-page-canvas-wrap')) {
      wrap.classList.toggle('bindery-zoomed', zoomed);
      const img = wrap.querySelector<HTMLImageElement>('.bindery-page-image');
      if (img) img.style.width = zoomed ? `${this.#zoomPercent}%` : '';
    }
  }

  /**
   * [wyodrebnione po recenzji calego designu — ten sam wzorzec byl
   * powielony osobno w `#mountImageList`/`#mountSceneList`/
   * `#mountJournalList`/`#mountDiagnosticList`] `scrollKey` to jedyne, co
   * KAZDY z nich mial osobne (poza wysokoscia wiersza i budowniczym wiersza)
   * — jedno miejsce na wiazanie `initialScrollTop`/`onScroll` z
   * `#listScrollTop`, zamiast czterech kopii tej samej logiki, gdzie klucz
   * moglby cicho rozjechac sie z atrybutem `data-list` w szablonie.
   */
  #mountList<T>(container: HTMLElement | null, scrollKey: string, items: readonly T[], rowHeightPx: number, renderRow: (item: T) => HTMLElement): VirtualList<T> | null {
    if (!container) return null;
    return new VirtualList<T>({
      container,
      items,
      rowHeightPx,
      renderRow,
      initialScrollTop: this.#listScrollTop[scrollKey],
      onScroll: (top) => (this.#listScrollTop[scrollKey] = top),
    });
  }

  // ---- Lista obrazow (Z2/Z4) ---------------------------------------------

  #mountImageList(images: CIFImage[]): void {
    // [redesign 2a] Wiersz sklada trzy linie w `.bindery-row-name-wrap`
    // (nazwa + meta + grupa journala) obok miniatury 48px wysokosci —
    // wysokosc dobrana empirycznie pod ten uklad (patrz `bindery.css`,
    // sekcja "Tabela obrazow").
    this.#imageList = this.#mountList(this.element.querySelector<HTMLElement>('[data-list="images"]'), 'images', images, 80, (image) => this.#buildImageRow(image));
  }

  #thumbnailFor(imageId: string): string | null {
    const cached = this.#thumbnailUrls.get(imageId);
    if (cached) return cached;
    const entry = this.#data.imageBytesById.get(imageId);
    if (!entry) return null;
    const mime = entry.format === 'png' ? 'image/png' : 'image/webp';
    const url = URL.createObjectURL(new Blob([new Uint8Array(entry.bytes)], { type: mime }));
    this.#thumbnailUrls.set(imageId, url);
    return url;
  }

  #buildImageRow(image: CIFImage): HTMLElement {
    const row = document.createElement('div');
    row.className = 'bindery-review-row bindery-image-row';
    row.dataset['imageId'] = image.id;
    if (image.id === this.#highlightedImageId) row.classList.add('bindery-row-highlighted');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'bindery-check';
    checkbox.checked = this.#selection.isImageSelected(image.id);
    checkbox.addEventListener('change', () => {
      this.#selection.setImage(image.id, checkbox.checked);
      void this.#refreshHeaderCounts();
    });
    row.appendChild(checkbox);

    // [redesign 2a] Slot 36x48 ZAWSZE obecny (nawet bez miniatury), zeby
    // kolumny siatki (`22px 36px 74px minmax(0,1fr) 148px`) zostawaly
    // identyczne w kazdym wierszu — VirtualList wymaga stalej wysokosci
    // wiersza, wiec brakujacy element nie moze zmieniac liczby kolumn.
    const thumbSlot = document.createElement('div');
    thumbSlot.className = 'bindery-row-thumb-slot';
    const thumbUrl = this.#thumbnailFor(image.id);
    if (thumbUrl) {
      const thumb = document.createElement('img');
      thumb.className = 'bindery-row-thumb';
      thumb.src = thumbUrl;
      thumb.alt = '';
      thumbSlot.appendChild(thumb);
    }
    row.appendChild(thumbSlot);

    const pageLabel = document.createElement('span');
    pageLabel.className = 'bindery-row-page';
    pageLabel.textContent = `p.${image.provenance.pageNumber}`;
    row.appendChild(pageLabel);

    const nameWrap = document.createElement('div');
    nameWrap.className = 'bindery-row-name-wrap';

    // [KROK-20, zgloszony na zywo brak "brakuje mi nadawania nazw wybranym
    // obrazom"] Nazwa obrazu edytowalna WPROST w wierszu — mirror wzorca z
    // `#buildJournalRow` (tam `nameInput` mutuje `row.journal.name` wprost na
    // obiekcie core'a). `image.caption` to JUZ istniejace, opcjonalne pole
    // `CIFImage` (patrz `packages/core/src/cif/types.ts`) czytane przez
    // `#runImport` jako nadpisanie domyslnej nazwy (`image.caption?.trim() ||
    // "Obraz p.N"`) — WSZYSTKIE trzy sciezki (Scena/Journal/Token) i grupowanie
    // journali dostaja te nazwe za darmo, bez zadnej dodatkowej logiki tutaj.
    const defaultImageName = game.i18n!.localize('BINDERY.review.defaultImageName' as never);
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'bindery-row-name-input';
    nameInput.placeholder = `${defaultImageName} p.${image.provenance.pageNumber}`;
    nameInput.value = image.caption ?? '';
    nameInput.addEventListener('click', (ev) => ev.stopPropagation());
    nameInput.addEventListener('change', () => {
      image.caption = nameInput.value.trim() || undefined;
    });
    nameWrap.appendChild(nameInput);

    // [zgloszenie uzytkownika, "unknown - 65x115 - undecided (40%) jest
    // zupelnie niepotrzebny, moze zostac jedynie rozmiar"] Dawniej pelny opis
    // (`targetKind — WxH — classification (confidence%)`) — reszta oprocz
    // samego rozmiaru byla wewnetrznym zargonem klasyfikatora, nieczytelnym
    // dla uzytkownika i nieprzydatnym w podjeciu decyzji o przeznaczeniu.
    const meta = document.createElement('span');
    meta.className = 'bindery-row-meta';
    meta.textContent = `${image.width}×${image.height}`;
    nameWrap.appendChild(meta);

    // [KROK-19] Nazwa grupy journala — ma sens WYLACZNIE dla przeznaczenia
    // `journal` (patrz `ReviewSelection.imageJournalGroup`), stad ukryta
    // dla pozostalych przeznaczen zamiast usuwana z DOM-u (prostszy toggle
    // widocznosci nizej w handlerze zmiany `destSelect`). Trzecia linia w
    // `nameWrap` (doc: "zachowaj pelna edycje per-wiersz, nie usuwaj bez
    // pytania" — patrz README, wiec zostaje, tylko zdegradowana wizualnie
    // przez `.bindery-row-journal-group` jak `meta` powyzej).
    const groupInput = document.createElement('input');
    groupInput.type = 'text';
    groupInput.className = 'bindery-row-journal-group';
    groupInput.placeholder = game.i18n!.localize('BINDERY.review.journalGroupPlaceholder' as never);
    groupInput.value = this.#selection.imageJournalGroup(image.id);
    groupInput.addEventListener('click', (ev) => ev.stopPropagation());
    groupInput.addEventListener('change', () => {
      this.#selection.setImageJournalGroup(image.id, groupInput.value);
    });
    nameWrap.appendChild(groupInput);

    // [KROK-42, "token jako produkt"] Ten sam wzorzec co `groupInput` powyzej
    // — trzecia linia w `nameWrap`, widoczna WYLACZNIE dla przeznaczenia
    // `token` (grid `.bindery-image-row` ma STALA liczbe kolumn, patrz
    // `bindery.css`, wiec nowy przycisk musi isc do JUZ istniejacej,
    // elastycznej kolumny `nameWrap`, nie jako nowe dziecko `row`). Otwiera
    // `TokenPrepApp` (usuwanie tla/maska/ramka), na zatwierdzeniu PODMIENIA
    // bajty/wymiary/format obrazu — mirror `#resizeImage`/`#rotateImage`,
    // patrz `#prepareToken`. Mechanizm przypisania tokenu do aktora (krok 35)
    // nie wie i nie musi wiedziec, ze bajty pochodza z tego panelu.
    const prepareTokenBtn = document.createElement('button');
    prepareTokenBtn.type = 'button';
    prepareTokenBtn.className = 'bindery-row-prepare-token-btn';
    prepareTokenBtn.textContent = game.i18n!.localize('BINDERY.review.prepareToken' as never);
    prepareTokenBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void this.#prepareToken(image);
    });
    nameWrap.appendChild(prepareTokenBtn);

    row.appendChild(nameWrap);

    // [KROK-14 Z4] Przeznaczenie per obraz — sugerowane z `CIFImage.targetKind`
    // [zgloszenie uzytkownika, "wszystkie obrazy trafiaja do Nieprzydzielone,
    // uzytkownik przydziela recznie"] Domyslnie zawsze `unassigned` (patrz
    // `defaultImageDestination`) — nadpisywalne tutaj.
    const destSelect = document.createElement('select');
    destSelect.className = 'bindery-select bindery-row-destination';
    for (const [value, labelKey] of [
      ['scene', 'BINDERY.review.destinationScene'],
      ['journal', 'BINDERY.review.destinationJournal'],
      ['token', 'BINDERY.review.destinationToken'],
      ['unassigned', 'BINDERY.review.destinationUnassigned'],
    ] as const) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = game.i18n!.localize(labelKey as never);
      destSelect.appendChild(opt);
    }
    destSelect.value = this.#selection.imageDestination(image.id);
    destSelect.addEventListener('click', (ev) => ev.stopPropagation());
    groupInput.style.display = destSelect.value === 'journal' ? '' : 'none';
    prepareTokenBtn.style.display = destSelect.value === 'token' ? '' : 'none';

    destSelect.addEventListener('change', () => {
      const destination = destSelect.value as ImageDestination;
      this.#selection.setImageDestination(image.id, destination);
      // [KROK-16 Z2, naprawa zgloszonego bledu] `#runImport` przetwarza
      // WYLACZNIE zaznaczone obrazy (checkbox) — bez tego, wybranie
      // przeznaczenia dla obrazu ktory startuje ODZNACZONY (KAZDY obraz,
      // patrz `ReviewSelection.fromDocument` — zgloszenie uzytkownika,
      // wszystkie obrazy startuja odznaczone) nie robilo NIC, bez zadnego
      // bledu ani ostrzezenia ("scena sie nie tworzy"). Zmiana przeznaczenia na
      // cokolwiek innego niz "Nieprzydzielone" jest jednoznaczna deklaracja
      // intencji — zaznacz obraz od razu, zeby dropdown i checkbox nie
      // rozjezdzaly sie w dwa niezalezne, ciche zrodla prawdy.
      const shouldBeSelected = destination !== 'unassigned';
      if (this.#selection.isImageSelected(image.id) !== shouldBeSelected) this.#selection.setImage(image.id, shouldBeSelected);
      // [zgloszenie uzytkownika, podzakladki Scena/Journal/Token/Nieprzydzielone] Obraz
      // wedruje do INNEJ podzakladki przeznaczenia — pelny render (zamiast
      // dotychczasowej chirurgicznej aktualizacji tego jednego wiersza), zeby
      // zniknal z biezacej listy i pojawil sie we wlasciwej. `scrollable`
      // (patrz `PARTS.main` wyzej) chroni pozycje przewijania listy mimo
      // pelnego renderu.
      void this.render();
    });
    row.appendChild(destSelect);

    // [zgloszenie uzytkownika, "obrocenie juz wycietego obrazu — mapa zajmuje
    // cala strone, zaznaczenie obszaru by ja zle wycielo, chodzi o obrocenie
    // JUZ wycietego obrazu"] Obraca SAMA TRESC (piksele juz zapisanych
    // bajtow) o 90° — NIEZALEZNE od uchwytow obrotu/zmiany rozmiaru na
    // podgladzie strony (`#renderResizeHandles`/`#resizeImage`), ktore
    // dotycza WYBORU obszaru PRZED ponownym wycieciem z PDF-a. Tutaj PDF w
    // ogole nie jest ponownie odpytywany — czysta operacja na canvasie.
    const rotateWrap = document.createElement('div');
    rotateWrap.className = 'bindery-row-rotate';
    const rotateLeftBtn = document.createElement('button');
    rotateLeftBtn.type = 'button';
    rotateLeftBtn.className = 'bindery-row-rotate-btn';
    rotateLeftBtn.textContent = '↺';
    rotateLeftBtn.title = game.i18n!.format('BINDERY.review.rotateImageLeft' as never, { n: String(ReviewScreen.#IMAGE_ROTATE_STEP_DEG) });
    rotateLeftBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void this.#rotateImage(image, -1);
    });
    rotateWrap.appendChild(rotateLeftBtn);
    const rotateRightBtn = document.createElement('button');
    rotateRightBtn.type = 'button';
    rotateRightBtn.className = 'bindery-row-rotate-btn';
    rotateRightBtn.textContent = '↻';
    rotateRightBtn.title = game.i18n!.format('BINDERY.review.rotateImageRight' as never, { n: String(ReviewScreen.#IMAGE_ROTATE_STEP_DEG) });
    rotateRightBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void this.#rotateImage(image, 1);
    });
    rotateWrap.appendChild(rotateRightBtn);
    row.appendChild(rotateWrap);

    row.addEventListener('click', (ev) => {
      if (ev.target === checkbox || ev.target === destSelect || ev.target === groupInput || ev.target === nameInput) return;
      this.#highlightedImageId = image.id;
      if (this.#currentPageNumber === image.provenance.pageNumber) {
        this.#refreshImageRowHighlights();
        void this.#redrawOverlay();
      } else {
        this.#currentPageNumber = image.provenance.pageNumber;
        void this.render();
      }
    });

    return row;
  }

  static #onSelectAllImages(this: ReviewScreen): void {
    this.#selection.selectAllImages();
    void this.render();
  }
  static #onSelectNoImages(this: ReviewScreen): void {
    this.#selection.selectNoImages();
    void this.render();
  }
  static #onSelectOnlyContent(this: ReviewScreen): void {
    this.#selection.selectOnlyContentImages(this.#data.document);
    void this.render();
  }

  // [KROK-16 Z2, naprawa zgloszonego bledu] Journale (pelny tekst ksiazki)
  // startuja teraz odznaczone (patrz `ReviewSelection.fromDocument`) — te dwa
  // przyciski to jawny opt-in zbiorczy, zeby uzytkownik, ktory FAKTYCZNIE chce
  // pelnotekstowe journale, nie musial klikac kazdego rozdzialu osobno.
  static #onSelectAllJournals(this: ReviewScreen): void {
    this.#selection.setAllJournals(true);
    void this.render();
  }
  static #onSelectNoJournals(this: ReviewScreen): void {
    this.#selection.setAllJournals(false);
    void this.render();
  }

  /**
   * [redesign 2a] Doc laczy dwa dawne przyciski ("Ustaw przeznaczenie
   * zaznaczonym" + "Ustaw grupe journala zaznaczonym") w jeden — przeznaczenie
   * jest ZAWSZE ustawiane (`<select>` zawsze ma jakas wartosc), grupa journala
   * TYLKO gdy pole nie jest puste (patrz README: nie czysc grupy journala
   * zaznaczonym obrazom tylko dlatego, ze ktos kliknal "Ustaw" bez wpisania
   * niczego w to pole).
   */
  static #onApplyBulkSettings(this: ReviewScreen): void {
    const select = this.element.querySelector<HTMLSelectElement>('[data-select="bulkDestination"]');
    if (select) {
      this.#bulkDestinationValue = select.value as ImageDestination;
      this.#selection.setDestinationForSelected(this.#bulkDestinationValue);
    }
    const input = this.element.querySelector<HTMLInputElement>('[data-input="bulkJournalGroup"]');
    if (input && input.value.trim() !== '') {
      this.#selection.setJournalGroupForSelected(input.value);
      this.#bulkJournalGroupValue = '';
    }
    void this.render();
  }

  /**
   * [KROK-19, naprawa zgloszonego bledu] Przywraca ostatni wybor w pasku
   * operacji zbiorczych (`bulkDestination`/`bulkJournalGroup`) PO kazdym
   * zamontowaniu zakladki Obrazy — patrz komentarz przy `#bulkDestinationValue`
   * wyzej, dlaczego bez tego wybor cicho gubil sie przy kazdej nawigacji
   * podgladu strony.
   */
  #wireBulkImageControls(): void {
    const destSelect = this.element.querySelector<HTMLSelectElement>('[data-select="bulkDestination"]');
    if (destSelect) {
      destSelect.value = this.#bulkDestinationValue;
      destSelect.addEventListener('change', () => {
        this.#bulkDestinationValue = destSelect.value as ImageDestination;
      });
    }
    const groupInput = this.element.querySelector<HTMLInputElement>('[data-input="bulkJournalGroup"]');
    if (groupInput) {
      groupInput.value = this.#bulkJournalGroupValue;
      groupInput.addEventListener('input', () => {
        this.#bulkJournalGroupValue = groupInput.value;
      });
    }
  }

  /**
   * [naprawa zgloszonego bledu — recenzja calego designu] Poprzednia wersja
   * celowala w `.bindery-review-counts` — klase, ktora nigdy nie istniala w
   * `review-screen.hbs`/`bindery.css` (prawdopodobnie relikt sprzed
   * "redesign 2a"), wiec `querySelector` zawsze zwracal `null` i cala
   * aktualizacja byla cichym no-opem: licznik "N zaznaczonych" w pasku
   * krokow zamrazal sie po kazdym (od)zaznaczeniu checkboxa, az do
   * przypadkowego pelnego renderu. `data-count="images"` na wlasciwym
   * `<span>` (patrz szablon) jest jedynym miejscem, ktore faktycznie
   * pokazuje ten licznik.
   */
  async #refreshHeaderCounts(): Promise<void> {
    const el = this.element.querySelector<HTMLElement>('[data-count="images"]');
    if (!el) return;
    el.textContent = `${this.#selection.selectedImageCount} / ${this.#data.document.images.length} ${game.i18n!.localize('BINDERY.review.images' as never)}`;
  }

  /** [KROK-11 Z3] Aktualizuje klase podswietlenia na juz-wyrenderowanych wierszach listy obrazow, bez pelnego `render()` (patrz `#redrawOverlay`). */
  #refreshImageRowHighlights(): void {
    const rows = this.element.querySelectorAll<HTMLElement>('.bindery-image-row');
    for (const row of rows) {
      row.classList.toggle('bindery-row-highlighted', row.dataset['imageId'] === this.#highlightedImageId);
    }
  }

  // ---- [KROK-20 Z2] Lista aktorow -----------------------------------------

  /**
   * [KROK-21, zmierzony na zywo blad] Bez wirtualizacji — celowo, w
   * odroznieniu od obrazow/scen/journali/diagnostyki (`VirtualList`, ktory
   * zaklada WPROST "brak wierszy zmiennej wysokosci", patrz jego wlasny
   * komentarz). Wiersz aktora jest z natury zmiennej wysokosci (opcjonalny
   * rzad kandydatow na nazwe, zawijana lista cech, zawijana lista atakow,
   * zmienna liczba notatek adaptera) — sztywne `rowHeightPx` w `VirtualList`
   * powodowalo, ze tresc dluzszych wierszy (np. "Ręce" ze str. 56: 5 atakow +
   * kilka notatek) byla wizualnie przykrywana przez NASTEPNY wiersz
   * (absolutne pozycjonowanie + wymuszona wysokosc), mimo ze dane pod spodem
   * byly kompletne przez caly czas — utworzony Actor mial wszystkie 4 ataki
   * poprawnie, tylko EDYTOR ich nie pokazywal. Liczba aktorow w realnej
   * ksiazce to dziesiatki, nie tysiace obrazow, ktore `VirtualList`
   * faktycznie musi obslugiwac (jego wlasny cel: "2500 elementow bez
   * zacinania") — zwykly, niewirtualizowany rendering jest tu poprawnym
   * kompromisem, nie tymczasowym obejsciem.
   */
  #mountActorList(actors: CIFActor[]): void {
    const container = this.element.querySelector<HTMLElement>('[data-list="actors"]');
    if (!container) return;
    container.innerHTML = '';
    for (const actor of actors) container.appendChild(this.#buildActorRow(actor));
    // [zgloszenie uzytkownika, "wybieram obraz z listy, przeskakuje na
    // początek"] Ten sam problem co `VirtualList` (patrz uzasadnienie przy
    // `initialScrollTop` tam), mimo ze ta lista NIE jest wirtualizowana:
    // kontener jest PUSTY w szablonie Handlebars, wiec Foundry'owy
    // `scrollable` probuje przywrocic `scrollTop` ZANIM wiersze wyzej w ogole
    // istnieja — ustawienie scrolla na pustym kontenerze jest przegladarkowo
    // przycinane do 0. Przywracamy wiec SAMI, PO wypelnieniu.
    container.scrollTop = this.#listScrollTop['actors'] ?? 0;
    container.addEventListener('scroll', () => (this.#listScrollTop['actors'] = container.scrollTop));
  }

  /** Wiersz statystyk z etykietami skroconymi (`S`,`WYG`,...) — patrz `CHARACTERISTIC_KEY_MAP`/derivedBlock w `adapters/coc7.ts`. Klucz kanoniczny jest dluzszy niz etykieta z ksiazki (np. "strength" vs "S") — mapa odwrotna WYLACZNIE do etykietowania inputow w tym ekranie, nie do zadnej decyzji. */
  static readonly #STAT_SHORT_LABELS: Readonly<Record<string, string>> = {
    strength: 'S',
    charisma: 'WYG',
    constitution: 'KON',
    willpower: 'MOC',
    size: 'BC',
    education: 'WYK',
    dexterity: 'ZR',
    intelligence: 'INT',
    sanity: 'P',
    hitPoints: 'PW',
    damageBonus: 'MO',
    build: 'Krzepa',
    movement: 'Ruch',
    magicPoints: 'PM',
  };

  #buildActorRow(actor: CIFActor): HTMLElement {
    const row = document.createElement('div');
    row.className = 'bindery-review-row bindery-actor-row';
    row.dataset['actorId'] = actor.id;
    if (actor.id === this.#highlightedActorId) row.classList.add('bindery-row-highlighted');

    const completeness = computeActorCompleteness(actor);
    const preview = this.#actorAdapterPreview.get(actor.id);

    const line1 = document.createElement('div');
    line1.className = 'bindery-actor-row-line1';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'bindery-check';
    checkbox.checked = this.#actorSelection.isSelected(actor.id);
    checkbox.addEventListener('change', () => {
      this.#actorSelection.setSelected(actor.id, checkbox.checked);
      void this.#refreshActorHeaderCounts();
    });
    line1.appendChild(checkbox);

    // [DoD Z2] Rozstrzyganie nazwy — pole tekstowe zawsze edytowalne (nazwa
    // pewna startuje wypelniona, placeholder startuje PUSTY, wymuszajac
    // swiadomy wybor), plus przyciski-skroty dla kazdego kandydata z
    // `nameCandidates` (S4/A10 — "jedno klikniecie, nie formularz", brief Z2).
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'bindery-row-name-input bindery-actor-name-input';
    nameInput.placeholder = actor.nameConfident ? actor.name : game.i18n!.localize('BINDERY.review.actorUnresolvedNamePlaceholder' as never);
    nameInput.value = this.#actorSelection.resolvedName(actor);
    if (!this.#actorSelection.isNameResolved(actor)) nameInput.classList.add('bindery-actor-name-unresolved');
    nameInput.addEventListener('click', (ev) => ev.stopPropagation());
    nameInput.addEventListener('change', () => {
      this.#actorSelection.setResolvedName(actor.id, nameInput.value);
      nameInput.classList.toggle('bindery-actor-name-unresolved', !this.#actorSelection.isNameResolved(actor));
      this.#rebuildActorAdapterPreview();
      this.#refreshActorRowNotes(actor.id);
      void this.#refreshActorHeaderCounts();
    });
    line1.appendChild(nameInput);

    const completenessBadge = document.createElement('span');
    completenessBadge.className = 'bindery-actor-completeness';
    completenessBadge.dataset['complete'] = completeness.missingStatCount === 0 && completeness.hasAttacks ? '1' : '0';
    completenessBadge.textContent = `${completeness.presentStatCount}/${completeness.expectedStatCount}${completeness.hasAttacks ? '' : ' · ' + game.i18n!.localize('BINDERY.review.actorNoAttacks' as never)}`;
    completenessBadge.dataset['tooltip'] = game.i18n!.localize('BINDERY.review.actorCompletenessTooltip' as never);
    line1.appendChild(completenessBadge);

    const pageLink = document.createElement('span');
    pageLink.className = 'bindery-actor-page-link';
    pageLink.textContent = `str. ${actor.provenance.pageNumber}`;
    line1.appendChild(pageLink);
    row.appendChild(line1);

    row.appendChild(this.#buildActorImageSection(actor));

    // Kandydaci na nazwe — WYLACZNIE gdy nazwa jeszcze nierozstrzygnieta (po rozstrzygnieciu znikaja, zeby nie zasmiecac wiersza).
    if (actor.nameCandidates && actor.nameCandidates.length > 0 && !this.#actorSelection.isNameResolved(actor)) {
      const candidatesRow = document.createElement('div');
      candidatesRow.className = 'bindery-actor-candidates';
      const label = document.createElement('span');
      label.textContent = game.i18n!.localize('BINDERY.review.actorCandidatesLabel' as never) + ':';
      candidatesRow.appendChild(label);
      for (const candidate of actor.nameCandidates) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'bindery-actor-candidate-btn';
        btn.textContent = candidate;
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.#actorSelection.setResolvedName(actor.id, candidate);
          nameInput.value = candidate;
          nameInput.classList.remove('bindery-actor-name-unresolved');
          this.#rebuildActorAdapterPreview();
          void this.render();
        });
        candidatesRow.appendChild(btn);
      }
      row.appendChild(candidatesRow);
    }

    // [DoD Z2] Wartosci cech/pochodnych — edytowalny input per klucz FAKTYCZNIE obecny w tym aktorze (generyczne, nie zakodowana na sztywno lista pol).
    const statsRow = document.createElement('div');
    statsRow.className = 'bindery-actor-stats';
    for (const [key, stat] of Object.entries(actor.statistics)) {
      const field = document.createElement('label');
      field.className = 'bindery-actor-stat-field';
      const shortLabel = ReviewScreen.#STAT_SHORT_LABELS[key] ?? key;
      const labelSpan = document.createElement('span');
      labelSpan.textContent = shortLabel;
      field.appendChild(labelSpan);
      const input = document.createElement('input');
      input.type = 'text';
      input.value = this.#actorSelection.effectiveStatRaw(actor, key);
      input.title = stat.sourceLabel;
      input.addEventListener('click', (ev) => ev.stopPropagation());
      input.addEventListener('change', () => {
        this.#actorSelection.setStatOverride(actor.id, key, input.value);
        this.#rebuildActorAdapterPreview();
        this.#refreshActorRowNotes(actor.id);
      });
      field.appendChild(input);
      statsRow.appendChild(field);
    }
    row.appendChild(statsRow);

    // [DoD Z2] Ataki — nazwa/trafienie/obrazenia + przycisk usuniecia (przywracalny ponownym kliknieciem — `toggleAttackRemoved`).
    if (actor.attacks.length > 0) {
      const attacksRow = document.createElement('div');
      attacksRow.className = 'bindery-actor-attacks';
      actor.attacks.forEach((attack, index) => {
        const chip = document.createElement('span');
        chip.className = 'bindery-actor-attack-chip';
        if (this.#actorSelection.isAttackRemoved(actor.id, index)) chip.classList.add('bindery-actor-attack-removed');
        const text = document.createElement('span');
        text.textContent = `${attack.name}${attack.toHit ? ' ' + attack.toHit + '%' : ''}${attack.damage ? ' ' + attack.damage : ''}`;
        chip.appendChild(text);
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'bindery-actor-attack-remove';
        removeBtn.textContent = this.#actorSelection.isAttackRemoved(actor.id, index) ? '↺' : '×';
        removeBtn.dataset['tooltip'] = this.#actorSelection.isAttackRemoved(actor.id, index)
          ? game.i18n!.localize('BINDERY.review.actorAttackRestore' as never)
          : game.i18n!.localize('BINDERY.review.actorAttackRemove' as never);
        removeBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.#actorSelection.toggleAttackRemoved(actor.id, index);
          chip.classList.toggle('bindery-actor-attack-removed');
          removeBtn.textContent = this.#actorSelection.isAttackRemoved(actor.id, index) ? '↺' : '×';
          this.#rebuildActorAdapterPreview();
          this.#refreshActorRowNotes(actor.id);
        });
        chip.appendChild(removeBtn);
        attacksRow.appendChild(chip);
      });
      row.appendChild(attacksRow);
    }

    // [DoD Z2, A3/A10] `notes` z adaptera — WIDOCZNE, nigdy ukryte. Kontener z wlasnym data-attribute, zeby `#refreshActorRowNotes` mogl go podmienic bez przebudowy calego wiersza.
    const notesBox = document.createElement('div');
    notesBox.className = 'bindery-actor-notes';
    notesBox.dataset['actorNotesFor'] = actor.id;
    this.#renderActorNotesInto(notesBox, preview);
    row.appendChild(notesBox);

    row.addEventListener('click', (ev) => {
      if (ev.target instanceof HTMLElement && (ev.target.closest('input') || ev.target.closest('button'))) return;
      this.#highlightedActorId = actor.id;
      if (this.#currentPageNumber === actor.provenance.pageNumber) {
        this.#refreshActorRowHighlights();
        void this.#redrawActorOverlay();
      } else {
        this.#currentPageNumber = actor.provenance.pageNumber;
        void this.render();
      }
    });

    return row;
  }

  /**
   * [KROK-35 Z1/Z2] Token+portret aktora — WYLACZNIE wybor z listy obrazow o
   * przeznaczeniu `token` (zakladka Obrazy), zero automatycznego dopasowania
   * geometrycznego (`images.associateWithEntity` z profilu, MDD §5.5,
   * swiadomie nieuzyte — decyzja produktowa kroku 35). Lista NIE jest
   * ograniczona do strony aktora (brief: "autor moze chciec dowolny").
   * Pusta lista tlumaczy, dlaczego jest pusta (ten sam wzorzec co pusta
   * zakladka Aktorow bez profilu, krok 21), zamiast pokazywac pusty dropdown.
   */
  #buildActorImageSection(actor: CIFActor): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'bindery-actor-image-section';

    // [zgloszenie uzytkownika, "obraz bez zaznaczonego checkboxa dawal sie
    // wybrac jako token, ale nie trafial do importu"] `imageDestination ===
    // 'token'` samo w sobie NIE wystarcza — obraz z odznaczonym checkboxem
    // (zakladka Obrazy) NIGDY nie trafia do `uploadedTokenImagePathById`
    // (patrz `#runImport`, petla po `doc.images`: `if (!isImageSelected)
    // continue`), wiec wybranie go tutaj konczylo sie tokenem bez obrazka na
    // karcie (adapter degraduje z ostrzezeniem, ale autor tego ostrzezenia
    // moglby nie zauwazyc). Lepiej nie dawac wyboru, ktory i tak nie zadziala.
    const candidates = this.#data.document.images
      .filter((img) => this.#selection.isImageSelected(img.id) && this.#selection.imageDestination(img.id) === 'token')
      .sort((a, b) => a.provenance.pageNumber - b.provenance.pageNumber);

    if (candidates.length === 0) {
      const hint = document.createElement('span');
      hint.className = 'bindery-actor-image-empty-hint hint';
      hint.textContent = game.i18n!.localize('BINDERY.review.actorTokenEmptyHint' as never);
      wrap.appendChild(hint);
      return wrap;
    }

    // [zgloszenie uzytkownika, "podpowiedz automatyczna po nr strony", potem
    // "ten proponowany token wyglada brzydko" — zmierzone: podpowiedz str. 3
    // dla aktora ze str. 23] Gdy autor jeszcze NIC nie wybral
    // (`hasTokenImageSelection` — odroznia to od jawnego "brak"), podpowiedz
    // kandydata NAJBLIZSZEGO stronie wlasnego statbloku — ALE tylko gdy
    // "najblizszy" faktycznie oznacza BLISKO (ten sam rozklad tresci
    // ksiazki, np. portret na sasiedniej stronie/rozkladowce), nie
    // "najmniej-daleki z calej ksiazki". Bez progu, gdy w calym dokumencie
    // jest tylko kilka obrazow oznaczonych jako token, "najblizszy"
    // potrafil wskazywac cos 20 stron dalej — geometrycznie NIEZWIAZanego
    // z ta postacia (dokladnie zgloszony przypadek), gorsza podpowiedz niz
    // brak podpowiedzi w ogole (A10 — nie zgaduj, gdy sygnal jest slaby).
    const TOKEN_SUGGESTION_MAX_PAGE_DISTANCE = 2;
    if (!this.#actorSelection.hasTokenImageSelection(actor.id)) {
      const nearest = candidates.reduce((best, img) =>
        Math.abs(img.provenance.pageNumber - actor.provenance.pageNumber) < Math.abs(best.provenance.pageNumber - actor.provenance.pageNumber) ? img : best,
      );
      if (Math.abs(nearest.provenance.pageNumber - actor.provenance.pageNumber) <= TOKEN_SUGGESTION_MAX_PAGE_DISTANCE) {
        this.#actorSelection.setTokenImageId(actor.id, nearest.id);
      }
    }

    const tokenField = document.createElement('div');
    tokenField.className = 'bindery-actor-image-field';
    const tokenLabel = document.createElement('span');
    tokenLabel.className = 'bindery-actor-image-field-label';
    tokenLabel.textContent = game.i18n!.localize('BINDERY.review.actorTokenLabel' as never);
    tokenField.appendChild(tokenLabel);
    tokenField.appendChild(
      this.#buildImagePicker(candidates, this.#actorSelection.tokenImageId(actor.id), (imageId) => {
        this.#actorSelection.setTokenImageId(actor.id, imageId);
      }),
    );
    wrap.appendChild(tokenField);

    // [Z2, "Rozdzielenie portretu i tokenu"] Pod "Ustawieniami zaawansowanymi"
    // — domyslnie zwiniete i BEZ wlasnego przypisania (portret podaza za
    // tokenem, P1), rozwiniete automatycznie gdy autor JUZ wczesniej rozdzielil
    // (np. po edycji wczesniejszego wiersza i ponownym renderze calej listy).
    const details = document.createElement('details');
    details.className = 'bindery-studio-advanced-details';
    details.open = this.#actorSelection.hasCustomPortrait(actor.id);
    const summary = document.createElement('summary');
    summary.textContent = game.i18n!.localize('BINDERY.review.actorAdvancedSettings' as never);
    details.appendChild(summary);

    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'bindery-actor-portrait-toggle';
    const toggleCheckbox = document.createElement('input');
    toggleCheckbox.type = 'checkbox';
    toggleCheckbox.className = 'bindery-check';
    toggleCheckbox.checked = this.#actorSelection.hasCustomPortrait(actor.id);
    const toggleText = document.createElement('span');
    toggleText.textContent = game.i18n!.localize('BINDERY.review.actorSeparatePortraitToggle' as never);
    toggleLabel.appendChild(toggleCheckbox);
    toggleLabel.appendChild(toggleText);
    details.appendChild(toggleLabel);

    const portraitField = document.createElement('div');
    portraitField.className = 'bindery-actor-image-field';
    portraitField.style.display = toggleCheckbox.checked ? '' : 'none';
    const portraitLabel = document.createElement('span');
    portraitLabel.className = 'bindery-actor-image-field-label';
    portraitLabel.textContent = game.i18n!.localize('BINDERY.review.actorPortraitLabel' as never);
    portraitField.appendChild(portraitLabel);
    details.appendChild(portraitField);

    // [Z2] Podglad portretu budowany DOPIERO gdy nadpisanie jest wlaczone —
    // dopoki podaza za tokenem, nie ma WLASNEGO stanu wartego wlasnego
    // widgetu (patrz `portraitImageId` w `ActorReviewSelection`).
    const mountPortraitPicker = (): void => {
      const existing = portraitField.querySelector('.bindery-actor-image-picker');
      existing?.remove();
      portraitField.appendChild(
        this.#buildImagePicker(candidates, this.#actorSelection.portraitImageId(actor.id), (imageId) => {
          this.#actorSelection.setPortraitImageId(actor.id, imageId);
        }),
      );
    };
    if (toggleCheckbox.checked) mountPortraitPicker();

    toggleCheckbox.addEventListener('click', (ev) => ev.stopPropagation());
    toggleCheckbox.addEventListener('change', () => {
      if (toggleCheckbox.checked) {
        this.#actorSelection.setPortraitImageId(actor.id, this.#actorSelection.tokenImageId(actor.id));
        portraitField.style.display = '';
        mountPortraitPicker();
      } else {
        this.#actorSelection.clearCustomPortrait(actor.id);
        portraitField.style.display = 'none';
        portraitField.querySelector('.bindery-actor-image-picker')?.remove();
      }
    });

    wrap.appendChild(details);
    return wrap;
  }

  /**
   * [KROK-35 Z1] Dropdown z miniaturami — natywny `<select>` nie potrafi
   * pokazac obrazka per pozycja (twarde ograniczenie HTML), stad wlasny,
   * malutki popover: przycisk pokazujacy AKTUALNY wybor (miniatura+strona),
   * po kliknieciu lista wszystkich kandydatow (miniatura+strona kazdy).
   * Samodzielny, zamykany klikiem poza soba — zero zaleznosci od reszty
   * wiersza, zeby dalo sie go uzyc zarowno dla tokenu jak i portretu.
   */
  #buildImagePicker(images: readonly CIFImage[], currentId: string, onSelect: (imageId: string) => void): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'bindery-actor-image-picker';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'bindery-actor-image-picker-toggle';

    const menu = document.createElement('div');
    menu.className = 'bindery-actor-image-picker-menu';
    menu.hidden = true;

    const renderToggleContent = (imageId: string): void => {
      toggle.innerHTML = '';
      const image = images.find((i) => i.id === imageId) ?? null;
      const thumbUrl = imageId ? this.#thumbnailFor(imageId) : null;
      if (thumbUrl) {
        const thumb = document.createElement('img');
        thumb.className = 'bindery-actor-image-picker-thumb';
        thumb.src = thumbUrl;
        thumb.alt = '';
        toggle.appendChild(thumb);
      }
      const text = document.createElement('span');
      text.textContent = image ? `str. ${image.provenance.pageNumber}` : game.i18n!.localize('BINDERY.review.actorImageNone' as never);
      toggle.appendChild(text);
    };
    renderToggleContent(currentId);

    const buildOption = (imageId: string, image: CIFImage | null): HTMLElement => {
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'bindery-actor-image-picker-option';
      const thumbUrl = image ? this.#thumbnailFor(image.id) : null;
      if (thumbUrl) {
        const thumb = document.createElement('img');
        thumb.className = 'bindery-actor-image-picker-thumb';
        thumb.src = thumbUrl;
        thumb.alt = '';
        opt.appendChild(thumb);
      }
      const text = document.createElement('span');
      text.textContent = image ? `str. ${image.provenance.pageNumber}` : game.i18n!.localize('BINDERY.review.actorImageNone' as never);
      opt.appendChild(text);
      opt.addEventListener('click', (ev) => {
        ev.stopPropagation();
        menu.hidden = true;
        renderToggleContent(imageId);
        onSelect(imageId);
      });
      return opt;
    };

    menu.appendChild(buildOption('', null));
    for (const image of images) menu.appendChild(buildOption(image.id, image));

    const closeOnOutsideClick = (ev: MouseEvent): void => {
      if (wrap.contains(ev.target as Node)) return;
      menu.hidden = true;
      document.removeEventListener('click', closeOnOutsideClick);
    };
    toggle.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const willOpen = menu.hidden;
      menu.hidden = !willOpen;
      if (willOpen) document.addEventListener('click', closeOnOutsideClick);
    });

    wrap.appendChild(toggle);
    wrap.appendChild(menu);
    return wrap;
  }

  #renderActorNotesInto(container: HTMLElement, preview: AdapterResult<Coc7ActorPayload> | undefined): void {
    container.innerHTML = '';
    if (!preview) return;
    for (const issue of preview.issues) {
      const p = document.createElement('p');
      p.className = `bindery-actor-note bindery-actor-note-${issue.severity}`;
      p.textContent = localizeMessage('coc7', issue);
      container.appendChild(p);
    }
    for (const note of preview.notes) {
      const p = document.createElement('p');
      p.className = 'bindery-actor-note bindery-actor-note-info';
      p.textContent = localizeMessage('coc7', note);
      container.appendChild(p);
    }
  }

  /** Odswieza WYLACZNIE notatki JEDNEGO wiersza (po edycji pola) — bez pelnego `render()`, zeby nie gubic fokusu/scrolla listy. */
  #refreshActorRowNotes(actorId: string): void {
    const box = this.element.querySelector<HTMLElement>(`[data-actor-notes-for="${actorId}"]`);
    if (box) this.#renderActorNotesInto(box, this.#actorAdapterPreview.get(actorId));
  }

  static #onSelectAllActors(this: ReviewScreen): void {
    this.#actorSelection.selectAll();
    void this.render();
  }
  static #onSelectNoActors(this: ReviewScreen): void {
    this.#actorSelection.selectNone();
    void this.render();
  }

  /** [naprawa zgloszonego bledu — patrz `#refreshHeaderCounts`, ten sam blad, ten sam relikt `.bindery-review-counts`.] */
  async #refreshActorHeaderCounts(): Promise<void> {
    const el = this.element.querySelector<HTMLElement>('[data-count="actors"]');
    if (!el || this.#tab !== 'actors') return;
    el.textContent = `${game.i18n!.localize('BINDERY.review.selectedCount' as never)}: ${this.#actorSelection.selectedCount}/${(this.#data.document.actors ?? []).length}`;
  }

  #refreshActorRowHighlights(): void {
    const rows = this.element.querySelectorAll<HTMLElement>('.bindery-actor-row');
    for (const row of rows) {
      row.classList.toggle('bindery-row-highlighted', row.dataset['actorId'] === this.#highlightedActorId);
    }
  }

  /** [KROK-20 Z2] Nawigacja `provenance` w OBIE strony — mirror `#mountOverlay`/`#redrawOverlay` obrazow, ale bez trybu "zaznacz i wytnij" (nie dotyczy aktorow). */
  async #redrawActorOverlay(): Promise<void> {
    await this.#mountActorOverlay(this.#data.document.actors ?? []);
  }

  async #mountActorOverlay(actors: readonly CIFActor[]): Promise<void> {
    const svg = this.element.querySelector<SVGSVGElement>('[data-overlay]');
    const img = this.element.querySelector<HTMLImageElement>('.bindery-page-image');
    if (!svg || !img) return;

    // [naprawa zgloszonego bledu — patrz identyczny komentarz w `#mountOverlay`.]
    const requestedPageNumber = this.#currentPageNumber;
    const box = await this.#data.previewDocument.getPageBox(requestedPageNumber);
    if (this.#currentPageNumber !== requestedPageNumber) return;
    const draw = () => {
      const width = img.naturalWidth || img.clientWidth;
      const height = img.naturalHeight || img.clientHeight;
      if (!width || !height) return;
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.style.width = `${img.clientWidth}px`;
      svg.style.height = `${img.clientHeight}px`;
      svg.innerHTML = '';
      for (const actor of actors) {
        if (actor.provenance.pageNumber !== this.#currentPageNumber) continue;
        const screen = pdfRectToScreen(actor.provenance.bbox, { pageBox: box.box, imageWidthPx: width, imageHeightPx: height, rotation: box.rotation as never });
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', String(screen.minX));
        rect.setAttribute('y', String(screen.minY));
        rect.setAttribute('width', String(Math.max(0, screen.maxX - screen.minX)));
        rect.setAttribute('height', String(Math.max(0, screen.maxY - screen.minY)));
        const classes = [this.#actorSelection.isSelected(actor.id) ? 'bindery-overlay-selected' : 'bindery-overlay-unselected'];
        if (actor.id === this.#highlightedActorId) classes.push('bindery-overlay-highlighted');
        rect.setAttribute('class', classes.join(' '));
        rect.dataset['actorId'] = actor.id;
        rect.addEventListener('click', () => {
          this.#highlightedActorId = actor.id;
          // [KROK-21] Bez VirtualList (patrz komentarz `#mountActorList`) — wiersz
          // jest juz w DOM, wystarczy zwykle przewiniecie do niego.
          this.element.querySelector(`.bindery-actor-row[data-actor-id="${actor.id}"]`)?.scrollIntoView({ block: 'nearest' });
          this.#refreshActorRowHighlights();
          draw();
        });
        svg.appendChild(rect);
      }
    };
    if (img.complete) draw();
    else img.addEventListener('load', draw, { once: true });
  }

  // ---- Lista scen ---------------------------------------------------------

  #mountSceneList(): void {
    this.#sceneList = this.#mountList(this.element.querySelector<HTMLElement>('[data-list="scenes"]'), 'scenes', this.#data.document.scenes, 48, (scene) => this.#buildSceneRow(scene));
  }

  #buildSceneRow(scene: CIFScene): HTMLElement {
    const row = document.createElement('div');
    row.className = 'bindery-review-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'bindery-check';
    checkbox.checked = this.#selection.isSceneSelected(scene.id);
    checkbox.addEventListener('change', () => this.#selection.setScene(scene.id, checkbox.checked));
    row.appendChild(checkbox);
    const label = document.createElement('span');
    label.className = 'bindery-row-label';
    label.textContent = `${scene.name} — str. ${scene.provenance.pageNumber}`;
    row.appendChild(label);
    return row;
  }

  // ---- Drzewo journali (Z5) ------------------------------------------------

  #mountJournalList(): void {
    this.#journalList = this.#mountList(this.element.querySelector<HTMLElement>('[data-list="journals"]'), 'journals', this.#journalRows, 40, (row) => this.#buildJournalRow(row));
  }

  #buildJournalRow(row: JournalRow): HTMLElement {
    const el = document.createElement('div');
    el.className = row.kind === 'journal' ? 'bindery-review-row bindery-journal-header-row' : 'bindery-review-row bindery-journal-page-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'bindery-check';
    if (row.kind === 'journal') {
      checkbox.checked = this.#selection.isJournalSelected(row.journal.id);
      checkbox.addEventListener('change', () => {
        this.#selection.setJournal(row.journal.id, checkbox.checked);
        for (const page of row.journal.pages) this.#selection.setJournalPage(page.id, checkbox.checked);
        void this.render();
      });
    } else {
      checkbox.checked = this.#selection.isJournalPageSelected(row.pageId!);
      checkbox.addEventListener('change', () => this.#selection.setJournalPage(row.pageId!, checkbox.checked));
    }
    el.appendChild(checkbox);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'bindery-row-name-input';
    nameInput.value = row.kind === 'journal' ? row.journal.name : row.pageName!;
    nameInput.addEventListener('change', () => {
      if (row.kind === 'journal') row.journal.name = nameInput.value;
      else {
        const page = row.journal.pages.find((p) => p.id === row.pageId);
        if (page) page.name = nameInput.value;
      }
    });
    el.appendChild(nameInput);

    return el;
  }

  // ---- Diagnostyka (Z7) -----------------------------------------------------

  #mountDiagnosticList(container: HTMLElement | null, diagnostics?: readonly Diagnostic[]): void {
    if (!container) return;
    const groups = diagnostics ? this.#groupDiagnostics(diagnostics) : this.#diagnosticGroups;
    // [zgloszenie uzytkownika] Ten sam kontroler montowany dla DWOCH roznych
    // kontenerow (zakladka Diagnostyka i krok Podsumowanie) — `data-list`
    // (juz uzyty przez wywolujacego do znalezienia `container`) jako klucz
    // sledzenia przewijania, zeby obie listy mialy WLASNA, niezalezna pamiec.
    const key = container.dataset['list'] ?? 'diagnostics';
    this.#diagnosticList = this.#mountList(container, key, groups, 32, (group) => this.#buildDiagnosticRow(group));
  }

  #groupDiagnostics(diagnostics: readonly Diagnostic[]): DiagnosticGroup[] {
    const byCode = new Map<string, Diagnostic[]>();
    for (const d of diagnostics) {
      const arr = byCode.get(d.code) ?? [];
      arr.push(d);
      byCode.set(d.code, arr);
    }
    return [...byCode.entries()].map(([code, examples]) => ({ code, severity: examples[0]!.severity, count: examples.length, examples: examples.slice(0, 20) }));
  }

  #buildDiagnosticRow(group: DiagnosticGroup): HTMLElement {
    const row = document.createElement('div');
    row.className = `bindery-review-row bindery-diagnostic-row bindery-diagnostic-${group.severity}`;
    const label = document.createElement('span');
    label.textContent = `[${group.severity}] ${group.code} × ${group.count}`;
    row.appendChild(label);
    const firstPage = group.examples.find((d) => d.pageNumber !== undefined)?.pageNumber;
    if (firstPage !== undefined && this.#step === 'review') {
      const jump = document.createElement('button');
      jump.type = 'button';
      jump.textContent = `str. ${firstPage}`;
      jump.addEventListener('click', () => {
        this.#currentPageNumber = firstPage;
        this.#tab = 'images';
        void this.render();
      });
      row.appendChild(jump);
    }
    return row;
  }

  // ---- Zakladki / krok (Z2/Z6) -----------------------------------------------

  static #onSwitchTab(this: ReviewScreen, _ev: PointerEvent, target: HTMLElement): void {
    const tab = target.dataset['tab'] as ReviewTab | undefined;
    if (!tab) return;
    this.#tab = tab;
    void this.render();
  }

  static #onSwitchImageSourceTab(this: ReviewScreen, _ev: PointerEvent, target: HTMLElement): void {
    const source = target.dataset['source'] as ImageSourceTab | undefined;
    if (!source) return;
    this.#imageSourceTab = source;
    void this.render();
  }

  static #onSwitchImageDestTab(this: ReviewScreen, _ev: PointerEvent, target: HTMLElement): void {
    const dest = target.dataset['dest'] as ImageDestTab | undefined;
    if (!dest) return;
    this.#imageDestTab = dest;
    void this.render();
  }

  static #onCancelReview(this: ReviewScreen): void {
    void this.close();
  }

  static #onProceedToTarget(this: ReviewScreen): void {
    this.#step = 'target';
    void this.render();
  }

  static #onBackToReview(this: ReviewScreen): void {
    this.#step = 'review';
    void this.render();
  }

  #wireTargetInputs(): void {
    if (this.#step !== 'target') return;
    const sceneFolder = this.element.querySelector<HTMLInputElement>('input[name="sceneFolder"]');
    const journalFolder = this.element.querySelector<HTMLInputElement>('input[name="journalFolder"]');
    const actorFolder = this.element.querySelector<HTMLInputElement>('input[name="actorFolder"]');
    const imagePath = this.element.querySelector<HTMLInputElement>('input[name="imagePath"]');
    const namePrefix = this.element.querySelector<HTMLInputElement>('input[name="namePrefix"]');
    sceneFolder?.addEventListener('change', () => (this.#targets.sceneFolder = sceneFolder.value));
    journalFolder?.addEventListener('change', () => (this.#targets.journalFolder = journalFolder.value));
    actorFolder?.addEventListener('change', () => (this.#targets.actorFolder = actorFolder.value));
    namePrefix?.addEventListener('change', () => (this.#targets.namePrefix = namePrefix.value));
    if (imagePath) {
      imagePath.value = game.settings!.get(MODULE_ID, 'uploadPath') as string;
      imagePath.addEventListener('change', () => void game.settings!.set(MODULE_ID, 'uploadPath', imagePath.value));
    }
  }

  // ---- Import (Z6) --------------------------------------------------------

  static async #onConfirmImport(this: ReviewScreen): Promise<void> {
    this.#isImporting = true;
    this.#importError = null;
    await this.render();

    try {
      await game.settings!.set(MODULE_ID, 'importTargets', { ...this.#targets });
      const summary = await this.#runImport();
      this.#summaryEntries = summary.entries;
      this.#summaryDiagnostics = summary.diagnostics;
      this.#settled = true;
      this.#resolve?.({ confirmed: true });
      this.#step = 'summary';
    } catch (err) {
      this.#importError = game.i18n!.localize('BINDERY.review.importErrorGeneric');
      console.warn('Bindery | import z ekranu przegladu nieudany:', err);
    } finally {
      this.#isImporting = false;
      await this.render();
    }
  }

  async #runImport(): Promise<{ entries: { label: string; uuid?: string }[]; diagnostics: Diagnostic[] }> {
    const doc = this.#data.document;
    const baseName = this.#data.fileName.replace(/\.pdf$/i, '') || 'bindery-import';
    const prefix = this.#targets.namePrefix.trim();
    const withPrefix = (name: string): string => (prefix ? `${prefix} ${name}` : name);

    const entries: { label: string; uuid?: string }[] = [];
    const runDiagnostics: Diagnostic[] = [];

    // Sceny — WYLACZNIE zaznaczone.
    const sceneFolderId = await ensureFolder(this.#targets.sceneFolder, 'Scene');
    // [KROK-14 Z4, poprawione KROK-16 Z2] Obrazy juz obsluzone przez CIFScene
    // (nizej) lub osadzone w journalu (dalej) NIE przechodza jeszcze raz przez
    // petle przeznaczenia per obraz — ten sam obraz nie powinien dostac DWOCH
    // dokumentow. WYLACZNIE dla FAKTYCZNIE zaznaczonych scen/journali/stron —
    // pierwotna wersja dodawala `scene.imageRef` bezwarunkowo, wiec obraz
    // nalezacy do ODZNACZONEJ (a wiec nigdy nie utworzonej) CIFScene byl mimo
    // to wykluczany z petli przeznaczenia per obraz w zakladce Obrazy ("scena
    // sie nie tworzy" — obraz nie dostawal ZADNEGO dokumentu, wbrew intencji
    // uzytkownika ustawionej w dropdownie).
    const usedImageIds = new Set<string>();
    // [KROK-20] Patrz komentarz przy `SCENES_JOURNALS_FROM_CIF_ENABLED` u gory
    // pliku — auto-detekcja CIFScene/CIFJournal wylaczona "na razie", te same
    // obrazy nadal dostepne w zakladce Obrazy z Przeznaczeniem Scena/Journal.
    if (SCENES_JOURNALS_FROM_CIF_ENABLED) {
      for (const scene of doc.scenes) {
        if (this.#selection.isSceneSelected(scene.id)) usedImageIds.add(scene.imageRef);
      }

      for (const scene of doc.scenes) {
        if (!this.#selection.isSceneSelected(scene.id)) continue;
        const image = doc.images.find((i) => i.id === scene.imageRef);
        const bytes = this.#data.imageBytesById.get(scene.imageRef);
        if (!image || !bytes) {
          runDiagnostics.push({ severity: 'error', code: 'REVIEW_SCENE_IMAGE_MISSING', params: { name: scene.name, imageRef: scene.imageRef }, pageNumber: scene.provenance.pageNumber });
          continue;
        }
        try {
          const upload = await uploadImage({ bytes: bytes.bytes, baseName: `${baseName}-${scene.imageRef}`, format: bytes.format === 'png' ? 'png' : 'webp' });
          const name = withPrefix(scene.name);
          const grid = await this.#pickGridForImage(bytes, image);
          const created = await createSceneFromImage({ name, imagePath: upload.path, width: image.width, height: image.height, grid, folder: sceneFolderId });
          entries.push({ label: name, uuid: created.uuid });
        } catch (err) {
          runDiagnostics.push({ severity: 'error', code: 'REVIEW_SCENE_CREATE_FAILED', params: { name: scene.name, error: err instanceof Error ? err.message : String(err) }, pageNumber: scene.provenance.pageNumber });
        }
      }
    }

    // Journale — WYLACZNIE zaznaczone journale, WYLACZNIE zaznaczone strony wewnatrz.
    const journalFolderId = await ensureFolder(this.#targets.journalFolder, 'JournalEntry');
    if (SCENES_JOURNALS_FROM_CIF_ENABLED) {
      const filteredJournals: CIFJournalForCreation[] = [];
      for (const journal of doc.journals) {
        if (!this.#selection.isJournalSelected(journal.id)) continue;
        const pages = journal.pages.filter((p) => this.#selection.isJournalPageSelected(p.id));
        if (pages.length === 0) continue;
        for (const p of pages) for (const id of p.imageRefs) usedImageIds.add(id);
        filteredJournals.push({ name: withPrefix(journal.name), pages: pages.map((p) => ({ name: p.name, headingLevel: p.headingLevel, html: p.html })) });
      }
      if (filteredJournals.length > 0) {
        const imagesForUpload = doc.images.filter((i) => usedImageIds.has(i.id)).map((i) => ({ id: i.id, format: i.format }));
        const result = await createJournalsFromCIF({
          journals: filteredJournals,
          images: imagesForUpload,
          imageBytesById: this.#data.imageBytesById,
          baseName,
          folder: journalFolderId,
        });
        for (const j of result.createdJournals) entries.push({ label: j.name, uuid: j.uuid });
        for (const missing of result.missingImageIds) {
          runDiagnostics.push({ severity: 'warning', code: 'REVIEW_JOURNAL_IMAGE_MISSING', params: { imageId: missing } });
        }
      }
    }

    const defaultImageName = game.i18n!.localize('BINDERY.review.defaultImageName' as never);

    // [KROK-19, zgloszony na zywo brak "brakuje mi lepszej segregacji
    // journali"] Obrazy z przeznaczeniem `journal` I niepusta nazwa grupy
    // (ustawiona w zakladce Obrazy — per obraz albo zbiorczo) trafiaja RAZEM
    // do JEDNEGO JournalEntry (wiele stron typu image), zamiast kazdy dostawac
    // wlasny osobny journal jak dotychczas. Obrazy z PUSTA grupa (domyslnie)
    // zachowuja stare zachowanie — obsluguje je petla per-obraz ponizej,
    // ktora pomija juz-obsluzone `usedImageIds`.
    const journalGroups = new Map<string, CIFImage[]>();
    for (const image of doc.images) {
      if (usedImageIds.has(image.id)) continue;
      if (!this.#selection.isImageSelected(image.id)) continue;
      if (this.#selection.imageDestination(image.id) !== 'journal') continue;
      const group = this.#selection.imageJournalGroup(image.id);
      if (!group) continue;
      // Zaklamane od razu (nie dopiero po udanym przetworzeniu ponizej) —
      // ten obraz NALEZY do grupy niezaleznie od tego czy jego przetworzenie
      // sie powiedzie; petla per-obraz ponizej nie powinna go dotknac nawet
      // przy bledzie (unika zdublowanej diagnostyki dla tego samego obrazu).
      usedImageIds.add(image.id);
      const list = journalGroups.get(group) ?? [];
      list.push(image);
      journalGroups.set(group, list);
    }
    for (const [groupName, groupImages] of journalGroups) {
      const pages: { name: string; imagePath: string }[] = [];
      for (const image of groupImages) {
        const bytes = this.#data.imageBytesById.get(image.id);
        if (!bytes) {
          runDiagnostics.push({ severity: 'error', code: 'REVIEW_IMAGE_BYTES_MISSING', params: { imageId: image.id }, pageNumber: image.provenance.pageNumber });
          continue;
        }
        try {
          const upload = await uploadImage({ bytes: bytes.bytes, baseName: `${baseName}-${image.id}`, format: bytes.format === 'png' ? 'png' : 'webp' });
          pages.push({ name: withPrefix(image.caption?.trim() || `${defaultImageName} p.${image.provenance.pageNumber}`), imagePath: upload.path });
        } catch (err) {
          // [KROK-27 Z1] Kod odrebny od `REVIEW_IMAGE_DESTINATION_FAILED` ponizej —
          // inny ksztalt parametrow (imageId+groupName, nie name+destination), wiec
          // wspolny kod dawalby niespojny szablon lokalizacji.
          runDiagnostics.push({ severity: 'error', code: 'REVIEW_IMAGE_JOURNAL_GROUP_FAILED', params: { imageId: image.id, groupName, error: err instanceof Error ? err.message : String(err) }, pageNumber: image.provenance.pageNumber });
        }
      }
      if (pages.length === 0) continue;
      try {
        const created = await createJournalHandoutFromImages({ name: withPrefix(groupName), pages, folder: journalFolderId });
        entries.push({ label: created.name, uuid: created.uuid });
      } catch (err) {
        runDiagnostics.push({ severity: 'error', code: 'REVIEW_JOURNAL_GROUP_CREATE_FAILED', params: { groupName, error: err instanceof Error ? err.message : String(err) } });
      }
    }

    // [KROK-35 Z2] Sciezka WGRANEGO obrazu `token` per `CIFImage.id` — jedyny
    // most miedzy zakladka Obrazy (co ZOSTALO faktycznie wgrane, ponizej) i
    // zakladka Aktorzy (co autor WYBRAL jako token/portret, `ctx.imagePathResolver`
    // przekazany do adaptera). Zamierzenie: obraz wybrany jako token, ktory z
    // jakiegos powodu nie trafil TUTAJ (odznaczony w zakladce Obrazy, przeznaczenie
    // zmienione, blad uploadu — patrz `catch` nizej) po prostu nie ma tu wpisu,
    // wiec resolver zwraca `null` i adapter degraduje z jawnym ostrzezeniem
    // zamiast wpisywac sciezke do nieistniejacego pliku (A3/A7, brief Z2).
    const uploadedTokenImagePathById = new Map<string, string>();

    // [KROK-14 Z4] Przeznaczenie per obraz (zakladka Obrazy) — WYLACZNIE
    // zaznaczone obrazy, ktore NIE zostaly juz obsluzone jako CIFScene, osadzone
    // w journalu, ani zebrane w grupe journala powyzej. `scene`/`journal`/`token`
    // tworza wprost z POJEDYNCZEGO obrazu (MDD v2.1 §1.2, P1); `unassigned`
    // (dawne `skip` — zgloszenie uzytkownika, patrz `defaultImageDestination`)
    // jest pomijany.
    for (const image of doc.images) {
      if (usedImageIds.has(image.id)) continue;
      if (!this.#selection.isImageSelected(image.id)) continue;
      const destination = this.#selection.imageDestination(image.id);
      if (destination === 'unassigned') continue;

      const bytes = this.#data.imageBytesById.get(image.id);
      if (!bytes) {
        runDiagnostics.push({ severity: 'error', code: 'REVIEW_IMAGE_BYTES_MISSING', params: { imageId: image.id }, pageNumber: image.provenance.pageNumber });
        continue;
      }
      const name = withPrefix(image.caption?.trim() || `${defaultImageName} p.${image.provenance.pageNumber}`);
      try {
        const upload = await uploadImage({ bytes: bytes.bytes, baseName: `${baseName}-${image.id}`, format: bytes.format === 'png' ? 'png' : 'webp' });
        if (destination === 'scene') {
          const grid = await this.#pickGridForImage(bytes, image);
          const created = await createSceneFromImage({ name, imagePath: upload.path, width: image.width, height: image.height, grid, folder: sceneFolderId });
          entries.push({ label: name, uuid: created.uuid });
        } else if (destination === 'journal') {
          const created = await createJournalHandoutFromImage({ name, imagePath: upload.path, folder: journalFolderId });
          entries.push({ label: name, uuid: created.uuid });
        } else {
          // [KROK-14 Z4, poprawione KROK-16 Z2] 'token' — zapis na dysk, bez
          // tworzenia dokumentu (brief). Pierwotnie etykieta bez sciezki byla
          // NIEODROZNIALNA od "nic sie nie stalo" ("nie widze gdzie sie
          // zapisuje tokeny") — dopisujemy realna sciezke zwrocona przez
          // `FilePicker.upload()`, jedyny slad tego zapisu widoczny dla
          // uzytkownika (brak dokumentu, wiec brak `uuid`/linku do otwarcia).
          entries.push({ label: `${name} — ${upload.path}` });
          // [KROK-35 Z2] Zapamietane PO udanym wgraniu — patrz komentarz przy
          // `uploadedTokenImagePathById` powyzej.
          uploadedTokenImagePathById.set(image.id, upload.path);
        }
      } catch (err) {
        runDiagnostics.push({ severity: 'error', code: 'REVIEW_IMAGE_DESTINATION_FAILED', params: { name, destination, error: err instanceof Error ? err.message : String(err) }, pageNumber: image.provenance.pageNumber });
      }
    }

    // [KROK-20 Z2] Aktorzy — WYLACZNIE zaznaczone, PO nadpisaniach uzytkownika
    // (`applyActorOverrides`), z notatkami adaptera WLACZONYMI (w odroznieniu
    // od `tools/build-z4-measurement-macro.ts` z kroku 19, ktore je celowo
    // zerowalo WYLACZNIE do pomiaru — produkt docelowy zawsze je liczy, A3/A10).
    const selectedActors = (doc.actors ?? []).filter((a) => this.#actorSelection.isSelected(a.id));
    if (selectedActors.length > 0) {
      const actorFolderId = await ensureFolder(this.#targets.actorFolder, 'Actor');
      const actorResults = selectedActors.map((actor) => {
        const patched = applyActorOverrides(actor, this.#actorSelection);
        // [KROK-35 Z1/Z2] `tokenImageRef`/`portraitImageRef` — id obrazu WYBRANEGO
        // przez autora w zakladce Aktorow (pusty string = "brak"), rozwiazywany
        // na sciezke WYLACZNIE przez `imagePathResolver` (patrz `uploadedTokenImagePathById`
        // powyzej) — adapter degraduje sam, gdy resolver zwroci `null`.
        const ctx = {
          folderId: actorFolderId ?? null,
          imagePathResolver: (ref: string) => uploadedTokenImagePathById.get(ref) ?? null,
          language: doc.source.detectedLanguage,
          profileId: doc.source.detectedProfileId,
          tokenImageRef: this.#actorSelection.tokenImageId(actor.id) || null,
          portraitImageRef: this.#actorSelection.portraitImageId(actor.id) || null,
        };
        // Patrz komentarz przy `#rebuildActorAdapterPreview` — ten sam bezpieczny rzut, WLASNA implementacja `coc7Adapter`.
        return coc7Adapter.fromActor(patched, ctx) as AdapterResult<Coc7ActorPayload>;
      });
      try {
        const created = await createActorsFromAdapterResults({ results: actorResults, folder: actorFolderId });
        for (const entry of created) {
          entries.push({ label: entry.actor.name as unknown as string, uuid: (entry.actor as unknown as { uuid?: string }).uuid });
          // [KROK-27 Z1] Bez prefiksu "nazwa aktora: " — parametry issue'a
          // (np. `UNCERTAIN_NAME`'s `name`) juz niosa te sama nazwe; dublowanie
          // jej tutaj (poprzedni ksztalt z `.message`) bylo widoczna nadmiarowoscia
          // ("X: Nazwa niepewna: X..."), nie celowa cecha.
          for (const issue of entry.issues) {
            runDiagnostics.push({ severity: issue.severity, code: issue.code, params: issue.params });
          }
        }
      } catch (err) {
        runDiagnostics.push({ severity: 'error', code: 'REVIEW_ACTOR_CREATE_FAILED', params: { error: err instanceof Error ? err.message : String(err) } });
      }
    }

    return { entries, diagnostics: runDiagnostics };
  }

  /**
   * [KROK-16 Z2, wpiecie GridPicker] Otwiera `GridPicker` (zbudowany w kroku
   * 8, do dzis nigdzie nie wywolywany — martwy kod) z podgladem NA ZYWO
   * KONKRETNEGO obrazu, zamiast dawac kazdej scenie ten sam, niedopasowany
   * punkt startowy. Uzytkownik moze zatwierdzic (kalibracja zapisywana jako
   * `lastGridConfig` — startowa pozycja suwakow dla NASTEPNEJ sceny, zeby nie
   * zaczynac od zera przy podobnych mapach) albo anulowac — wtedy uzywamy
   * OSTATNIEJ ZATWIERDZONEJ kalibracji jako rozsadnego przyblizenia (jawny
   * wybor uzytkownika "pomin", nie ciche narzucenie cudzych ustawien jak w
   * pierwotnym buggu — patrz historia tego pliku).
   */
  async #pickGridForImage(bytes: { bytes: Uint8Array; format: string }, image: { width: number; height: number; suggestedGrid?: CIFImage['suggestedGrid'] }): Promise<GridConfig> {
    const mime = bytes.format === 'png' ? 'image/png' : 'image/webp';
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes.bytes)], { type: mime }));
    try {
      // [KROK-17] Sugestia auto-detekcji przekazana WYLACZNIE gdy pewnosc
      // przekracza prog "warty pokazania" — ponizej niego lepszym punktem
      // startowym jest ostatnia reczna kalibracja (`lastGridConfig`, patrz
      // `GridPickerApp.pick`) niz zgadywanie na slabym sygnale.
      const suggested = image.suggestedGrid;
      const suggestedGrid =
        suggested && suggested.confidence >= MIN_GRID_SUGGESTION_CONFIDENCE
          ? { size: suggested.size, offsetX: suggested.offsetX, offsetY: suggested.offsetY }
          : undefined;
      const picked = await pickGrid({ imageDataUrl: url, imageWidth: image.width, imageHeight: image.height, suggestedGrid });
      if (picked) return picked;
      return game.settings!.get(MODULE_ID, 'lastGridConfig') as GridConfig;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  static #onCloseReview(this: ReviewScreen): void {
    void this.close();
  }

  static #onOpenDocument(this: ReviewScreen, _ev: PointerEvent, target: HTMLElement): void {
    const uuid = target.dataset['uuid'];
    if (!uuid) return;
    void (async () => {
      const doc = await fromUuid(uuid);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (doc as any)?.sheet?.render(true);
    })();
  }
}

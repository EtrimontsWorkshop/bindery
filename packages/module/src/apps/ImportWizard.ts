import { ASSET_BASE_URL, MODULE_ID, type LastActorProfile } from '../settings.js';
import { buildJournalsForReview, openPreviewForReview, validateActorProfileFile, type CIFBuildResult } from '../api.js';
import { STATBLOCKS_ENABLED } from '../features.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** [KROK-21 Z1] Skrocone dane profilu do wyswietlenia — NIGDY tresc (R2: profil to instrukcje parsowania, nie interesuje nas jego "wyglad", tylko to, ze dziala). */
interface ActorProfileSummary {
  title: string;
  publication: string;
  gameLine: string;
  language: string;
  patternCount: number;
}

interface WizardState {
  status: 'idle' | 'analyzing' | 'done' | 'error';
  fileName: string | null;
  errorMessage: string | null;
  summary: import('@bindery/core').DocumentSummary | null;
  isBuildingReview: boolean;
  reviewProgress: { done: number; total: number } | null;
  reviewBuildError: string | null;
  lastImportSummary: string | null;
  /** [KROK-21 Z1] `null` = brak wczytanego pliku profilu jeszcze w tej sesji okna. */
  actorProfileFileName: string | null;
  actorProfileSummary: ActorProfileSummary | null;
  actorProfileIssues: readonly string[] | null;
}

/**
 * Ryzyko I3: pdf.js NIE jest importowany na poziomie modulu — dopiero wewnatrz
 * #onAnalyze, gdy uzytkownik faktycznie otworzy okno i kliknie analizuj.
 * Weryfikacja w Z7: swiat bez otwarcia tego okna nie powinien pobierac pdf.mjs
 * ani @bindery/core (ktory reeksportuje typy, ale kod inspectDocument tez
 * dynamicznie importuje pdfjs-dist wewnatrz — samo @bindery/core jest male).
 *
 * [KROK-11] `ReviewScreen` jest DYNAMICZNIE importowany dopiero w
 * `#onOpenReview` (ten sam powod I3 — nie obciazac budzetu <40KB startu
 * swiata skladem calego ekranu przegladu, wirtualizacji itd., ktore sa
 * potrzebne WYLACZNIE po faktycznym kliknieciu). Ten plik NIE tworzy juz
 * zadnych dokumentow Foundry samodzielnie — wylacznie buduje `CIFDocument` i
 * oddaje kontrole `ReviewScreen`, ktory jest JEDYNYM miejscem tworzacym
 * Scene/JournalEntry (A5: czlowiek zawsze przeglada przed zapisem).
 */
export class ImportWizard extends HandlebarsApplicationMixin(ApplicationV2) {
  static override DEFAULT_OPTIONS = {
    id: 'bindery-wizard',
    classes: ['bindery', 'bindery-wizard'],
    window: {
      title: 'BINDERY.wizard.title',
      resizable: true,
      icon: 'fa-solid fa-file-import',
    },
    position: {
      // [redesign 2a] 480 -> 560: strefa zrzutu pliku + karta profilu
      // potrzebuja wiecej oddechu niz dawny, ciasny uklad tabelaryczny.
      width: 560,
      // [KROK-8, odkrycie] `height: 'auto'` nie daje przeskrolowania, gdy tresc
      // (siatka wyekstrahowanych obrazow) urosnie ponad widoczny obszar — okno
      // po prostu obcina reszte bez paska przewijania. Stala wysokosc + CSS
      // `overflow-y` na `.window-content` (domyslne Foundry) daje przewijanie;
      // `resizable: true` (juz ustawione) pozwala uzytkownikowi powiekszyc okno.
      height: 600,
    },
    actions: {
      analyze: ImportWizard.#onAnalyze,
      clearActorProfile: ImportWizard.#onClearActorProfile,
      openReview: ImportWizard.#onOpenReview,
    },
  };

  static override PARTS = {
    main: {
      template: 'modules/bindery/templates/wizard.hbs',
      // [zgloszenie uzytkownika, "przewijanie na dol wraca na gore"] Postep
      // budowania przegladu (`onProgress` nizej) wola `this.render()` RAZ NA
      // STRONE — ApplicationV2 (`HandlebarsApplicationMixin`) podmienia CALY
      // korzen tej czesci (`.bindery-wizard-root`) na nowy element przy
      // kazdym renderze (`_replaceHTML`, `element.replaceWith(...)`, bo ta
      // czesc nie ma `root: true`), wiec przewijana tresc WEWNATRZ niej
      // (`.bindery-wizard-body`, `overflow-y: auto` w `bindery.css`) dostaje
      // SWIEZY element ze `scrollTop` zerowanym z definicji — uzytkownik
      // przewija w dol, zeby zobaczyc licznik stron, a kolejny tik postepu
      // natychmiast to cofa. `scrollable` to udokumentowany mechanizm samego
      // Foundry (`handlebars-application.mjs`, `_preSyncPartState`/
      // `_syncPartState`) na dokladnie ten przypadek: zapamietuje
      // `scrollTop`/`scrollLeft` wskazanego selektora PRZED podmiana i
      // przywraca PO niej — zaden wlasny mechanizm nie jest potrzebny.
      scrollable: ['.bindery-wizard-body'],
    },
  };

  #state: WizardState = {
    status: 'idle',
    fileName: null,
    errorMessage: null,
    summary: null,
    isBuildingReview: false,
    reviewProgress: null,
    reviewBuildError: null,
    lastImportSummary: null,
    actorProfileFileName: null,
    actorProfileSummary: null,
    actorProfileIssues: null,
  };

  #selectedFile: File | null = null;
  #fileBuffer: ArrayBuffer | null = null;
  #buildController: AbortController | null = null;
  /**
   * [naprawa zgloszonego bledu — recenzja calego designu] `#buildController`
   * jest zerowany zaraz PO fazie budowy CIF (`finally` w `#onOpenReview`),
   * WCZESNIEJ niz `openPreviewForReview`/`ReviewScreen.open()` (te dwa kroki
   * nie maja wlasnego `AbortSignal` — `openPreviewDocument` w core go nie
   * przyjmuje). Zamkniecie okna W TYM oknie czasowym robilo z `close()`'s
   * `abort()` cichy no-op i `ReviewScreen` otwieral sie mimo wszystko, mimo
   * jawnego zamkniecia przez uzytkownika. Ta flaga jest sprawdzana PO obu
   * tych krokach, niezaleznie od `#buildController`.
   */
  #closed = false;
  /** [KROK-21 Z1] Profil zwalidowany, gotowy do przekazania do `buildJournalsForReview` — `null` = brak (import bez rozpoznawania postaci, jak dzis dla PDF-ow bez profilu). */
  #actorProfile: import('@bindery/core').ProfileV2 | null = null;
  /** Przywracanie zapamietanego profilu ze `game.settings` uruchamiane WYLACZNIE raz na instancje okna (nie przy kazdym renderze). */
  #actorProfileRestoreAttempted = false;

  override async _prepareContext(): Promise<Record<string, unknown>> {
    // [KROK-44 Z1] Statbloki ukryte za flaga (patrz `features.ts`) — pomija
    // NAWET przywrocenie zapamietanego profilu z `game.settings`, zeby swiat z
    // profilem zapisanym PRZED tym wydaniem nie wznowil po cichu parsowania
    // aktorow mimo ukrytego UI (`#actorProfile` musi zostac `null`, nie tylko
    // sekcja wczytywania musi zniknac z widoku).
    if (STATBLOCKS_ENABLED) void this.#ensureActorProfileRestored();
    return {
      statblocksEnabled: STATBLOCKS_ENABLED,
      status: this.#state.status,
      fileName: this.#state.fileName,
      errorMessage: this.#state.errorMessage,
      summary: this.#state.summary,
      isAnalyzing: this.#state.status === 'analyzing',
      hasResult: this.#state.status === 'done' && this.#state.summary !== null,
      hasError: this.#state.status === 'error',
      isBuildingReview: this.#state.isBuildingReview,
      reviewProgress: this.#state.reviewProgress,
      reviewBuildError: this.#state.reviewBuildError,
      lastImportSummary: this.#state.lastImportSummary,
      actorProfileFileName: this.#state.actorProfileFileName,
      actorProfileSummary: this.#state.actorProfileSummary,
      hasActorProfile: this.#state.actorProfileSummary !== null,
      actorProfileIssues: this.#state.actorProfileIssues,
      hasActorProfileError: this.#state.actorProfileIssues !== null,
    };
  }

  /**
   * [KROK-21 Z1] Wywolywane z `_prepareContext` (jedyne miejsce pewnie
   * wywolywane PRZED kazdym renderem), ale robi robote WYLACZNIE raz na
   * instancje okna — kolejne wywolania to no-op. Laduje `@bindery/core`
   * (ryzyko I3) dopiero TERAZ, czyli gdy uzytkownik faktycznie otworzyl okno
   * importu — "otwarcie kreatora" jest jednym z dwoch dozwolonych wyzwalaczy
   * w CLAUDE.md (obok klikniecia Analizuj), wiec to NIE jest ladowanie na
   * starcie swiata.
   */
  async #ensureActorProfileRestored(): Promise<void> {
    if (this.#actorProfileRestoreAttempted) return;
    this.#actorProfileRestoreAttempted = true;
    const saved = game.settings!.get(MODULE_ID, 'lastActorProfile');
    if (!saved.fileName) return; // fileName === '' (default) = brak zapamietanego profilu
    const result = await validateActorProfileFile(saved.profile);
    if (!result.ok) return; // profil zapamietany wczesniej przestal byc poprawny (np. edytowany recznie w bazie) — cichy powrot do "brak profilu", nie blad przy otwarciu okna
    this.#actorProfile = result.profile;
    this.#state.actorProfileFileName = saved.fileName;
    this.#state.actorProfileSummary = {
      title: result.profile.title,
      publication: result.profile.publication,
      gameLine: result.profile.gameLine,
      language: result.profile.language,
      patternCount: Object.keys(result.profile.patterns).length,
    };
    this.#state.actorProfileIssues = null;
    void this.render();
  }

  // Typy generyczne bazowej klasy sa parametryzowane instancja; w podklasie bez
  // wlasnych parametrow generycznych prostsze i rownie bezpieczne w praktyce jest
  // przekazanie bez zmian dalej do super.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override async _onRender(context: any, options: any): Promise<void> {
    await super._onRender(context, options);
    const input = this.element.querySelector<HTMLInputElement>('input[type="file"][data-role="pdf"]');
    input?.addEventListener('change', () => {
      this.#onPdfFileSelected(input.files?.[0] ?? null);
    });

    // [redesign 2a, "zaimplementuj obsluge drop, albo nie obiecuj jej
    // wizualnie"] Strefa zrzutu wolala TA SAMA sciezke co zmiana pliku przez
    // input (`#onPdfFileSelected`) — jedno zrodlo prawdy, zero powielonej
    // logiki wyboru pliku. `dragover` musi wywolywac `preventDefault()`,
    // inaczej przegladarka domyslnie OTWIERA upuszczony plik jako nawigacje
    // zamiast wywolac `drop`.
    const dropzone = this.element.querySelector<HTMLElement>('[data-role="dropzone"]');
    dropzone?.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      dropzone.classList.add('bindery-dragover');
    });
    dropzone?.addEventListener('dragleave', () => {
      dropzone.classList.remove('bindery-dragover');
    });
    dropzone?.addEventListener('drop', (ev) => {
      ev.preventDefault();
      dropzone.classList.remove('bindery-dragover');
      const file = ev.dataTransfer?.files?.[0] ?? null;
      if (file) this.#onPdfFileSelected(file);
    });

    const profileInput = this.element.querySelector<HTMLInputElement>('input[type="file"][data-role="profile"]');
    profileInput?.addEventListener('change', () => {
      const file = profileInput.files?.[0] ?? null;
      if (file) void this.#onActorProfileFileSelected(file);
    });
  }

  #onPdfFileSelected(file: File | null): void {
    this.#selectedFile = file;
    this.#fileBuffer = null;
    this.#state.fileName = file?.name ?? null;
    this.#state.status = 'idle';
    this.#state.errorMessage = null;
    this.#state.summary = null;
    this.#state.reviewBuildError = null;
    this.#state.lastImportSummary = null;
    void this.render();
  }

  override async close(options?: object): Promise<this> {
    this.#closed = true;
    this.#buildController?.abort();
    return super.close(options);
  }

  /**
   * [KROK-21 Z1] Jedyna droga do wczytania profilu aktorow — plik wybrany
   * przez uzytkownika, walidowany przez ISTNIEJACE `validateProfile` (ten sam
   * kontrakt co profile docelowo ladowane przez rejestr D2/D3, wciaz
   * niezbudowany). Zly plik -> czytelny blad w oknie, NIGDY wyjatek w konsoli
   * (DoD kroku 21). Sukces -> profil zapamietany per swiat (`game.settings`),
   * zeby nie trzeba bylo wskazywac go przy kazdym imporcie.
   */
  async #onActorProfileFileSelected(file: File): Promise<void> {
    this.#state.actorProfileFileName = file.name;
    this.#state.actorProfileSummary = null;
    this.#state.actorProfileIssues = null;
    this.#actorProfile = null;
    await this.render();

    let parsed: unknown;
    try {
      const text = await file.text();
      parsed = JSON.parse(text);
    } catch {
      this.#state.actorProfileIssues = [game.i18n!.localize('BINDERY.wizard.actorProfileErrorNotJson' as never)];
      await this.render();
      return;
    }

    const result = await validateActorProfileFile(parsed);
    if (!result.ok) {
      this.#state.actorProfileIssues = result.issues;
      await this.render();
      return;
    }

    this.#actorProfile = result.profile;
    this.#state.actorProfileSummary = {
      title: result.profile.title,
      publication: result.profile.publication,
      gameLine: result.profile.gameLine,
      language: result.profile.language,
      patternCount: Object.keys(result.profile.patterns).length,
    };
    const toSave: LastActorProfile = { fileName: file.name, profile: parsed };
    await game.settings!.set(MODULE_ID, 'lastActorProfile', toSave);
    await this.render();
  }

  static async #onClearActorProfile(this: ImportWizard): Promise<void> {
    this.#actorProfile = null;
    this.#state.actorProfileFileName = null;
    this.#state.actorProfileSummary = null;
    this.#state.actorProfileIssues = null;
    await game.settings!.set(MODULE_ID, 'lastActorProfile', { fileName: '', profile: null });
    await this.render();
  }

  static async #onAnalyze(this: ImportWizard): Promise<void> {
    if (!this.#selectedFile) return;
    this.#state.status = 'analyzing';
    this.#state.errorMessage = null;
    await this.render();

    try {
      this.#fileBuffer = await this.#selectedFile.arrayBuffer();
      // Dynamiczny import — dopiero teraz pdf.js (i @bindery/core, ktore go uzywa)
      // faktycznie sie laduje. Ryzyko I3.
      const { inspectDocument } = await import('@bindery/core');
      const summary = await inspectDocument(this.#fileBuffer, { assetBaseUrl: ASSET_BASE_URL });
      this.#state.status = 'done';
      this.#state.summary = summary;
    } catch (err: unknown) {
      this.#state.status = 'error';
      const name = (err as { name?: string } | null)?.name;
      // R4: PDF zaszyfrowany -> czytelny komunikat, zero prob obejscia zabezpieczen,
      // zero nieobslugiwanego wyjatku w konsoli.
      this.#state.errorMessage =
        name === 'PasswordException'
          ? game.i18n!.localize('BINDERY.wizard.errorEncrypted')
          : game.i18n!.localize('BINDERY.wizard.errorGeneric');
      console.warn('Bindery | inspectDocument failed:', err);
    }

    await this.render();
  }

  /**
   * [KROK-11] Zastepuje dawny lancuch extractImages->buildJournals->createJournals
   * (kazdy krok tworzacy dokumenty NATYCHMIAST, bez przegladu) — teraz buduje
   * caly `CIFDocument` (obrazy+sceny+journale+diagnostyka), otwiera podglad
   * strony i oddaje WSZYSTKO ekranowi przegladu. Zero dokumentow Foundry
   * powstaje w TEJ funkcji.
   */
  static async #onOpenReview(this: ImportWizard): Promise<void> {
    if (!this.#fileBuffer || !this.#state.fileName) return;
    this.#state.isBuildingReview = true;
    this.#state.reviewBuildError = null;
    this.#state.reviewProgress = null;
    await this.render();

    this.#buildController = new AbortController();
    let result: CIFBuildResult;
    try {
      result = await buildJournalsForReview(this.#fileBuffer, this.#state.fileName, {
        signal: this.#buildController.signal,
        onProgress: (done, total) => {
          this.#state.reviewProgress = { done, total };
          void this.render();
        },
        profile: this.#actorProfile ?? undefined,
      });
    } catch (err: unknown) {
      this.#state.isBuildingReview = false;
      if (err instanceof DOMException && err.name === 'AbortError') {
        await this.render();
        return;
      }
      this.#state.reviewBuildError = game.i18n!.localize('BINDERY.wizard.journalBuildErrorGeneric');
      console.warn('Bindery | buildJournalsForReview failed:', err);
      await this.render();
      return;
    } finally {
      this.#buildController = null;
    }

    try {
      const previewDocument = await openPreviewForReview(this.#fileBuffer);
      // [naprawa zgloszonego bledu — recenzja calego designu] `#buildController`
      // jest juz `null` w tym miejscu (patrz komentarz przy polu `#closed`) —
      // bez tej sprawdzajacej flagi, zamkniecie okna DOKLADNIE w tym oknie
      // czasowym (miedzy koncem budowy CIF a otwarciem podgladu) nie mialo
      // jak zatrzymac ponizszego `ReviewScreen.open()`.
      if (this.#closed) {
        await previewDocument.destroy();
        return;
      }
      this.#state.isBuildingReview = false;
      await this.render();

      const { ReviewScreen } = await import('./ReviewScreen.js');
      const reviewResult = await ReviewScreen.open({
        document: result.document,
        imageBytesById: result.imageBytesById,
        previewDocument,
        fileName: this.#state.fileName,
        removeTokenBackgroundDefault: this.#actorProfile?.images?.removeTokenBackgroundDefault ?? false,
      });

      if (reviewResult.confirmed) {
        this.#state.lastImportSummary = game.i18n!.localize('BINDERY.wizard.reviewImportDone' as never);
        ui.notifications?.info(game.i18n!.localize('BINDERY.wizard.reviewImportDone' as never));
      }
      await this.render();
    } catch (err) {
      this.#state.isBuildingReview = false;
      this.#state.reviewBuildError = game.i18n!.localize('BINDERY.wizard.journalBuildErrorGeneric');
      console.warn('Bindery | otwarcie ekranu przegladu nieudane:', err);
      await this.render();
    }
  }
}

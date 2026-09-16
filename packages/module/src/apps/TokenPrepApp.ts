import {
  normalizeDecodedImage,
  removeBackground,
  DEFAULT_REMOVE_BACKGROUND,
  rotateAndCropImage,
  applyTokenMask,
  applyBuiltInFrame,
  compositeCustomFrame,
  browserImageEncoder,
  type DecodedImage,
  type TokenMaskShape,
} from '@bindery/core';

/**
 * TokenPrepApp (KROK-42, "token jako produkt") — okno `ApplicationV2` osobne
 * od `ReviewScreen` (wzorem `GridPicker.ts`), otwierane przyciskiem
 * "Przygotuj token" WYLACZNIE dla obrazow z przeznaczeniem `token`. Zero
 * automatyki w tle: kazdy krok (usuniecie tla, kadr+zoom, maska, ramka)
 * dzieje sie na ZYWO w podgladzie, zatwierdzenie koduje DOKLADNIE to, co
 * widac. Mechanizm przypisania tokenu do aktora (krok 35,
 * `uploadedTokenImagePathById` w `ReviewScreen.ts`) pozostaje NIETKNIETY —
 * ten panel wylacznie PODMIENIA bajty/wymiary/format obrazu PRZED tym, jak
 * `#runImport` je wgra, dokladnie jak dzis robi to `#resizeImage`/`#rotateImage`.
 *
 * Pipeline (ten sam co w `redraw()` na podgladzie i przy zatwierdzeniu, tylko
 * inna docelowa rozdzielczosc — brak rozjazdu podglad/wynik): zrodlo ->
 * (opcjonalnie) `removeBackground` na CALYM zrodlowym obrazie (rogi = tlo,
 * patrz `removeBackground.ts` — najbardziej niezawodne, gdy dziala na
 * NIEPRZYCIETYM jeszcze obrazie, gdzie rogi naprawde sa tlem strony) ->
 * `rotateAndCropImage` (kadr+zoom w kwadrat, `rotationRad=0` — obrot
 * obrazu to osobna, juz istniejaca funkcja w wierszu obrazu) -> `applyTokenMask`
 * -> `applyBuiltInFrame`/`compositeCustomFrame`.
 */

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const PREVIEW_PX = 420;
const OUTPUT_SIZES = [256, 512, 1024] as const;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const BUILT_IN_FRAME_THICKNESS: Record<'thin' | 'thick', number> = { thin: 0.05, thick: 0.12 };
/**
 * [KROK-42 Z3, "dyspozycja aktora NIEDOSTEPNA w momencie przygotowania tokenu"]
 * `disposition` nigdzie nie jest czytana przed zapisem aktora (patrz
 * `coc7.ts`, na stale `1`) — zgodnie z furtka z briefu ("jesli disposition
 * niedostepne, zostaw kolor domyslny") ramka wbudowana dostaje JEDEN,
 * neutralny domyslny kolor zamiast probowac zgadywac przyjazny/wrogi/neutralny.
 */
const DEFAULT_FRAME_COLOR = '#8a6d3b';
const CHECKER_CELL_PX = 10;

type FrameChoice = 'none' | 'thin' | 'thick' | 'custom';
type OutputSize = (typeof OUTPUT_SIZES)[number];

export interface PrepareTokenInput {
  bytes: Uint8Array;
  format: string;
  width: number;
  height: number;
  /** Wartosc startowa przelacznika "usun tlo" — patrz `images.removeTokenBackgroundDefault` w `schema.ts` (`@bindery/core`). */
  removeBackgroundDefault: boolean;
}

export interface PrepareTokenResult {
  bytes: Uint8Array;
  format: 'webp' | 'png';
  width: number;
  height: number;
}

function mimeFor(format: string): string {
  return format === 'png' ? 'image/png' : 'image/webp';
}

async function decodeToBitmap(bytes: Uint8Array, format: string): Promise<ImageBitmap> {
  const blob = new Blob([new Uint8Array(bytes)], { type: mimeFor(format) });
  return createImageBitmap(blob);
}

class TokenPrepApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static override DEFAULT_OPTIONS = {
    id: 'bindery-token-prep',
    classes: ['bindery', 'bindery-token-prep-app'],
    window: {
      title: 'BINDERY.tokenPrep.title',
      resizable: false,
    },
    position: {
      width: 460,
    },
    actions: {
      confirm: TokenPrepApp.#onConfirm,
      cancel: TokenPrepApp.#onCancel,
    },
  };

  static override PARTS = {
    main: {
      template: 'modules/bindery/templates/token-prep.hbs',
    },
  };

  #input: PrepareTokenInput;
  #resolve: ((value: PrepareTokenResult | null) => void) | null = null;

  #source: DecodedImage | null = null;
  /** [wydajnosc] `removeBackground` niezalezne od kadru/zoomu — cache po tolerancji+wersji ziaren, zeby przeciaganie podgladu (pan/zoom) NIE przeliczalo flood-fill na calym zrodle w kazdej klatce. */
  #bgRemovedCache: { tolerance: number; seedsVersion: number; image: DecodedImage } | null = null;
  #customFrameBytes: Uint8Array | null = null;

  /**
   * [ZGLOSZENIE-doklikniecie-tla Z1, "kapelusz laczacy sie z cialem tworzy
   * zamknieta kieszen tla"] Punkty dodane recznie przez uzytkownika, we
   * WSPOLRZEDNYCH PELNEGO ZRODLA (nie podgladu/kadru — stabilne niezaleznie
   * od pozniejszej zmiany zoomu/panoramy), przekazywane jako `extraSeeds` do
   * `removeBackground`. `#seedsVersion` rosnie przy kazdej zmianie (dodanie/
   * cofniecie) — klucz cache'u obok tolerancji, bo `removeBackground` samo w
   * sobie nie wie o zawartosci tej tablicy.
   */
  #clickSeeds: Array<{ x: number; y: number }> = [];
  #seedsVersion = 0;
  /** Tryb "dokliknij tlo" — gdy aktywny, klikniecie (bez przeciagniecia) na podgladzie dodaje ziarno zamiast przesuwac kadr. */
  #clickToAddMode = false;

  #shape: TokenMaskShape = 'circle';
  #outputSize: OutputSize = 512;
  #format: 'webp' | 'png' = 'webp';
  #removeBg: boolean;
  #tolerance: number = DEFAULT_REMOVE_BACKGROUND.tolerance;
  #zoom = 1;
  #centerX = 0;
  #centerY = 0;
  #frame: FrameChoice = 'none';
  #frameColor = DEFAULT_FRAME_COLOR;

  #canvas: HTMLCanvasElement | null = null;
  #dragState: { pointerId: number; startClientX: number; startClientY: number; startCenterX: number; startCenterY: number; moved: boolean } | null = null;
  #redrawSeq = 0;

  constructor(input: PrepareTokenInput, options: object = {}) {
    super(options);
    this.#input = input;
    this.#removeBg = input.removeBackgroundDefault;
  }

  static async prepare(input: PrepareTokenInput): Promise<PrepareTokenResult | null> {
    const app = new TokenPrepApp(input);
    return new Promise<PrepareTokenResult | null>((resolve) => {
      app.#resolve = resolve;
      void app.render(true);
    });
  }

  override async _prepareContext(): Promise<Record<string, unknown>> {
    return {
      previewPx: PREVIEW_PX,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      zoom: this.#zoom,
      shapeIsCircle: this.#shape === 'circle',
      shapeIsSquare: this.#shape === 'square',
      shapeIsRoundedSquare: this.#shape === 'roundedSquare',
      shapeIsHex: this.#shape === 'hex',
      removeBg: this.#removeBg,
      tolerance: this.#tolerance,
      clickToAddMode: this.#clickToAddMode,
      canUndoClick: this.#clickSeeds.length > 0,
      frameIsNone: this.#frame === 'none',
      frameIsThin: this.#frame === 'thin',
      frameIsThick: this.#frame === 'thick',
      frameIsCustom: this.#frame === 'custom',
      frameColor: this.#frameColor,
      outputSizeOptions: OUTPUT_SIZES.map((size) => ({ value: size, label: `${size}×${size}`, selected: size === this.#outputSize })),
      formatIsWebp: this.#format === 'webp',
      formatIsPng: this.#format === 'png',
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override async _onRender(context: any, options: any): Promise<void> {
    await super._onRender(context, options);
    const root = this.element;
    const canvas = root.querySelector<HTMLCanvasElement>('canvas.bindery-token-prep-canvas');
    if (!canvas) {
      console.warn('Bindery | TokenPrepApp: brak <canvas> w wyrenderowanym DOM');
      return;
    }
    this.#canvas = canvas;

    if (!this.#source) {
      try {
        const bitmap = await decodeToBitmap(this.#input.bytes, this.#input.format);
        this.#source = normalizeDecodedImage({ width: bitmap.width, height: bitmap.height, bitmap });
        bitmap.close?.();
        this.#centerX = this.#source.width / 2;
        this.#centerY = this.#source.height / 2;
      } catch (err) {
        console.warn('Bindery | TokenPrepApp: dekodowanie obrazu zrodlowego nieudane:', err);
        ui.notifications?.error(game.i18n!.localize('BINDERY.review.resizeFailed' as never));
        return;
      }
    }
    void this.#redraw();

    const CLICK_MOVE_THRESHOLD_PX = 3;
    canvas.addEventListener('pointerdown', (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      this.#dragState = { pointerId: e.pointerId, startClientX: e.clientX, startClientY: e.clientY, startCenterX: this.#centerX, startCenterY: this.#centerY, moved: false };
    });
    canvas.addEventListener('pointermove', (e: PointerEvent) => {
      const drag = this.#dragState;
      if (!drag || drag.pointerId !== e.pointerId) return;
      if (Math.abs(e.clientX - drag.startClientX) > CLICK_MOVE_THRESHOLD_PX || Math.abs(e.clientY - drag.startClientY) > CLICK_MOVE_THRESHOLD_PX) drag.moved = true;
      // [ZGLOSZENIE-doklikniecie-tla Z1] W trybie "dokliknij tlo" przeciaganie NIE przesuwa kadru — samo klikniecie (patrz `endDrag`) dodaje ziarno, zeby przypadkowy mikroruch myszy miedzy pointerdown/up nie przesunal kadru pod uzytkownikiem.
      if (this.#clickToAddMode) return;
      const scale = this.#currentScale(PREVIEW_PX);
      this.#centerX = drag.startCenterX - (e.clientX - drag.startClientX) * scale;
      this.#centerY = drag.startCenterY - (e.clientY - drag.startClientY) * scale;
      void this.#redraw();
    });
    const endDrag = (e: PointerEvent): void => {
      const drag = this.#dragState;
      if (drag?.pointerId !== e.pointerId) return;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      if (this.#clickToAddMode && !drag.moved) {
        const rect = canvas.getBoundingClientRect();
        const canvasX = ((e.clientX - rect.left) / rect.width) * PREVIEW_PX;
        const canvasY = ((e.clientY - rect.top) / rect.height) * PREVIEW_PX;
        const scale = this.#currentScale(PREVIEW_PX);
        this.#clickSeeds.push({ x: this.#centerX + (canvasX - PREVIEW_PX / 2) * scale, y: this.#centerY + (canvasY - PREVIEW_PX / 2) * scale });
        this.#seedsVersion++;
        this.#updateUndoButtonState();
        void this.#redraw();
      }
      this.#dragState = null;
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    const clickToAddToggle = root.querySelector<HTMLInputElement>('input[name="clickToAdd"]');
    clickToAddToggle?.addEventListener('change', () => {
      this.#clickToAddMode = clickToAddToggle.checked;
      canvas.classList.toggle('bindery-token-prep-canvas-click-mode', this.#clickToAddMode);
    });
    const undoClickBtn = root.querySelector<HTMLButtonElement>('button[data-action="undoClickSeed"]');
    undoClickBtn?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.#clickSeeds.pop();
      this.#seedsVersion++;
      this.#updateUndoButtonState();
      void this.#redraw();
    });
    this.#updateUndoButtonState();

    root.querySelector<HTMLInputElement>('input[name="zoom"]')?.addEventListener('input', (e) => {
      this.#zoom = Number((e.target as HTMLInputElement).value);
      void this.#redraw();
    });
    for (const el of root.querySelectorAll<HTMLInputElement>('input[name="shape"]')) {
      el.addEventListener('change', () => {
        if (el.checked) {
          this.#shape = el.value as TokenMaskShape;
          void this.#redraw();
        }
      });
    }
    root.querySelector<HTMLInputElement>('input[name="removeBg"]')?.addEventListener('change', (e) => {
      this.#removeBg = (e.target as HTMLInputElement).checked;
      void this.#redraw();
    });
    root.querySelector<HTMLInputElement>('input[name="tolerance"]')?.addEventListener('input', (e) => {
      this.#tolerance = Number((e.target as HTMLInputElement).value);
      void this.#redraw();
    });
    for (const el of root.querySelectorAll<HTMLInputElement>('input[name="frame"]')) {
      el.addEventListener('change', () => {
        if (el.checked) {
          this.#frame = el.value as FrameChoice;
          void this.#redraw();
        }
      });
    }
    root.querySelector<HTMLInputElement>('input[name="frameColor"]')?.addEventListener('input', (e) => {
      this.#frameColor = (e.target as HTMLInputElement).value;
      void this.#redraw();
    });
    root.querySelector<HTMLInputElement>('input[name="frameFile"]')?.addEventListener('change', async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      this.#customFrameBytes = new Uint8Array(await file.arrayBuffer());
      void this.#redraw();
    });
    root.querySelector<HTMLSelectElement>('select[name="outputSize"]')?.addEventListener('change', (e) => {
      this.#outputSize = Number((e.target as HTMLSelectElement).value) as OutputSize;
    });
    root.querySelector<HTMLSelectElement>('select[name="format"]')?.addEventListener('change', (e) => {
      this.#format = (e.target as HTMLSelectElement).value as 'webp' | 'png';
    });
  }

  /**
   * Pikseli ZRODLA na piksel WYJSCIA przy biezacym zoomie — kadr wypelnia
   * caly kwadrat przy zoom=1, wieksze wartosci przyblizaja. `outputEdgePx`
   * PARAMETREM (nie zawsze `PREVIEW_PX`) — `#compose` woła to z docelowa
   * rozdzielczoscia zapisu (256-1024), NIE z rozdzielczoscia podgladu, inaczej
   * finalny zapis mialby INNY kadr/zoom niz to, co widac na podgladzie
   * (zmierzony na zywo blad pierwszej wersji: mnozenie JUZ policzonej skali
   * "dla PREVIEW_PX" przez `outputSize/PREVIEW_PX` zamiast `PREVIEW_PX/outputSize`
   * dawalo skale zaburzona kwadratem stosunku rozdzielczosci).
   */
  #currentScale(outputEdgePx: number): number {
    if (!this.#source) return 1;
    const baseCropEdge = Math.min(this.#source.width, this.#source.height);
    return baseCropEdge / this.#zoom / outputEdgePx;
  }

  #updateUndoButtonState(): void {
    const btn = this.element.querySelector<HTMLButtonElement>('button[data-action="undoClickSeed"]');
    if (btn) btn.disabled = this.#clickSeeds.length === 0;
    const countEl = this.element.querySelector<HTMLElement>('.bindery-token-prep-click-count');
    if (countEl) countEl.textContent = String(this.#clickSeeds.length);
  }

  #backgroundRemoved(): DecodedImage {
    const source = this.#source!;
    if (!this.#removeBg) {
      const hint = this.element.querySelector<HTMLElement>('.bindery-token-prep-bg-aborted-hint');
      if (hint) hint.hidden = true;
      return source;
    }
    if (this.#bgRemovedCache?.tolerance === this.#tolerance && this.#bgRemovedCache?.seedsVersion === this.#seedsVersion) return this.#bgRemovedCache.image;
    const result = removeBackground(source, {
      tolerance: this.#tolerance,
      featherPx: DEFAULT_REMOVE_BACKGROUND.featherPx,
      maxAreaFraction: DEFAULT_REMOVE_BACKGROUND.maxAreaFraction,
      extraSeeds: this.#clickSeeds,
    });
    this.#bgRemovedCache = { tolerance: this.#tolerance, seedsVersion: this.#seedsVersion, image: result.image };
    const hint = this.element.querySelector<HTMLElement>('.bindery-token-prep-bg-aborted-hint');
    if (hint) hint.hidden = !result.aborted;
    return result.image;
  }

  /** Skladany pipeline: kadr+zoom -> maska -> ramka, przy dowolnej docelowej rozdzielczosci (podglad i finalny zapis dziela ten sam kod). */
  async #compose(outputSize: number): Promise<DecodedImage> {
    const base = this.#backgroundRemoved();
    const cropped = rotateAndCropImage(base, {
      centerX: this.#centerX,
      centerY: this.#centerY,
      outputWidth: outputSize,
      outputHeight: outputSize,
      rotationRad: 0,
      scale: this.#currentScale(outputSize),
    });
    const masked = applyTokenMask(cropped, this.#shape, Math.max(1, Math.round(outputSize / 128)));

    if (this.#frame === 'thin' || this.#frame === 'thick') {
      return applyBuiltInFrame(masked, { shape: this.#shape, thicknessNorm: BUILT_IN_FRAME_THICKNESS[this.#frame], color: this.#hexToRgb(this.#frameColor) });
    }
    if (this.#frame === 'custom' && this.#customFrameBytes) {
      try {
        const bitmap = await decodeToBitmap(this.#customFrameBytes, 'png');
        const canvas = new OffscreenCanvas(outputSize, outputSize);
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(bitmap, 0, 0, outputSize, outputSize);
        bitmap.close?.();
        const imageData = ctx.getImageData(0, 0, outputSize, outputSize);
        const frameImage: DecodedImage = { width: outputSize, height: outputSize, rgba: new Uint8ClampedArray(imageData.data) };
        return compositeCustomFrame(masked, frameImage);
      } catch (err) {
        console.warn('Bindery | TokenPrepApp: nie udalo sie zastosowac wlasnej ramki:', err);
        return masked;
      }
    }
    return masked;
  }

  #hexToRgb(hex: string): [number, number, number] {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
    if (!m) return [0, 0, 0];
    return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
  }

  async #redraw(): Promise<void> {
    if (!this.#source || !this.#canvas) return;
    const seq = ++this.#redrawSeq;
    const composed = await this.#compose(PREVIEW_PX);
    if (seq !== this.#redrawSeq) return; // [race] nowsze wywolanie #redraw juz w toku — porzuc przestarzaly wynik
    const ctx = this.#canvas.getContext('2d');
    if (!ctx) return;
    for (let y = 0; y < PREVIEW_PX; y += CHECKER_CELL_PX) {
      for (let x = 0; x < PREVIEW_PX; x += CHECKER_CELL_PX) {
        ctx.fillStyle = (x / CHECKER_CELL_PX + y / CHECKER_CELL_PX) % 2 === 0 ? '#cfcfcf' : '#8f8f8f';
        ctx.fillRect(x, y, CHECKER_CELL_PX, CHECKER_CELL_PX);
      }
    }
    const layer = new OffscreenCanvas(PREVIEW_PX, PREVIEW_PX);
    const layerCtx = layer.getContext('2d')!;
    layerCtx.putImageData(new ImageData(new Uint8ClampedArray(composed.rgba), composed.width, composed.height), 0, 0);
    ctx.drawImage(layer, 0, 0);
  }

  static #onConfirm(this: TokenPrepApp): void {
    void (async () => {
      try {
        const composed = await this.#compose(this.#outputSize);
        const encoded = await browserImageEncoder.encode(composed, { format: this.#format });
        this.#resolve?.({ bytes: encoded.bytes, format: encoded.format, width: composed.width, height: composed.height });
        this.#resolve = null;
        void this.close();
      } catch (err) {
        console.warn('Bindery | TokenPrepApp: zapis tokenu nieudany:', err);
        ui.notifications?.error(game.i18n!.localize('BINDERY.review.resizeFailed' as never));
      }
    })();
  }

  static #onCancel(this: TokenPrepApp): void {
    this.#resolve?.(null);
    this.#resolve = null;
    void this.close();
  }

  override async close(options?: object): Promise<this> {
    this.#resolve?.(null);
    this.#resolve = null;
    return super.close(options);
  }
}

/** Otwiera panel przygotowania tokenu, zwraca gotowe bajty/format/wymiary albo `null` (anulowano). */
export async function prepareToken(input: PrepareTokenInput): Promise<PrepareTokenResult | null> {
  return TokenPrepApp.prepare(input);
}

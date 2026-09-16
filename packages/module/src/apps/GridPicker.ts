import { MODULE_ID } from '../settings.js';

/**
 * GridPicker (KROK-8 Z5) — podglad na zywo z suwakami rozmiaru/offsetu i
 * nakladka siatki, zapamietujacy ostatnie ustawienie (`lastGridConfig`).
 * Zero automatycznego wykrywania siatki (brief: poza MVP) — uzytkownik
 * ustawia recznie, majac natychmiastowy podglad efektu.
 *
 * [KROK-8, odkrycie] Pierwsza wersja uzywala `DialogV2.wait({content, render})`
 * z surowym HTML w stringu — zawodzilo w prawdziwym Foundry: `render` (event,
 * dialog) => dialog.element.querySelector(...) zwracalo `null` (blad "Cannot
 * read properties of null (reading 'getContext')"), mimo poprawnej skladni.
 * Przyczyna nieustalona (mozliwe niuanse cyklu renderu DialogV2 z surowym
 * content vs. PARTS Handlebars) — zamiast dalej zgadywac, przepisane na
 * WLASNA klase `ApplicationV2`+`HandlebarsApplicationMixin` z `_onRender`,
 * DOKLADNIE ten sam, juz sprawdzony wzorzec co `ImportWizard` (ktory
 * niezawodnie robi `this.element.querySelector(...)` w `_onRender`).
 */

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const MAX_PREVIEW_PX = 640;
const MIN_GRID_SIZE_PX = 20;
const MAX_GRID_SIZE_PX = 400;

export interface GridConfig {
  size: number;
  offsetX: number;
  offsetY: number;
}

export interface PickGridInput {
  imageDataUrl: string;
  imageWidth: number;
  imageHeight: number;
  /**
   * [KROK-17] Sugestia auto-detekcji siatki z pikseli mapy (`@bindery/core`,
   * `images/detectGrid.ts`) — gdy podana, PREFEROWANA nad ostatnio zapisana
   * konfiguracja (`lastGridConfig`) jako wstepne wypelnienie suwakow. Decyzja
   * "czy przekazac" (np. prog pewnosci) nalezy do wolajacego (`ReviewScreen`),
   * nie do tego modulu — patrz komentarz przy `CIFImage.suggestedGrid`.
   */
  suggestedGrid?: GridConfig;
}

function drawPreview(ctx: CanvasRenderingContext2D, img: HTMLImageElement, previewScale: number, grid: GridConfig): void {
  const w = img.width * previewScale;
  const h = img.height * previewScale;
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.drawImage(img, 0, 0, w, h);

  const size = grid.size * previewScale;
  if (size < 2) return; // suwak na skrajnie malej wartosci — nie rysuj nieczytelnej siatki

  ctx.strokeStyle = 'rgba(255, 0, 0, 0.6)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const offsetX = ((grid.offsetX * previewScale) % size) - size;
  const offsetY = ((grid.offsetY * previewScale) % size) - size;
  for (let x = offsetX; x <= w; x += size) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  for (let y = offsetY; y <= h; y += size) {
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();
}

class GridPickerApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static override DEFAULT_OPTIONS = {
    id: 'bindery-grid-picker',
    classes: ['bindery', 'bindery-grid-picker-app'],
    window: {
      title: 'BINDERY.gridPicker.title',
      resizable: false,
    },
    position: {
      width: 420,
    },
    actions: {
      confirm: GridPickerApp.#onConfirm,
      cancel: GridPickerApp.#onCancel,
    },
  };

  static override PARTS = {
    main: {
      template: 'modules/bindery/templates/grid-picker.hbs',
    },
  };

  #input: PickGridInput;
  #grid: GridConfig;
  #previewScale: number;
  #isSuggested: boolean;
  #resolve: ((value: GridConfig | null) => void) | null = null;

  constructor(input: PickGridInput, initialGrid: GridConfig, isSuggested: boolean, options: object = {}) {
    super(options);
    this.#input = input;
    this.#grid = { ...initialGrid };
    this.#isSuggested = isSuggested;
    this.#previewScale = Math.min(1, MAX_PREVIEW_PX / Math.max(input.imageWidth, input.imageHeight));
  }

  static async pick(input: PickGridInput): Promise<GridConfig | null> {
    // [KROK-17] Sugestia auto-detekcji (gdy podana) ma pierwszenstwo nad
    // ostatnio zapisana reczna konfiguracja — inny obraz ma inna siatke, wiec
    // "co bylo ostatnio" jest gorszym punktem startowym niz "co widac na TYM
    // konkretnym obrazie", o ile cokolwiek wykryto.
    const base = input.suggestedGrid ?? game.settings!.get(MODULE_ID, 'lastGridConfig');
    const initialGrid: GridConfig = {
      size: Math.min(MAX_GRID_SIZE_PX, Math.max(MIN_GRID_SIZE_PX, base.size)),
      offsetX: base.offsetX,
      offsetY: base.offsetY,
    };
    const app = new GridPickerApp(input, initialGrid, input.suggestedGrid !== undefined);
    const result = await new Promise<GridConfig | null>((resolve) => {
      app.#resolve = resolve;
      void app.render(true);
    });
    if (result) {
      await game.settings!.set(MODULE_ID, 'lastGridConfig', result);
    }
    return result;
  }

  override async _prepareContext(): Promise<Record<string, unknown>> {
    return {
      previewWidth: Math.round(this.#input.imageWidth * this.#previewScale),
      previewHeight: Math.round(this.#input.imageHeight * this.#previewScale),
      grid: this.#grid,
      minSize: MIN_GRID_SIZE_PX,
      maxSize: MAX_GRID_SIZE_PX,
      isSuggested: this.#isSuggested,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override async _onRender(context: any, options: any): Promise<void> {
    await super._onRender(context, options);
    const root = this.element;
    const canvas = root.querySelector<HTMLCanvasElement>('canvas.bindery-grid-canvas');
    if (!canvas) {
      console.warn('Bindery | GridPicker: brak <canvas> w wyrenderowanym DOM');
      return;
    }
    const ctx = canvas.getContext('2d')!;
    const img = new Image();
    img.src = this.#input.imageDataUrl;

    const redraw = (): void => drawPreview(ctx, img, this.#previewScale, this.#grid);
    img.onload = redraw;
    if (img.complete) redraw();

    for (const name of ['size', 'offsetX', 'offsetY'] as const) {
      const el = root.querySelector<HTMLInputElement>(`input[name="${name}"]`);
      if (!el) continue;
      el.addEventListener('input', () => {
        this.#grid[name] = Number(el.value);
        const label = root.querySelector(`span[data-value="${name}"]`);
        if (label) label.textContent = el.value;
        redraw();
      });
    }
  }

  static #onConfirm(this: GridPickerApp): void {
    this.#resolve?.({ ...this.#grid });
    this.#resolve = null;
    void this.close();
  }

  static #onCancel(this: GridPickerApp): void {
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

/** Otwiera GridPicker, zwraca wybrana konfiguracje siatki albo `null` (anulowano). */
export async function pickGrid(input: PickGridInput): Promise<GridConfig | null> {
  return GridPickerApp.pick(input);
}

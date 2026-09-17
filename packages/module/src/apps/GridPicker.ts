import { MODULE_ID } from '../settings.js';

/**
 * GridPicker (Step 8 Z5) — live preview with size/offset sliders and a grid
 * overlay, remembering the last setting (`lastGridConfig`). Zero automatic
 * grid detection (brief: out of MVP scope) — the user sets it manually, with
 * an immediate preview of the effect.
 *
 * [Step 8, discovery] The first version used `DialogV2.wait({content, render})`
 * with raw HTML in a string — this failed in a real Foundry instance:
 * `render` (event, dialog) => dialog.element.querySelector(...) returned
 * `null` (error "Cannot read properties of null (reading 'getContext')"),
 * despite correct syntax. The cause was never determined (possibly nuances
 * of DialogV2's render cycle with raw content vs. Handlebars PARTS) —
 * instead of continuing to guess, this was rewritten as its OWN
 * `ApplicationV2`+`HandlebarsApplicationMixin` class with `_onRender`,
 * EXACTLY the same, already-proven pattern as `ImportWizard` (which reliably
 * does `this.element.querySelector(...)` in `_onRender`).
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
   * [Step 17] Suggestion from automatic grid detection on the map's pixels
   * (`@bindery/core`, `images/detectGrid.ts`) — when provided, PREFERRED over
   * the last saved configuration (`lastGridConfig`) as the initial fill for
   * the sliders. The decision of "whether to pass it" (e.g. a confidence
   * threshold) belongs to the caller (`ReviewScreen`), not to this module —
   * see the comment near `CIFImage.suggestedGrid`.
   */
  suggestedGrid?: GridConfig;
}

function drawPreview(ctx: CanvasRenderingContext2D, img: HTMLImageElement, previewScale: number, grid: GridConfig): void {
  const w = img.width * previewScale;
  const h = img.height * previewScale;
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.drawImage(img, 0, 0, w, h);

  const size = grid.size * previewScale;
  if (size < 2) return; // slider at an extremely small value — don't draw an illegible grid

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
    // [Step 17] An auto-detection suggestion (when provided) takes priority
    // over the last saved manual configuration — a different image has a
    // different grid, so "what it was last time" is a worse starting point
    // than "what's visible on THIS particular image", provided anything was
    // detected.
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
      console.warn('Bindery | GridPicker: missing <canvas> in the rendered DOM');
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

/** Opens GridPicker, returns the chosen grid configuration or `null` (cancelled). */
export async function pickGrid(input: PickGridInput): Promise<GridConfig | null> {
  return GridPickerApp.pick(input);
}

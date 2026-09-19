import { DEFAULT_WEBP_QUALITY } from '@bindery/core';

/**
 * ImageEraseApp — an `ApplicationV2` window that shows ONE already-extracted
 * image at a large size (a preview) and lets the user erase unwanted parts of
 * it (typically a piece of page text captured together with an illustration).
 * Same shape as `TokenPrepApp`/`GridPicker`: a small separate window with a
 * static `prepare`-style entry point (`eraseImage`) that resolves to the new
 * bytes, or `null` when nothing was changed / the window was cancelled.
 * `ReviewScreen` then swaps the bytes in `imageBytesById` exactly like it does
 * for rotation and token preparation — nothing here knows about the PDF.
 *
 * Erasing works on a full-resolution working canvas (the visible canvas IS
 * that canvas, only scaled with CSS), so what the user paints is exactly what
 * gets saved. Two ways to erase: to transparency, or by painting a solid color
 * (with an eyedropper to sample the surrounding background).
 */

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

type Tool = 'view' | 'brush' | 'rect' | 'pick';
type EraseTo = 'transparent' | 'color';

const MAX_FIT_UPSCALE = 8;
const MAX_UNDO_STEPS = 20;
const UNDO_MEMORY_BUDGET_BYTES = 160_000_000;

export interface EraseImageInput {
  bytes: Uint8Array;
  format: string;
}

export interface EraseImageResult {
  bytes: Uint8Array;
  format: 'webp' | 'png';
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

class ImageEraseApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static override DEFAULT_OPTIONS = {
    id: 'bindery-image-erase',
    classes: ['bindery', 'bindery-image-erase-app'],
    window: {
      title: 'BINDERY.imageErase.title',
      resizable: false,
    },
    position: {
      width: Math.min(920, Math.max(360, window.innerWidth - 40)),
    },
    actions: {
      save: ImageEraseApp.#onSave,
      cancel: ImageEraseApp.#onCancel,
      undo: ImageEraseApp.#onUndo,
      reset: ImageEraseApp.#onReset,
    },
  };

  static override PARTS = {
    main: {
      template: 'modules/bindery/templates/image-erase.hbs',
    },
  };

  #input: EraseImageInput;
  #resolve: ((value: EraseImageResult | null) => void) | null = null;

  #source: ImageBitmap | null = null;
  #work: HTMLCanvasElement = document.createElement('canvas');
  #ctx: CanvasRenderingContext2D | null = null;
  #cursorRing: HTMLElement = document.createElement('div');
  #selectionBox: HTMLElement = document.createElement('div');
  #undoStack: ImageData[] = [];
  #dirty = false;
  /** Number of applied edit steps still in effect (also counts steps trimmed off the undo stack), so undoing everything can restore `#dirty = false`. */
  #editCount = 0;

  #tool: Tool = 'view';
  #eraseTo: EraseTo = 'transparent';
  #color = '#ffffff';
  #brushSize = 30;
  #zoom = 1;

  #strokeLast: Point | null = null;
  #rectStart: Point | null = null;

  constructor(input: EraseImageInput, options: object = {}) {
    super(options);
    this.#input = input;
    this.#cursorRing.className = 'bindery-image-erase-cursor';
    this.#selectionBox.className = 'bindery-image-erase-selection';
    this.#work.className = 'bindery-image-erase-canvas';
    this.#attachCanvasListeners();
  }

  static async prepare(input: EraseImageInput): Promise<EraseImageResult | null> {
    const app = new ImageEraseApp(input);
    return new Promise<EraseImageResult | null>((resolve) => {
      app.#resolve = resolve;
      void app.render(true);
    });
  }

  override async _prepareContext(): Promise<Record<string, unknown>> {
    return {
      toolIsView: this.#tool === 'view',
      toolIsBrush: this.#tool === 'brush',
      toolIsRect: this.#tool === 'rect',
      toolIsPick: this.#tool === 'pick',
      eraseToTransparent: this.#eraseTo === 'transparent',
      eraseToColor: this.#eraseTo === 'color',
      color: this.#color,
      brushSize: this.#brushSize,
      brushMax: this.#brushMax(),
      zoom: this.#zoom,
      canUndo: this.#undoStack.length > 0,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override async _onRender(context: any, options: any): Promise<void> {
    await super._onRender(context, options);
    const root = this.element;
    const stage = root.querySelector<HTMLElement>('[data-stage]');
    if (!stage) {
      console.warn('Bindery | ImageEraseApp: missing stage element in the rendered DOM');
      return;
    }

    if (!this.#source) {
      try {
        const blob = new Blob([new Uint8Array(this.#input.bytes)], { type: this.#input.format === 'png' ? 'image/png' : 'image/webp' });
        this.#source = await createImageBitmap(blob);
        this.#work.width = this.#source.width;
        this.#work.height = this.#source.height;
        this.#ctx = this.#work.getContext('2d', { willReadFrequently: true });
        this.#ctx?.drawImage(this.#source, 0, 0);
        this.#brushSize = Math.max(4, Math.round(Math.min(this.#source.width, this.#source.height) / 25));
      } catch (err) {
        console.warn('Bindery | ImageEraseApp: decoding the source image failed:', err);
        ui.notifications?.error(game.i18n!.localize('BINDERY.imageErase.failed' as never));
        return;
      }
    }

    stage.prepend(this.#work);
    stage.append(this.#selectionBox, this.#cursorRing);
    this.#applyToolCursor();
    this.#applyZoom();
    this.#syncBrushControls();

    for (const el of root.querySelectorAll<HTMLInputElement>('input[name="tool"]')) {
      el.addEventListener('change', () => {
        if (!el.checked) return;
        this.#tool = el.value as Tool;
        this.#applyToolCursor();
        this.#hideCursorRing();
      });
    }
    for (const el of root.querySelectorAll<HTMLInputElement>('input[name="eraseTo"]')) {
      el.addEventListener('change', () => {
        if (el.checked) this.#eraseTo = el.value as EraseTo;
      });
    }
    root.querySelector<HTMLInputElement>('input[name="color"]')?.addEventListener('input', (e) => {
      this.#color = (e.target as HTMLInputElement).value;
    });
    root.querySelector<HTMLInputElement>('input[name="brushSize"]')?.addEventListener('input', (e) => {
      this.#brushSize = Number((e.target as HTMLInputElement).value);
    });
    root.querySelector<HTMLInputElement>('input[name="zoom"]')?.addEventListener('input', (e) => {
      this.#zoom = Number((e.target as HTMLInputElement).value);
      this.#applyZoom();
    });
    this.#updateUndoButtonState();
  }

  #brushMax(): number {
    const longEdge = this.#source ? Math.max(this.#source.width, this.#source.height) : 400;
    return Math.max(40, Math.round(longEdge / 4));
  }

  #syncBrushControls(): void {
    const range = this.element.querySelector<HTMLInputElement>('input[name="brushSize"]');
    if (!range) return;
    range.max = String(this.#brushMax());
    range.value = String(this.#brushSize);
  }

  #applyToolCursor(): void {
    this.#work.style.cursor = this.#tool === 'view' ? 'default' : this.#tool === 'brush' ? 'none' : 'crosshair';
  }

  /** CSS size of the canvas: "fit into the viewport" times the user's zoom; the viewport scrolls when it doesn't fit. */
  #applyZoom(): void {
    const viewport = this.element.querySelector<HTMLElement>('[data-viewport]');
    if (!viewport || !this.#source) return;
    const measurable = viewport.clientWidth > 0 && viewport.clientHeight > 0;
    const fit = measurable ? Math.min(viewport.clientWidth / this.#source.width, viewport.clientHeight / this.#source.height, MAX_FIT_UPSCALE) : 1;
    const scale = Math.max(fit, 0.01) * this.#zoom;
    this.#work.style.width = `${Math.round(this.#source.width * scale)}px`;
    this.#work.style.height = `${Math.round(this.#source.height * scale)}px`;
  }

  #displayScale(): number {
    const rect = this.#work.getBoundingClientRect();
    return rect.width > 0 ? this.#work.width / rect.width : 1;
  }

  #toImagePoint(e: PointerEvent): Point {
    const rect = this.#work.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * this.#work.width,
      y: ((e.clientY - rect.top) / rect.height) * this.#work.height,
    };
  }

  /** Position relative to the stage (the canvas' offset parent), in CSS px — for the cursor ring / selection box. */
  #toStagePoint(e: PointerEvent): Point {
    const rect = this.#work.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  #attachCanvasListeners(): void {
    const canvas = this.#work;
    canvas.addEventListener('pointerdown', (e: PointerEvent) => {
      if (this.#tool === 'view' || !this.#ctx) return;
      canvas.setPointerCapture(e.pointerId);
      const p = this.#toImagePoint(e);
      if (this.#tool === 'pick') {
        this.#pickColorAt(p);
        return;
      }
      this.#pushUndo();
      if (this.#tool === 'brush') {
        this.#strokeLast = p;
        this.#paintDot(p);
      } else {
        this.#rectStart = p;
        this.#updateSelectionBox(e);
      }
    });
    canvas.addEventListener('pointermove', (e: PointerEvent) => {
      if (this.#tool === 'brush') this.#moveCursorRing(e);
      if (this.#tool === 'brush' && this.#strokeLast) {
        const p = this.#toImagePoint(e);
        this.#paintLine(this.#strokeLast, p);
        this.#strokeLast = p;
      } else if (this.#tool === 'rect' && this.#rectStart) {
        this.#updateSelectionBox(e);
      }
    });
    const end = (e: PointerEvent): void => {
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      if (this.#tool === 'rect' && this.#rectStart) {
        this.#applyRect(this.#rectStart, this.#toImagePoint(e));
        this.#rectStart = null;
        this.#selectionBox.style.display = 'none';
      }
      this.#strokeLast = null;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', () => this.#hideCursorRing());
  }

  #moveCursorRing(e: PointerEvent): void {
    const p = this.#toStagePoint(e);
    const diameter = this.#brushSize / this.#displayScale();
    const ring = this.#cursorRing;
    ring.style.display = 'block';
    ring.style.width = `${diameter}px`;
    ring.style.height = `${diameter}px`;
    ring.style.left = `${p.x - diameter / 2}px`;
    ring.style.top = `${p.y - diameter / 2}px`;
  }

  #hideCursorRing(): void {
    this.#cursorRing.style.display = 'none';
  }

  #updateSelectionBox(e: PointerEvent): void {
    if (!this.#rectStart) return;
    const rect = this.#work.getBoundingClientRect();
    const scale = 1 / this.#displayScale();
    const a = { x: this.#rectStart.x * scale, y: this.#rectStart.y * scale };
    const b = this.#toStagePoint(e);
    const box = this.#selectionBox;
    box.style.display = 'block';
    box.style.left = `${Math.min(a.x, b.x)}px`;
    box.style.top = `${Math.min(a.y, b.y)}px`;
    box.style.width = `${Math.min(Math.abs(a.x - b.x), rect.width)}px`;
    box.style.height = `${Math.min(Math.abs(a.y - b.y), rect.height)}px`;
  }

  /** Paints with the current "erase to" setting: `destination-out` makes pixels transparent, otherwise a solid color. */
  #withEraseStyle(draw: (ctx: CanvasRenderingContext2D) => void): void {
    const ctx = this.#ctx;
    if (!ctx) return;
    ctx.save();
    if (this.#eraseTo === 'transparent') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = '#000';
      ctx.fillStyle = '#000';
    } else {
      ctx.strokeStyle = this.#color;
      ctx.fillStyle = this.#color;
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = this.#brushSize;
    draw(ctx);
    ctx.restore();
    this.#dirty = true;
  }

  #paintDot(p: Point): void {
    this.#withEraseStyle((ctx) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, this.#brushSize / 2, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  #paintLine(from: Point, to: Point): void {
    this.#withEraseStyle((ctx) => {
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    });
  }

  #applyRect(a: Point, b: Point): void {
    const x = Math.max(0, Math.round(Math.min(a.x, b.x)));
    const y = Math.max(0, Math.round(Math.min(a.y, b.y)));
    const w = Math.min(this.#work.width, Math.round(Math.max(a.x, b.x))) - x;
    const h = Math.min(this.#work.height, Math.round(Math.max(a.y, b.y))) - y;
    if (w < 1 || h < 1) {
      this.#undoStack.pop();
      this.#editCount--;
      this.#updateUndoButtonState();
      return;
    }
    this.#withEraseStyle((ctx) => ctx.fillRect(x, y, w, h));
  }

  #pickColorAt(p: Point): void {
    const ctx = this.#ctx;
    if (!ctx) return;
    const x = Math.min(this.#work.width - 1, Math.max(0, Math.floor(p.x)));
    const y = Math.min(this.#work.height - 1, Math.max(0, Math.floor(p.y)));
    const [r, g, b, a] = ctx.getImageData(x, y, 1, 1).data;
    if (a === 0) return;
    const hex = `#${[r, g, b].map((v) => (v ?? 0).toString(16).padStart(2, '0')).join('')}`;
    this.#color = hex;
    this.#eraseTo = 'color';
    this.#tool = 'brush';
    this.#applyToolCursor();
    void this.render();
  }

  #pushUndo(): void {
    const ctx = this.#ctx;
    if (!ctx) return;
    const bytesPerSnapshot = this.#work.width * this.#work.height * 4;
    const limit = Math.max(2, Math.min(MAX_UNDO_STEPS, Math.floor(UNDO_MEMORY_BUDGET_BYTES / bytesPerSnapshot)));
    this.#undoStack.push(ctx.getImageData(0, 0, this.#work.width, this.#work.height));
    this.#editCount++;
    while (this.#undoStack.length > limit) this.#undoStack.shift();
    this.#updateUndoButtonState();
  }

  #updateUndoButtonState(): void {
    const btn = this.element?.querySelector<HTMLButtonElement>('button[data-action="undo"]');
    if (btn) btn.disabled = this.#undoStack.length === 0;
  }

  static #onUndo(this: ImageEraseApp): void {
    const snapshot = this.#undoStack.pop();
    if (snapshot && this.#ctx) {
      this.#ctx.putImageData(snapshot, 0, 0);
      this.#editCount = Math.max(0, this.#editCount - 1);
      this.#dirty = this.#editCount > 0;
    }
    this.#updateUndoButtonState();
  }

  static #onReset(this: ImageEraseApp): void {
    if (!this.#ctx || !this.#source) return;
    this.#pushUndo();
    this.#ctx.clearRect(0, 0, this.#work.width, this.#work.height);
    this.#ctx.drawImage(this.#source, 0, 0);
    this.#dirty = true;
  }

  static #onSave(this: ImageEraseApp): void {
    void (async () => {
      if (!this.#dirty) {
        this.#resolve?.(null);
        this.#resolve = null;
        void this.close();
        return;
      }
      try {
        const format: 'webp' | 'png' = this.#input.format === 'png' ? 'png' : 'webp';
        const mime = format === 'png' ? 'image/png' : 'image/webp';
        const blob = await new Promise<Blob | null>((resolve) => this.#work.toBlob(resolve, mime, format === 'webp' ? DEFAULT_WEBP_QUALITY : undefined));
        if (!blob) throw new Error('canvas.toBlob returned null');
        const bytes = new Uint8Array(await blob.arrayBuffer());
        this.#resolve?.({ bytes, format, width: this.#work.width, height: this.#work.height });
        this.#resolve = null;
        void this.close();
      } catch (err) {
        console.warn('Bindery | ImageEraseApp: saving the edited image failed:', err);
        ui.notifications?.error(game.i18n!.localize('BINDERY.imageErase.failed' as never));
      }
    })();
  }

  static #onCancel(this: ImageEraseApp): void {
    this.#resolve?.(null);
    this.#resolve = null;
    void this.close();
  }

  override async close(options?: object): Promise<this> {
    this.#resolve?.(null);
    this.#resolve = null;
    this.#source?.close();
    this.#source = null;
    return super.close(options);
  }
}

/** Opens the preview/erase window on the given image bytes; resolves to the edited bytes, or `null` when nothing was changed or the window was cancelled. */
export async function eraseImage(input: EraseImageInput): Promise<EraseImageResult | null> {
  return ImageEraseApp.prepare(input);
}

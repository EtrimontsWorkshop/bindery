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
const MAX_UNDO_STEPS = 100;
/** Total pixel memory kept for undo + redo history; the oldest steps are dropped beyond it. */
const HISTORY_MEMORY_BUDGET_BYTES = 200_000_000;

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

/** One history entry stores only the pixels of the region an edit touched (not the whole canvas), so long histories stay cheap even for large images. */
interface HistoryStep {
  x: number;
  y: number;
  data: ImageData;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
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
      redo: ImageEraseApp.#onRedo,
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
  #undoStack: HistoryStep[] = [];
  #redoStack: HistoryStep[] = [];
  /** The edit in progress: the whole canvas as it was before it started, plus the bounding box painted so far. */
  #pending: { before: ImageData; box: Box | null } | null = null;
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
      canRedo: this.#redoStack.length > 0,
      undoCount: this.#undoStack.length,
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

    // Ctrl/Cmd+Z undoes the last step, Ctrl/Cmd+Shift+Z (or Ctrl+Y) redoes it.
    // The stage is focusable and gets focus when the user paints, so the
    // shortcut works right after an edit without hijacking Foundry's own
    // shortcuts elsewhere.
    root.addEventListener('keydown', (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || (e.target as HTMLElement).tagName === 'INPUT') return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) ImageEraseApp.#onUndo.call(this);
      else if ((key === 'z' && e.shiftKey) || key === 'y') ImageEraseApp.#onRedo.call(this);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
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
      this.#work.parentElement?.focus({ preventScroll: true });
      const p = this.#toImagePoint(e);
      if (this.#tool === 'pick') {
        this.#pickColorAt(p);
        return;
      }
      if (this.#tool === 'brush') this.#beginStep();
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
      if (this.#strokeLast) this.#commitStep();
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
    this.#extendBox(p.x, p.y, p.x, p.y, this.#brushSize / 2 + 2);
    this.#withEraseStyle((ctx) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, this.#brushSize / 2, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  #paintLine(from: Point, to: Point): void {
    this.#extendBox(Math.min(from.x, to.x), Math.min(from.y, to.y), Math.max(from.x, to.x), Math.max(from.y, to.y), this.#brushSize / 2 + 2);
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
    if (w < 1 || h < 1) return;
    this.#beginStep();
    this.#extendBox(x, y, x + w, y + h, 0);
    this.#withEraseStyle((ctx) => ctx.fillRect(x, y, w, h));
    this.#commitStep();
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

  #beginStep(): void {
    if (!this.#ctx) return;
    this.#pending = { before: this.#ctx.getImageData(0, 0, this.#work.width, this.#work.height), box: null };
  }

  #extendBox(x0: number, y0: number, x1: number, y1: number, pad: number): void {
    if (!this.#pending) return;
    const box: Box = {
      x0: Math.max(0, Math.floor(x0 - pad)),
      y0: Math.max(0, Math.floor(y0 - pad)),
      x1: Math.min(this.#work.width, Math.ceil(x1 + pad)),
      y1: Math.min(this.#work.height, Math.ceil(y1 + pad)),
    };
    const cur = this.#pending.box;
    this.#pending.box = cur ? { x0: Math.min(cur.x0, box.x0), y0: Math.min(cur.y0, box.y0), x1: Math.max(cur.x1, box.x1), y1: Math.max(cur.y1, box.y1) } : box;
  }

  /** Finishes the edit in progress: keeps only the pre-edit pixels of the touched region as an undo step. */
  #commitStep(): void {
    const pending = this.#pending;
    this.#pending = null;
    if (!pending?.box) return;
    const { x0, y0, x1, y1 } = pending.box;
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < 1 || h < 1) return;
    const crop = new ImageData(w, h);
    const rowBytes = w * 4;
    const stride = pending.before.width * 4;
    for (let row = 0; row < h; row++) {
      const from = (y0 + row) * stride + x0 * 4;
      crop.data.set(pending.before.data.subarray(from, from + rowBytes), row * rowBytes);
    }
    this.#undoStack.push({ x: x0, y: y0, data: crop });
    this.#redoStack = [];
    this.#editCount++;
    this.#trimHistory();
    this.#updateUndoButtonState();
  }

  #trimHistory(): void {
    const total = (): number => [...this.#undoStack, ...this.#redoStack].reduce((sum, step) => sum + step.data.data.byteLength, 0);
    while (this.#undoStack.length > MAX_UNDO_STEPS || (this.#undoStack.length > 1 && total() > HISTORY_MEMORY_BUDGET_BYTES)) this.#undoStack.shift();
  }

  #updateUndoButtonState(): void {
    const setup = (action: 'undo' | 'redo', count: number): void => {
      const btn = this.element?.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`);
      if (!btn) return;
      btn.disabled = count === 0;
      btn.textContent = `${btn.dataset['label'] ?? ''}${count > 0 ? ` (${count})` : ''}`;
    };
    setup('undo', this.#undoStack.length);
    setup('redo', this.#redoStack.length);
  }

  /** Swaps a history step with the current pixels of the same region: applies it and returns what it replaced (for the opposite stack). */
  #swapStep(step: HistoryStep): HistoryStep | null {
    const ctx = this.#ctx;
    if (!ctx) return null;
    const replaced = ctx.getImageData(step.x, step.y, step.data.width, step.data.height);
    ctx.putImageData(step.data, step.x, step.y);
    return { x: step.x, y: step.y, data: replaced };
  }

  static #onUndo(this: ImageEraseApp): void {
    const step = this.#undoStack.pop();
    const inverse = step ? this.#swapStep(step) : null;
    if (inverse) {
      this.#redoStack.push(inverse);
      this.#editCount = Math.max(0, this.#editCount - 1);
      this.#dirty = this.#editCount > 0;
    }
    this.#updateUndoButtonState();
  }

  static #onRedo(this: ImageEraseApp): void {
    const step = this.#redoStack.pop();
    const inverse = step ? this.#swapStep(step) : null;
    if (inverse) {
      this.#undoStack.push(inverse);
      this.#editCount++;
      this.#dirty = true;
    }
    this.#updateUndoButtonState();
  }

  static #onReset(this: ImageEraseApp): void {
    if (!this.#ctx || !this.#source) return;
    this.#beginStep();
    this.#extendBox(0, 0, this.#work.width, this.#work.height, 0);
    this.#ctx.clearRect(0, 0, this.#work.width, this.#work.height);
    this.#ctx.drawImage(this.#source, 0, 0);
    this.#dirty = true;
    this.#commitStep();
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

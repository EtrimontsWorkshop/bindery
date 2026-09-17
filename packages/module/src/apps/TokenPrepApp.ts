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
import { MODULE_ID, type TokenPrepDefaults } from '../settings.js';

/**
 * TokenPrepApp (Step 42, "token as a product") — an `ApplicationV2` window
 * separate from `ReviewScreen` (following the pattern of `GridPicker.ts`),
 * opened by the "Prepare token" button EXCLUSIVELY for images with the
 * `token` destination. Zero automation in the background: every step
 * (background removal, crop+zoom, mask, frame) happens LIVE in the preview,
 * confirming encodes EXACTLY what's visible. The mechanism that assigns a
 * token to an actor (step 35, `uploadedTokenImagePathById` in
 * `ReviewScreen.ts`) stays UNTOUCHED — this panel ONLY REPLACES the image's
 * bytes/dimensions/format BEFORE `#runImport` uploads them, exactly the way
 * `#resizeImage`/`#rotateImage` do today.
 *
 * Pipeline (the same one used in `redraw()` for the preview and on confirm,
 * just a different target resolution — no preview/result drift): source ->
 * (optionally) `removeBackground` over the WHOLE source image (corners =
 * background, see `removeBackground.ts` — most reliable when run on the
 * NOT-YET-CROPPED image, where the corners really are the page background)
 * -> `rotateAndCropImage` (crop+zoom into a square, `rotationRad=0` —
 * rotating the image is a separate, already-existing function in the image
 * row) -> `applyTokenMask` -> `applyBuiltInFrame`/`compositeCustomFrame`.
 */

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const PREVIEW_PX = 420;
const OUTPUT_SIZES = [256, 512, 1024] as const;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const BUILT_IN_FRAME_THICKNESS: Record<'thin' | 'thick', number> = { thin: 0.05, thick: 0.12 };
/**
 * [Step 42 Z3, "actor disposition UNAVAILABLE at token-prep time"]
 * `disposition` is never read anywhere before the actor is saved (see
 * `coc7.ts`, hardcoded `1`) — per the escape hatch from the brief ("if
 * disposition is unavailable, leave the default color"), the built-in frame
 * gets ONE neutral default color instead of trying to guess
 * friendly/hostile/neutral.
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
  /** Starting value of the "remove background" toggle — see `images.removeTokenBackgroundDefault` in `schema.ts` (`@bindery/core`). */
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

/** [Set as default] `game.settings` only stores JSON-able values — the custom frame's bytes travel as base64. */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
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
      setDefault: TokenPrepApp.#onSetDefault,
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
  /** [performance] `removeBackground` is independent of crop/zoom — cached by tolerance+seed version, so that dragging the preview (pan/zoom) does NOT recompute the flood-fill over the whole source on every frame. */
  #bgRemovedCache: { tolerance: number; seedsVersion: number; image: DecodedImage } | null = null;
  #customFrameBytes: Uint8Array | null = null;

  /**
   * [REPORT-click-to-add-background Z1, "a hat touching the body creates a
   * closed background pocket"] Points added manually by the user, in FULL
   * SOURCE COORDINATES (not preview/crop coordinates — stable regardless of
   * later zoom/pan changes), passed as `extraSeeds` to `removeBackground`.
   * `#seedsVersion` increments on every change (add/undo) — a cache key
   * alongside tolerance, because `removeBackground` itself doesn't know
   * about the contents of this array.
   */
  #clickSeeds: Array<{ x: number; y: number }> = [];
  #seedsVersion = 0;
  /** "Click to add background" mode — when active, a click (without dragging) on the preview adds a seed instead of panning the crop. */
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

    // [Set as default] Once the user has clicked this button, their saved
    // set of settings wins over ALL the built-in initial values ABOVE —
    // including the profile's suggestion (`input.removeBackgroundDefault`)
    // — this is an explicit, deliberate decision made via the button, not a
    // default profile heuristic.
    const saved = game.settings!.get(MODULE_ID, 'tokenPrepDefaults');
    if (saved.enabled) {
      this.#shape = saved.shape as TokenMaskShape;
      this.#removeBg = saved.removeBackground;
      this.#tolerance = saved.removeBackgroundTolerance;
      this.#frame = saved.frame as FrameChoice;
      this.#frameColor = saved.frameColor;
      this.#outputSize = saved.outputSize as OutputSize;
      this.#format = saved.format as 'webp' | 'png';
      if (saved.frame === 'custom' && saved.frameCustomImage) {
        this.#customFrameBytes = base64ToBytes(saved.frameCustomImage);
      }
    }
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
      console.warn('Bindery | TokenPrepApp: missing <canvas> in the rendered DOM');
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
        console.warn('Bindery | TokenPrepApp: decoding the source image failed:', err);
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
      // [REPORT-click-to-add-background Z1] In "click to add background" mode, dragging does NOT pan the crop — a plain click (see `endDrag`) adds a seed, so an accidental micro-movement of the mouse between pointerdown/up doesn't shift the crop under the user.
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
   * SOURCE pixels per OUTPUT pixel at the current zoom — the crop fills the
   * whole square at zoom=1, larger values zoom in. `outputEdgePx` is a
   * PARAMETER (not always `PREVIEW_PX`) — `#compose` calls this with the
   * target save resolution (256-1024), NOT the preview resolution, otherwise
   * the final save would have a DIFFERENT crop/zoom than what's shown in the
   * preview (bug measured live in the first version: multiplying the scale
   * already computed "for PREVIEW_PX" by `outputSize/PREVIEW_PX` instead of
   * `PREVIEW_PX/outputSize` gave a scale distorted by the square of the
   * resolution ratio).
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

  /** Composed pipeline: crop+zoom -> mask -> frame, at any target resolution (the preview and the final save share the same code). */
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
        console.warn('Bindery | TokenPrepApp: failed to apply the custom frame:', err);
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
    if (seq !== this.#redrawSeq) return; // [race] a newer #redraw call is already in flight — discard the stale result
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
        console.warn('Bindery | TokenPrepApp: saving the token failed:', err);
        ui.notifications?.error(game.i18n!.localize('BINDERY.review.resizeFailed' as never));
      }
    })();
  }

  /**
   * [Set as default] Saves the panel's CURRENT (not yet confirmed) settings
   * as the starting point for every subsequent `TokenPrepApp` opening in
   * this world — does not close the window or encode a token; the user can
   * keep fine-tuning this particular token after clicking it.
   */
  static #onSetDefault(this: TokenPrepApp): void {
    void (async () => {
      const payload: TokenPrepDefaults = {
        enabled: true,
        shape: this.#shape,
        removeBackground: this.#removeBg,
        removeBackgroundTolerance: this.#tolerance,
        frame: this.#frame,
        frameColor: this.#frameColor,
        frameCustomImage: this.#frame === 'custom' && this.#customFrameBytes ? bytesToBase64(this.#customFrameBytes) : null,
        outputSize: this.#outputSize,
        format: this.#format,
      };
      await game.settings!.set(MODULE_ID, 'tokenPrepDefaults', payload);
      ui.notifications?.info(game.i18n!.localize('BINDERY.tokenPrep.setDefaultSaved' as never));
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

/** Opens the token-preparation panel, returns the finished bytes/format/dimensions or `null` (cancelled). */
export async function prepareToken(input: PrepareTokenInput): Promise<PrepareTokenResult | null> {
  return TokenPrepApp.prepare(input);
}

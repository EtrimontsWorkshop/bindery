import type { CIFImage, Rect, RotatedRect } from '@bindery/core';
import { pdfRectToScreen } from '@bindery/core';
import type { ReviewScreenData } from '../apps/ReviewScreen.js';
import type { ReviewSelection } from './selectionState.js';
import type { VirtualList } from './VirtualList.js';

/**
 * What the overlay reads and changes of the review screen it belongs to. `ReviewScreen` builds one in its constructor;
 * the fields that are not `readonly` are live views of the screen's own state.
 */
export interface PageOverlayHost {
  readonly element: HTMLElement;
  currentPageNumber: number;
  readonly data: ReviewScreenData;
  highlightedImageId: string | null;
  readonly selection: ReviewSelection;
  imageList: VirtualList<CIFImage> | null;
  refreshImageRowHighlights(): void;
  pendingCrop: RotatedRect | null;
  pendingCropPageNumber: number | null;
  overlayDraw: (() => void) | null;
  overlayResizeObserver: ResizeObserver | null;
  isSelectMode: boolean;
  isCropping: boolean;
  dragState: { startScreen: { x: number; y: number }; rectEl: SVGRectElement } | null;
  createManualCropRotated(screenRect: RotatedRect): Promise<void>;
  imageAdjustRotation: { imageId: string; rotationRad: number } | null;
  resizeImage(image: CIFImage, screenRect: RotatedRect): Promise<void>;
}

/**
 * The layer drawn over the page preview in the review screen: the boxes of the page's images, the handles that resize
 * and turn the highlighted one, and the rectangle of "select and crop" with its confirm/cancel toolbar. Moved out of
 * `ReviewScreen.ts` unchanged; it reaches the screen's state through `PageOverlayHost`.
 */
export class PageOverlay {
  readonly #host: PageOverlayHost;

  constructor(host: PageOverlayHost) {
    this.#host = host;
  }

  #overlayImages: readonly CIFImage[] = [];
  /** Confirm/cancel bar element added DYNAMICALLY to `.bindery-page-canvas-wrap` (like `rectEl` in `#dragState` — it's not in the Handlebars markup) — kept here so it can be removed on confirm/cancel/page change. */
  #pendingCropToolbar: HTMLElement | null = null;

  /** Redraws the overlay on the SAME (already loaded) page — without a full `render()`, so it doesn't lose the list's scroll position. `getPageBox` is cached in `PreviewDocument`, so this is cheap. */
  async redrawOverlay(): Promise<void> {
    await this.mountOverlay(this.#overlayImages);
  }

  async mountOverlay(images: readonly CIFImage[]): Promise<void> {
    this.#overlayImages = images;
    const svg = this.#host.element.querySelector<SVGSVGElement>('[data-overlay]');
    const img = this.#host.element.querySelector<HTMLImageElement>('.bindery-page-image');
    if (!svg || !img) return;

    // [Bug fix — whole-design review] `_onRender` calls `#mountOverlay`
    // without `await` (deliberately — we don't want to block the render's
    // completion on loading the page geometry), so ANOTHER full render (e.g.
    // a second "next page" click before `getPageBox` below resolves) can
    // change `#currentPageNumber` BEFORE this `await` returns. Without this
    // guard flag, the overlay would draw rectangles computed for a page that
    // is NO LONGER current on top of the image of the CURRENT page — the
    // other (already in-flight) `#mountOverlay` will draw the correct
    // overlay right after anyway, so it's safe to simply skip drawing here.
    const requestedPageNumber = this.#host.currentPageNumber;
    const box = await this.#host.data.previewDocument.getPageBox(requestedPageNumber);
    if (this.#host.currentPageNumber !== requestedPageNumber) return;
    const draw = () => {
      const width = img.naturalWidth || img.clientWidth;
      const height = img.naturalHeight || img.clientHeight;
      if (!width || !height) return;
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      // The overlay's CSS box MUST have exactly the same proportions
      // as the viewBox, otherwise SVG's default `preserveAspectRatio`
      // ("xMidYMid meet") adds invisible bars and centers/scales the SVG
      // content within its own box — `width:100%;height:100%` from CSS is
      // computed relative to `.bindery-page-canvas-wrap` (whose height is
      // constrained by layout), NOT relative to the actually rendered
      // `<img>` (which for a tall page is taller and scrollable), so the
      // proportions didn't match and the naive calculation in
      // `toOverlayPoint` (a simple `viewBox/rect`) gave a wrong result.
      svg.style.width = `${img.clientWidth}px`;
      svg.style.height = `${img.clientHeight}px`;
      svg.innerHTML = '';
      for (const image of images) {
        if (image.provenance.pageNumber !== this.#host.currentPageNumber) continue;
        const screen = pdfRectToScreen(image.provenance.bbox, { pageBox: box.box, imageWidthPx: width, imageHeightPx: height, rotation: box.rotation as never });
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', String(screen.minX));
        rect.setAttribute('y', String(screen.minY));
        rect.setAttribute('width', String(Math.max(0, screen.maxX - screen.minX)));
        rect.setAttribute('height', String(Math.max(0, screen.maxY - screen.minY)));
        const isHighlighted = image.id === this.#host.highlightedImageId;
        const classes = [this.#host.selection.isImageSelected(image.id) ? 'bindery-overlay-selected' : 'bindery-overlay-unselected'];
        if (isHighlighted) classes.push('bindery-overlay-highlighted');
        rect.setAttribute('class', classes.join(' '));
        rect.dataset['imageId'] = image.id;
        rect.addEventListener('click', () => {
          this.#host.highlightedImageId = image.id;
          this.#host.imageList?.scrollToIndex(images.findIndex((i) => i.id === image.id));
          this.#host.refreshImageRowHighlights();
          draw();
        });
        svg.appendChild(rect);
        // [User request, "the ability to resize an automatically found
        // image"] Handles appear SOLELY on the currently highlighted image
        // (the same mechanism as clicking a list row/rectangle — nothing new
        // to turn on) — reusing `#highlightedImageId` instead of a separate
        // mode.
        if (isHighlighted && !this.#host.pendingCrop) this.renderResizeHandles(svg, image, rect, screen);
      }
      if (this.#host.pendingCrop && this.#host.pendingCropPageNumber !== this.#host.currentPageNumber) {
        // Safety net: switching to another page (◄/► navigation, clicking an
        // image/actor row on another page) should already have reset
        // `#pendingCrop` at the source — this is an extra safety net so we
        // don't ACCIDENTALLY crop a fragment of one page based on
        // coordinates drawn on a completely different one.
        this.#host.pendingCrop = null;
        this.#host.pendingCropPageNumber = null;
        this.teardownPendingCropUi();
      }
      this.renderPendingCropOverlay(svg);
    };
    if (img.complete) draw();
    else img.addEventListener('load', draw, { once: true });

    this.wireSelectDrag(svg, img, draw);
  }

  /**
   * Wires up mouse dragging ON `svg` (not on the overlay's individual
   * rectangles) — a `pointerdown` on a child bubbles up to the parent
   * anyway, so one set of listeners on the whole overlay is enough. The
   * `dataset['dragWired']` flag guards against re-wiring on EVERY call to
   * `#mountOverlay`/`#redrawOverlay` (clicking an existing rectangle
   * refreshes the overlay without a full `render()`, so the same `<svg>`
   * element can pass through `#mountOverlay` multiple times) — the `<svg>`
   * element SURVIVES `svg.innerHTML = ''` in `draw()` (which only clears its
   * children), so a flag on the element itself is a safe, persistent marker.
   */
  wireSelectDrag(svg: SVGSVGElement, img: HTMLImageElement, redraw: () => void): void {
    // The latest `draw()` of this overlay: a redraw without a full render (`#redrawOverlay`) makes a new one, with the
    // current list of images, which the resize observer below has to use rather than the one it was created with.
    this.#host.overlayDraw = redraw;
    if (svg.dataset['dragWired']) return;
    svg.dataset['dragWired'] = '1';

    // The Foundry window's size (and hence the rendered <img>'s) can change
    // AFTER the first `draw()` (dragging/resizing the ApplicationV2 window)
    // — without this, the overlay would stay at the old size and
    // letterboxing/misalignment would return on every window resize.
    // Every render brings a new <img>, so the previous observer is disconnected:
    // left alone, each one kept its detached page image and this window alive.
    this.#host.overlayResizeObserver?.disconnect();
    this.#host.overlayResizeObserver = new ResizeObserver(() => this.#host.overlayDraw?.());
    this.#host.overlayResizeObserver.observe(img);

    svg.addEventListener('pointerdown', (e: PointerEvent) => {
      if (!this.#host.isSelectMode || this.#host.isCropping || this.#host.pendingCrop || e.button !== 0) return;
      e.preventDefault();
      const start = this.toOverlayPoint(svg, e.clientX, e.clientY);
      const rectEl = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rectEl.setAttribute('class', 'bindery-select-drag-rect');
      rectEl.setAttribute('x', String(start.x));
      rectEl.setAttribute('y', String(start.y));
      rectEl.setAttribute('width', '0');
      rectEl.setAttribute('height', '0');
      svg.appendChild(rectEl);
      this.#host.dragState = { startScreen: start, rectEl };
      svg.setPointerCapture(e.pointerId);
    });

    svg.addEventListener('pointermove', (e: PointerEvent) => {
      if (!this.#host.dragState) return;
      const { startScreen, rectEl } = this.#host.dragState;
      const cur = this.toOverlayPoint(svg, e.clientX, e.clientY);
      rectEl.setAttribute('x', String(Math.min(startScreen.x, cur.x)));
      rectEl.setAttribute('y', String(Math.min(startScreen.y, cur.y)));
      rectEl.setAttribute('width', String(Math.abs(cur.x - startScreen.x)));
      rectEl.setAttribute('height', String(Math.abs(cur.y - startScreen.y)));
    });

    const MIN_DRAG_PX = 8; // below this we treat it as an accidental click, not a deliberate selection
    const finishDrag = (e: PointerEvent): void => {
      if (!this.#host.dragState) return;
      const { startScreen, rectEl } = this.#host.dragState;
      this.#host.dragState = null;
      rectEl.remove();
      const cur = this.toOverlayPoint(svg, e.clientX, e.clientY);
      const screenRect: Rect = {
        minX: Math.min(startScreen.x, cur.x),
        maxX: Math.max(startScreen.x, cur.x),
        minY: Math.min(startScreen.y, cur.y),
        maxY: Math.max(startScreen.y, cur.y),
      };
      if (screenRect.maxX - screenRect.minX < MIN_DRAG_PX || screenRect.maxY - screenRect.minY < MIN_DRAG_PX) return;
      // [User request, "rotate the selected area before cropping"]
      // We no longer crop right away — we move into a "rotation adjustment"
      // state (handle + confirm/cancel bar), see `#pendingCrop`.
      this.#host.pendingCrop = {
        centerX: (screenRect.minX + screenRect.maxX) / 2,
        centerY: (screenRect.minY + screenRect.maxY) / 2,
        width: screenRect.maxX - screenRect.minX,
        height: screenRect.maxY - screenRect.minY,
        rotationRad: 0,
      };
      this.#host.pendingCropPageNumber = this.#host.currentPageNumber;
      this.renderPendingCropOverlay(svg);
      const wrap = svg.closest<HTMLElement>('.bindery-page-canvas-wrap');
      if (wrap) this.showPendingCropToolbar(wrap);
    };
    svg.addEventListener('pointerup', finishDrag);
    svg.addEventListener('pointercancel', finishDrag);
  }

  /**
   * [User request, "the area is shifted to the right relative to the
   * cursor"] `rect` is the WHOLE `<svg>` box — the FRAME's size
   * (`img.clientWidth/Height`, see the comment next to
   * `.bindery-page-canvas-wrap`), NOT the size of the actually visible
   * (letterboxed) content. The `viewBox`'s default
   * `preserveAspectRatio="xMidYMid meet"` scales ITS OWN CONTENT (the
   * overlay rectangles) to the LARGEST fragment of `rect` with the
   * `viewBox`'s proportions, CENTERED — exactly what `object-fit: contain`
   * does to the `<img>` itself (hence the empty bars visible on screen
   * whenever the PDF page's proportions aren't EXACTLY 3:4). The overlay
   * rectangles (drawn in `viewBox` units) therefore land correctly — the
   * same SVG mechanism positions them. A naive `vb.width/rect.width`
   * division (without this same correction) assumed the content fills the
   * WHOLE `rect`, so EVERY click/drag was offset by half the width of the
   * letterboxing bar — a small but real shift to the right (or downward) on
   * every page whose proportions aren't exactly 3:4 (i.e. almost every
   * page). When zoomed (`bindery-zoomed`, `object-fit:none`, `<img>` scaled
   * by width only) `rect` and `viewBox` have the same proportions by
   * definition — the formula below then degenerates to the old (correct in
   * that case) behavior.
   */
  toOverlayPoint(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } {
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
   * [User request, "rotate the selected area before cropping", drag handle]
   * Draws `#pendingCrop` as a `<g>` with `transform="rotate(deg cx cy)"`
   * (SVG's `rotate` uses EXACTLY the same matrix `[cos,-sin; sin,cos]` as
   * `screenRotatedRectToPdf` on the core side — so what's seen on screen is,
   * by definition, consistent with what actually gets cropped afterward).
   * The handle is a simple circle ABOVE the center of the top edge, in the
   * `<g>`'s LOCAL (unrotated) coordinate space — it rotates together with
   * the rectangle purely via the parent's transform, no separate algebra.
   * The handle's radius/offset are converted to `viewBox` units so that on
   * SCREEN it has a constant size regardless of the page's resolution/zoom
   * level (otherwise on a high-resolution page the handle would be
   * invisibly small).
   *
   * [rotation direction] `rotationRad = atan2(dy, dx) + PI/2` (where `dx,dy`
   * is the cursor vector relative to the center) — derived so that after
   * applying EXACTLY the same rotation matrix as SVG's `rotate()`, the
   * handle (locally straight ABOVE the center) lands EXACTLY under the
   * cursor: dragging the handle is therefore WYSIWYG on screen by
   * definition. Whether the final, PIXEL-cropped image rotates in the same
   * direction as the on-screen preview could NOT be verified without a live
   * test in Foundry (see `renderRotatedRegion.test.ts`) — if the live test
   * shows it's reversed, the only fix is to negate the angle HERE (in
   * `rotationRad = ...` below), not in the `core` layer.
   */
  renderPendingCropOverlay(svg: SVGSVGElement): void {
    svg.querySelector('.bindery-pending-crop')?.remove();
    const pending = this.#host.pendingCrop;
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
      if (!this.#host.pendingCrop || !handle.hasPointerCapture(e.pointerId)) return;
      e.stopPropagation();
      const pt = this.toOverlayPoint(svg, e.clientX, e.clientY);
      const angle = Math.atan2(pt.y - this.#host.pendingCrop.centerY, pt.x - this.#host.pendingCrop.centerX);
      this.#host.pendingCrop = { ...this.#host.pendingCrop, rotationRad: angle + Math.PI / 2 };
      // [User request, "it's very sluggish, only a few degrees at a time"]
      // The full `#renderPendingCropOverlay` must NOT be called here — it
      // REMOVES and RECREATES the `handle` (via `svg.querySelector(...)
      // .remove()` at the start), and removing an element from the DOM that
      // holds `setPointerCapture` silently releases that capture (the
      // browser automatically fires `lostpointercapture`). The newly
      // created `handle` does NOT have capture, so SUBSEQUENT `pointermove`
      // events (the cursor already far from its position) missed it
      // entirely — hence "only works a few degrees at a time" (one move =
      // one event before the handle got replaced). During dragging, ONLY
      // the rotation angle changes — the local geometry (rect/line/handle)
      // is constant — so it's enough to swap the `transform` on the
      // EXISTING `g`, without rebuilding the whole group/losing capture.
      const deg = (this.#host.pendingCrop.rotationRad * 180) / Math.PI;
      g.setAttribute('transform', `rotate(${deg} ${this.#host.pendingCrop.centerX} ${this.#host.pendingCrop.centerY})`);
    });
    const releaseHandle = (e: PointerEvent): void => {
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    };
    handle.addEventListener('pointerup', releaseHandle);
    handle.addEventListener('pointercancel', releaseHandle);

    svg.appendChild(g);
  }

  /** Confirm/cancel bar added DYNAMICALLY to `.bindery-page-canvas-wrap` (like `rectEl`/`#pendingCrop` — it's not in the Handlebars markup, see `#pendingCropToolbar`). */
  showPendingCropToolbar(wrap: HTMLElement): void {
    this.#pendingCropToolbar?.remove();
    const toolbar = document.createElement('div');
    toolbar.className = 'bindery-pending-crop-toolbar';
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'bindery-btn bindery-btn--primary';
    confirmBtn.textContent = game.i18n!.localize('BINDERY.review.selectModeConfirmCrop' as never);
    confirmBtn.addEventListener('click', () => void this.confirmPendingCrop());
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'bindery-btn';
    cancelBtn.textContent = game.i18n!.localize('BINDERY.review.selectModeCancelCrop' as never);
    cancelBtn.addEventListener('click', () => this.cancelPendingCrop());
    toolbar.append(confirmBtn, cancelBtn);
    wrap.appendChild(toolbar);
    this.#pendingCropToolbar = toolbar;
  }

  teardownPendingCropUi(): void {
    this.#pendingCropToolbar?.remove();
    this.#pendingCropToolbar = null;
  }

  async confirmPendingCrop(): Promise<void> {
    const pending = this.#host.pendingCrop;
    if (!pending || this.#host.isCropping) return;
    this.#host.pendingCrop = null;
    this.#host.pendingCropPageNumber = null;
    this.teardownPendingCropUi();
    await this.#host.createManualCropRotated(pending);
  }

  cancelPendingCrop(): void {
    if (!this.#host.pendingCrop) return;
    this.#host.pendingCrop = null;
    this.#host.pendingCropPageNumber = null;
    this.teardownPendingCropUi();
    void this.redrawOverlay();
  }

  /**
   * [User request, "the ability to resize an automatically found image — it's
   * too big/too small to manually enlarge or shrink"] Eight handles (4
   * corners + 4 edge midpoints) on the rectangle of the HIGHLIGHTED image —
   * works the same way for an automatically detected image and a manually
   * cropped one, because the fitting mechanism doesn't depend on the
   * image's source. Corners change both axes at once, edge midpoints only
   * one (`dx`/`dy` = -1 minX/minY, 0 = no change, +1 = maxX/maxY).
   *
   * [Lesson from an earlier bug in the same session, "the rotation handle
   * only works a few degrees at a time"] WHILE dragging, a full overlay
   * redraw must NOT be called (it destroys and recreates the handles from
   * scratch, silently losing `setPointerCapture`) — `updateAll` only
   * REPLACES the attributes of already existing elements (`rectEl` +
   * handles), so the same `<circle>` element holds capture throughout the
   * whole gesture.
   */
  renderResizeHandles(svg: SVGSVGElement, image: CIFImage, rectEl: SVGRectElement, initialScreen: Rect): void {
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const vb = svg.viewBox.baseVal;
    const svgRect = svg.getBoundingClientRect();
    const scale = vb.width > 0 && svgRect.width > 0 ? vb.width / svgRect.width : 1;
    const handleRadius = 6 * scale;
    const minSize = 12 * scale; // minimum size in viewBox px — guards against shrinking the rectangle to zero/flipping an axis
    const rotateHandleOffset = 32 * scale;
    const initialRotation = this.#host.imageAdjustRotation?.imageId === image.id ? this.#host.imageAdjustRotation.rotationRad : 0;

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

    // [User request, "the ability to rotate an automatically selected
    // image"] The group carries the rotation — EXACTLY the same pattern as
    // `#renderPendingCropOverlay` (SVG's `rotate()` is the same matrix as
    // `screenRotatedRectToPdf`, so screen = what actually gets cropped).
    // `rectEl` is already attached to `svg` (by the caller in `draw()`) —
    // `appendChild` MOVES it into this group, it doesn't clone it.
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

    // [Lesson from an earlier bug in the same session, "the rotation handle
    // only works a few degrees at a time"] `currentRect`/`currentRotation`
    // are SHARED (closure) across ALL handles (8 for resizing + 1 for
    // rotation) — WHILE dragging, a full overlay redraw must NOT be called
    // (it destroys and recreates the handles from scratch, silently losing
    // `setPointerCapture`) — `updateAll` only REPLACES the attributes of
    // already existing elements, so the same `<circle>` element holds
    // capture throughout the whole gesture, no matter how many times it
    // fires.
    let currentRect = initialScreen;
    let currentRotation = initialRotation;

    // [User request, "can't resize from the left side of an automatically
    // selected image"] When the selection reaches almost to the page edge
    // (typical for automatically detected images covering all/almost all of
    // the page), a handle drawn EXACTLY on the rectangle's edge has HALF of
    // its circle outside the `viewBox` — SVG clips by default (`overflow:
    // hidden` by definition on the root `<svg>`) everything outside its own
    // box, so that half is invisible AND unclickable; when the edge is
    // CLOSE ENOUGH to the border, the WHOLE handle can disappear. `clampX`/
    // `clampY` only push the drawn/clickable position (never the
    // `currentRect` data, which still reflects the TRUE edge) away from the
    // `viewBox` borders by the handle's radius, so every handle always fits
    // entirely within the visible/clickable area.
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
      // Same problem/fix as the resize handles above — for a selection
      // reaching close to the TOP edge of the page, the rotation handle
      // (always above the center of the top edge) could fall outside the
      // `viewBox`. The connecting line MUST end at the SAME (clamped) point
      // as the handle, otherwise it will visually "detach" from it.
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

    /** Screen point (unrotated overlay coordinate space) -> LOCAL rectangle coordinate space (the inverse of the current `currentRotation` around `cx,cy`) — needed so that dragging the resize handles works correctly even when the image is ALREADY rotated. */
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
      void this.#host.resizeImage(image, { centerX, centerY, width: currentRect.maxX - currentRect.minX, height: currentRect.maxY - currentRect.minY, rotationRad: currentRotation });
    };

    HANDLE_DEFS.forEach(({ dx, dy }, i) => {
      const handle = resizeHandleEls[i]!;
      handle.addEventListener('pointerdown', (e: PointerEvent) => {
        if (this.#host.isCropping) return;
        e.preventDefault();
        e.stopPropagation();
        handle.setPointerCapture(e.pointerId);
        const startRect = currentRect;
        const startCx = (startRect.minX + startRect.maxX) / 2;
        const startCy = (startRect.minY + startRect.maxY) / 2;
        let changed = false;

        const onMove = (ev: PointerEvent): void => {
          if (!handle.hasPointerCapture(ev.pointerId)) return;
          const pt = this.toOverlayPoint(svg, ev.clientX, ev.clientY);
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
      if (this.#host.isCropping) return;
      e.preventDefault();
      e.stopPropagation();
      rotateHandle.setPointerCapture(e.pointerId);
      const startRotation = currentRotation;
      let changed = false;

      const onMove = (ev: PointerEvent): void => {
        if (!rotateHandle.hasPointerCapture(ev.pointerId)) return;
        const pt = this.toOverlayPoint(svg, ev.clientX, ev.clientY);
        const cx = (currentRect.minX + currentRect.maxX) / 2;
        const cy = (currentRect.minY + currentRect.maxY) / 2;
        const angle = Math.atan2(pt.y - cy, pt.x - cx);
        currentRotation = angle + Math.PI / 2;
        this.#host.imageAdjustRotation = { imageId: image.id, rotationRad: currentRotation };
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
        this.#host.imageAdjustRotation = startRotation !== 0 ? { imageId: image.id, rotationRad: startRotation } : null;
        updateAll();
      };
      rotateHandle.addEventListener('pointermove', onMove);
      rotateHandle.addEventListener('pointerup', onUp);
      rotateHandle.addEventListener('pointercancel', onCancel);
    });
  }
}

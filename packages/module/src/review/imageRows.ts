import type { CIFImage } from '@bindery/core';
import type { ReviewScreenData } from '../apps/ReviewScreen.js';
import type { ReviewSelection, ImageDestination } from './selectionState.js';
import { pageRef } from '../i18n.js';
import type { ImageThumbnails } from './imageThumbnails.js';
import type { PageOverlay } from './pageOverlay.js';

/**
 * What a row of the image list reads and changes of the review screen, and the actions its buttons start there.
 * `ReviewScreen` builds one in its constructor; the fields that are not `readonly` are live views of its state.
 */
export interface ImageRowsHost {
  highlightedImageId: string | null;
  readonly selection: ReviewSelection;
  refreshHeaderCounts(): Promise<void>;
  readonly data: ReviewScreenData;
  readonly thumbnails: ImageThumbnails;
  showThumbPreview(url: string, anchor: HTMLElement, imageWidth: number, imageHeight: number): void;
  hideThumbPreview(): void;
  openImageEditor(image: CIFImage): Promise<void>;
  prepareToken(image: CIFImage): Promise<void>;
  render(): Promise<unknown>;
  rotateImage(image: CIFImage, direction: 1 | -1): Promise<void>;
  currentPageNumber: number;
  refreshImageRowHighlights(): void;
  readonly overlay: PageOverlay;
  readonly IMAGE_ROTATE_STEP_DEG: 10;
}

/**
 * Builds the rows of the review screen's image list: checkbox, thumbnail, page, name, destination and journal group,
 * and the buttons that turn, edit or prepare a token from the image. Moved out of `ReviewScreen.ts` unchanged; it
 * reaches the screen through `ImageRowsHost`.
 */
export class ImageRows {
  readonly #host: ImageRowsHost;

  constructor(host: ImageRowsHost) {
    this.#host = host;
  }


  buildImageRow(image: CIFImage): HTMLElement {
    const row = document.createElement('div');
    row.className = 'bindery-review-row bindery-image-row';
    row.dataset['imageId'] = image.id;
    if (image.id === this.#host.highlightedImageId) row.classList.add('bindery-row-highlighted');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'bindery-check';
    checkbox.checked = this.#host.selection.isImageSelected(image.id);
    checkbox.addEventListener('change', () => {
      this.#host.selection.setImage(image.id, checkbox.checked);
      void this.#host.refreshHeaderCounts();
    });
    row.appendChild(checkbox);

    // [Redesign 2a] The 36x48 slot is ALWAYS present (even without a
    // thumbnail), so the grid columns (`22px 36px 74px minmax(0,1fr) 148px`)
    // stay identical in every row — VirtualList requires a fixed row
    // height, so a missing element must not change the number of columns.
    const thumbSlot = document.createElement('div');
    thumbSlot.className = 'bindery-row-thumb-slot';
    if (this.#host.data.imageBytesById.has(image.id)) {
      const thumb = document.createElement('img');
      thumb.className = 'bindery-row-thumb';
      thumb.alt = '';
      void this.#host.thumbnails.row(image).then((url) => {
        if (url) thumb.src = url;
      });
      thumb.title = game.i18n!.localize('BINDERY.review.thumbnailOpenTitle' as never);
      // Hovering enlarges the thumbnail for a quick look; clicking opens the
      // full preview window, which also offers the erase tools.
      // The enlarged look needs the picture itself, not the small copy: its URL is made on the first hover.
      thumb.addEventListener('mouseenter', () => {
        const fullUrl = this.#host.thumbnails.full(image.id);
        if (fullUrl) this.#host.showThumbPreview(fullUrl, thumb, image.width, image.height);
      });
      thumb.addEventListener('mouseleave', () => this.#host.hideThumbPreview());
      thumb.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.#host.hideThumbPreview();
        void this.#host.openImageEditor(image);
      });
      thumbSlot.appendChild(thumb);
    }
    row.appendChild(thumbSlot);

    const pageLabel = document.createElement('span');
    pageLabel.className = 'bindery-row-page';
    pageLabel.textContent = pageRef(image.provenance.pageNumber);
    row.appendChild(pageLabel);

    const nameWrap = document.createElement('div');
    nameWrap.className = 'bindery-row-name-wrap';

    // Image name directly editable IN the row — mirrors the
    // pattern from `#buildJournalRow` (there `nameInput` mutates
    // `row.journal.name` directly on the core object). `image.caption` is
    // an ALREADY existing, optional `CIFImage` field (see
    // `packages/core/src/cif/types.ts`) read by `runReviewImport` as an override
    // for the default name (`image.caption?.trim() || "Image p.N"`) — ALL
    // three paths (Scene/Journal/Token) and journal grouping get this name
    // for free, with no extra logic here.
    const defaultImageName = game.i18n!.localize('BINDERY.review.defaultImageName' as never);
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'bindery-row-name-input';
    nameInput.placeholder = `${defaultImageName} ${pageRef(image.provenance.pageNumber)}`;
    nameInput.value = image.caption ?? '';
    nameInput.addEventListener('click', (ev) => ev.stopPropagation());
    nameInput.addEventListener('change', () => {
      image.caption = nameInput.value.trim() || undefined;
    });
    nameWrap.appendChild(nameInput);

    // [User request, "'unknown - 65x115 - undecided (40%)' is completely
    // unnecessary, only the size can stay"] Previously a full description
    // (`targetKind — WxH — classification (confidence%)`) — everything
    // besides the size itself was the classifier's internal jargon,
    // unreadable to the user and useless for deciding on a destination.
    const meta = document.createElement('span');
    meta.className = 'bindery-row-meta';
    meta.textContent = `${image.width}×${image.height}`;
    nameWrap.appendChild(meta);

    // Journal group name — only makes sense for the `journal`
    // destination (see `ReviewSelection.imageJournalGroup`), hence hidden
    // for other destinations instead of removed from the DOM (a simpler
    // visibility toggle below, in the `destSelect` change handler). A third
    // line in `nameWrap` (doc: "keep full per-row editability, don't remove
    // without asking" — see README, so it stays, just visually
    // de-emphasized via `.bindery-row-journal-group` like `meta` above).
    const groupInput = document.createElement('input');
    groupInput.type = 'text';
    groupInput.className = 'bindery-row-journal-group';
    groupInput.placeholder = game.i18n!.localize('BINDERY.review.journalGroupPlaceholder' as never);
    groupInput.value = this.#host.selection.imageJournalGroup(image.id);
    groupInput.addEventListener('click', (ev) => ev.stopPropagation());
    groupInput.addEventListener('change', () => {
      this.#host.selection.setImageJournalGroup(image.id, groupInput.value);
    });
    nameWrap.appendChild(groupInput);

    // The same pattern as `groupInput`
    // above — a third line in `nameWrap`, visible SOLELY for the `token`
    // destination (the `.bindery-image-row` grid has a FIXED number of
    // columns, see `bindery.css`, so a new button must go into the ALREADY
    // existing, flexible `nameWrap` column, not as a new child of `row`).
    // Opens `TokenPrepApp` (background removal/mask/frame); on confirmation
    // it REPLACES the image's bytes/dimensions/format — mirrors
    // `#resizeImage`/`#rotateImage`, see `#prepareToken`. The mechanism for
    // assigning a token to an actor (step 35) doesn't know and doesn't need
    // to know that the bytes come from this panel.
    const prepareTokenBtn = document.createElement('button');
    prepareTokenBtn.type = 'button';
    prepareTokenBtn.className = 'bindery-row-prepare-token-btn';
    prepareTokenBtn.textContent = game.i18n!.localize('BINDERY.review.prepareToken' as never);
    prepareTokenBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void this.#host.prepareToken(image);
    });
    nameWrap.appendChild(prepareTokenBtn);

    row.appendChild(nameWrap);

    // Per-image destination — suggested from `CIFImage.targetKind`
    // [User request, "all images end up in Unassigned, the user assigns
    // manually"] Always `unassigned` by default (see
    // `defaultImageDestination`) — overridable here.
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
    destSelect.value = this.#host.selection.imageDestination(image.id);
    destSelect.addEventListener('click', (ev) => ev.stopPropagation());
    groupInput.style.display = destSelect.value === 'journal' ? '' : 'none';
    prepareTokenBtn.style.display = destSelect.value === 'token' ? '' : 'none';

    destSelect.addEventListener('change', () => {
      const destination = destSelect.value as ImageDestination;
      this.#host.selection.setImageDestination(image.id, destination);
      // `runReviewImport` processes SOLELY
      // selected images (checkbox) — without this, choosing a destination
      // for an image that starts UNCHECKED (EVERY image, see
      // `ReviewSelection.fromDocument` — user request, all images start
      // unchecked) did NOTHING, with no error or warning ("the scene isn't
      // created"). Changing the destination to anything other than
      // "Unassigned" is an unambiguous declaration of intent — select the
      // image right away, so the dropdown and the checkbox don't drift
      // apart into two independent, silent sources of truth.
      const shouldBeSelected = destination !== 'unassigned';
      if (this.#host.selection.isImageSelected(image.id) !== shouldBeSelected) this.#host.selection.setImage(image.id, shouldBeSelected);
      // [User request, Scene/Journal/Token/Unassigned sub-tabs] The image
      // moves to a DIFFERENT destination sub-tab — a full render (instead of
      // the previous surgical update of this one row), so it disappears
      // from the current list and appears in the correct one. `scrollable`
      // (see `PARTS.main` above) protects the list's scroll position despite
      // the full render.
      void this.#host.render();
    });
    row.appendChild(destSelect);

    // [User request, "rotate an already-cropped image — the map covers the
    // whole page, selecting an area would crop it wrong, it's about
    // rotating an ALREADY cropped image"] Rotates the CONTENT ITSELF (the
    // pixels of the already-saved bytes) by 90° — INDEPENDENT of the
    // rotation/resize handles on the page preview
    // (`#renderResizeHandles`/`#resizeImage`), which concern SELECTING the
    // area BEFORE re-cropping from the PDF. Here the PDF is not queried
    // again at all — a pure canvas operation.
    const rotateWrap = document.createElement('div');
    rotateWrap.className = 'bindery-row-rotate';
    const rotateLeftBtn = document.createElement('button');
    rotateLeftBtn.type = 'button';
    rotateLeftBtn.className = 'bindery-row-rotate-btn';
    rotateLeftBtn.textContent = '↺';
    rotateLeftBtn.title = game.i18n!.format('BINDERY.review.rotateImageLeft' as never, { n: String(this.#host.IMAGE_ROTATE_STEP_DEG) });
    rotateLeftBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void this.#host.rotateImage(image, -1);
    });
    rotateWrap.appendChild(rotateLeftBtn);
    const rotateRightBtn = document.createElement('button');
    rotateRightBtn.type = 'button';
    rotateRightBtn.className = 'bindery-row-rotate-btn';
    rotateRightBtn.textContent = '↻';
    rotateRightBtn.title = game.i18n!.format('BINDERY.review.rotateImageRight' as never, { n: String(this.#host.IMAGE_ROTATE_STEP_DEG) });
    rotateRightBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void this.#host.rotateImage(image, 1);
    });
    rotateWrap.appendChild(rotateRightBtn);
    row.appendChild(rotateWrap);

    row.addEventListener('click', (ev) => {
      if (ev.target === checkbox || ev.target === destSelect || ev.target === groupInput || ev.target === nameInput) return;
      this.#host.highlightedImageId = image.id;
      if (this.#host.currentPageNumber === image.provenance.pageNumber) {
        this.#host.refreshImageRowHighlights();
        void this.#host.overlay.redrawOverlay();
      } else {
        this.#host.currentPageNumber = image.provenance.pageNumber;
        void this.#host.render();
      }
    });

    return row;
  }
}

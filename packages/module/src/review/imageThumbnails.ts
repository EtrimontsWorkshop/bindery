/**
 * Object URLs of the review screen's images: a small copy of each for its row in the list, and the image itself where
 * it is needed whole. Pure browser code (no Foundry), owned by `ReviewScreen`, which releases it when it closes.
 */
export class ImageThumbnails {
  /** Long edge of a row's thumbnail, in pixels: twice the size it is shown at, for dense screens. */
  static readonly ROW_THUMB_PX = 160;

  readonly #bytesById: ReadonlyMap<string, { bytes: Uint8Array; format: string }>;
  /** Full-size URLs, made only when one is needed whole: the enlarged preview on hover, the statblock cards. */
  #fullUrls = new Map<string, string>();
  #rowUrls = new Map<string, string>();
  #rowJobs = new Map<string, Promise<string | null>>();
  #disposed = false;

  /** @param bytesById The live map of the review's images: an edit replaces an entry, and `drop()` is called for it. */
  constructor(bytesById: ReadonlyMap<string, { bytes: Uint8Array; format: string }>) {
    this.#bytesById = bytesById;
  }

  /** Forgets every URL made for an image whose bytes have just been replaced (crop, rotation, eraser, token). */
  drop(imageId: string): void {
    for (const urls of [this.#fullUrls, this.#rowUrls]) {
      const url = urls.get(imageId);
      if (url) URL.revokeObjectURL(url);
      urls.delete(imageId);
    }
    // A thumbnail still being made is of the old bytes: `row()` sees it is no longer the current job and drops it.
    this.#rowJobs.delete(imageId);
  }

  /**
   * A small copy of the image for its row in the list. A row is 80 px high, and showing the image itself there made the
   * browser decode every picture at full size (a map is tens of megabytes decoded) each time its row scrolled into view.
   * The small copy is made once, off screen, and kept; a picture that is small already is used as it is.
   */
  row(image: { id: string; width: number; height: number }): Promise<string | null> {
    const cached = this.#rowUrls.get(image.id);
    if (cached) return Promise.resolve(cached);
    const running = this.#rowJobs.get(image.id);
    if (running) return running;
    const entry = this.#bytesById.get(image.id);
    if (!entry) return Promise.resolve(null);

    let job: Promise<string | null> | undefined = undefined;
    job = (async () => {
      const mime = entry.format === 'png' ? 'image/png' : 'image/webp';
      const source = new Blob([new Uint8Array(entry.bytes)], { type: mime });
      let blob = source;
      const size = ImageThumbnails.ROW_THUMB_PX;
      if (Math.max(image.width, image.height) > size * 2) {
        try {
          const bitmap = await createImageBitmap(source, image.width >= image.height ? { resizeWidth: size, resizeQuality: 'medium' } : { resizeHeight: size, resizeQuality: 'medium' });
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
          bitmap.close();
          blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
        } catch (err) {
          // The picture itself still shows (as before); only the saving is lost.
          console.warn('Bindery | making a thumbnail failed, the full image is shown instead:', err);
        }
      }
      // Replaced or released while this was being made: nothing to keep.
      if (this.#disposed || this.#rowJobs.get(image.id) !== job) return null;
      const url = URL.createObjectURL(blob);
      this.#rowJobs.delete(image.id);
      this.#rowUrls.set(image.id, url);
      return url;
    })();
    this.#rowJobs.set(image.id, job);
    return job;
  }

  /** The image itself as a URL (made on first use and kept), or `null` when it has no bytes. */
  full(imageId: string): string | null {
    const cached = this.#fullUrls.get(imageId);
    if (cached) return cached;
    const entry = this.#bytesById.get(imageId);
    if (!entry) return null;
    const mime = entry.format === 'png' ? 'image/png' : 'image/webp';
    const url = URL.createObjectURL(new Blob([new Uint8Array(entry.bytes)], { type: mime }));
    this.#fullUrls.set(imageId, url);
    return url;
  }

  /** Releases every URL; a thumbnail that finishes afterwards keeps nothing. */
  dispose(): void {
    this.#disposed = true;
    for (const urls of [this.#fullUrls, this.#rowUrls]) {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    }
    this.#rowJobs.clear();
  }
}

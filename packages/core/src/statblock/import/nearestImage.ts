import { rectGapDistance, type Rect } from '../../geometry.js';
import type { DetectionRegion } from '../pdf/types.js';

/** One candidate image the "nearest image" heuristic can point at — deliberately NOT `ImageEntry` (`inventory/imageRegistry.ts`, which carries pdf.js-adjacent bookkeeping this module has no business depending on); the caller (module layer) adapts whatever it already extracted into this minimal shape. */
export interface ImageCandidate {
  id: string;
  pageNumber: number;
  bbox: Rect;
}

/**
 * [Task 4] "Serwis przypisania obrazu... heurystyka najbliższy obraz" — pure
 * geometry, no I/O: picks the `ImageCandidate` with the smallest
 * `rectGapDistance` (Task-established helper, `geometry.ts`) to the
 * instance's OWN first region (same "first region is where the statblock
 * starts" precedent `extractStatblockInstance` already uses), considering
 * only images on the SAME page as that region — an image on a different
 * page is never "nearest" no matter how the raw numbers compare, since page
 * coordinate spaces aren't comparable. Returns `undefined` when there is no
 * image on that page at all; turning an id into an actual usable path (and
 * letting the user override it) is the module layer's job — this function
 * only ever picks a DEFAULT.
 */
export function findNearestImage(regions: readonly DetectionRegion[], images: readonly ImageCandidate[]): string | undefined {
  const anchor = regions[0];
  if (!anchor) return undefined;

  let best: ImageCandidate | undefined;
  let bestDistance = Infinity;
  for (const image of images) {
    if (image.pageNumber !== anchor.pageNumber) continue;
    const distance = rectGapDistance(anchor.bbox, image.bbox);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = image;
    }
  }
  return best?.id;
}

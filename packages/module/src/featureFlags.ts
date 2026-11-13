/**
 * Core's auto-detection of "this is a whole
 * scene/map" (`doc.scenes`, CIFScene) and "this is the full book text as a
 * journal" (`doc.journals`, CIFJournal from the PDF bookmark hierarchy) is
 * disabled "for now" — a flag instead of removing the code, so it can be
 * restored easily later. The "Scenes"/"Journals" tabs are hidden in
 * `review-screen.hbs`; the same flag skips their creation in `runReviewImport`
 * (without this, images used by `doc.scenes` would be "used" — see
 * `usedImageIds` — despite the hidden tab, and would NOT reach the Images
 * tab as a normal Destination choice). The same images are still available
 * in the Images tab with a Scene/Journal Destination, handled per-image
 * instead of through this pipeline.
 *
 * While it is off the analysis is also told not to build the journals at all (`includeJournals` in `api.ts`): nothing
 * would read them, and laying the whole book out as HTML is work for every import. It lives in a file of its own
 * because `api.ts` belongs to the small bundle loaded at world startup, and the review screen does not.
 */
export const SCENES_JOURNALS_FROM_CIF_ENABLED = false;

/**
 * Maps -> scenes (Step 8 Z5, MDD phase 7). Scene dimensions come DIRECTLY
 * from the bitmap (`packages/core` has already decoded the image and knows
 * `width`/`height`) — zero automatic grid detection (out of MVP scope, per
 * the brief).
 *
 * [Step 8, discovery #1] Foundry v14 rebuilt scene backgrounds around a
 * multi-level model (`Level` — an embedded document, each with its own
 * `background.src`) — the OLD, flat `Scene#background.src` field (v10-v13)
 * is today ONLY a backward-compatibility getter (`BaseScene.shimData`,
 * `scene.mjs`), reconstructed from the FIRST Level, WITHOUT a matching
 * setter — `Scene.create({background: {src}})` does NOT work in v14
 * (silently ignored, the background stays empty). Verified directly in the
 * source (`resources/app/common/documents/{scene,level}.mjs`), not guessed
 * — per CLAUDE.md: "always verify against the actually installed version".
 *
 * [Step 8, discovery #2 — caught empirically on a real Foundry instance,
 * not in the source code] `Scene.create()` ALWAYS creates one DEFAULT,
 * EMPTY Level with the fixed ID `defaultLevel0000`
 * (`BaseScene.metadata.defaultLevelId`, `scene.mjs`) and sets `initialLevel`
 * to that very level. The first version of this code called
 * `scene.createEmbeddedDocuments('Level', [...])`, which ADDED A SECOND,
 * NEW Level with the real background — the scene was created correctly,
 * but STILL showed the empty default level (because `initialLevel` was
 * never changed), and the new level with the image was "hidden" in the
 * background. Symptom: "the scene gets created, but without the image" —
 * confirmed by directly reading the world's LevelDB database
 * (`worlds/<world>/data/scenes/*.log`): both `Level` entities existed, but
 * `initialLevel` pointed at the EMPTY one. Fix: UPDATE (don't create a new)
 * default Level under its fixed ID — one level, the correct background,
 * `initialLevel` already points to it automatically.
 */

const DEFAULT_LEVEL_ID = 'defaultLevel0000';

export interface CreateSceneFromImageInput {
  name: string;
  imagePath: string;
  width: number;
  height: number;
  grid: { size: number; offsetX: number; offsetY: number };
  /** [Step 11 Z6] `Scene` folder id (see `ensureFolder.ts`) — `undefined` = root. */
  folder?: string;
}

export async function createSceneFromImage(input: CreateSceneFromImageInput): Promise<foundry.documents.BaseScene> {
  const sceneData = {
    name: input.name,
    width: input.width,
    height: input.height,
    padding: 0,
    folder: input.folder,
    grid: {
      size: input.grid.size,
    },
    // [Step 17, bug reported live] `grid.offsetX`/`offsetY` (chosen manually
    // in GridPicker or suggested by `detectGrid.ts`) are DELIBERATELY NOT
    // passed to `shiftX`/`shiftY` — verified directly on a live Foundry
    // instance (`scene.getDimensions()`): `padding:0` gives
    // `dimensions.x=0`, so `sceneX = -shiftX` — ANY nonzero value shifts the
    // `sceneRect` (the scene's active/interactive area) relative to the
    // canvas by that many pixels, cutting off exactly that much from the
    // OPPOSITE edge of the image, outside the scene area. This is NOT a
    // cosmetic shift of the grid lines (as the name might suggest) — it's a
    // permanent shift of the whole scene boundary. This same mechanism was
    // already fixed once (Step 16, user confirmed "Looks OK now" after
    // zeroing it out) via the incorrect use of the OLD, stale
    // `lastGridConfig` value — GridPicker/auto-detection from this step
    // introduced a NEW offset value, correct for THIS image, but being
    // subject to EXACTLY THE SAME Foundry mechanism means the regression
    // came back with an identical symptom ("scene is cut off"), regardless
    // of the offset now being computed correctly. `shiftX`/`shiftY` stay at
    // their default of 0 (not set at all) — aligning the grid to specific
    // image pixels (beyond `grid.size`) is a job for Foundry's own
    // "Configure Grid" tool AFTER scene creation, which deliberately accepts
    // this same trade-off (shift = lost edge) as an interactive GM decision,
    // not a silent side effect of import.
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SceneCls = (foundry.documents as any).Scene ?? (globalThis as any).Scene;
  const scene = await SceneCls.create(sceneData);
  if (!scene) {
    throw new Error('Bindery | failed to create the scene');
  }

  // [discovery #2 above] UPDATE the default Level (it already exists,
  // `initialLevel` already points to it) — do NOT create a second one.
  // `updateEmbeddedDocuments` with a matching `_id` modifies the existing
  // embedded collection entry.
  await scene.updateEmbeddedDocuments('Level', [
    {
      _id: DEFAULT_LEVEL_ID,
      name: input.name,
      background: { src: input.imagePath },
    },
  ]);

  return scene;
}

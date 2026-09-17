import type { CIFActor, CIFJournal, CIFScene } from './types.js';
import type { LocalizableMessage } from '../localizableMessage.js';

/**
 * [Step 19 Z1] System adapter contract — exactly per MDD §5.6. Lives in
 * `packages/core` (not `packages/module`) because it is ONLY a
 * type-contract, generic with respect to the target system — concrete
 * adapter implementations (e.g. CoC7) are Foundry/system-specific and live
 * in `packages/module/src/adapters/` (MDD §7, repository structure).
 *
 * **Adapter contract (MDD §5.6):**
 * 1. Never throws — errors are reported via `issues`.
 * 2. Never loses data — unrecognized fields go into `notes`, which end up
 *    in the actor's description.
 * 3. Never converts values between game lines (§6.6).
 * 4. Is a PURE function — no side effects, no document creation. Documents
 *    are created by the module layer (`packages/module/documents/`), NOT
 *    the adapter.
 */

export type ContentKind = 'actors' | 'items' | 'journals' | 'scenes' | 'images';

/** [Step 27 Z1] `message: string` removed — see `LocalizableMessage`. */
export interface AdapterIssue extends LocalizableMessage {
  severity: 'info' | 'warning' | 'error';
}

export interface AdapterResult<T> {
  data: T;
  /** What the adapter did with fields it wasn't able to map. */
  notes: LocalizableMessage[];
  issues: AdapterIssue[];
}

export interface ImportContext {
  folderId: string | null;
  imagePathResolver: (imageRef: string) => string | null;
  language: string | null;
  profileId: string | null;
  /**
   * [Step 35 Z2] The id of the image (`CIFImage.id`) selected by the user
   * in the review screen as the token/portrait for THIS SPECIFIC actor —
   * ONLY this id, not the path (which is resolved only by
   * `imagePathResolver`, DIRECTLY in the adapter, so that `fromActor`
   * remains a pure function — see the file header). `null`/unset = the
   * author chose "none" or hasn't configured the assignment yet. Step 35
   * product decision: zero automatic matching (`images.associateWithEntity`,
   * §5.5, remains UNUSED) — ONLY an explicit choice from the list in the
   * review screen.
   */
  tokenImageRef?: string | null;
  /** [Step 35 Z2] Like `tokenImageRef`, but for the portrait — "One selection sets both" (P1 product decision): the review screen copies this same value from `tokenImageRef` by default, unless the author explicitly separated them under "Advanced Settings". */
  portraitImageRef?: string | null;
}

export interface SystemAdapter {
  readonly id: string;
  readonly systemId: string;
  /** semver range, e.g. ">=7.0.0 <9". */
  readonly systemVersion: string;
  /** gameLine values accepted by this adapter; `'*'` = universal fallback. */
  readonly accepts: readonly string[];
  readonly produces: readonly ContentKind[];
  readonly label: string;

  /** Optional, shallow validation before full mapping. */
  validate?(cif: CIFActor): AdapterIssue[];

  fromActor(cif: CIFActor, ctx: ImportContext): AdapterResult<object>;
  fromScene?(cif: CIFScene, ctx: ImportContext): AdapterResult<object>;
  fromJournal?(cif: CIFJournal, ctx: ImportContext): AdapterResult<object>;
}

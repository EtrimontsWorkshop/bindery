/**
 * [Step 44 Z1, "public release — the first release covers images only"] One
 * flag, not scattered conditionals — a product decision: statblocks,
 * Profile Studio and the `playerCharacter` route stay in a working-but-unreleased
 * state (they work, but require a profile, which we don't ship
 * for commercial rulebooks — R3). Option B (hide behind a flag, do NOT
 * remove the code) — the same pattern as `provides` in step 37: removing the
 * code would immediately cause branches to diverge, and an empty Actors tab
 * teaches the user that the interface is lying.
 *
 * The code/schema/adapter/pattern engine and routes remain UNTOUCHED — this
 * flag controls ONLY visibility in the UI: the Profile Studio entry point
 * (`settings.ts`), the actor-profile loading section (`ImportWizard.ts`),
 * the Actors tab in the review screen (`ReviewScreen.ts`). Everything else
 * (folders/actor counters in the target screen) already degrades to zero on
 * its own, because `actorCount`/`hasActorProfile` always come out
 * empty/false anyway when a profile can never be loaded through the UI —
 * zero extra conditionals there.
 *
 * RESTORE CONDITION: profiles for commercial rulebooks supplied by the
 * community (R3 allows this — community-hosted, never linked from this
 * repo) OR a built-in profile for free content (e.g.
 * `coc7-quickstart-en.json`, already exists). Once one of these conditions
 * is met, restoring this is a single value change below to `true`.
 */
export const STATBLOCKS_ENABLED = false;

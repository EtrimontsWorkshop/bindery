const { ApplicationV2 } = foundry.applications.api;

/**
 * [Step 22 Z1, I3] `game.settings.registerMenu` requires the `type` value to
 * be SYNCHRONOUSLY available already at `registerSettings()` (the `init`
 * hook, world startup) — importing the real `ProfileStudio` there directly
 * (the way `ImportWizard` is) would force Rollup to pull its entire code
 * (and everything it statically imports from `../api.js`) into a chunk
 * loaded EAGERLY on EVERY world startup — exactly the risk I3 that the step
 * 22 brief explicitly forbids ("The Studio must not touch that [the <40KB
 * budget]. Load it via dynamic import(), exactly like pdf.js.").
 *
 * Verified directly against the installed Foundry version
 * (`client/applications/settings/config.mjs`, `#onOpenSubmenu`): the menu
 * button does ONLY `const app = new menu.type(); await app.render(true);`
 * — the class is CONSTRUCTED and RENDERED only AFTER the click, never
 * before. This thin "launcher" is therefore the only class actually loaded
 * statically (cheap — zero import of `@bindery/core`/`api.js`) — its OWN
 * `render()` is REPLACED by a dynamic `import()` of the real `ProfileStudio`
 * only at that point, never before. This object itself never renders its
 * own window.
 */
export class ProfileStudioLauncher extends ApplicationV2 {
  static override DEFAULT_OPTIONS = {
    id: 'bindery-profile-studio-launcher',
  };

  // Override of the base `render` signature (generics parameterized by the
  // base class instance, see the analogous comment near `_onRender` in
  // ImportWizard.ts/ReviewScreen.ts) — this object NEVER invokes the real
  // ApplicationV2 render cycle, it only forwards the call.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override async render(..._args: any[]): Promise<this> {
    const { ProfileStudio } = await import('./ProfileStudio.js');
    await new ProfileStudio().render(true);
    return this;
  }
}

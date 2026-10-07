const { ApplicationV2 } = foundry.applications.api;

/**
 * Stand-in registered with `game.settings.registerMenu` (which instantiates its `type` and calls `render`): it is part of the EAGER world-startup bundle, so it stays tiny and loads the real `StatblockProfilesApp` only when the menu button is actually pressed (`check:size`). It never renders anything itself.
 */
export class StatblockProfilesLauncher extends ApplicationV2 {
  override async render(options?: object | boolean): Promise<this> {
    const { StatblockProfilesApp } = await import('./StatblockProfilesApp.js');
    await new StatblockProfilesApp().render(typeof options === 'boolean' ? { force: options } : options);
    return this;
  }
}

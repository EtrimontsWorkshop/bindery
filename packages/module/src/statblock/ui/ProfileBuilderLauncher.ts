const { ApplicationV2 } = foundry.applications.api;

/**
 * Stand-in registered with `game.settings.registerMenu` (which instantiates its `type` and calls `render`): it is part of the EAGER world-startup bundle, so it stays tiny and loads the real `ProfileBuilderApp` — and with it all of the builder's UI code — only when the menu button is actually pressed (risk I3/`check:size`). It never renders anything itself.
 */
export class ProfileBuilderLauncher extends ApplicationV2 {
  override async render(options?: object | boolean): Promise<this> {
    const { ProfileBuilderApp } = await import('./ProfileBuilderApp.js');
    await new ProfileBuilderApp().render(typeof options === 'boolean' ? { force: options } : options);
    return this;
  }
}

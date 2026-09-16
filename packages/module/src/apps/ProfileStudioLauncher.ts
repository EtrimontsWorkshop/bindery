const { ApplicationV2 } = foundry.applications.api;

/**
 * [KROK-22 Z1, I3] `game.settings.registerMenu` wymaga wartosci `type`
 * SYNCHRONICZNIE dostepnej juz przy `registerSettings()` (hook `init`,
 * start swiata) — zaimportowanie prawdziwego `ProfileStudio` tam wprost
 * (tak jak `ImportWizard`) zmusilby Rollupa do wciagniecia calego jego kodu
 * (i wszystkiego, co on statycznie importuje z `../api.js`) do chunka
 * ladowanego EAGERLY przy KAZDYM starcie swiata — dokladnie ryzyko I3, ktore
 * brief kroku 22 wprost zakazuje ("Studio nie moze tego ruszyc [budzetu
 * <40KB]. Ladowane dynamicznym import(), dokladnie jak pdf.js.").
 *
 * Zweryfikowane wprost w zainstalowanej wersji Foundry
 * (`client/applications/settings/config.mjs`, `#onOpenSubmenu`): przycisk
 * menu robi WYLACZNIE `const app = new menu.type(); await app.render(true);`
 * — klasa jest KONSTRUOWANA i RENDEROWANA dopiero PO kliknieciu, nigdy
 * wczesniej. Ten cienki "launcher" jest wiec jedyna klasa faktycznie
 * zaladowana statycznie (tania — zero importu `@bindery/core`/`api.js`) —
 * jego WLASNY `render()` PODMIENIA sie na dynamiczny `import()` prawdziwego
 * `ProfileStudio` dopiero w tym momencie, nigdy wczesniej. Ten obiekt sam w
 * sobie nigdy nie renderuje wlasnego okna.
 */
export class ProfileStudioLauncher extends ApplicationV2 {
  static override DEFAULT_OPTIONS = {
    id: 'bindery-profile-studio-launcher',
  };

  // Nadpisanie sygnatury bazowej `render` (generyki parametryzowane
  // instancja klasy bazowej, patrz analogiczny komentarz przy `_onRender` w
  // ImportWizard.ts/ReviewScreen.ts) — ten obiekt NIGDY nie wywoluje
  // prawdziwego cyklu renderowania ApplicationV2, wylacznie przekazuje dalej.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override async render(..._args: any[]): Promise<this> {
    const { ProfileStudio } = await import('./ProfileStudio.js');
    await new ProfileStudio().render(true);
    return this;
  }
}

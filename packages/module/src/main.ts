import { buildAPI } from './api.js';
import { MODULE_ID, registerSettings } from './settings.js';

Hooks.once('init', () => {
  registerSettings();
});

Hooks.once('ready', async () => {
  // Wywolywane w hooku 'ready' — game.modules/game.settings/game.i18n sa juz
  // zainicjalizowane na tym etapie cyklu zycia Foundry.
  const mod = game.modules!.get(MODULE_ID);
  if (!mod) return;

  mod.api = buildAPI(mod.version ?? '0.0.0');

  if (game.user?.isGM && !game.settings!.get(MODULE_ID, 'legalNoticeAcknowledged')) {
    await foundry.applications.api.DialogV2.prompt({
      window: { title: 'BINDERY.wizard.title' },
      content: `<p>${game.i18n!.localize('BINDERY.legal.notice')}</p>`,
      ok: { label: 'COMMON.Confirm' },
      rejectClose: false,
    });
    await game.settings!.set(MODULE_ID, 'legalNoticeAcknowledged', true);
  }
});

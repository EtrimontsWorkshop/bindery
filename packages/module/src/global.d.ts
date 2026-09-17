import type { BinderyAPI } from './api.js';
import type { ImportTargets, LastActorProfile, TokenPrepDefaults } from './settings.js';

declare module 'fvtt-types/configuration' {
  interface ModuleConfig {
    bindery: {
      api: BinderyAPI;
    };
  }

  interface RequiredModules {
    bindery: true;
  }

  interface SettingConfig {
    'bindery.legalNoticeAcknowledged': boolean;
    'bindery.uploadPath': string;
    'bindery.lastGridConfig': { size: number; offsetX: number; offsetY: number };
    'bindery.importTargets': ImportTargets;
    'bindery.lastActorProfile': LastActorProfile;
    'bindery.tokenPrepDefaults': TokenPrepDefaults;
  }
}

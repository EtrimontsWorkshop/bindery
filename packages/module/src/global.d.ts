import type { StatblockProfile } from '@bindery/core';
import type { BinderyAPI } from './api.js';
import type { ImportTargets, TokenPrepDefaults } from './settings.js';

declare module 'fvtt-types/configuration' {
  interface ModuleConfig {
    'bindery-pdf-importer': {
      api: BinderyAPI;
    };
  }

  interface RequiredModules {
    'bindery-pdf-importer': true;
  }

  interface SettingConfig {
    'bindery-pdf-importer.legalNoticeAcknowledged': boolean;
    'bindery-pdf-importer.uploadPath': string;
    'bindery-pdf-importer.lastGridConfig': { size: number; offsetX: number; offsetY: number };
    'bindery-pdf-importer.importTargets': ImportTargets;
    'bindery-pdf-importer.tokenPrepDefaults': TokenPrepDefaults;
    'bindery-pdf-importer.statblockProfiles': Record<string, StatblockProfile>;
  }
}

/**
 * Profile-based statblock import (the profiles window, the public statblock API and the review screen's Statblocks tab) is built and tested, but not part of the current release, so it is OFF in every normal build. Build with the environment variable `BINDERY_STATBLOCKS=1` to switch it on (for example `BINDERY_STATBLOCKS=1 npm run build`): it registers the "Statblock profiles" settings button, exposes `api.statblock` and shows the Statblocks tab. Nothing else depends on it — PDF image import works the same either way.
 */
declare const __BINDERY_STATBLOCKS__: boolean;

export const STATBLOCK_IMPORT_ENABLED: boolean = __BINDERY_STATBLOCKS__;

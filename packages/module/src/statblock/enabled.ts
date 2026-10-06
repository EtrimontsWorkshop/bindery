/**
 * Profile-based statblock import (the profile builder and the review screen's Statblocks tab) is built and tested, but not part of the current release. Flip this to `true` to switch both on again: it registers the "Statblock profile builder" settings button and shows the Statblocks tab. Nothing else in the module depends on it — PDF image import works the same either way.
 */
export const STATBLOCK_IMPORT_ENABLED = false;

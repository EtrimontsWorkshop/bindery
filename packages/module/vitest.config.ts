import { defineConfig } from 'vitest/config';

// Unit tests of the Foundry layer: the parts that do not need a running Foundry. Each test stubs the few Foundry
// globals (`game`, `foundry`, `ui`) the code under test touches, and mocks the module's own files that would pull
// in ApplicationV2 at import time. Kept apart from `vite.config.ts`, which builds the module (static copies,
// manifest rewrite) and has nothing to do with tests.
export default defineConfig({
  define: {
    __BINDERY_STATBLOCKS__: 'true',
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});

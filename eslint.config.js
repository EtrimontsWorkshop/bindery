// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'spike/**',
      'samples/**',
      // Build artifacts synchronized into the repo root (this directory is also the module folder of
      // the local Foundry install) — the source is packages/module/*.
      'lib/**',
      'scripts/**',
      'styles/**',
      'templates/**',
      // A design prototype delivered as an HTML/JS reference (not production code to copy) — never
      // imported or built by the module, so it must not block `npm run lint` with its own `no-undef`
      // errors (browser globals without `/* global */`, written to be opened directly in a browser,
      // not for this repo's ESLint).
      'design_handoff_bindery_redesign/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // A "_" prefix marks a deliberately unused parameter (e.g. conforming to an interface
    // signature) — a common convention, not an error.
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Node CLI scripts (check-boundary, check-size, package-module) — not browser/core code.
    files: ['**/scripts/**/*.mjs', 'tools/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // The Foundry layer (packages/module) — browser code + Foundry's global API (the types come
    // from fvtt-types, but ESLint needs its own list of globals for the no-undef rule, because it
    // doesn't read .d.ts files).
    files: ['packages/module/src/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
        game: 'readonly',
        Hooks: 'readonly',
        foundry: 'readonly',
        CONFIG: 'readonly',
        ui: 'readonly',
        canvas: 'readonly',
      },
    },
  },
  {
    // Fixture generator and self-check harness — heavy duck-typing against pdfjs-dist (generic/
    // incomplete types). This is test infrastructure, not production code of packages/core/src.
    files: ['packages/core/test/synth/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // packages/core MUST NOT reference Foundry globals or import anything from packages/module.
    // See packages/core/scripts/check-boundary.mjs for the second-level check (a scan of the built
    // bundle), because lint can be bypassed with globalThis['game'] etc. — the bundle scan has the
    // last word.
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'game', message: 'packages/core must not know Foundry' },
        { name: 'ui', message: 'packages/core must not know Foundry' },
        { name: 'canvas', message: 'packages/core must not know Foundry' },
        { name: 'Hooks', message: 'packages/core must not know Foundry' },
        { name: 'foundry', message: 'packages/core must not know Foundry' },
        { name: 'CONFIG', message: 'packages/core must not know Foundry' },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/packages/module/**', '@bindery/module', '@bindery/module/*'],
              message: 'packages/core must not import anything from packages/module',
            },
          ],
        },
      ],
    },
  },
);

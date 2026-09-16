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
      // Artefakty builda zsynchronizowane do korzenia repo (ten katalog jest
      // tez folderem modulu lokalnej instalacji Foundry) — zrodlo to packages/module/*.
      'lib/**',
      'scripts/**',
      'styles/**',
      'templates/**',
      // [redesign 2a] Prototyp projektowy dostarczony jako referencja HTML/JS
      // (design_handoff_bindery_redesign/README.md: "nie kod produkcyjny do
      // skopiowania") — nigdy nie jest importowany ani budowany przez modul,
      // wiec nie powinien blokowac `npm run lint` wlasnymi bledami `no-undef`
      // (globalne przegladarkowe API bez `/* global */`, pisane pod otwarcie
      // bezposrednio w przegladarce, nie pod ESLint tego repo).
      'design_handoff_bindery_redesign/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Prefiks "_" oznacza swiadomie nieuzywany parametr (np. zgodnosc z sygnatura
    // interfejsu) — konwencja powszechna, nie blad.
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Skrypty Node CLI (check-boundary, check-size, package-module) — nie kod przegladarki/core.
    files: ['**/scripts/**/*.mjs', 'tools/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Warstwa Foundry (packages/module) — kod przegladarki + globalne API Foundry
    // (typy pochodza z fvtt-types, ale ESLint sam potrzebuje wlasnej listy globali
    // do reguly no-undef, bo nie czyta plikow .d.ts).
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
    // Generator fixture'ow i harness samokontroli (KROK-3-fixtures.md) — duck-typing
    // intensywny wobec pdfjs-dist (typy generyczne/niepelne). "Struktura ma znaczenie,
    // testy generatora — nie" (KROK-3-fixtures.md) — to jest infrastruktura testowa,
    // nie kod produkcyjny packages/core/src.
    files: ['packages/core/test/synth/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Bramka A1 / ryzyko I2: packages/core NIE MOZE odwolywac sie do globali Foundry
    // ani importowac niczego z packages/module. Zobacz packages/core/scripts/check-boundary.mjs
    // dla weryfikacji drugiego stopnia (skan zbudowanego bundla), bo lint mozna ominac
    // globalThis['game'] itp. — bundle-scan jest ostatecznym slowem.
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'game', message: 'packages/core nie moze znac Foundry (zalozenie A1)' },
        { name: 'ui', message: 'packages/core nie moze znac Foundry (zalozenie A1)' },
        { name: 'canvas', message: 'packages/core nie moze znac Foundry (zalozenie A1)' },
        { name: 'Hooks', message: 'packages/core nie moze znac Foundry (zalozenie A1)' },
        { name: 'foundry', message: 'packages/core nie moze znac Foundry (zalozenie A1)' },
        { name: 'CONFIG', message: 'packages/core nie moze znac Foundry (zalozenie A1)' },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/packages/module/**', '@bindery/module', '@bindery/module/*'],
              message: 'packages/core nie moze importowac niczego z packages/module (zalozenie A1)',
            },
          ],
        },
      ],
    },
  },
);

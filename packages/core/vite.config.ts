import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: () => 'index.js',
    },
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      // pdfjs-dist stays external — the consuming module (packages/module) loads it with a dynamic
      // import() separately, core must not bundle it in.
      external: ['pdfjs-dist/legacy/build/pdf.mjs'],
      output: {
        // CRITICAL: without this Rollup leaves the bare specifier 'pdfjs-dist/legacy/build/pdf.mjs' in
        // the built code. It works in Node (resolution through node_modules), but in a browser (Foundry)
        // it is invalid ESM syntax — "Failed to resolve module specifier". Found in a live Foundry, not
        // in Node/Vitest tests.
        // A path relative to dist/lib/core/index.js (where this file actually lands in the module),
        // ultimately dist/lib/pdf.mjs (copied in the module's vite.config next to pdf.worker.mjs).
        paths: {
          'pdfjs-dist/legacy/build/pdf.mjs': '../pdf.mjs',
        },
      },
    },
  },
});

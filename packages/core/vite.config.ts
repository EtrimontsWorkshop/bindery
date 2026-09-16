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
      // pdfjs-dist zostaje zewnetrzne — modul-konsument (packages/module) laduje je
      // dynamicznym import() osobno (ryzyko I3), core nie ma go bundlowac na sztywno.
      external: ['pdfjs-dist/legacy/build/pdf.mjs'],
      output: {
        // KRYTYCZNE (Z7): bez tego Rollup zostawia goly specyfikator
        // 'pdfjs-dist/legacy/build/pdf.mjs' w zbudowanym kodzie. W Node dziala
        // (rozwiazanie przez node_modules), ale w przegladarce (Foundry) to
        // nieprawidlowa skladnia ESM — "Failed to resolve module specifier".
        // Wykryte na zywym Foundry, nie w testach Node/Vitest.
        // Sciezka wzgledna do dist/lib/core/index.js (gdzie ten plik faktycznie
        // laduje w module), docelowo dist/lib/pdf.mjs (kopiowane w vite.config
        // modulu obok pdf.worker.mjs).
        paths: {
          'pdfjs-dist/legacy/build/pdf.mjs': '../pdf.mjs',
        },
      },
    },
  },
});

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

/**
 * The entry script (`esmodules` in `module.json`) and the stylesheet carry the module version in
 * their FILE NAME (`bindery-<version>.js`, `bindery-<version>.css`). Rollup only hashes
 * dependently-loaded chunks (`ReviewScreen-*.js` etc.), never the main entry file, and a browser
 * does not always re-download a file whose name is unchanged — after an update the user could
 * keep running the old code from cache, with no error or warning.
 *
 * A query parameter (`bindery.js?v=...`) does not work: Foundry validates every `esmodules`
 * entry on the SERVER, before any HTML is rendered, by checking that the file exists on disk
 * (`PackageAssetField`, `mustExist`). A relative path with a query string is not an absolute
 * URL, so the whole string — including `?v=...` — is looked up as a literal file name and
 * reported as "does not exist". Putting the version into the file name itself avoids that: the
 * file really exists, and the browser fetches a new URL on every version bump.
 *
 * The version comes ONLY from the `version` field of `packages/module/module.json` (the single
 * source of truth), read once here and used both for the output file names and to rewrite the
 * `esmodules`/`styles` entries of the already-copied `dist/module.json` (the source
 * `module.json` keeps the plain names). The rewrite runs in `closeBundle`, registered AFTER
 * `viteStaticCopy` in `plugins`, so the copy of `module.json` is already on disk when it is read.
 *
 * `tools/check-size.mjs` reads the real file name from `dist/module.json`'s `esmodules[0]`
 * instead of assuming one, so this keeps working across version bumps.
 */
const manifestVersion = (JSON.parse(readFileSync(join(import.meta.dirname, 'module.json'), 'utf8')) as { version: string }).version;
const esmoduleFileName = `scripts/bindery-${manifestVersion}.js`;
// `styles/bindery.css` gets the same versioned name as the script, for the same browser-cache
// reason — a CSS change could otherwise look like it "doesn't work" while the code on disk was already correct.
const stylesFileName = `bindery-${manifestVersion}.css`;

function fixManifestAssetPaths(): Plugin {
  return {
    name: 'bindery-fix-manifest-asset-paths',
    closeBundle() {
      const manifestPath = join(import.meta.dirname, 'dist', 'module.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { esmodules: string[]; styles: string[] };
      manifest.esmodules = manifest.esmodules.map(() => esmoduleFileName);
      manifest.styles = manifest.styles.map(() => `styles/${stylesFileName}`);
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    },
  };
}

// The build output (dist/) is a self-contained, deployable Foundry module folder: module.json at
// the top, scripts/, styles/, lang/, templates/, lib/ (pdf.js assets). CI packs dist/** straight
// into module.zip; for local testing dist/ is synced into the repo root by
// tools/sync-local-module.mjs, because the repo directory IS the module folder of the local
// Foundry install.
export default defineConfig({
  // Statblock import is switched off in every normal build (and so in every release). Set
  // `BINDERY_STATBLOCKS=1` for the build to switch it on, e.g. to try it in a local Foundry:
  // `BINDERY_STATBLOCKS=1 npm run build`. See `src/statblock/enabled.ts`.
  define: {
    __BINDERY_STATBLOCKS__: JSON.stringify(process.env['BINDERY_STATBLOCKS'] === '1'),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: 'src/main.ts',
      formats: ['es'],
      fileName: () => esmoduleFileName,
    },
    rollupOptions: {
      // pdf.js is NEVER bundled here — @bindery/core imports it dynamically at runtime (lazy loading).
      // It must stay external here too, otherwise Vite would pull it into the main chunk and defeat the
      // lazy loading.
      external: ['pdfjs-dist/legacy/build/pdf.mjs', '@bindery/core'],
      output: {
        // @bindery/core is external, but at runtime Foundry loads it through a dynamic
        // import('@bindery/core') — that specifier must be redirected to the real path in dist/lib/core/.
        paths: {
          // Relative to dist/scripts/bindery-<version>.js (where this code actually loads in the browser),
          // not to the sources. dist/lib/core/index.js is copied there by viteStaticCopy below.
          '@bindery/core': '../lib/core/index.js',
        },
        // `ReviewScreen` is imported dynamically (to keep the world-startup budget < 40KB), so Rollup would
        // by default create extra chunk files in the ROOT of `dist/`, outside `dist/scripts/`.
        // `sync-local-module.mjs` copies the whole `dist/`, so those chunks would land in the repo root,
        // where ESLint's ignores (which assume all JS lives under `scripts/`) don't cover them. Forcing ALL
        // chunks under `scripts/` fixes it at the source instead of adding another ignore pattern.
        chunkFileNames: 'scripts/[name]-[hash].js',
      },
    },
  },
  plugins: [
    viteStaticCopy({
      // By default the plugin keeps the glob's full relative path under dest (e.g. dist/lang/lang/en.json) —
      // `rename: { stripBase: true }` gives a flat copy.
      targets: [
        { src: 'module.json', dest: '.', rename: { stripBase: true } },
        { src: 'lang/*.json', dest: 'lang', rename: { stripBase: true } },
        { src: 'styles/bindery.css', dest: 'styles', rename: { stripBase: true, name: stylesFileName } },
        { src: 'templates/*.hbs', dest: 'templates', rename: { stripBase: true } },
        // Fonts are vendored locally (Caprasimo/Figtree/JetBrains Mono): the window must work offline,
        // with no hard runtime dependency on Google Fonts (see the comment at @font-face in bindery.css).
        { src: 'fonts/*.woff2', dest: 'fonts', rename: { stripBase: true } },
        // The SIL OFL 1.1 license texts for the three font families above must go through the SAME copy
        // step as the .woff2 files, otherwise `tools/sync-local-module.mjs` (which deletes and recreates
        // `fonts/` from `dist/` on every local build) silently drops them, since they are not part of the
        // built output.
        { src: 'fonts/OFL-*.txt', dest: 'fonts', rename: { stripBase: true } },
        // `module.json`'s `license`/`readme` refer to "LICENSE"/"README.md" relative to the root of the
        // installed module (i.e. `packages/module/dist/**`, which is what goes into `module.zip`) —
        // without copying them those references would point nowhere after installation. Copying with
        // `dest: '.'` from a `src` outside the vite root (`../../LICENSE`) landed the file next to
        // `packages/module/` (ONE level too high), not in `dist/` — so the copies live here (the same
        // pattern as `fonts/`: vendored locally, not a reference upward).
        { src: 'LICENSE', dest: '.', rename: { stripBase: true } },
        { src: 'README.md', dest: '.', rename: { stripBase: true } },
        {
          src: '../../packages/core/dist/*',
          dest: 'lib/core',
          rename: { stripBase: true },
        },
        {
          src: '../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
          dest: 'lib',
          rename: { stripBase: true },
        },
        {
          // pdf.mjs itself (the main library) — @bindery/core imports it dynamically under the rewritten
          // path '../pdf.mjs' (see packages/core/vite.config.ts).
          src: '../../node_modules/pdfjs-dist/legacy/build/pdf.mjs',
          dest: 'lib',
          rename: { stripBase: true },
        },
        {
          src: '../../node_modules/pdfjs-dist/wasm/{openjpeg,jbig2,qcms_bg}.wasm',
          dest: 'lib/wasm',
          rename: { stripBase: true },
        },
        {
          src: '../../node_modules/pdfjs-dist/standard_fonts/*',
          dest: 'lib/standard_fonts',
          rename: { stripBase: true },
        },
      ],
    }),
    fixManifestAssetPaths(),
  ],
});

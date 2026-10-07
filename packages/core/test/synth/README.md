# Synthetic fixture generator

A generator of PDFs with a controlled, known-in-advance structure — test material for the layout engine, because on a real PDF you cannot tell a parser bug from a quirk of the file.

**This code stays in the repo permanently** and is extended throughout the project (it is not a one-off spike).

## Guiding rule

> **A fixture must prove that it tests what it declares.**

Every fixture has two layers in its `<id>.json` file:

1. **`claims`** — a property the fixture is meant to demonstrate, verified automatically by running the PDF through pdf.js (`npm run fixtures:verify`). This is the generator's self-check.
2. **`expected`** — ground truth for the golden tests. It may be incomplete — describe only what the fixture actually tests.

**A fixture without a passing `claims` layer does not enter the set.**

## How to add a new fixture

1. Create `fixtures/<id>.ts` exporting `build(): Buffer`. Use `rawPdf.ts` (`PdfWriter`), `contentStream.ts` (`ContentStreamBuilder`), `fonts.ts` (`embedFont`) and — for images — `images.ts`.
2. Create `fixtures/<id>.json` by hand: `id`, `description`, `targetPhase`, `claims`, `expected`.
3. Register it in `index.ts` (import the module + import the JSON + add it to the `fixtures` array).
4. Run `npm run fixtures:verify` (in `packages/core`). If `claims` doesn't pass — **fix the fixture, or fix `claims` so that they reflect what pdf.js actually returns**. Don't guess values — measure and write down the measured ones.
5. `npm test` also runs the determinism test (two `build()` calls must give an identical SHA-256) — added automatically for every fixture in the registry, with no extra work.

## Key pitfalls (read before writing a new fixture)

- **pdf.js merges adjacent glyphs into one `TextItem` based on geometry** (distance relative to the font width), **regardless of the number of `Tj` operators**. To force a separate item per token, **put each token on its own row** (a different `Tm`/Y) — the only reliable, simple way. Gaps on the same line give unpredictable merging (sometimes separate items + a synthetic space, sometimes a merge into one string with spaces inside).
- **Changing the font resource (`/F1` → `/F2`) does NOT force a new item** if both resources point at the same `/Font` object — pdf.js compares `font.name` (built from `/BaseFont`), not the resource name from `Tf`.
- **A `/ToUnicode` mapping to an empty string (`<code> <>`) is ignored by pdf.js** — `Font#_charToGlyph` in `pdf.worker.mjs` does `this.toUnicode.get(charcode) || charcode`, and an empty string is falsy in JS, so it silently falls back to the raw character code. A `TextItem` with `str === ""` cannot be built this way.
- **`Util.getAxialAlignedBoundingBox` does not exist** in pdfjs-dist 6.1.200 — compute the bbox by hand from the four corners through the CTM (see `metrics.ts`, `computeImageBBoxes`).
- **A luminosity mask (`beginGroup` with `smask.subtype === "Luminosity"`) requires the mask's `/G` target to HAVE ITS OWN `/Group /S /Transparency`** — without it `PartialEvaluator.buildFormXObject` doesn't emit `beginGroup` at all (verified directly in the pdf.js source).

## Structure

```
rawPdf.ts         a low-level emitter: PDF objects, xref, trailer (PdfWriter)
contentStream.ts  building content-stream operators (ContentStreamBuilder)
fonts.ts          embedding TrueType + /ToUnicode (embedFont, buildToUnicodeCMap)
images.ts         image XObjects, luminosity masks (imageXObject, luminosityMaskForm)
metrics.ts        computes metrics from pdf.js for the claims layer (computeMetrics)
types.ts          the types FixtureClaims/FixtureGroundTruth/Fixture
verifyClaims.ts   compares the computed metrics with the claims (checkClaims, verifyAll)
verify-cli.ts     the entry point of `npm run fixtures:verify`
determinism.test.ts  a Vitest test: two build() calls = an identical SHA-256, for every fixture
index.ts          the registry of all fixtures
fixtures/         <id>.ts + <id>.json, one pair per fixture
assets/fonts/     Lato and Roboto (SIL OFL 1.1) — the only binary files from this directory in the repo
```

## Test fonts

`assets/fonts/{Lato,Roboto}-*.ttf` — SIL Open Font License 1.1 (`OFL-*.txt` alongside). They are not publisher content, only widely available open-source fonts used as a carrier for testing text extraction. `/BaseFont` in the generated PDFs is set freely per fixture (e.g. `Autobahn`, `AAAAAH+Bookmania-Bold`) — it doesn't have to match the real name of the embedded font, because pdf.js reads the name from the `/Font` dictionary, not from the `name` table inside the TTF file itself (verified empirically).

## What this directory does NOT do

- It doesn't implement any layout logic (word merging, column detection, reading order) — it supplies material, not the engine.
- It doesn't commit the generated PDFs — `build()` returns a `Buffer` in memory, consumed directly by `pdfjs.getDocument({ data: ... })`.

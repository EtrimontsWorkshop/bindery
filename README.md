# Bindery — PDF Asset Importer for Foundry VTT

Bindery pulls the maps, handouts, and images that take the longest to prepare from PDFs you own into Foundry Virtual Tabletop, independent of game system or language. It analyzes the layout of the PDF, shows you what it found in a review screen, and creates nothing until you approve it.

**Status:** this release covers images — maps, handouts, and portraits — analyzed, reviewed, and imported as Scenes and JournalEntry handouts, including manual region cropping, journal grouping, and a full token-preparation toolkit (background removal with a manual touch-up tool, four mask shapes, built-in or custom frames, sharpening). See [known limitations](#known-limitations) before relying on it for a real session. Actor (stat block) import, random tables, items, and spells are **not part of this release** — see [What's not in this release](#whats-not-in-this-release).

## Installation

Install from Foundry's **Add-on Modules** screen using this manifest URL:

```
https://github.com/EtrimontsWorkshop/bindery/releases/latest/download/module.json
```

Requires Foundry VTT **v14 or later**. Earlier versions are not supported and have never been tested — Bindery relies on ApplicationV2 and the v14 `JournalEntryPage` document shape.

Works on self-hosted Foundry and on The Forge (verified end to end: asset loading, PDF analysis, and image upload). Other hosting providers have not been tested — if you hit a loading or upload failure on one, please open an issue.

## Known limitations

Stated plainly, so you know what to expect before importing a real book:

- **Image recall is not perfect, and the number below is a ceiling, not a guarantee.** On the reference set used to calibrate the classifier (556 hand-labeled images across 3 real sourcebooks), **~85% (95% confidence interval: 79–91%, n=134 useful images)** of genuinely useful images end up either auto-selected or in the "undecided" review list — the rest can still be missed entirely. Precision (how much of what's auto-selected is actually useful) is around 95%. **Both numbers were measured on the same 3-book set used to tune the classifier's thresholds** — that's the standard overfitting caveat, and it means real-world performance on a book you didn't calibrate against could land anywhere in that interval, or below it. If a map or handout you expect is missing, check the PDF directly; the review screen doesn't yet catch everything.

- **Full-book text-to-journal has no UI entry point in this release.** The underlying extraction (semantic blocks → HTML, chaptered by the PDF's own outline) still runs for every document, and so does full-page map detection — but the review screen's separate tabs for reviewing and selecting them as a batch are disabled in favor of one unified per-image flow. Set an image's destination to "Scene" for a full-page map; there's currently no way to import book text as a journal.

- **"Select & cut" (manual region crop)** — drag a rectangle over any page in the review screen to cut it out as a custom image — has been verified against a handful of real sourcebooks across several geometry edge cases (scrolled page, page corner, a differently-proportioned page, a resized window). Not yet exercised across many books; report anything that looks off.

- **Background removal is a manual touch-up tool, not full auto-cutout.** Corner-based flood fill handles most flat backgrounds well, but a background pocket fully enclosed by the subject (for example under a hat brim touching a shoulder) needs one manual click to include — this is a known, permanent limitation of the technique, not a bug to be fixed later.

## What's not in this release

**Actor (stat block) import.** Bindery can read stat blocks from a PDF and create actors from them, but each book lays its stat blocks out differently, so it needs a description of that layout to work. Building and loading those descriptions is hidden in this release until there's a supported way to share them. The feature is built and tested, and this section will be updated when it's available.

## Legal notice

> This tool processes files you own. It does not contain or distribute any publisher's content. Responsibility for holding the rights to imported material rests with you. Import results are not intended for further distribution.

Bindery does not bypass encryption or password protection on any PDF. If a file is password-protected, the wizard will tell you and refuse to process it.

This repository, its releases, and any community-contributed profiles never include publisher content (stat blocks, artwork, proprietary fonts, or text).

## Development

This is an npm workspaces monorepo:

- `packages/core` — pure TypeScript library (PDF analysis), zero dependency on Foundry globals. Publishable and testable standalone.
- `packages/module` — the Foundry-facing layer (UI, hooks, settings, asset loading).

```
npm install
npm run build           # builds core + module, syncs the result to repo root for local Foundry testing
npm run test            # unit tests (packages/core)
npm run lint            # ESLint across the whole repo
npm run check:boundary  # verifies packages/core never references Foundry globals
npm run check:size      # verifies the world-startup bundle stays under 40 KB
npm run package         # produces module.zip from the built module
```

Because this repository doubles as a live Foundry module folder during local development, `npm run build` also copies the built `packages/module/dist/**` output to the repo root (`module.json`, `scripts/`, `styles/`, `lang/`, `templates/`, `lib/`) via `tools/sync-local-module.mjs`. Those root-level files are generated, gitignored, and not part of the tracked source — the source of truth is `packages/module/`.

## License

[MIT](LICENSE). Bundled fonts (Figtree, Caprasimo, JetBrains Mono, in `fonts/`) are licensed separately under the SIL Open Font License 1.1 — see the `OFL-*.txt` files alongside them.

PDF parsing uses [pdf.js](https://mozilla.github.io/pdf.js/), licensed under Apache-2.0.

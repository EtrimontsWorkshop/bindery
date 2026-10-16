# Bindery — PDF Asset Importer for Foundry VTT

Bindery pulls the maps, handouts, and images that take the longest to prepare from PDFs you own into Foundry Virtual Tabletop, independent of game system or language. It analyzes the layout of the PDF, shows you what it found in a review screen, and creates nothing until you approve it.

**Status:** this release covers images — maps, handouts, and portraits — analyzed, reviewed, and imported as Scenes and JournalEntry handouts, including manual region cropping, journal grouping, an image editor (erase, fill background, rotate), and a full token-preparation toolkit (background removal with a manual touch-up tool, four mask shapes, built-in or custom frames, sharpening). See [known limitations](#known-limitations) before relying on it for a real session. Actor (stat block) import, random tables, items, and spells are **not part of this release** — see [What's not in this release](#whats-not-in-this-release).

## Installation

Install from Foundry's **Add-on Modules** screen using this manifest URL:

```
https://github.com/EtrimontsWorkshop/bindery/releases/latest/download/module.json
```

Requires Foundry VTT **v14 or later**. Earlier versions are not supported and have never been tested — Bindery relies on ApplicationV2 and the v14 `JournalEntryPage` document shape.

Works on self-hosted Foundry and on The Forge (verified end to end: asset loading, PDF analysis, and image upload). Other hosting providers have not been tested — if you hit a loading or upload failure on one, please open an issue.

## The review screen

After the analysis, every image Bindery found is listed with a thumbnail, its page and a destination (Scene, Journal handout, Token or unassigned). Nothing is created until you confirm.

- **Preview and editing.** Click a thumbnail to open the image editor: erase parts of the picture (to transparency or to a color), fill the background with a color, and rotate it left or right. Every step, turns included, can be undone.
- **Moving through the images.** With an image highlighted, the ↑ and ↓ keys move to the previous and the next image of the list shown (the page preview follows).
- **Order of the list.** By default the images Bindery is sure about come first, by page, then the undecided ones from the largest to the smallest. The module setting **Sort images by page** lists everything in the order of the book instead.
- **Transparent areas.** The module setting **Add a white background to images** puts a white background behind every image that has transparent pixels (useful for line drawings); images you changed by hand are left as you made them.
- **What you may find in the list.** Floor plans, maps and diagrams that the PDF paints as vector lines over a panel are offered as the picture the page shows. A map that runs across two pages is joined into one image, listed on the first of the two pages. Pictures stored sideways in the PDF are turned the way the page shows them.

## Known limitations

Stated plainly, so you know what to expect before importing a real book:

- **Image recall is not perfect, and the numbers below are an old, rough indication.** On the reference set used to calibrate the classifier at the time (556 hand-labeled images across 3 real sourcebooks), **~85% (95% confidence interval: 79–91%, n=134 useful images)** of genuinely useful images ended up either auto-selected or in the "undecided" review list — the rest could still be missed entirely — and precision (how much of what's auto-selected is actually useful) was around 95%. **Both numbers were measured on the set used to tune the thresholds** (the standard overfitting caveat), and **they have not been measured again since**: the rules have been tuned on more books since, which changed them. Real-world performance on a book you didn't calibrate against could land anywhere around those figures, or below them. If a map or handout you expect is missing, check the PDF directly; the review screen doesn't yet catch everything.

- **Layout heuristics can be wrong on a book they were not tuned on.** Bindery decides what is a picture and what is the page's own design (panels, backgrounds, frames, tape) from the PDF's structure and the pixels of the pictures. In particular: a dark panel that a layout lays behind text or cards is hidden unless something is drawn on it; a dark illustration that looks like such a panel may be hidden by mistake (and a panel may be offered); the two halves of a map are joined across a spread only when both are big translucent panels of the same height. A picture that the PDF stores sideways is imported the way the page shows it, which for a landscape map printed on a portrait page means portrait. Anything wrongly hidden can still be cut out with "Select & cut".

- **Full-book text-to-journal has no UI entry point in this release.** The underlying extraction (semantic blocks → HTML, chaptered by the PDF's own outline) still runs for every document, and so does full-page map detection — but the review screen's separate tabs for reviewing and selecting them as a batch are disabled in favor of one unified per-image flow. Set an image's destination to "Scene" for a full-page map; there's currently no way to import book text as a journal.

- **"Select & cut" (manual region crop)** — drag a rectangle over any page in the review screen to cut it out as a custom image — has been verified against a handful of real sourcebooks across several geometry edge cases (scrolled page, page corner, a differently-proportioned page, a resized window). Not yet exercised across many books; report anything that looks off.

- **Background removal is a manual touch-up tool, not full auto-cutout.** Corner-based flood fill handles most flat backgrounds well, but a background pocket fully enclosed by the subject (for example under a hat brim touching a shoulder) needs one manual click to include — this is a known, permanent limitation of the technique, not a bug to be fixed later.

## What's not in this release

**Actor (stat block) import.** Bindery can read stat blocks from a PDF and create actors from them, but each book lays its stat blocks out differently, so it needs a description of that layout to work. Building and loading those descriptions is hidden in this release until there's a supported way to share them. The feature is built and tested, and this section will be updated when it's available. The import engine behind it is exposed to other modules through a versioned API (`game.modules.get('bindery-pdf-importer').api.statblock`), which is how profiles can be authored outside of Bindery; that API exists only while the feature is switched on.

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
npm run check:imports   # verifies the built files import nothing by a bare module name
npm run check:lang      # both language files parse and carry the same keys
npm run check:lang-usage  # every localization key used in the code exists
npm run check:no-system-names  # statblock code names no RPG system and no `system.*` path
npm run check:readme-sync      # packages/module/README.md is identical to this file
npm run package         # produces module.zip from the built module
npm run check:manifest  # module.json matches the files and the zip
npm run deploy:foundry  # copies the built module into a Foundry modules folder (BINDERY_FOUNDRY_MODULE_DIR)
```

Profile-based statblock import is compiled in only when you build with `BINDERY_STATBLOCKS=1` (for example `BINDERY_STATBLOCKS=1 npm run build`); a plain `npm run build` produces the release build, without it.

Because this repository doubles as a live Foundry module folder during local development, `npm run build` also copies the built `packages/module/dist/**` output to the repo root (`module.json`, `scripts/`, `styles/`, `lang/`, `templates/`, `lib/`) via `tools/sync-local-module.mjs`. Those root-level files are generated, gitignored, and not part of the tracked source — the source of truth is `packages/module/`. `packages/module/README.md` is the copy that ships inside the module (see `vite.config.ts`); keep it identical to this file — `npm run build` checks that they match.

## License

[MIT](LICENSE). Bundled fonts (Figtree, Caprasimo, JetBrains Mono, in `fonts/`) are licensed separately under the SIL Open Font License 1.1 — see the `OFL-*.txt` files alongside them.

PDF parsing uses [pdf.js](https://mozilla.github.io/pdf.js/), licensed under Apache-2.0.

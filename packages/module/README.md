# Bindery — PDF Asset Importer for Foundry VTT

Bindery pulls the maps, handouts, and images that take the longest to prepare from PDFs you own into Foundry Virtual Tabletop, independent of game system or language. It analyzes the layout of the PDF, shows you what it found in a review screen, and creates nothing until you approve it.

**Status:** this release covers images — maps, handouts, and portraits — analyzed, reviewed, and imported as Scenes and JournalEntry handouts, including manual region cropping, optional vector drawings, journal grouping, an image editor (erase, fill background, rotate), and a full token-preparation toolkit (background removal with a manual touch-up tool, four mask shapes, built-in or custom frames, sharpening). See [known limitations](#known-limitations) before relying on it for a real session. Actor (stat block) import, random tables, items, and spells are **not part of this release** — see [What's not in this release](#whats-not-in-this-release).

## Installation

Install from Foundry's **Add-on Modules** screen using this manifest URL:

```
https://github.com/EtrimontsWorkshop/bindery/releases/latest/download/module.json
```

Requires Foundry VTT **v14 or later**. Earlier versions are not supported and have never been tested — Bindery relies on ApplicationV2 and the v14 `JournalEntryPage` document shape.

Works on self-hosted Foundry and on The Forge (verified end to end: asset loading, PDF analysis, and image upload). Other hosting providers have not been tested — if you hit a loading or upload failure on one, please open an issue.

## The review screen

After the analysis, every image Bindery found is listed with a thumbnail, its page and a destination (Scene, Journal handout, Token or unassigned). Nothing is created until you confirm.

- **Preview and editing.** Click a thumbnail to open the image editor. It has four tools: *View* (only look at the image), *Brush* and *Rectangle* (erase unwanted parts, for example text captured with an illustration) and *Pick color* (take a color from the picture). *Erase to* decides what an erased area becomes: *Transparent* or a *Solid color* (the color picker next to it). **Fill background** puts the chosen color behind the whole picture, so every transparent area gets that color (useful for sketches that are hard to read on a transparent background). The brush size and the zoom have sliders, and the picture can be rotated a quarter turn left or right. Every step, turns included, can be undone and redone (Ctrl+Z), *Restore original* goes back to the image as Bindery found it, and *Apply changes* keeps the result.
- **Moving through the images.** With an image highlighted, the ↑ and ↓ keys move to the previous and the next image of the list shown (the page preview follows).
- **Order of the list.** By default the images Bindery is sure about come first, by page, then the undecided ones from the largest to the smallest. The module setting **Sort images by page** lists everything in the order of the book instead (see [Module settings](#module-settings)).
- **What you may find in the list.** Floor plans, maps and diagrams that the PDF paints as vector lines over a panel are offered as the picture the page shows. A picture that runs across two facing pages (a map, a double-page illustration, a figure split by the gutter) is joined into one image, listed on the first of the two pages, when the pixels of the two halves go on across the seam. An illustration drawn in several pieces (a few objects on one page) comes out as one picture, and a card of text laid over a portrait is imported apart from the portrait. A picture painted twice in the same place comes out once, from its own pixels, without the ring or frame the page draws around it. Pictures stored sideways in the PDF are turned the way the page shows them.
- **Vector drawings.** Some books draw their art as vector paths, not as pictures (the cartoon figures beside the text of a rulebook, diagrams, a publisher's logo), and there is nothing in such a PDF to extract. The module setting **Import vector drawings** (off by default) makes Bindery look for them too: clusters of filled paths that make a figure are rendered as the part of the page they cover and listed as undecided images, unchecked. With the setting off the PDF is analysed as before. See the limitations below; the setting applies to the next PDF you analyse.

## Module settings

The settings are in Foundry's **Settings → Configure Settings → Module Settings** screen, under Bindery (the **Import PDF…** button there opens the import wizard). All of them are per world and take effect for the next PDF you analyse or the next image you save.

| Setting | Default | What it does |
| --- | --- | --- |
| **Image upload folder** | `worlds/<world>/bindery-imports` | The folder in the world's data storage where the images you import are saved. |
| **Sort images by page** | off | Off: the review lists the images Bindery is sure about by page first, then the undecided ones from the largest to the smallest. On: every image is listed in the order of the book, page by page and from the top of a page to the bottom. |
| **Add a white background to images** | off | Images that have transparent areas get a white background behind them right after the PDF is analysed (so you review them with it) and again when they are saved. Images you changed by hand in the token panel or the editor are left as you made them. It also applies to tokens and statblock portraits, and makes sketches and line drawings easier to read. For a single image use **Fill background** in the image editor, which fills with any color. |
| **Import vector drawings** | off | Also looks for drawings made of vector paths (cartoon figures beside the text, diagrams, logos) and lists them as undecided images, unchecked. Off: the PDF is analysed as before. See the limitations below. |

## Known limitations

Stated plainly, so you know what to expect before importing a real book:

- **Image recall is not perfect, and the numbers below are an old, rough indication.** On the reference set used to calibrate the classifier at the time (556 hand-labeled images across 3 real sourcebooks), **~85% (95% confidence interval: 79–91%, n=134 useful images)** of genuinely useful images ended up either auto-selected or in the "undecided" review list — the rest could still be missed entirely — and precision (how much of what's auto-selected is actually useful) was around 95%. **Both numbers were measured on the set used to tune the thresholds** (the standard overfitting caveat), and **they have not been measured again since**: the rules have been tuned on more books since, which changed them. Real-world performance on a book you didn't calibrate against could land anywhere around those figures, or below them. If a map or handout you expect is missing, check the PDF directly; the review screen doesn't yet catch everything.

- **Layout heuristics can be wrong on a book they were not tuned on.** Bindery decides what is a picture and what is the page's own design (panels, backgrounds, frames, tape) from the PDF's structure and the pixels of the pictures. In particular: a dark panel that a layout lays behind text or cards is hidden unless something is drawn on it; a dark illustration that looks like such a panel may be hidden by mistake (and a panel may be offered); a picture that runs a point or two past the edge of the page is judged by the pixels and not by the text on it, so a sheet of text that runs flush with the edge may be offered, unchecked. A picture that the PDF stores sideways is imported the way the page shows it, which for a landscape map printed on a portrait page means portrait. Anything wrongly hidden can still be cut out with "Select & cut".

- **Joining the two halves of a picture is a guess from the pixels at the seam.** Two unrelated pictures that merely meet at the gutter are kept apart, but two full-page scans of facing pages whose edges look alike may still be joined into one image. Pieces of an illustration that do not touch, or that are not on facing pages, are not joined.

- **Vector drawings come with a few extras.** A drawing is rendered as the part of the page its box covers, so scraps of the page's text that run past it can remain in the corners (Bindery paints over the text that lies where no shape of the drawing does, and the image editor can erase what is left); tables with rounded cells, logos and a barcode may be offered as drawings too. A drawing wider than about three quarters of the page, drawn with fewer than fifteen paths, or built of rectangles only is not found, and a drawing that is repeated on three pages or more is taken for a running ornament and left out. Anything missed can be cut out with "Select & cut".

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

[MIT](LICENSE). Bundled fonts (Figtree, JetBrains Mono, in `fonts/`) are licensed separately under the SIL Open Font License 1.1 — see the `OFL-*.txt` files alongside them.

PDF parsing uses [pdf.js](https://mozilla.github.io/pdf.js/), licensed under Apache-2.0.

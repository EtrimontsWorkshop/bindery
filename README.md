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

**Actor (stat block) import** is under active development on a separate branch and is **not available in this release** — the sections below describe the feature as it's being built, not something you can use with the version this README ships alongside. This section will be updated (and the "Status" line above changed) once it ships.

## Statblock import (profile-based) — in development

Bindery can read stat blocks from a PDF and create Actors from them, for **any** game system, in **any** language — it never assumes a particular system's field names or a particular layout. Instead, you teach it once per book (or per layout) by building a **profile**: you point it at an Actor you've already set up in your world as a template, then show it where each value sits on an example page. From then on, it can find every statblock in that PDF that follows the same layout and build an Actor for each one.

### Workflow

1. **Open the profile builder** (module settings → "Statblock profile builder…") and start a new profile, or edit an existing one.
2. **Source tab** — pick the template Actor (the one whose fields you want to fill in) and load an example PDF containing at least one statblock in the layout you want to teach.
3. **Fields tab** — click an element on the page preview (or drag a rectangle) to select it, then click the matching field in the Actor's own field list to assign it. Repeat for every field worth extracting; a live preview shows the raw text, the value after any transforms, and whether it's valid for that field's type. Fields you don't map can optionally inherit their value from the template Actor instead of staying empty.
4. **Collections tab** — for repeating sections (attacks, spells, inventory — whatever your system's Actor has as embedded Items), point at a template Item and describe how the section splits into individual entries (a repeating line pattern, a heading followed by entries, or a fixed delimiter).
5. **Detection tab** — describe how to recognize where one statblock starts (a heading pattern, or a heading's visual style) and ends (the next statblock, a blank-line gap, the end of a column/page, or a closing marker), then run "test on the whole PDF" to see every statblock it finds and how confident it is about each one, before importing anything.
6. **Save** the profile (with validation against the template Actor's current schema), and reuse it on any other PDF that shares the same layout. Profiles export to a `.json` file so you can share one for a specific book with other GMs running the same system.

### A worked example, on made-up fields

Because Bindery has no idea which system you're using, every example below is deliberately abstract — substitute your own system's actual field names:

- The book prints `Attribute A: 14` under each creature's name → map a field with source "label: `Attribute A:`, same line" to your Actor's `attributeA` path, with a "parse number" transform so `"14"` becomes the number `14`, not the string `"14"`.
- The book prints `Resource B (used/max): 3/10` → map that text to `resourceB.value`/`resourceB.max` as two separate fields (or one field plus a "split" transform on `/`), whichever your system's Actor schema actually has.
- A repeating "Actions" section, each entry starting with a bold name, followed by a description → a collection with split rule "heading, then entries" (heading pattern `ACTIONS`), each entry's own name and description mapped the same way as any other field, scoped to that one entry.

### Limitations

- **No OCR.** Bindery reads the PDF's own text layer — the same layer you could select and copy in a PDF viewer. A scanned book with no text layer (image-only pages) has nothing for it to find; run the PDF through an OCR tool first if you need this to work on one.
- **One profile per layout, not per book.** If a book uses two different statblock layouts (for example, a simpler format for minor NPCs and a fuller one for major ones), you need one profile per layout.
- **Requires an existing Actor (and, for repeating sections, Item) in your world to teach from.** The profile builder introspects that Actor's live schema — it never has or needs built-in knowledge of any game system.
- Region-based field selection (dragging a rectangle instead of clicking a labeled value) is normalized against the whole page in the current profile builder, not against the statblock's own boundaries — it works reliably for one statblock per page, and may need manual adjustment for multi-column layouts with more than one statblock per page.

### Extension points

Noted here as documented directions for future work, not commitments:

- **OCR fallback.** For scanned, image-only PDFs, a future version could run OCR to produce a synthetic text layer before detection — the rest of the pipeline (profiles, extraction, detection) is already independent of *how* the text layer was produced, so this would slot in ahead of it rather than requiring changes throughout.
- **Mapping suggestions.** The profile builder currently requires you to click every field yourself. A future version could suggest likely matches (e.g. a number near a label whose text resembles a field's own name or localized label) for you to confirm or reject, rather than replacing your judgment outright.

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

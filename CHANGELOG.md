# Changelog

All notable changes to this project are documented in this file.

## [0.1.0] — First public release: PDF images into Foundry VTT

Bindery imports maps, handouts, and portrait images from user-owned PDFs into Foundry VTT — analyzed, previewed in a review screen, and created only after explicit approval. Everything in this release is scoped to images. Actor (stat block) import exists in the codebase and is built and tested, but its interface is hidden in this release (see [What's not in this release](README.md#whats-not-in-this-release) in the README) rather than shipped without a supported way to describe a book's stat block layout.

### Added

- Four-stage pipeline (layout → semantic blocks → CIF → Foundry documents) for PDF images: font/vector/image inventory, column/reading-order layout detection, image classification (content/decoration/mask), and extraction with a three-step fallback (direct object → common object → region render).
- Review screen (`ApplicationV2`): virtualized image list, page preview with bounding-box overlays, per-image destination selection (Scene / Journal handout / Token / Unassigned) with a bulk-apply control, diagnostics panel, nothing written until the user confirms.
- **Manual region crop ("Select & cut")**: drag a rectangle over any page in the review screen's preview to cut out a custom region as a new image, added to the review list alongside the automatically detected ones.
- **Journal grouping**: images with destination "Journal" and a shared, user-chosen group name are bundled into a single `JournalEntry` with one page per image (e.g. one handout journal per book chapter), instead of one journal per image.
- **Per-image naming**: each image's name is editable directly in the review list.
- Manual per-image rotation (content, not just the crop rectangle) and resize handles on auto-detected image regions.
- **Token preparation panel**, opened from an image's "Token" destination: crop and zoom within any of four mask shapes (circle, square, rounded square, hexagon), remove the background (corner-based flood fill with an adjustable tolerance), touch up the result by clicking any background pocket the automatic fill couldn't reach (e.g. under a hat brim that touches the shoulder — a manual step by design, not an automation gap), apply a built-in ring frame or upload a custom one, and sharpen the result — all previewed live over a checkerboard before saving. A profile-level toggle (`images.removeTokenBackgroundDefault`) can default the background-removal switch on for a given book.
- Import targets: Scenes (with grid alignment), JournalEntry image handouts, token-ready uploads.
- One-time legal notice gate; zero password-bypass or DRM-circumvention logic — protected PDFs produce a friendly error and a hard stop.
- i18n: English and Polish.

### Changed

- Unassigned images default to *deselected* rather than guessing a destination — auto-guessing performed poorly enough in practice that manual assignment via the destination dropdown is the only path.
- Images with extreme aspect ratios (≥6:1 — thin decorative dividers) or below 100px on a side no longer get silently discarded as "decoration": both cases land in the review screen as "undecided", with a diagnostic note explaining why, so you see and decide rather than losing an image without a trace.

### Fixed

- Rotating an already-cropped image no longer shrinks it cumulatively over repeated rotations; rotating 36× by 10° now returns to the original size, not a degraded fragment.
- Cropping images with rotation applied no longer bilinear-blurs corners into visible artifacts.

### Known limitations

Stated plainly, so you know what to expect before importing a real book:

- **Image recall is not perfect, and the number below is a ceiling, not a guarantee.** Measured against a hand-labeled reference set of several hundred images, roughly **85% of genuinely useful images** end up either auto-selected or in the "undecided" review list — the rest can still be missed entirely. Precision (how much of what's auto-selected is actually useful) is around 95%. **Both numbers come from the same material used to tune the classifier's thresholds**, which is the standard overfitting caveat: on a book the classifier was never calibrated against, real-world performance could be meaningfully lower.
- **Automatic scene/journal detection review is currently folded into the unified Images tab, not a separate review step.** The underlying pipeline still detects full-page maps and can extract the whole book's text into a chaptered journal from the PDF's own outline — but the dedicated review tabs for those are disabled in favor of one unified per-image flow. Full-book text-as-journal has no UI entry point in this release.
- **"Select & cut" (manual region crop)** has been verified across several geometry edge cases, but on a limited set of books — not yet battle-tested widely.
- **Background removal is a manual touch-up tool, not full auto-cutout.** A background pocket fully enclosed by the subject needs one manual click to include — a known, permanent limitation of the technique, not a bug to be fixed later.
- Stat block extraction, random tables, items, and spells are **not implemented** in this release.
- Hosting providers other than self-hosted Foundry and The Forge are **untested**.

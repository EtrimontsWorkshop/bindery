## [0.2.3]

### Changed

- **Package ID renamed to `bindery-pdf-importer`** (from `bindery`) — the old id was already taken by an unrelated module in Foundry's official package directory, which blocked submission. **This makes Foundry treat it as a different module.** Existing installs under the old id are not migrated automatically: after updating, reinstall using the new manifest URL and reconfigure the upload path/settings once. The repository and its URL are unchanged.

## [0.2.2]

### Changed

- **Removed the "Select content only" button** from the image list.
- **Bulk actions act only on the active tab:** "Select all", "Select none" and the top "set destination/journal group for selected" now affect only the images of the tab you are looking at (source + destination). Previously selected images sitting in other tabs (for example tokens or journals) were silently moved too.

### Fixed

- **Images without a destination no longer count as ready to import:** selecting only "Unassigned" images keeps the "Next" button disabled and the footer explains that a Scene, Journal or Token has to be set first.
- **"Next" button and the "Ready to import" hint now update immediately** when you tick or untick images or actors. Before, deselecting everything left the button enabled (and the import created nothing), and selecting one image again left it disabled until you changed the page.

## [0.2.1]

### Added

- **Redo and keyboard shortcuts in the image erase window:** a "Redo" button, Ctrl/Cmd+Z to undo and Ctrl/Cmd+Shift+Z (or Ctrl+Y) to redo. The Undo button shows how many steps can be undone.

### Changed

- **Cleaner auto-detected image list:** single-color images (for example a blank white rectangle, allowing tiny deviations) and long, narrow images (typically frames and borders) are no longer offered in the review list. Anything still needed can be cut out with "Select & cut" on the page preview.
- **Paper and page backgrounds are hidden too:** smooth backgrounds (a soft parchment/paper texture or a page wash, with no edges or shapes) are no longer offered in the review list, even when the importer wasn't sure about them. Detection was checked on a real adventure PDF: all 15 background images were hidden and none of the 35 illustrations, maps, portraits, or pencil sketches (the other 8 images were narrow frame strips, hidden by the long-and-narrow rule).
- **Erase history:** undo steps now store only the region that changed, so long histories (up to 100 steps) work even on large images.
- **Module title** is now "Bindery — PDF Asset Importer" in Foundry, matching the repository.

## [0.2.0]

### Added

- **Image preview on hover:** hovering an image thumbnail in the review list shows an enlarged preview, so you can check the image without opening anything.
- **Image preview and erase window:** clicking a thumbnail opens a large preview with erase tools — brush, rectangle, and a color picker (eyedropper). Unwanted parts (for example text captured together with an illustration) can be erased to transparency or painted over with a solid color. Includes zoom, brush size, undo, and restore original; applying the changes replaces the image in the import.

## [0.1.1]

### Added

- **Default token settings:** added the ability to save settings for preparing images for use as tokens. Choose the desired options and click **Set as default** to save them as defaults.

### Fixed

- **Saved file names:** previously, a user-defined image name appeared only in Foundry VTT, while the locally saved file retained its automatically generated name. The file name now also includes the name chosen by the user.

- **Fixed language inconsistencies** — all source comments are now in English.

## [0.1.0]

### Added

- **PDF image import:** images can be imported into Foundry VTT as scene backgrounds with grid alignment, illustrations in journal entries, and files ready for use as tokens.
- **Review screen (ApplicationV2):** an image list, a page preview with bounding boxes around detected regions, a diagnostics panel, and destination selection for each image: Scene / Journal handout / Token / Unassigned. Destinations can also be assigned in bulk. Nothing is saved without user approval.
- **Manual region extraction ("Select & cut"):** selecting a rectangular area on a PDF page lets you extract it as a new image.
- **Journal entry grouping:** images assigned to the "Journal" destination with a shared group name are combined into a single `JournalEntry`, with one page per image. This allows you, for example, to create one journal entry containing materials for a book chapter instead of a separate entry for every image.
- **Image naming:** each image's name can be edited directly in the review list.
- **Rotation and cropping:** images can be rotated, changing the orientation of the illustration itself rather than just the crop rectangle. Resize handles let you adjust the boundaries of automatically detected regions.
- **Token preparation panel:** selecting the "Token" destination enables cropping and zooming within one of four mask shapes: circle, square, rounded square, or hexagon. The panel also supports background removal with adjustable tolerance, manual touch-ups, applying a built-in ring frame or uploading a custom one, and image sharpening. Background removal starts at the corners; enclosed areas the algorithm cannot reach can be removed with a manual click. All changes are previewed live over a checkerboard before saving. The `images.removeTokenBackgroundDefault` profile setting lets you enable background removal by default for a given book.
- **Legal notice and protected file handling:** added a one-time acknowledgment of the legal notice. The module does not bypass passwords or DRM protection. Attempting to use a protected PDF displays a clear error message and stops processing.
- **Interface languages:** English and Polish.

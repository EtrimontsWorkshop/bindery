## [0.3.2]

### Fixed

- **Pictures next to page-edge pieces are no longer extracted with the page around them.** In some rulebooks a photo sits beside a coloured tab or a corner ornament that runs off the edge of the page. Bindery used to merge such a piece into the photo's unit, so the extracted image grew to the page edge and picked up the text and margins in between. These pieces now stay separate (offered as unchecked "undecided" images) and the photo is cut out on its own.
- **Pictures cut by page text now come out clean.** When a picture is partly covered by the page's own text (for example a portrait with a caption laid over its edge), Bindery used to render that page area and so copied the text into the image. It now takes the original image from the PDF instead, when that image has the same proportions as the place it is drawn in. The original has no frame or mask shape, and a picture whose original does not match what the page shows (a texture under a shape) is still rendered from the page as before.
- **Photos pinned to the page as tilted prints are extracted as the photo itself.** A photo with a tilted edge, a white print border or a drop shadow used to be cut out as a rectangle of the page, so it came with the page background, the margin strip and a neighbor's text. When the photo's mask lets most of it through and the original image has the proportions of the place it is drawn in, Bindery now takes the original image from the PDF (full resolution, no print border). A mask that hides a large part of the picture still gets the page render.
- **Paper scraps, stains and shadows that run off the page are no longer offered as images.** These pieces of the page's own design (a masked picture that bleeds off the page) used to show up as unchecked "undecided" images that were just a piece of the page with its text. They are now treated as decoration.
- **Taking the original photo now also works in the browser.** The PDF library hands decoded images over a few milliseconds after a page is read, and Bindery used to look for the mask of a photo before it had arrived, so in Foundry the photos pinned to the page as tilted prints were still rendered together with the page around them. Bindery now waits briefly for the images it needs.
- **The right image is taken from the PDF.** The library numbers images differently when pages without pictures are skipped, so an image could be mistaken for another one on the same page (a strip of paper or a mask instead of the photo). Bindery now reads the image's number from the page's own drawing list.
- **Pictures that overlap on a page are offered one by one.** Photos pinned to a page, stacked and overlapping, used to be merged into one unit and rendered as a whole block of the page (or, with the original photo taken, the others disappeared from the list). Now each photo or note that covers a real share of the page is its own image, and the tape, crests and paperclips on them stay with the picture they are on.
- **Text that lies on a picture stays with it.** A paper note or a newspaper handout is the blank paper in the PDF and the text is drawn by the page, so taking the original image gave only the background. Pictures with text over them (30% or more of their area) are rendered as the page shows them.
- **Tape, translucent ornaments and paper backgrounds are no longer offered as images.** Small elongated masked scraps (strips of adhesive tape), ornaments painted at 10%-50% opacity (watermarks, zodiac wheels) and page-sized sheets of paper are treated as decoration. They remain available through "Select & cut".
- **The hidden bottom of a stack of photos is no longer offered.** In a stack of pinned photos the one underneath is covered almost completely (75% or more) by the one on top and is not what the page shows. In some books the same filler picture lies under every stack, so it showed up many times.
- **Paperclips and other small cut-outs are no longer offered.** Small images that are mostly transparent (a paperclip, a pin) are treated as decoration.
- **Character sheets no longer fill the list with their label bars and boxes.** Images below 0.5% of the page that could not be classified are not offered, and on a page with a crowd of such images (a character sheet) its other small undecided parts are not offered either.

## [0.3.1]

### Fixed

- **PDF analysis no longer fails when something else on the page has frozen `Math`.** With some combinations of modules or browser extensions, analyzing a PDF failed with "Cannot define property sumPrecise, object is not extensible" because the PDF library tries to add a missing `Math.sumPrecise` to a locked-down `Math`. Bindery now loads the library with a temporary stand-in in that situation (and logs a warning in the console), so the import works; nothing changes when `Math` is intact.

## [0.3.0]

### Added

- **A public API for statblock profiles** (`game.modules.get('bindery-pdf-importer').api.statblock`): list, read, save, delete and export profiles, introspect an Actor's fields, and use the detection and extraction functions that run a profile. It lets a separate module author profiles without duplicating any of Bindery's import logic.
- **A "Statblock profiles" window** (Settings → Bindery) to see the profiles available in the world, import one from a `.json` file, export it, or delete it.

### Changed

- **The profile builder is no longer part of this repository.** Creating and editing profiles moves to a separate module; Bindery keeps everything needed to run a profile.
- Comments, test titles and the messages printed by the build scripts are now in English.

Statblock import is still switched off in every released build, so none of this changes what you can do with PDF import today.

## [0.2.6]

### Changed

- **No change to PDF import.** This release only brings the unfinished, profile-based character (statblock) import into the codebase, switched off: there is no "Statblock profile builder" button in the settings and no Statblocks tab in the review screen. Importing maps, handouts, images and tokens works exactly as in 0.2.5.

## [0.2.5]

### Fixed

- **The page preview in the review screen no longer falls apart.** The page frame, the overlay with the detected images, the "Select & cut" drag rectangle and cursor, the image list and its rows lost their styles in 0.2.4, so the overlay ended up below the page and the "Select & cut" button far from the preview. The styles are restored.

## [0.2.4]

### Removed

- **Character-profile / statblock recognition, the Actors tab, and the Call of Cthulhu 7th Edition adapter have been removed from the codebase.** This was still work-in-progress code, hidden behind a flag and never enabled in a released build — Bindery has only ever imported maps, handouts, and images for you, so nothing changes in what you can do with this update. Removing the unfinished code clears the way for a redesigned approach to character import in a future release.

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

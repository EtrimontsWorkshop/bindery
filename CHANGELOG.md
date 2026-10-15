## [0.3.4]

### Fixed

- **Tokens made from line art on a transparent ground are no longer blurred.** The token mask and the background removal smoothed their edges by blurring the picture's whole alpha channel, which also blurred sketches whose lines are drawn in alpha: thick, grey, smeared lines with blocks around them. Only the edge of the shape (or of the removed area) is smoothed now; opaque pictures come out as before.

## [0.3.3]

### Added

- **A global "Add a white background to images" setting.** In the module settings, next to "Import PDF…". When it is on, every image that has transparent areas gets a white background right after the PDF is analysed, so the review (thumbnails, editor, rotation) already shows it, and again when it is saved at import (which covers later edits). An image with no transparency is left untouched. It applies to every image, tokens and statblock portraits included; an image that you changed by hand (token panel, image editor) keeps what you did and gets no background at save.
- **"Fill background" in the image editor.** Puts the chosen color behind the whole picture, so that a sketch exported with a transparent background can be read. One undo step, like the erase tools.

### Fixed

- **Watermark crests are imported without the page text that lies over them.** A crest or emblem painted faintly (10%-20% opacity) behind a quotation or a text column used to be rendered together with that text. Such a translucent picture is now taken from the PDF as it is (the clean mark, unchecked "undecided" as before); the text is not part of it.
- **A paper splatter or stain that runs off the page is no longer imported as a piece of the page.** An undecided picture that bleeds off the page and has no text in its centre used to be rendered together with the body text that flows over its edge. It now comes out as the picture itself.
- **Photos pinned as strongly tilted prints no longer come with the white print border.** The more a print is tilted, the more of its mask is black, so photos tilted by more than about 10 degrees were still rendered as a rectangle of the page. Bindery now also recognizes a mask that is a tilted rectangle (by its shape, not only by how white it is) and takes the original photo. Masks with a different shape (a silhouette, an oval, a torn edge), and prints with a page text lying over them, are rendered as before.
- **A photo with a faint crest behind it is imported as the photo.** When a translucent crest laid under a pinned photo was larger than the photo, the crest decided how the unit was extracted and the photo came out with the page around it. The photo now represents the unit.
- **PDF documents and their workers are released after use.** Every analysis step opened the PDF in its own pdf.js worker and never closed it, so each import left several workers (each holding the whole file in memory) running until the page was reloaded, and repeated imports piled them up. Each step now releases its document as soon as it is done, also when it fails or is cancelled, and the bookmarks are read from the document that is already open. Measured in a browser on a short test file: after file inspection, statblock detection, image extraction, the review build and the page preview the old code left 10 workers running, the new code 0.
- **A picture cut from a larger sheet is taken as the page shows it.** Some layouts paint a figure from an image that holds several figures and let a clipping path hide the rest, so the original showed a piece of the neighbor that is not on the page. Bindery now reads the clipping paths and applies them to the original image: what the page hides becomes transparent and the result is cropped to what is visible. Many photos come out a few percent tighter for the same reason: the page shows less of them than the original holds.
- **Cut-out figures no longer come with the text around them.** A figure on a transparent ground is placed in a box that is larger than the figure, and the page text that runs around it lies in that box. It used to make Bindery render the page region together with the text. It now takes the figure itself, also when the text is a heading or a sidebar and when a colored backdrop shape stands behind the figure. A faded paper vignette laid over an illustration is not taken for the illustration, and the illustration is rendered without the strip of page that the vignette adds around it.
- **A picture painted a second time over itself at reduced opacity is no longer offered twice.** A tinted copy of the same artwork at 20%-60% opacity is part of that picture. The limit for "painted translucent" now also covers 0.6 as PDF stores it (0.600006).
- **Chapter-opener banners are no longer offered as images.** The halftone layer behind "Chapter N" is a small masked raster painted at 20% opacity (up to 6% of the page, 300 px on the long edge). Such a faint layer is now treated as decoration. Faded pictures painted at 30% and more (emblems, watermarks) are not affected.
- **Every map of a map set is offered, not just the first.** Full-page pictures of one size at the same place on every page (a booklet of maps, one to a page) were taken for repeats of the first one and merged with it. A picture that fills half the page or more is now a duplicate of another only when its pixels are identical.
- **The print hidden under another print is no longer offered.** A tilted print lies in the box of the whole rotated raster, so a print that the one on top covers almost completely (the white border and the shadow are all that shows) was not covered enough by the boxes. The check now uses the part that the mask lets through. This also hides four such back prints in a second rulebook, each a picture that is not on the page.
- **Torn paper scraps under a handout are no longer offered.** An opaque, light, flat and smooth picture that could not be classified (the scrap the crest or the note is drawn on) is hidden like other smooth backgrounds. Dark pictures that are as smooth are not affected.
- **Paper sheets under the text are no longer offered.** The torn sheets that a page lays its text on (80%-95% opaque because of their ragged edges, light and smooth) are hidden like other smooth backgrounds; the rule now looks at the visible pixels only.
- **Background removal in the token panel works on pictures with a white background.** A sketch on white is 83%-95% background, which the safeguard against a runaway flood fill (60% of the picture) took for a failed detection: the removal was cancelled and the white came back, also after a manual click on an extra area. The limit is now 98.5% when the four corners are white.
- **Black torn edges along the page are no longer offered.** A raster whose visible pixels are all black (the ragged black border of a page, a shadow) is hidden like other backgrounds.
- **Figures cut out against the page edge are offered again.** A masked figure that overhangs the page by a point or two was taken for a paper scrap or a stain that runs off the page and hidden. When its mask is a silhouette and the picture has real colors (not a splatter, smoke or a faded vignette), it is now offered.
- **Figures standing on colored panels are imported one by one, without the panel.** On a page where several figures stand on faint colored shapes, the shapes used to be offered as images of their own, or one of them stood for the whole group and the figure came out with its panel and the text around it. The faint shapes (20% opacity) are now left out of the unit and the figures are offered separately, as the figure alone.
- **A picture covered by a much larger one is hidden, a picture covered by a vignette is not.** Only a covering picture that is masked, page-sized or at least twice as large hides what is under it.

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

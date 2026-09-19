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

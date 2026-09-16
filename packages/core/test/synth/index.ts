import type { Fixture, FixtureGroundTruth } from './types.js';

import * as helloWorld from './fixtures/hello-world.js';
import helloWorldGT from './fixtures/hello-world.json' with { type: 'json' };
import * as imagesLuminosityMask from './fixtures/images-luminosity-mask.js';
import imagesLuminosityMaskGT from './fixtures/images-luminosity-mask.json' with { type: 'json' };
import * as imagesDecorated from './fixtures/images-decorated.js';
import imagesDecoratedGT from './fixtures/images-decorated.json' with { type: 'json' };
import * as imagesBleedBackground from './fixtures/images-bleed-background.js';
import imagesBleedBackgroundGT from './fixtures/images-bleed-background.json' with { type: 'json' };
import * as imagesOverlapping from './fixtures/images-overlapping.js';
import imagesOverlappingGT from './fixtures/images-overlapping.json' with { type: 'json' };
import * as imagesMaskOpcode from './fixtures/images-mask-opcode.js';
import imagesMaskOpcodeGT from './fixtures/images-mask-opcode.json' with { type: 'json' };
import * as imagesMaskGeometry from './fixtures/images-mask-geometry.js';
import imagesMaskGeometryGT from './fixtures/images-mask-geometry.json' with { type: 'json' };
import * as vectorsRectangle from './fixtures/vectors-rectangle.js';
import vectorsRectangleGT from './fixtures/vectors-rectangle.json' with { type: 'json' };
import * as imagesInline from './fixtures/images-inline.js';
import imagesInlineGT from './fixtures/images-inline.json' with { type: 'json' };
import * as extractSingleClean from './fixtures/extract-single-clean.js';
import extractSingleCleanGT from './fixtures/extract-single-clean.json' with { type: 'json' };
import * as extractMasked from './fixtures/extract-masked.js';
import extractMaskedGT from './fixtures/extract-masked.json' with { type: 'json' };
import * as extractCluster from './fixtures/extract-cluster.js';
import extractClusterGT from './fixtures/extract-cluster.json' with { type: 'json' };
import * as extractVectorOnly from './fixtures/extract-vector-only.js';
import extractVectorOnlyGT from './fixtures/extract-vector-only.json' with { type: 'json' };
import * as extractDecorated3pages from './fixtures/extract-decorated-3pages.js';
import extractDecorated3pagesGT from './fixtures/extract-decorated-3pages.json' with { type: 'json' };
import * as extractJpx from './fixtures/extract-jpx.js';
import extractJpxGT from './fixtures/extract-jpx.json' with { type: 'json' };
import * as extractBleed from './fixtures/extract-bleed.js';
import extractBleedGT from './fixtures/extract-bleed.json' with { type: 'json' };
import * as extractIndependentTouching from './fixtures/extract-independent-touching.js';
import extractIndependentTouchingGT from './fixtures/extract-independent-touching.json' with { type: 'json' };
import * as extractAnchorLooseFragment from './fixtures/extract-anchor-loose-fragment.js';
import extractAnchorLooseFragmentGT from './fixtures/extract-anchor-loose-fragment.json' with { type: 'json' };
import * as extractSharedResourceMultipage from './fixtures/extract-shared-resource-multipage.js';
import extractSharedResourceMultipageGT from './fixtures/extract-shared-resource-multipage.json' with { type: 'json' };
import * as layout1col from './fixtures/layout-1col.js';
import layout1colGT from './fixtures/layout-1col.json' with { type: 'json' };
import * as layout2col from './fixtures/layout-2col.js';
import layout2colGT from './fixtures/layout-2col.json' with { type: 'json' };
import * as layout3col from './fixtures/layout-3col.js';
import layout3colGT from './fixtures/layout-3col.json' with { type: 'json' };
import * as layout2colSpanning from './fixtures/layout-2col-spanning.js';
import layout2colSpanningGT from './fixtures/layout-2col-spanning.json' with { type: 'json' };
import * as layout2colSidebar from './fixtures/layout-2col-sidebar.js';
import layout2colSidebarGT from './fixtures/layout-2col-sidebar.json' with { type: 'json' };
import * as layoutRunningHeads from './fixtures/layout-running-heads.js';
import layoutRunningHeadsGT from './fixtures/layout-running-heads.json' with { type: 'json' };
import * as layoutTocDotleaders from './fixtures/layout-toc-dotleaders.js';
import layoutTocDotleadersGT from './fixtures/layout-toc-dotleaders.json' with { type: 'json' };
import * as layoutStatblockFramed from './fixtures/layout-statblock-framed.js';
import layoutStatblockFramedGT from './fixtures/layout-statblock-framed.json' with { type: 'json' };
import * as layoutStatblockPlain from './fixtures/layout-statblock-plain.js';
import layoutStatblockPlainGT from './fixtures/layout-statblock-plain.json' with { type: 'json' };
import * as fontsNoSuffix from './fixtures/fonts-no-suffix.js';
import fontsNoSuffixGT from './fixtures/fonts-no-suffix.json' with { type: 'json' };
import * as fontsSubsetPrefix from './fixtures/fonts-subset-prefix.js';
import fontsSubsetPrefixGT from './fixtures/fonts-subset-prefix.json' with { type: 'json' };
import * as textFragmented75 from './fixtures/text-fragmented-75.js';
import textFragmented75GT from './fixtures/text-fragmented-75.json' with { type: 'json' };
import * as textFragmented20 from './fixtures/text-fragmented-20.js';
import textFragmented20GT from './fixtures/text-fragmented-20.json' with { type: 'json' };
import * as textEmptyItems from './fixtures/text-empty-items.js';
import textEmptyItemsGT from './fixtures/text-empty-items.json' with { type: 'json' };
import * as textPositionalDuplicates from './fixtures/text-positional-duplicates.js';
import textPositionalDuplicatesGT from './fixtures/text-positional-duplicates.json' with { type: 'json' };
import * as textRotatedMarginalia from './fixtures/text-rotated-marginalia.js';
import textRotatedMarginaliaGT from './fixtures/text-rotated-marginalia.json' with { type: 'json' };
import * as textRotatedExtreme from './fixtures/text-rotated-extreme.js';
import textRotatedExtremeGT from './fixtures/text-rotated-extreme.json' with { type: 'json' };
import * as textBrokenToUnicode from './fixtures/text-broken-tounicode.js';
import textBrokenToUnicodeGT from './fixtures/text-broken-tounicode.json' with { type: 'json' };
import * as textCombiningDiacritics from './fixtures/text-combining-diacritics.js';
import textCombiningDiacriticsGT from './fixtures/text-combining-diacritics.json' with { type: 'json' };
import * as textLigaturesHyphenation from './fixtures/text-ligatures-hyphenation.js';
import textLigaturesHyphenationGT from './fixtures/text-ligatures-hyphenation.json' with { type: 'json' };

function make(mod: { build(): Buffer }, gt: FixtureGroundTruth): Fixture {
  return { id: gt.id, build: mod.build, groundTruth: gt };
}

export const fixtures: Fixture[] = [
  make(helloWorld, helloWorldGT as FixtureGroundTruth),
  // Grupa A — inwentaryzacja (obrazy, fonty)
  make(imagesLuminosityMask, imagesLuminosityMaskGT as FixtureGroundTruth),
  make(imagesDecorated, imagesDecoratedGT as FixtureGroundTruth),
  make(imagesBleedBackground, imagesBleedBackgroundGT as FixtureGroundTruth),
  make(imagesOverlapping, imagesOverlappingGT as FixtureGroundTruth),
  make(imagesMaskOpcode, imagesMaskOpcodeGT as FixtureGroundTruth),
  make(imagesMaskGeometry, imagesMaskGeometryGT as FixtureGroundTruth),
  make(vectorsRectangle, vectorsRectangleGT as FixtureGroundTruth),
  make(imagesInline, imagesInlineGT as FixtureGroundTruth),
  // Grupa D — klasyfikacja i ekstrakcja obrazow (faza 3)
  make(extractSingleClean, extractSingleCleanGT as FixtureGroundTruth),
  make(extractMasked, extractMaskedGT as FixtureGroundTruth),
  make(extractCluster, extractClusterGT as FixtureGroundTruth),
  make(extractVectorOnly, extractVectorOnlyGT as FixtureGroundTruth),
  make(extractDecorated3pages, extractDecorated3pagesGT as FixtureGroundTruth),
  make(extractJpx, extractJpxGT as FixtureGroundTruth),
  make(extractBleed, extractBleedGT as FixtureGroundTruth),
  make(extractIndependentTouching, extractIndependentTouchingGT as FixtureGroundTruth),
  make(extractAnchorLooseFragment, extractAnchorLooseFragmentGT as FixtureGroundTruth),
  make(extractSharedResourceMultipage, extractSharedResourceMultipageGT as FixtureGroundTruth),
  // Grupa C — uklad (kolumny, kolejnosc czytania, bloki semantyczne)
  make(layout1col, layout1colGT as FixtureGroundTruth),
  make(layout2col, layout2colGT as FixtureGroundTruth),
  make(layout3col, layout3colGT as FixtureGroundTruth),
  make(layout2colSpanning, layout2colSpanningGT as FixtureGroundTruth),
  make(layout2colSidebar, layout2colSidebarGT as FixtureGroundTruth),
  make(layoutRunningHeads, layoutRunningHeadsGT as FixtureGroundTruth),
  make(layoutTocDotleaders, layoutTocDotleadersGT as FixtureGroundTruth),
  make(layoutStatblockFramed, layoutStatblockFramedGT as FixtureGroundTruth),
  make(layoutStatblockPlain, layoutStatblockPlainGT as FixtureGroundTruth),
  make(fontsNoSuffix, fontsNoSuffixGT as FixtureGroundTruth),
  make(fontsSubsetPrefix, fontsSubsetPrefixGT as FixtureGroundTruth),
  // Grupa B — higiena i scalanie tekstu
  make(textFragmented75, textFragmented75GT as FixtureGroundTruth),
  make(textFragmented20, textFragmented20GT as FixtureGroundTruth),
  make(textEmptyItems, textEmptyItemsGT as FixtureGroundTruth),
  make(textPositionalDuplicates, textPositionalDuplicatesGT as FixtureGroundTruth),
  make(textRotatedMarginalia, textRotatedMarginaliaGT as FixtureGroundTruth),
  make(textRotatedExtreme, textRotatedExtremeGT as FixtureGroundTruth),
  make(textBrokenToUnicode, textBrokenToUnicodeGT as FixtureGroundTruth),
  make(textCombiningDiacritics, textCombiningDiacriticsGT as FixtureGroundTruth),
  make(textLigaturesHyphenation, textLigaturesHyphenationGT as FixtureGroundTruth),
];

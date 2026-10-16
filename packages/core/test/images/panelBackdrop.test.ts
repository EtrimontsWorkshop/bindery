import { describe, expect, it } from 'vitest';
import { drawnShare, isBareDarkTexture, isColorfulPicture, isDrawingOnPanel, isPanelBackdrop, type PanelEvidence } from '../../src/images/panelBackdrop.js';

const textureLook = { meanLuminance: 40, luminanceStdDev: 20, meanSaturation: 12 };
const panelWithText: PanelEvidence = { translucent: true, masked: false, opaqueFraction: 1, textCoverage: 0.5, extractedRaw: true, confidence: 0.9, look: textureLook };
const bareTexture: PanelEvidence = { translucent: true, masked: false, opaqueFraction: 1, textCoverage: 0, extractedRaw: true, confidence: 0.5, look: textureLook };

describe('isPanelBackdrop: a translucent rectangle with the page text on it', () => {
  it('is recognized, even when the classifier was sure', () => {
    expect(isPanelBackdrop(panelWithText)).toBe(true);
    expect(isPanelBackdrop({ ...panelWithText, textCoverage: 0.16 })).toBe(true);
  });

  it('is not taken when the raster is light or a render of a region: an emblem or a seal painted translucent is a picture', () => {
    expect(isPanelBackdrop({ ...panelWithText, look: { meanLuminance: 190, luminanceStdDev: 80, meanSaturation: 14 } })).toBe(false);
    expect(isPanelBackdrop({ ...panelWithText, extractedRaw: false, look: null })).toBe(false);
  });

  it('is not taken when the picture is painted opaque', () => {
    expect(isPanelBackdrop({ ...panelWithText, translucent: false })).toBe(false);
  });

  it('is not taken for a crest or a faded figure: its raster has a transparent surround', () => {
    expect(isPanelBackdrop({ ...panelWithText, opaqueFraction: 0.4 })).toBe(false);
  });

  it('is not taken with hardly any text on it, unless it is a bare texture', () => {
    expect(isPanelBackdrop({ ...panelWithText, textCoverage: 0.05 })).toBe(false);
  });

  it('leaves a masked shape to the other rules and an unmeasured raster undecided', () => {
    expect(isPanelBackdrop({ ...panelWithText, masked: true })).toBe(false);
    expect(isPanelBackdrop({ ...panelWithText, opaqueFraction: null })).toBe(false);
  });
});

describe('isPanelBackdrop: a bare dark texture', () => {
  it('is recognized when translucent, whatever lies on it', () => {
    expect(isPanelBackdrop(bareTexture)).toBe(true);
  });

  it('is recognized when opaque, covered by page text and very smooth; a dark illustration among text (spread 34) is not', () => {
    expect(isPanelBackdrop({ ...bareTexture, translucent: false, textCoverage: 0.2, look: { ...textureLook, luminanceStdDev: 27 } })).toBe(true);
    expect(isPanelBackdrop({ ...bareTexture, translucent: false, textCoverage: 0.2, look: { ...textureLook, luminanceStdDev: 34 } })).toBe(false);
  });

  it('is not taken when opaque with no text on it: a dark photograph looks the same by its pixels', () => {
    expect(isPanelBackdrop({ ...bareTexture, translucent: false })).toBe(false);
  });

  it('is not taken from a render of a region, nor when the classifier was sure, nor when it has a figure', () => {
    expect(isPanelBackdrop({ ...bareTexture, extractedRaw: false })).toBe(false);
    expect(isPanelBackdrop({ ...bareTexture, confidence: 0.9 })).toBe(false);
    expect(isPanelBackdrop({ ...bareTexture, look: { ...textureLook, luminanceStdDev: 60 } })).toBe(false);
  });
});

describe('isBareDarkTexture', () => {
  it('needs a dark, evenly spread, hardly saturated raster', () => {
    expect(isBareDarkTexture(textureLook)).toBe(true);
    expect(isBareDarkTexture({ ...textureLook, meanLuminance: 120 })).toBe(false);
    expect(isBareDarkTexture({ ...textureLook, meanSaturation: 60 })).toBe(false);
  });
});

function solid(width: number, height: number, luminance: number): { width: number; height: number; rgba: Uint8ClampedArray } {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba.set([luminance, luminance, luminance, 255], i);
  return { width, height, rgba };
}

describe('drawnShare', () => {
  it('is zero when the render is just the texture under a translucent paint over a brighter page', () => {
    // A raster with a pattern, shown at a lower contrast over a lifted background: a straight line fits it exactly.
    const raw = solid(64, 64, 0);
    const render = solid(64, 64, 0);
    for (let i = 0; i < 64 * 64; i++) {
      const v = (i * 37) % 90;
      raw.rgba.set([v, v, v, 255], i * 4);
      render.rgba.set([60 + v * 0.4, 60 + v * 0.4, 60 + v * 0.4, 255], i * 4);
    }
    expect(drawnShare(render, raw)).toBe(0);
  });

  it('counts the lines and labels drawn over the texture', () => {
    const raw = solid(64, 64, 30);
    const render = solid(64, 64, 40);
    for (let x = 0; x < 64; x++) render.rgba.set([200, 200, 200, 255], (10 * 64 + x) * 4);
    expect(drawnShare(render, raw)).toBeCloseTo(1 / 64, 5);
  });

  it('copes with a render and a raster of different sizes', () => {
    expect(drawnShare(solid(32, 16, 40), solid(100, 70, 30))).toBe(0);
  });
});

describe('isDrawingOnPanel', () => {
  it('needs something drawn and hardly any text on the panel', () => {
    expect(isDrawingOnPanel({ textCoverage: 0.02, drawnShare: 0.1 })).toBe(true);
    expect(isDrawingOnPanel({ textCoverage: 0.02, drawnShare: 0 })).toBe(false);
    expect(isDrawingOnPanel({ textCoverage: 0.1, drawnShare: 0.1 })).toBe(false);
  });
});

describe('isColorfulPicture', () => {
  it('tells a colorful map from a panel or a paper wash by saturation', () => {
    expect(isColorfulPicture({ meanLuminance: 75, luminanceStdDev: 45, meanSaturation: 43 })).toBe(true);
    expect(isColorfulPicture({ meanLuminance: 40, luminanceStdDev: 20, meanSaturation: 12 })).toBe(false);
    expect(isColorfulPicture({ meanLuminance: 154, luminanceStdDev: 40, meanSaturation: 18 })).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { probeRawLook, type PdfPageForExtract } from '../../src/images/extract.js';

/** A sheet of plain light paper, 100x100, with a dark ground 10 px wide round its edges (RGBA, as pdf.js decodes it). */
function sheetOnDarkGround(): { width: number; height: number; kind: number; data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(100 * 100 * 4);
  for (let y = 0; y < 100; y++) {
    for (let x = 0; x < 100; x++) {
      const edge = x < 10 || y < 10 || x >= 90 || y >= 90;
      data.set(edge ? [30, 30, 30, 255] : [230, 220, 200, 255], (y * 100 + x) * 4);
    }
  }
  return { width: 100, height: 100, kind: 3, data };
}

function pageWith(objId: string, raw: unknown): PdfPageForExtract {
  const none = { has: () => false, get: () => undefined };
  return {
    objs: { has: (id: string) => id === objId, get: (_id: string, callback: (data: unknown) => void) => callback(raw) },
    commonObjs: none,
    getOperatorList: async () => ({}),
  } as unknown as PdfPageForExtract;
}

describe('probeRawLook', () => {
  it('looks at the whole raster, or with an inset only at its middle', async () => {
    const page = pageWith('img_1', sheetOnDarkGround());
    const whole = await probeRawLook(page, 'img_1');
    const middle = await probeRawLook(page, 'img_1', 0.15);
    expect(whole!.luminanceStdDev).toBeGreaterThan(50);
    expect(middle!.luminanceStdDev).toBeLessThan(1);
    expect(middle!.meanLuminance).toBeGreaterThan(200);
  });

  it('is null for a resource the page does not have', async () => {
    expect(await probeRawLook(pageWith('img_1', sheetOnDarkGround()), 'img_2')).toBeNull();
  });
});

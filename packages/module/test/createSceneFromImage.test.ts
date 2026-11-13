import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSceneFromImage } from '../src/documents/createSceneFromImage.js';

const input = { name: 'Map', imagePath: 'worlds/test/map.webp', width: 1000, height: 800, grid: { size: 100, offsetX: 0, offsetY: 0 } };

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubScene(updateEmbeddedDocuments: () => Promise<unknown>) {
  const scene = { uuid: 'Scene.1', updateEmbeddedDocuments: vi.fn(updateEmbeddedDocuments), delete: vi.fn(async () => undefined) };
  vi.stubGlobal('foundry', { documents: { Scene: { create: vi.fn(async () => scene) } } });
  return scene;
}

describe('createSceneFromImage', () => {
  it('sets the background on the default level and keeps the scene', async () => {
    const scene = stubScene(async () => []);
    await expect(createSceneFromImage(input)).resolves.toBe(scene);
    expect(scene.updateEmbeddedDocuments).toHaveBeenCalledWith('Level', [{ _id: 'defaultLevel0000', name: 'Map', background: { src: input.imagePath } }]);
    expect(scene.delete).not.toHaveBeenCalled();
  });

  it('removes the scene when its background cannot be set, and reports the failure', async () => {
    const scene = stubScene(async () => {
      throw new Error('no level');
    });
    await expect(createSceneFromImage(input)).rejects.toThrow('no level');
    expect(scene.delete).toHaveBeenCalledTimes(1);
  });
});

import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectDocument } from '../src/inspect.js';
import { openPdf, withPdf } from '../src/pdfDocument.js';
import { buildPagesForDetection } from '../src/statblock/pdf/buildPagesForDetection.js';
import { build as buildSingleClean } from './synth/fixtures/extract-single-clean.js';

// Every pdf.js loading task started during a test is recorded, so that the tests can check that each one was
// destroyed — i.e. that its worker and the document held by it were released.
const tracked = vi.hoisted(() => ({
  tasks: [] as Array<{ destroyed: boolean; destroy(): Promise<void> }>,
  failDestroy: false,
}));

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', async (importOriginal) => {
  const mod = await importOriginal<typeof import('pdfjs-dist/legacy/build/pdf.mjs')>();
  return {
    ...mod,
    getDocument: (src: Parameters<typeof mod.getDocument>[0]) => {
      const task = mod.getDocument(src);
      tracked.tasks.push(task);
      if (tracked.failDestroy) {
        const real = task.destroy.bind(task);
        task.destroy = async () => {
          await real();
          throw new Error('releasing failed');
        };
      }
      return task;
    },
  };
});

// In Node pdf.js runs its worker in-process but still imports it from `workerSrc`, so the base must point at a
// real pdf.js build directory.
const ASSETS = `${pathToFileURL(resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../node_modules/pdfjs-dist/legacy/build')).href}/`;

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

const pdf = () => toArrayBuffer(buildSingleClean());
const garbage = () => new TextEncoder().encode('this is not a pdf file at all').buffer as ArrayBuffer;

beforeEach(() => {
  tracked.tasks.length = 0;
  tracked.failDestroy = false;
});

describe('releasing PDF documents', () => {
  it('withPdf releases the document after the work returned', async () => {
    const pages = await withPdf(pdf(), ASSETS, async (doc) => doc.numPages);
    expect(pages).toBe(1);
    expect(tracked.tasks).toHaveLength(1);
    expect(tracked.tasks[0]!.destroyed).toBe(true);
  });

  it('withPdf releases the document when the work throws, and the original error reaches the caller', async () => {
    await expect(
      withPdf(pdf(), ASSETS, async () => {
        throw new Error('stage failed');
      }),
    ).rejects.toThrow('stage failed');
    expect(tracked.tasks[0]!.destroyed).toBe(true);
  });

  it('withPdf releases the document when the work is aborted', async () => {
    await expect(
      withPdf(pdf(), ASSETS, async () => {
        throw new DOMException('aborted', 'AbortError');
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(tracked.tasks[0]!.destroyed).toBe(true);
  });

  it('openPdf releases the loading task when the file cannot be loaded, and rethrows', async () => {
    await expect(openPdf(garbage(), ASSETS)).rejects.toBeDefined();
    expect(tracked.tasks).toHaveLength(1);
    expect(tracked.tasks[0]!.destroyed).toBe(true);
  });

  it('destroy is idempotent: the task is destroyed once, however often it is called', async () => {
    const opened = await openPdf(pdf(), ASSETS);
    const destroySpy = vi.spyOn(tracked.tasks[0]!, 'destroy');
    await opened.destroy();
    await opened.destroy();
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it('a failing release does not hide the result of the work', async () => {
    tracked.failDestroy = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(withPdf(pdf(), ASSETS, async (doc) => doc.numPages)).resolves.toBe(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a failing release does not hide the error of the work', async () => {
    tracked.failDestroy = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      withPdf(pdf(), ASSETS, async () => {
        throw new Error('stage failed');
      }),
    ).rejects.toThrow('stage failed');
    warn.mockRestore();
  });

  it('inspectDocument releases its document, also for a file that cannot be loaded', async () => {
    const summary = await inspectDocument(pdf(), { assetBaseUrl: ASSETS });
    expect(summary.pageCount).toBe(1);
    expect(tracked.tasks).toHaveLength(1);
    expect(tracked.tasks.every((t) => t.destroyed)).toBe(true);

    tracked.tasks.length = 0;
    await expect(inspectDocument(garbage(), { assetBaseUrl: ASSETS })).rejects.toBeDefined();
    expect(tracked.tasks).toHaveLength(1);
    expect(tracked.tasks.every((t) => t.destroyed)).toBe(true);
  });

  it('buildPagesForDetection opens two documents and releases both', async () => {
    const pages = await buildPagesForDetection(pdf(), { assetBaseUrl: ASSETS });
    expect(pages).toHaveLength(1);
    expect(tracked.tasks).toHaveLength(2);
    expect(tracked.tasks.every((t) => t.destroyed)).toBe(true);
  });

  it('buildPagesForDetection releases the documents it has opened when it is aborted between its stages', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(buildPagesForDetection(pdf(), { assetBaseUrl: ASSETS, signal: controller.signal })).rejects.toBeDefined();
    expect(tracked.tasks.length).toBeGreaterThan(0);
    expect(tracked.tasks.every((t) => t.destroyed)).toBe(true);
  });

  it('only one document is alive at a time while a pipeline runs its stages', async () => {
    let maxAlive = 0;
    const originalWork = async (doc: { numPages: number }) => {
      maxAlive = Math.max(maxAlive, tracked.tasks.filter((t) => !t.destroyed).length);
      return doc.numPages;
    };
    await withPdf(pdf(), ASSETS, originalWork);
    await withPdf(pdf(), ASSETS, originalWork);
    await withPdf(pdf(), ASSETS, originalWork);
    expect(tracked.tasks).toHaveLength(3);
    expect(maxAlive).toBe(1);
  });
});

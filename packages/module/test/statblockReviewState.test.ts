import { beforeEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({
  buildPagesForDetection: vi.fn(),
  detectStatblocks: vi.fn(),
}));

vi.mock('@bindery/core', () => ({
  buildPagesForDetection: core.buildPagesForDetection,
  detectStatblocks: core.detectStatblocks,
  findNearestImage: () => undefined,
  validateProfile: (profile: unknown) => ({ ok: true, profile }),
}));
vi.mock('../src/settings.js', () => ({ ASSET_BASE_URL: 'modules/bindery-pdf-importer/lib/' }));
vi.mock('../src/statblock/import/importStatblocks.js', () => ({ importStatblocks: vi.fn() }));
vi.mock('../src/statblock/profile/store.js', () => ({
  listProfiles: () => [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ],
}));

const { StatblockReviewState } = await import('../src/statblock/ui/statblockReviewState.js');

/** A promise with its resolve/reject exposed, to finish the PDF read when the test says so. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const candidate = (id: string) => ({ id, regions: [{ pageNumber: 1 }], elements: [{ text: id }], confidence: 1, missingRequiredLabels: [], meetsRequirements: true });

beforeEach(() => {
  core.buildPagesForDetection.mockReset();
  core.detectStatblocks.mockReset();
  core.detectStatblocks.mockImplementation((_pages: unknown, profile: { id: string }) => [candidate(`from-${profile.id}`)]);
});

describe('StatblockReviewState.selectProfile', () => {
  it('reads the PDF once when the profile changes while it is being read, and keeps the rows of the latest choice', async () => {
    const pages = deferred<unknown[]>();
    core.buildPagesForDetection.mockReturnValue(pages.promise);
    const state = new StatblockReviewState(new ArrayBuffer(8), [], () => undefined);

    const first = state.selectProfile('a');
    const second = state.selectProfile('b');
    pages.resolve([]);
    await Promise.all([first, second]);

    expect(core.buildPagesForDetection).toHaveBeenCalledTimes(1);
    expect(state.selectedProfileId).toBe('b');
    expect(state.rows?.map((r) => r.id)).toEqual(['from-b']);
    expect(state.busy).toBe(false);
  });

  it('tries the read again after it failed', async () => {
    core.buildPagesForDetection.mockRejectedValueOnce(new Error('broken')).mockResolvedValueOnce([]);
    const state = new StatblockReviewState(new ArrayBuffer(8), [], () => undefined);
    await state.selectProfile('a');
    expect(state.issues).toEqual(['Error: broken']);
    await state.selectProfile('a');
    expect(state.issues).toEqual([]);
    expect(state.rows?.map((r) => r.id)).toEqual(['from-a']);
  });

  it('stops reading the PDF and stays silent once disposed', async () => {
    const pages = deferred<unknown[]>();
    core.buildPagesForDetection.mockReturnValue(pages.promise);
    const onChange = vi.fn();
    const state = new StatblockReviewState(new ArrayBuffer(8), [], onChange);

    const selection = state.selectProfile('a');
    const signal = (core.buildPagesForDetection.mock.calls[0]![1] as { signal: AbortSignal }).signal;
    const changesBefore = onChange.mock.calls.length;
    state.dispose();
    expect(signal.aborted).toBe(true);
    pages.reject(new DOMException('Aborted', 'AbortError'));
    await selection;

    expect(onChange.mock.calls.length).toBe(changesBefore);
    expect(state.issues).toEqual([]);
  });
});

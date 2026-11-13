import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/settings.js', () => ({ MODULE_ID: 'bindery-pdf-importer' }));
vi.mock('../src/documents/whiteBackground.js', () => ({ withWhiteBackground: vi.fn(async (input: unknown) => input) }));

const { UploadSession, sanitizeBaseName, uniqueFileName, uploadImage } = await import('../src/documents/uploadImages.js');

const UPLOAD_PATH = 'worlds/test/bindery-imports';

let filePicker: {
  createDirectory: ReturnType<typeof vi.fn>;
  browse: ReturnType<typeof vi.fn>;
  upload: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  filePicker = {
    createDirectory: vi.fn(async () => {
      throw new Error('already exists');
    }),
    browse: vi.fn(async () => ({ files: [`${UPLOAD_PATH}/book-a.webp`] })),
    upload: vi.fn(async (_source: string, path: string, file: File) => ({ path: `${path}/${file.name}` })),
  };
  vi.stubGlobal('foundry', { applications: { apps: { FilePicker: { implementation: filePicker } } } });
  vi.stubGlobal('game', { settings: { get: (_module: string, key: string) => (key === 'uploadPath' ? UPLOAD_PATH : false) } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const image = (baseName: string) => ({ bytes: new Uint8Array([1, 2, 3]), baseName, format: 'webp' as const });

describe('uniqueFileName', () => {
  it('adds the first free numeric suffix', () => {
    expect(uniqueFileName('a', 'webp', new Set())).toBe('a.webp');
    expect(uniqueFileName('a', 'webp', new Set(['a.webp', 'a-1.webp']))).toBe('a-2.webp');
  });
});

describe('uploadImage with an UploadSession', () => {
  it('creates and browses the folder once for the whole import', async () => {
    const session = new UploadSession();
    for (let i = 0; i < 5; i++) await uploadImage(image(`book-${i}`), { session });
    // One call per level of `worlds/test/bindery-imports`, once.
    expect(filePicker.createDirectory).toHaveBeenCalledTimes(3);
    expect(filePicker.browse).toHaveBeenCalledTimes(1);
    expect(filePicker.upload).toHaveBeenCalledTimes(5);
  });

  it('never gives two uploads of one import the same name', async () => {
    const session = new UploadSession();
    const first = await uploadImage(image('book-a'), { session });
    const second = await uploadImage(image('book-a'), { session });
    expect(first.path).toBe(`${UPLOAD_PATH}/book-a-1.webp`); // book-a.webp was already in the folder
    expect(second.path).toBe(`${UPLOAD_PATH}/book-a-2.webp`);
  });

  it('without a session, browses the folder for every upload (the old behaviour)', async () => {
    await uploadImage(image('x'));
    await uploadImage(image('y'));
    expect(filePicker.browse).toHaveBeenCalledTimes(2);
  });

  it('sanitizes the file name', async () => {
    const result = await uploadImage(image('Księga Łowcy: map/../1'), { session: new UploadSession() });
    expect(result.path).toBe(`${UPLOAD_PATH}/Ksiega_Lowcy_map_1.webp`);
  });
});

describe('uploadImage when the folder cannot be listed', () => {
  it('gives every file a suffix of the import instead of taking a name that may exist', async () => {
    filePicker.browse.mockRejectedValue(new Error('no listing'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const session = new UploadSession();
    const first = await uploadImage(image('book-a'), { session });
    const second = await uploadImage(image('book-a'), { session });
    expect(first.path).toBe(`${UPLOAD_PATH}/book-a-${session.unlistedSuffix}.webp`);
    expect(second.path).toBe(`${UPLOAD_PATH}/book-a-${session.unlistedSuffix}-1.webp`);
    expect(session.unlistedSuffix).toMatch(/^[0-9a-z]+$/);
  });
});

describe('uploadImage and the storage setting', () => {
  const withSettings = (values: Record<string, unknown>): void => {
    vi.stubGlobal('game', { settings: { get: (_module: string, key: string) => (key === 'uploadPath' ? UPLOAD_PATH : (values[key] ?? false)) } });
  };

  it('uses the local data folder by default', async () => {
    await uploadImage(image('x'));
    expect(filePicker.upload.mock.calls[0]?.[0]).toBe('data');
    expect(filePicker.upload.mock.calls[0]?.[3]).toEqual({});
  });

  it('passes the chosen storage and bucket to every call', async () => {
    withSettings({ uploadSource: 's3', uploadBucket: ' my-bucket ' });
    await uploadImage(image('x'));
    expect(filePicker.createDirectory.mock.calls[0]).toEqual(['s3', 'worlds', { bucket: 'my-bucket' }]);
    expect(filePicker.browse.mock.calls[0]).toEqual(['s3', UPLOAD_PATH, { bucket: 'my-bucket' }]);
    expect(filePicker.upload.mock.calls[0]?.[0]).toBe('s3');
    expect(filePicker.upload.mock.calls[0]?.[3]).toEqual({ bucket: 'my-bucket' });
  });

  it('knows a listed name that comes URL-encoded', async () => {
    filePicker.browse.mockResolvedValue({ files: [`${UPLOAD_PATH}/%D0%BA%D0%B0%D1%80%D1%82%D0%B0.webp`] });
    const result = await uploadImage(image('карта'));
    expect(result.path).toBe(`${UPLOAD_PATH}/карта-1.webp`);
  });
});

describe('sanitizeBaseName', () => {
  it('keeps letters and digits of other scripts', () => {
    expect(sanitizeBaseName('Карта подземелья №2')).toBe('Карта_подземелья_No2');
    expect(sanitizeBaseName('地図 その1')).toBe('地図_その1');
    expect(sanitizeBaseName('й')).toBe('й');
  });

  it('caps the length without cutting a character in half', () => {
    const long = sanitizeBaseName('😀'.repeat(5) + 'ż'.repeat(200));
    expect([...long].length).toBe(60);
    expect(long).toBe('z'.repeat(60));
    expect([...sanitizeBaseName('𠀀'.repeat(200))].length).toBe(60);
  });

  it('falls back to "image" when nothing is left', () => {
    expect(sanitizeBaseName('***')).toBe('image');
  });
});

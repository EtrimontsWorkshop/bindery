/**
 * Domkniecie luki opisanej w RAPORT-FAZA-1.md: `page.objs.get()` zwraca RoZNE
 * ksztalty zaleznie od srodowiska — `{ bitmap: ImageBitmap }` w przegladarce
 * (Foundry), `{ kind, data: Uint8ClampedArray }` w Node (fazy 0 spike). Bez tej
 * normalizacji golden testy dzialalyby w Node, a produkcja w przegladarce — czyli
 * nie sprawdzalyby tego, co sie naprawde wykonuje.
 */

/** Kanoniczna reprezentacja zdekodowanego obrazu, niezalezna od srodowiska. */
export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, 4 bajty na piksel. */
  rgba: Uint8ClampedArray;
}

// Stale zweryfikowane empirycznie w fazie 0 (KROK-1 spike, pdfjs-dist 6.1.200).
const IMAGE_KIND_GRAYSCALE_1BPP = 1;
const IMAGE_KIND_RGB_24BPP = 2;
const IMAGE_KIND_RGBA_32BPP = 3;

interface KindDataShape {
  [key: string]: unknown;
  width: number;
  height: number;
  kind: number;
  data: Uint8ClampedArray | Uint8Array;
}

interface BitmapShape {
  [key: string]: unknown;
  width: number;
  height: number;
  bitmap: unknown;
}

function isKindDataShape(img: Record<string, unknown>): img is KindDataShape {
  return typeof img['kind'] === 'number' && img['data'] != null;
}

function isBitmapShape(img: Record<string, unknown>): img is BitmapShape {
  return img['bitmap'] != null;
}

function normalizeFromKindData(img: KindDataShape): DecodedImage {
  const { width, height, kind, data } = img;

  if (kind === IMAGE_KIND_RGBA_32BPP) {
    return { width, height, rgba: Uint8ClampedArray.from(data) };
  }

  if (kind === IMAGE_KIND_RGB_24BPP) {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let px = 0; px < width * height; px++) {
      rgba[px * 4] = data[px * 3]!;
      rgba[px * 4 + 1] = data[px * 3 + 1]!;
      rgba[px * 4 + 2] = data[px * 3 + 2]!;
      rgba[px * 4 + 3] = 255;
    }
    return { width, height, rgba };
  }

  if (kind === IMAGE_KIND_GRAYSCALE_1BPP) {
    const rgba = new Uint8ClampedArray(width * height * 4);
    const bytesPerRow = Math.ceil(width / 8);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const byte = data[y * bytesPerRow + (x >> 3)]!;
        const bit = (byte >> (7 - (x & 7))) & 1;
        const v = bit ? 255 : 0;
        const px = (y * width + x) * 4;
        rgba[px] = v;
        rgba[px + 1] = v;
        rgba[px + 2] = v;
        rgba[px + 3] = 255;
      }
    }
    return { width, height, rgba };
  }

  throw new Error(`normalizeDecodedImage: nieobslugiwany kind=${kind}`);
}

function normalizeFromBitmap(img: BitmapShape): DecodedImage {
  // OffscreenCanvas jest standardem platformy webowej (nie API Foundry) — jego
  // uzycie tutaj nie lamie zalozenia A1. Ale jest dostepny tylko w przegladarce;
  // w Node (testy jednostkowe) rzuca czytelny blad zamiast cichego zawieszenia —
  // rzeczywiste rysowanie na canvasie zostaje faza 3 (patrz KROK-3-fixtures.md, Z6).
  const OffscreenCanvasCtor = (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas as
    | (new (w: number, h: number) => {
        getContext(id: '2d'): {
          drawImage(bitmap: unknown, dx: number, dy: number): void;
          getImageData(sx: number, sy: number, sw: number, sh: number): { data: Uint8ClampedArray };
        } | null;
      })
    | undefined;

  if (!OffscreenCanvasCtor) {
    throw new Error(
      'normalizeDecodedImage: OffscreenCanvas niedostepny w tym srodowisku (prawdopodobnie Node) — ' +
        'rysowanie ImageBitmap na canvasie to zakres fazy 3, nie fazy 1.',
    );
  }

  const canvas = new OffscreenCanvasCtor(img.width, img.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('normalizeDecodedImage: nie udalo sie utworzyc kontekstu 2D dla OffscreenCanvas');
  }
  ctx.drawImage(img.bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, img.width, img.height);
  return { width: img.width, height: img.height, rgba: imageData.data };
}

/**
 * Normalizuje wynik `page.objs.get()`/`page.commonObjs.get()` (dowolny z dwoch
 * ksztaltow obserwowanych empirycznie — patrz komentarz na gorze pliku) do
 * jednej kanonicznej reprezentacji RGBA.
 */
export function normalizeDecodedImage(raw: unknown): DecodedImage {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('normalizeDecodedImage: oczekiwano obiektu, otrzymano ' + typeof raw);
  }
  const img = raw as Record<string, unknown>;
  if (typeof img['width'] !== 'number' || typeof img['height'] !== 'number') {
    throw new Error('normalizeDecodedImage: brak liczbowych width/height w wejsciu');
  }

  if (isKindDataShape(img)) {
    return normalizeFromKindData(img);
  }
  if (isBitmapShape(img)) {
    return normalizeFromBitmap(img);
  }

  throw new Error('normalizeDecodedImage: nierozpoznany ksztalt wejscia (brak "data" i brak "bitmap")');
}

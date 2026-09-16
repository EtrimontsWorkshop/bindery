import type { DecodedImage } from './normalizeDecodedImage.js';

/**
 * Kodowanie do formatu docelowego (KROK-7 Z6, MDD faza 3). WebP domyslnie
 * (brief: "mapy trafiaja do kazdego gracza, rozmiar ma znaczenie"), PNG dla
 * obrazow z alfa tam, gdzie WebP zawodzi — wolajacy (orkiestrator) decyduje,
 * kiedy uzyc ktorego, ten modul tylko wykonuje.
 *
 * Ten sam wzorzec co `regionRenderer.ts` — jeden interfejs, dwie implementacje
 * (przegladarka: `OffscreenCanvas`/`convertToBlob`, tutaj; Node/testy:
 * `@napi-rs/canvas`, w `nodeCanvasImageEncoder.ts`, celowo NIEEKSPORTOWANY z
 * `index.ts` z tych samych powodow co `nodeCanvasRenderer.ts`).
 */

export type OutputFormat = 'webp' | 'png';

export interface EncodeOptions {
  format?: OutputFormat;
  /** 0-1 (konwencja Web — `HTMLCanvasElement.toBlob`/`convertToBlob`), tylko dla WebP. Ignorowane dla PNG (bezstratny). */
  quality?: number;
}

export interface EncodedImage {
  format: OutputFormat;
  bytes: Uint8Array;
}

export interface ImageEncoder {
  encode(image: DecodedImage, opts?: EncodeOptions): Promise<EncodedImage>;
}

export const DEFAULT_OUTPUT_FORMAT: OutputFormat = 'webp';
/**
 * [Skalibrowane w KROK-43 Z2, patrz `RAPORT-KROK-43.md` po metode] Zmierzone
 * na dwoch realnych obrazach z `sample/ZewCthulhu-WRAK.pdf` o ROZNYM
 * charakterze (str. 20, rozklad statku — duze plaskie/teksturowane obszary
 * nieba i lodu; str. 26, portret "Isaac Klein" — gladkie gradienty skory,
 * drobny detal) przy szesciu poziomach jakosci (0.70/0.75/0.82/0.88/0.92/0.95):
 * rozmiar pliku i sredni blad bezwzgledny na piksel (RGB) wzgledem oryginalu
 * PO ponownym zdekodowaniu WebP.
 *
 * [odkrycie, zaskakujace wzgledem zalozenia z briefu] Malowana, TEKSTUROWANA
 * ilustracja (rozklad statku) jest BARDZIEJ tolerancyjna na kompresje, nie
 * MNIEJ — wlasny szum/teksturowanie pedzla maskuje artefakty blokowe tak
 * skutecznie, ze q=0.70 i q=0.95 sa wizualnie NIEODROZNIALNE nawet w 2x
 * przyblizeniu. Odwrotnie: GLADKIE gradienty skory na portrecie sa
 * NAJBARDZIEJ czulym przypadkiem — przy q=0.70 widoczna "klockowatosc" przy
 * krawedziach (ucho/policzek), znikajaca calkowicie przy q=0.82; q=0.95
 * wyglada IDENTYCZNIE jak q=0.82 (potwierdzone wizualnie), ale plik ponad 2x
 * wiekszy (79KB vs 37KB dla tego wycinka) — czysty koszt bez korzysci.
 *
 * `0.82` (wartosc pierwotna, "z briefu") lezy WLASNIE na granicy, gdzie
 * artefakty na najczulszym przypadku (portret) znikaja, bez marnowania
 * bajtow na jakosc juz niezauwazalna — potwierdzone wizualnie przez
 * wlasciciela produktu (`AskUserQuestion`, KROK-43). Rozdzielenie per
 * przeznaczenie (mapa vs token) ROZWAZONE i ODRZUCONE: gdyby cokolwiek,
 * zaleznosc jest ODWROTNA od zalozenia w briefie (mapy/teksturowane sceny
 * potrzebuja MNIEJ, nie wiecej) — a jedna wartosc juz dziala dobrze dla OBU
 * skrajnych przypadkow w tej probce, wiec dodatkowa zlozonosc nie ma
 * uzasadnienia bez dalszych dowodow.
 */
export const DEFAULT_WEBP_QUALITY = 0.82;

export const browserImageEncoder: ImageEncoder = {
  async encode(image, opts = {}) {
    const format = opts.format ?? DEFAULT_OUTPUT_FORMAT;
    const OffscreenCanvasCtor = (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas as
      | (new (
          w: number,
          h: number,
        ) => {
          getContext(id: '2d'): { putImageData(data: ImageData, dx: number, dy: number): void } | null;
          convertToBlob(opts: { type: string; quality?: number }): Promise<Blob>;
        })
      | undefined;
    if (!OffscreenCanvasCtor) {
      throw new Error('browserImageEncoder: OffscreenCanvas niedostepny w tym srodowisku (prawdopodobnie Node) — uzyj nodeCanvasImageEncoder w testach.');
    }
    const canvas = new OffscreenCanvasCtor(image.width, image.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('browserImageEncoder: nie udalo sie utworzyc kontekstu 2D dla OffscreenCanvas');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height), 0, 0);
    const blob = await canvas.convertToBlob({ type: `image/${format}`, quality: opts.quality ?? DEFAULT_WEBP_QUALITY });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { format, bytes };
  },
};

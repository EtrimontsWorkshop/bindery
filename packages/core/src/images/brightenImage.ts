import type { DecodedImage } from './normalizeDecodedImage.js';

/**
 * [na zyczenie uzytkownika, po naprawie przyciecia "Wrak"] Obrazy ujawnione
 * przez `treatFullBleedAsContent` i przyciete przez `autoCropUniformMargins`
 * strace SASIEDZTWO jasnej, "postarzanego papieru" marginesu strony, ktory w
 * PDF-ie stal OBOK ilustracji i optycznie ja rozjasnial (efekt kontrastu
 * jednoczesnego, nie zmiana pikseli). Autor zglosil to jako "eksportowane
 * obrazy sa troche za ciemne" — to swiadome, kosmetyczne odejscie od
 * wiernosci pikseli (NIE naprawa bledu dekodowania, ktorego tu nie ma), stad
 * wlasny, jawny, domyslnie wylaczony przelacznik
 * (`images.brightenAutoCroppedImages`), ograniczony WYLACZNIE do obrazow,
 * ktore faktycznie zostaly przyciete (patrz wywolanie w `buildImageExtraction.ts`).
 *
 * [Trzecia iteracja, dwa kolejne zmierzone na zywo niepowodzenia]
 *
 * 1) Sama krzywa gamma (`out=255*(in/255)^gamma`) zawodzi na obrazach z
 *    prawie-czarnym tlem (str. 26 "Wrak.pdf", `img_p25_1`, portret na
 *    ciemnej winiecie) — gamma z DEFINICJI zachowuje `0` (`0^gamma==0`),
 *    wiec prawie-czarne rogi zostaja prawie-czarne NIEZALEZNIE od tego, jak
 *    agresywna gamma (zmierzone wizualnie: nawet gamma=0.6 nie ruszylo
 *    winiety). Naprawiono PIERWSZA iteracja przez dodanie stalego
 *    podniesienia punktu czerni PRZED gamma.
 *
 * 2) Stale podniesienie (np. `lift=25`) samo w sobie okazalo sie
 *    NIEWYSTARCZAJACE dla bardzo ciemnego portretu (uzytkownik: "w mojej
 *    opinii to nadal za malo"), ale podniesienie WYSTARCZAJACO duze dla
 *    portretu (np. `lift=60`) zauwazalnie "myje" str. 20 (statek), ktorej
 *    najciemniejsze tony sa juz umiarkowanie jasne (~21/255) — jeden STALY
 *    parametr nie moze byc jednoczesnie "wystarczajacy" dla obrazu z
 *    prawie-czarnym dnem i "bezpieczny" dla obrazu, ktory takiego dna nie ma.
 *
 * Naprawa: ADAPTACYJNE rozciagniecie poziomow — punkt czerni WYLICZANY Z
 * WLASNEGO histogramu KAZDEGO obrazu (dolny percentyl jasnosci, odporny na
 * pojedyncze szumowe piksele w odroznieniu od zwyklego minimum), przesuwany
 * do wspolnego celu (`TARGET_FLOOR`). Obraz z prawie-czarnym dnem (portret,
 * percentyl ~5/255) dostaje DUZE rozciagniecie; obraz, ktorego dno i tak jest
 * juz umiarkowanie jasne (statek, percentyl ~21/255) dostaje MALE — dokladnie
 * tyle, ile mu POTRZEBA, nie jeden sztywny przepis dla obu.
 *
 * [Czwarta iteracja, na wyrazna prosbe uzytkownika "sprobuje rozjasnic troche
 * wiecej" PO potwierdzeniu, ze wersja z TARGET_FLOOR=75 juz dziala] Podniesione
 * do 95 (gamma 0.95->0.9) — wyrazniej jasniejszy portret, statek WCIAZ nie
 * "myje" sie w mgle (sprawdzone wizualnie: 110 juz zauwazalnie splaszcza
 * niebo/lod statku, 95 jeszcze nie).
 *
 * [Piata iteracja, zgloszenie uzytkownika "jest teraz dosc jasno, ale straciło
 * trochę kontrastu"] Oczekiwane, nie przeoczenie: rozciagniecie [sourceFloor,
 * 255] -> [targetFloor, 255] jest z DEFINICJI kompresja tego zakresu w
 * mniejszy zakres wyjsciowy — to co rozjasnia cienie, jednoczesnie splaszcza
 * roznice miedzy nimi. Naprawa: DODATKOWY kontrast wokol pivotu (`out = pivot
 * + (in-pivot)*contrastFactor`, PO rozciagnieciu i gamma) — pivot WYZEJ niz
 * standardowe 128 (skalibrowane na 150), bo obrazy tej ksiazki sa w wiekszosci
 * jasne (papier/lod), wiec pivot blisko srodka calego zakresu przyciemnialby
 * tez juz-jasne partie. Skalibrowane wizualnie na OBU obrazach:
 * contrastFactor=1.25 przywraca wyrazna glebie cienia (twarz portretu, kadlub
 * statku) bez przepalania juz jasnych partii (niebo, lod, papier).
 */

export interface BrightenOptions {
  /** Docelowa jasnosc (0-255), do ktorej przesuwany jest wykryty dolny percentyl obrazu. */
  targetFloor: number;
  /** Dolny percentyl histogramu jasnosci (0-1) uzywany jako "punkt czerni" tego KONKRETNEGO obrazu — nie zwykle minimum, zeby pojedynczy szumowy ciemny piksel nie zdominowal calego przeliczenia. */
  floorPercentile: number;
  /** Krzywa gamma zastosowana PO rozciagnieciu poziomow; <1 rozjasnia dalej (mocniej w cieniach/polcieniach niz w swiatlach). */
  gamma: number;
  /** Wzmocnienie kontrastu wokol `contrastPivot`, zastosowane PO gamma — przywraca glebie, ktora rozciagniecie poziomow splaszcza z definicji. 1 = brak zmiany, >1 wzmacnia. */
  contrastFactor: number;
  /** Punkt (0-255), wokol ktorego dziala `contrastFactor` — wartosci powyzej rosna, ponizej maleja. Celowo WYZEJ niz standardowe 128 dla obrazow zdominowanych jasnymi tonami (papier/lod), zeby kontrast nie przyciemnial tego, co juz jest jasne. */
  contrastPivot: number;
}

/** [Skalibrowane wizualnie na `img_p19_1` i `img_p25_1`, "Wrak.pdf", po czterech kolejnych iteracjach] Patrz uzasadnienie w naglowku pliku. */
export const AUTOCROP_BRIGHTEN: BrightenOptions = { targetFloor: 95, floorPercentile: 0.01, gamma: 0.9, contrastFactor: 1.25, contrastPivot: 150 };

/** Jasnosc (0-255) ponizej ktorej lezy `percentile` udzial pikseli obrazu — "punkt czerni" WLASNY dla tego obrazu, nie stala globalna. */
function percentileLuminance(image: DecodedImage, percentile: number): number {
  const hist = new Uint32Array(256);
  let total = 0;
  for (let i = 0; i < image.rgba.length; i += 4) {
    const lum = Math.round((image.rgba[i]! + image.rgba[i + 1]! + image.rgba[i + 2]!) / 3);
    hist[lum]!++;
    total++;
  }
  const target = total * percentile;
  let cumulative = 0;
  for (let v = 0; v < 256; v++) {
    cumulative += hist[v]!;
    if (cumulative >= target) return v;
  }
  return 255;
}

/**
 * Rozjasnia obraz adaptacyjnie: wylicza WLASNY dolny percentyl jasnosci tego
 * obrazu, rozciaga go do `targetFloor`, stosuje krzywa gamma, na koniec
 * przywraca kontrast wokol `contrastPivot` (patrz uzasadnienie w naglowku
 * pliku — rozciagniecie z definicji splaszcza roznice, ktore ten ostatni krok
 * odzyskuje). Dziala na kanalach R/G/B, alfa bez zmian. Dwa przebiegi po
 * pikselach (raz histogram, raz LUT z 256 wpisow) — nie funkcja per-piksel,
 * bezpieczne dla obrazow liczonych w milionach pikseli.
 */
export function brightenCroppedImage(image: DecodedImage, opts: BrightenOptions = AUTOCROP_BRIGHTEN): DecodedImage {
  const sourceFloor = percentileLuminance(image, opts.floorPercentile);
  // Rozciagamy WYLACZNIE gdy obraz faktycznie ma cos ciemniejszego niz cel —
  // w przeciwnym razie (obraz JUZ ma jasniejsze cienie niz `targetFloor`, np.
  // scena w plenerze bez glebokich cieni) formula ponizej przyciemnialaby ten
  // dolny percentyl W DOL do celu, dokladnie odwrotnie niz zamierzone (ta
  // flaga ma obraz WYLACZNIE rozjasniac, nigdy przyciemniac).
  const needsStretch = sourceFloor < opts.targetFloor;
  const scale = needsStretch ? (255 - opts.targetFloor) / Math.max(1, 255 - sourceFloor) : 1;

  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    const stretched = needsStretch ? Math.max(0, Math.min(255, opts.targetFloor + (i - sourceFloor) * scale)) : i;
    const gammaCorrected = 255 * Math.pow(stretched / 255, opts.gamma);
    const contrasted = opts.contrastPivot + (gammaCorrected - opts.contrastPivot) * opts.contrastFactor;
    lut[i] = Math.max(0, Math.min(255, Math.round(contrasted)));
  }

  const rgba = new Uint8ClampedArray(image.rgba.length);
  for (let i = 0; i < image.rgba.length; i += 4) {
    rgba[i] = lut[image.rgba[i]!]!;
    rgba[i + 1] = lut[image.rgba[i + 1]!]!;
    rgba[i + 2] = lut[image.rgba[i + 2]!]!;
    rgba[i + 3] = image.rgba[i + 3]!;
  }
  return { width: image.width, height: image.height, rgba };
}

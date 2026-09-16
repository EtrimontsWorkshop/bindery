# Generator fixture'ów syntetycznych

Generator PDF-ów o kontrolowanej, z góry znanej strukturze — materiał testowy dla fazy 2 (silnik układu), bo na prawdziwym PDF-ie nie da się odróżnić błędu parsera od dziwactwa pliku. Zob. [KROK-3-fixtures.md](../../../../KROK-3-fixtures.md) i [RAPORT-KROK-3.md](../../../../RAPORT-KROK-3.md) dla pełnego kontekstu.

**Ten kod zostaje w repo na stałe** i będzie rozbudowywany przez cały projekt (nie jest to spike jednorazowy).

## Zasada naczelna

> **Fixture musi udowodnić, że testuje to, co deklaruje.**

Każdy fixture ma dwie warstwy w swoim pliku `<id>.json`:

1. **`claims`** — właściwość, którą fixture ma wykazywać, zweryfikowana automatycznie uruchomieniem PDF-a przez pdf.js (`npm run fixtures:verify`). To jest samokontrola generatora.
2. **`expected`** — ground truth dla golden testów fazy 2. Może być niekompletne — opisuj tylko to, co fixture faktycznie testuje.

**Fixture bez przechodzącej warstwy `claims` nie trafia do zestawu.**

## Jak dodać nowy fixture

1. Utwórz `fixtures/<id>.ts`, eksportujący `build(): Buffer`. Użyj `rawPdf.ts` (`PdfWriter`), `contentStream.ts` (`ContentStreamBuilder`), `fonts.ts` (`embedFont`) i — dla obrazów — `images.ts`.
2. Utwórz `fixtures/<id>.json` ręcznie: `id`, `description`, `targetPhase`, `claims`, `expected`.
3. Zarejestruj w `index.ts` (import modułu + import JSON + dodanie do tablicy `fixtures`).
4. Uruchom `npm run fixtures:verify` (w `packages/core`). Jeśli `claims` nie przechodzi — **napraw fixture albo napraw `claims`, żeby odzwierciedlały to, co pdf.js faktycznie zwraca**. Nie zgaduj wartości — mierz i wpisz zmierzone.
5. `npm test` uruchomi też test determinizmu (dwa wywołania `build()` muszą dać identyczny SHA-256) — dodawany automatycznie dla każdego fixture'a w rejestrze, bez dodatkowej pracy.

## Kluczowe pułapki (przeczytaj przed pisaniem nowego fixture'a)

Pełna lista z uzasadnieniem: [RAPORT-KROK-3.md](../../../../RAPORT-KROK-3.md), sekcja "Napotkane pułapki". Skrót:

- **pdf.js scala sąsiadujące glify w jeden `TextItem` na podstawie geometrii** (odległość względem szerokości fontu), **niezależnie od liczby operatorów `Tj`**. Żeby wymusić osobny item per token, **umieść każdy token na własnym wierszu** (inny `Tm`/Y) — to jedyny niezawodny, prosty sposób. Odstępy w tej samej linii dają nieprzewidywalne scalanie (czasem osobne itemy + syntetyczna spacja, czasem scalenie w jeden string ze spacjami wewnątrz).
- **Zmiana zasobu fontu (`/F1` → `/F2`) NIE wymusza nowego itemu**, jeśli oba zasoby wskazują na ten sam obiekt `/Font` — pdf.js porównuje `font.name` (zbudowane z `/BaseFont`), nie nazwę zasobu z `Tf`.
- **`/ToUnicode` mapujący na pusty string (`<kod> <>`) jest ignorowany przez pdf.js** — `Font#_charToGlyph` w `pdf.worker.mjs` robi `this.toUnicode.get(charcode) || charcode`, a pusty string jest falsy w JS, więc cicho wraca do surowego kodu znaku. Nie da się tą drogą zbudować `TextItem` z `str === ""`.
- **`Util.getAxialAlignedBoundingBox` nie istnieje** w pdfjs-dist 6.1.200 — licz bbox ręcznie z czterech rogów przez CTM (patrz `metrics.ts`, `computeImageBBoxes`).
- **Maska luminancyjna (`beginGroup` z `smask.subtype === "Luminosity"`) wymaga, żeby cel `/G` maski MIAŁ WŁASNY `/Group /S /Transparency`** — bez tego `PartialEvaluator.buildFormXObject` nie emituje `beginGroup` w ogóle (zweryfikowane wprost w źródle pdf.js).

## Struktura

```
rawPdf.ts        emiter niskopoziomowy: obiekty PDF, xref, trailer (PdfWriter)
contentStream.ts  budowanie operatorów strumienia treści (ContentStreamBuilder)
fonts.ts          osadzanie TrueType + /ToUnicode (embedFont, buildToUnicodeCMap)
images.ts         obrazy XObject, maski luminancyjne (imageXObject, luminosityMaskForm)
metrics.ts        liczy metryki z pdf.js do warstwy claims (computeMetrics)
types.ts          typy FixtureClaims/FixtureGroundTruth/Fixture
verifyClaims.ts   porownanie policzonych metryk z claims (checkClaims, verifyAll)
verify-cli.ts     punkt wejscia `npm run fixtures:verify`
determinism.test.ts  test Vitest: dwa build() = identyczny SHA-256, dla kazdego fixture'a
index.ts          rejestr wszystkich fixture'ow
fixtures/         <id>.ts + <id>.json, jedna para na fixture
assets/fonts/     Lato i Roboto (SIL OFL 1.1) — jedyne pliki binarne w repo z tego katalogu
```

## Fonty testowe

`assets/fonts/{Lato,Roboto}-*.ttf` — SIL Open Font License 1.1 (`OFL-*.txt` obok). Reguła R1 (zero treści wydawców RPG) ich nie dotyczy — to nie jest treść wydawcy, tylko powszechnie dostępne fonty open-source używane jako nośnik do testowania ekstrakcji tekstu. `/BaseFont` w wygenerowanych PDF-ach jest ustawiane dowolnie per fixture (np. `Autobahn`, `AAAAAH+Bookmania-Bold`) — nie musi odpowiadać rzeczywistej nazwie osadzonego fontu, bo pdf.js odczytuje nazwę ze słownika `/Font`, nie z tablicy `name` wewnątrz samego pliku TTF (zweryfikowane empirycznie).

## Czego ten katalog NIE robi

- Nie implementuje niczego z fazy 2 (scalanie słów, wykrywanie kolumn, kolejność czytania) — dostarcza materiał, nie silnik.
- Nie commituje wygenerowanych PDF-ów — `build()` zwraca `Buffer` w pamięci, zużywany bezpośrednio przez `pdfjs.getDocument({ data: ... })`.
- Fixture'y grupy C (układy kolumnowe) nie zostały zbudowane w kroku 3 — patrz RAPORT-KROK-3.md, uzasadnienie w sekcji rekomendacji.

# Import statblocków z PDF — plan architektury (system-agnostyczny)

**Status: Zadania 1 (SchemaIntrospector + model profilu) i 2 (silnik
ekstrakcji pól w `extract/`) zaimplementowane i przetestowane jednostkowo.**
Stary silnik statbloków (`packages/core/src/profiles/`), Profile Studio i
adapter CoC7 zostały w całości usunięte w `v0.2.4` (commit `dd28f67`). Ten
dokument jest źródłem prawdy o architekturze tej funkcji między sesjami —
aktualizować po każdym zadaniu (reguła 10 poniżej).

**Uwaga o numeracji zadań:** właściciel zgrupował moje pierwotne "Zadanie 1"
(schemat profilu) i "Zadanie 2" (introspekcja) w JEDNO "Zadanie 1"; jego
"Zadanie 2" (ten silnik ekstrakcji) odpowiada mojemu pierwotnemu "Zadaniu 3",
ale zawężonemu do JEDNEGO już-zlokalizowanego bloku (znajdowanie GRANIC
statbloków w całym dokumencie zostaje osobnym, późniejszym zadaniem). Sekcja
"Lista zadań 1-7" niżej zachowuje oryginalną numerację jako punkt odniesienia
architektonicznego; sekcje "Zrealizowane" opisują, co faktycznie powstało
pod nazwami właściciela.

## Twarde zasady (obowiązują w każdym zadaniu)

1. Zero nazw własnych systemów RPG w kodzie, stringach, i18n, komentarzach,
   README, nazwach zmiennych i testach. Zero zahardkodowanych ścieżek typu
   `system.attributes.hp`. Wszystko wynika z profilu i schematu Actora.
2. Wiedza o strukturze postaci pochodzi wyłącznie z Actora istniejącego w
   świecie (wzorzec) i z introspekcji schematu typu Actora/Itemu w runtime.
3. Nie zakładaj języka ani układu statblocka. Użytkownik uczy moduł przez
   profil.
4. Zgodność z wersją Foundry z `module.json`; preferuj ApplicationV2 i
   DataModel.
5. Reużywaj istniejący kod PDF (pdf.js, cache, UI), nie duplikuj go.
6. Testy tylko na sztucznych fixture'ach (JSON z symulowaną warstwą
   tekstową: text, x, y, w, h, fontName, fontSize). Żadnych prawdziwych
   statblocków.
7. Wszystkie stringi UI w plikach lokalizacji `en` i `pl`.
8. Struktura: `schema/`, `profile/`, `pdf/`, `extract/`, `ui/`, `import/`.
   Logika bez zależności od Foundry (extract, detekcja) w czystych, osobno
   testowalnych modułach.
9. Ten dokument (`docs/statblock-import/PLAN.md`) jest źródłem prawdy między
   sesjami. Aktualizować po każdym zadaniu.
10. Commity po logicznych krokach. Na końcu każdego zadania: krótkie
    podsumowanie (co zrobiono, co przetestowano, co zostało).

## Dlaczego od zera

Poprzednie podejście (adapter CoC7, potem spike'owany adapter `dnd5e` na
branchu `etap-a`, nigdy niescalonym) hardkodowało nazwę i strukturę
konkretnego systemu w kodzie — dokładnie to, co reguła 1 teraz zakazuje.
Branch `etap-a` (6 commitów, adapter `dnd5e`, profil SRD 5.2.1) jest
prawdopodobnie martwy w obecnym kształcie — patrz pytanie #10 niżej.

**Uwaga o R-kodach/A-kodach:** stary kod (i usunięte pliki) odwoływał się do
skrótów typu R1-R6, A1-A12, przypisując im znaczenia w komentarzach (np. "A5:
człowiek zawsze przegląda przed zapisem", "A7: degraduj, nie failuj") i
cytując zewnętrzny dokument "MDD" z numerami sekcji. **Ten dokument nie
istnieje w repo** (nie jest śledzony przez git, prawdopodobnie lokalny plik
właściciela) — nie znalazłem NIGDZIE w repozytorium scentralizowanej
definicji tych kodów, tylko rozproszone użycia z doraźnym glosem. W tym
planie opisuję zasady wprost, słowami, zamiast cytować kody, których
znaczenia nie mogę zweryfikować z pewnością. Patrz pytanie #9.

## Co przetrwało z poprzedniej architektury (do reużycia, reguła 5)

Zbadałem realnie (nie z pamięci) cały nietknięty pipeline w `packages/core`
— **żaden z poniższych plików nie odwołuje się do żadnego konkretnego
systemu RPG**, były wszystkie WYŻEJ w pipeline niż usunięty silnik:

**Ekstrakcja tekstu z PDF (gotowe, generyczne, reużywalne wprost):**
- `inventory/inventory.ts::buildInventory()` — jeden przebieg operator-listy
  na stronę → `FontEntry[]` (klucz fontu, rozmiar, liczba glifów, strony),
  `rankFontRoles()` (body/heading/caption/accent — rangowanie z
  częstości/rozmiaru, NIGDY z parsowania nazwy fontu), `ImageEntry[]`,
  `VectorRegion[]` (prostokątne wypełnienia/obrysy — **potencjalny sygnał
  ramki statblocka**, patrz pytanie #7).
- `text/buildTextLayout.ts::buildTextLayout()` — higiena + scalanie słów +
  klastrowanie linii → `PageTextResult[]` z `TextStream[]` →
  `TextLine[]`. **To tutaj po raz pierwszy pojawia się bbox tokenu**
  (`geometry.ts::textRunBBox`, wywoływane w `layout/lineCluster.ts`) — niżej
  w pipeline niż `text/` samo w sobie, w warstwie `layout/`.
- `layout/buildPageLayout.ts::buildPageLayouts()` — kolumny, kolejność
  czytania, nagłówki/stopki na całym dokumencie → `PageLayout[]` +
  `SemanticBlock[]` (`semantic/blockBuilder.ts`).
- **`SemanticBlock`** (`kind`, `bbox`, `pageNumber`, `rawText`, `lines:
  TextLine[]`) to naturalna jednostka wejściowa dla nowego silnika —
  KAŻDY blok wciąż niesie pełny dostęp do bboxa+klucza fontu na poziomie
  pojedynczego tokenu przez `block.lines[].tokens`/`.runs`. Ciekawostka:
  `BlockKind` ma już zarezerwowaną (nigdy nieprzypisywaną) wartość
  `'statblock'` — pozostałość sprzed usunięcia starego silnika. **Nowy plan
  NIE używa tego jako uniwersalnej reguły klasyfikatora** (statblock nie ma
  uniwersalnego sygnału wizualnego jak nagłówek — rozpoznajemy go WYŁĄCZNIE
  względem profilu wskazanego przez użytkownika, zgodnie z regułą 3), tylko
  jako dopasowanie wzorca z profilu nad strumieniem bloków/tokenów.
- **Geometria ekran↔PDF**: `pageOverlayGeometry.ts` (`pdfPointToScreen`,
  `screenPointToPdf`, `pdfRectToScreen`, `screenRectToPdf`,
  `screenRotatedRectToPdf`) — kompletny, gotowy most do UI "kliknij w
  wyrenderowaną stronę". Używany dziś w `ReviewScreen.ts`'s
  `#mountOverlay` do rysowania klikalnych prostokątów SVG nad obrazem
  strony — dokładnie mechanizm potrzebny nowemu UI budowania profilu.
- **Renderowanie strony do podglądu**: `openPreviewDocument.ts` (osobny,
  lekki uchwyt pdf.js — `getPageBox`, `renderPage`, `renderRegion`,
  `renderRotatedRegion`) + `images/regionRenderer.ts` — gotowe, reużywalne
  wprost.
- **CIF, stan po usunięciu**: `CIFDocument` nie ma już `actors`/`CIFActor` —
  czysta karta. Ma za to ugruntowany wzorzec kształtu elementu (`id`,
  `provenance: {pageNumber, bbox, blockIds}`, `rawText`,
  `classification`/`confidence`) który nowy typ encji powinien
  naśladować. Patrz pytanie #6 o to, czy w ogóle przechodzić przez CIF.

**Wzorce UI do reużycia (`packages/module`, potwierdzone w żywym kodzie):**
- `GridPicker.ts`/`TokenPrepApp.ts` — wzorzec skupionego okna-modala:
  `static async pick()/prepare(input): Promise<Result|null>`, prywatne pole
  `#resolve` zamykające promise, `override close()` gwarantujące
  rozwiązanie promise nawet przy zamknięciu krzyżykiem. Jedna funkcja
  `#redraw()` wywoływana po KAŻDEJ zmianie kontrolki (`TokenPrepApp`) —
  ten sam wzorzec nadaje się na nowe okno "budowania profilu".
- Przeciąganie wskaźnikiem: `pointerdown`+`setPointerCapture` /
  `pointermove` / `pointerup`+`pointercancel`, z progiem "czy się ruszył"
  odróżniającym klik od przeciągnięcia (`TokenPrepApp.ts`).
- `ReviewScreen.ts::#mountOverlay` — SVG nad `<img>` strony, `viewBox`
  dopasowany do naturalnego rozmiaru obrazu, `pdfRectToScreen` konwertuje
  bbox `CIFImage.provenance.bbox` na współrzędne ekranowe, `<rect>` z
  listenerem `click` podświetlającym/zaznaczającym — to jest właśnie
  mechanizm "kliknij element na stronie", gotowy do reużycia dla klikania w
  przykładowe wartości pól statblocka.
- Konwencja ApplicationV2 spójna wszędzie: `HandlebarsApplicationMixin`,
  `static override DEFAULT_OPTIONS`/`PARTS`, `override async
  _prepareContext()`, `override async _onRender()`, prywatne pola `#stan`,
  `static async #onAkcja(this: Klasa)`.
- **Brak przetrwałego wzorca zapisu/odczytu profilu jako pliku JSON** —
  żadne dzisiejsze `<input type="file">` nie czyta tekstu/JSON-a (tylko
  bajty obrazów/PDF). Perzystencja per-świat istnieje (`game.settings`,
  wzorzec `lastGridConfig`/`tokenPrepDefaults`) ale mechanizm
  eksportu/importu pliku profilu (jak dawniej u aktora) trzeba zbudować od
  nowa. Patrz pytanie #2.

**Introspekcja schematu Actora (zweryfikowane w `fvtt-types`, z zastrzeżeniem):**
Generyczne, bez znajomości systemu: `CONFIG.Actor.dataModels[actor.type]`
(albo `actor.system.schema` na żywym dokumencie) daje `SchemaField`, który
ma `.entries()`/`.fields`/`.get(name)`. Rekurencja: `instanceof SchemaField`
→ zejdź w `.fields`; `instanceof ArrayField` → zejdź w `.element` (to jest
mechanizm dla sekcji powtarzalnych, np. lista ataków); liść → typ pola z
konstruktora (`NumberField`/`StringField`/`BooleanField`/...) + opcjonalne
`label`/`hint` (często puste w praktyce — wiele systemów polega na kluczach
i18n, nie na `label`). **Zastrzeżenie, nie pewnik** — patrz pytania #3 i #4.

## Proponowana architektura i struktura katalogów

Reguła 8 wymienia sześć katalogów bez podziału na pakiety — mapuję je na
istniejącą granicę `packages/core` (zero Foundry, wymuszane przez
`check:boundary`) vs `packages/module` (Foundry-facing), bo introspekcja
`CONFIG.Actor`/`DataModel` z definicji wymaga globali Foundry i NIE MOŻE
żyć w core:

```
packages/core/src/statblock/
  profile/          # StatblockProfile: typ + walidacja zod (wzorem starego
                     # profiles/schema.ts, ale bez wiedzy o RPG-ach)
  extract/          # czysta logika: dopasowanie kotwic, segmentacja
                     # regionów, relokacja pól/kolekcji względem kotwicy —
                     # zero zależności od Foundry, testowalne fixture'ami
  pdf/              # (jeśli w ogóle potrzebne) cienkie funkcje pomocnicze
                     # nad już istniejącym `text/`+`layout/`+`geometry.ts`
                     # — większość "pdf/" to już gotowe `packages/core`,
                     # bez potrzeby nowego katalogu na starcie

packages/module/src/statblock/
  schema/           # introspekcja CONFIG.Actor.dataModels / actor.schema
                     # w runtime — MUSI być tu, nie w core (Foundry globals)
  ui/               # nowe okno(a) ApplicationV2: budowanie profilu,
                     # przegląd znalezionych instancji przed importem
  import/           # zapis Actor+Item z ExtractedActorInstance[] przez
                     # DataModel-owe ścieżki ze schematu profilu — bez
                     # hardkodowanych ścieżek (wzorem starego
                     # createActors.ts, ale generycznie)
```

`packages/core/src/statblock/index.ts` eksportuje do głównego barrela
(`packages/core/src/index.ts`), tak jak dziś robi to `cif/index.ts`.
`CIFDocument` — patrz pytanie #6, czy w ogóle dostaje nowe pole, czy
`ExtractedActorInstance[]` to osobny, równoległy strumień danych.

## Schemat JSON profilu

```ts
interface StatblockProfile {
  schemaVersion: 1;
  id: string;                         // stabilny identyfikator (slug/uuid)
  name: string;                       // tytuł widoczny dla użytkownika
  language?: string;                  // WYŁĄCZNIE podpowiedź/metadana —
                                       // nigdy warunek w kodzie (reguła 3)

  actorType: string;                  // np. "npc" — string z DANYCH
                                       // wskazanych przez użytkownika,
                                       // nigdy literał w kodzie modułu
  templateActorUuid: string;          // UUID wzorcowego Actora w świecie,
                                       // z którego zbudowano ten profil
  templateSchemaFingerprint: string;  // hash schematu DataModel Actora w
                                       // momencie budowy profilu — wykrywa
                                       // rozjazd, gdy system się zaktualizuje

  detection: {
    // Jak rozpoznać "tu zaczyna się kolejny statblok", skanując cały PDF.
    anchor: {
      kind: 'labelPattern' | 'fontRoleAndPattern' | 'vectorFrame';
      pattern?: string;              // regex/string dopasowywany do tekstu
                                      // tokenu-kotwicy (np. nagłówek z
                                      // nazwą stworzenia)
      fontKey?: string;              // opcjonalne dodatkowe ograniczenie:
                                      // uchwycony klucz fontu kotwicy
    };
    boundary: {
      // Gdzie kończy się JEDEN statblok, zaczyna kolejny.
      kind: 'nextAnchor' | 'fixedLineCount' | 'vectorFrame';
    };
    pageRange?: { from: number; to?: number }[]; // opcjonalne ograniczenie
  };

  fields: ProfileField[];             // pola skalarne 1:1 na actor.system.*
  collections: ProfileCollection[];   // sekcje powtarzalne -> embedded Items
  valueMaps: ValueMap[];              // transformacje surowy tekst ->
                                       // wartość kanoniczna, per pole

  inheritUnmappedFromTemplate: boolean;
  // true: pola Actora NIEOBJĘTE przez fields[]/collections[] kopiują
  // wartość wprost z templateActorUuid zamiast zostać puste. Patrz
  // pytanie #8 o dokładną semantykę przy kolekcjach embedded Items.
}

interface ProfileField {
  id: string;
  actorSchemaPath: string;   // ścieżka odkryta introspekcją, np.
                              // "attributes.hp.value" — string w DANYCH
                              // profilu, nigdy literał w kodzie (reguła 1
                              // dotyczy KODU; profil to dane autorskie
                              // użytkownika, analogicznie do starego R2:
                              // "profil to instrukcja parsowania")
  dataType: 'number' | 'string' | 'boolean';  // musi zgadzać się z typem
                              // pola odkrytym przy budowie profilu
  capture: {
    exampleBbox: Rect;              // gdzie użytkownik kliknął/zaznaczył
                                     // w PDF-ie wzorcowym
    examplePageNumber: number;
    fontKey?: string;               // uchwycony font przykładu — dodatkowe
                                     // ograniczenie dopasowania
    labelPattern?: string;          // jeśli pole ma drukowaną etykietę
                                     // (np. "HP:") — tekst/regex etykiety
    relativePosition:
      | 'sameLineAfterLabel'
      | 'belowAnchor'
      | 'fixedOffsetFromAnchor';    // jak odnaleźć TĘ SAMĄ wartość w INNEJ
                                     // instancji statblocka gdzie indziej
                                     // w dokumencie
  };
  valueMapId?: string;
}

interface ProfileCollection {
  id: string;
  itemType: string;                 // string z danych, np. "weapon"
  templateItemUuid: string;         // wzorcowy embedded Item na
                                     // templateActor, introspektowany tak
                                     // samo jak templateActorUuid
  splitRule: {
    kind:
      | 'repeatingLinePattern'
      | 'sectionHeaderThenEntries'
      | 'fixedDelimiter';
    sectionHeaderPattern?: string;  // np. nagłówek sekcji ataków —
                                     // uchwycony, nie zahardkodowany
    entryBoundaryPattern?: string;
  };
  itemFields: ProfileField[];       // ten sam kształt co pola górne, ale
                                     // w zakresie jednego wpisu kolekcji
}

interface ValueMap {
  id: string;
  kind: 'stripUnits' | 'diceNotation' | 'regexReplace' | 'lookupTable';
  params: Record<string, unknown>;
}
```

## Schemat wyniku ekstrakcji (wartość + diagnostyka)

Diagnostyka reużywa istniejący typ `Diagnostic` z `packages/core/src/text/types.ts`
(`severity`, `code`, `params`, `pageNumber`) — ta sama konwencja co reszta
repo: nic nie znika po cichu, każde pole albo się wyekstrahowało z pewnością,
albo zostawia ślad.

```ts
interface ExtractedActorInstance {
  id: string;                  // stabilny w obrębie tego przebiegu
  profileId: string;
  provenance: Provenance;      // {pageNumber, bbox, blockIds} — ten sam
                                // kształt co w CIF, patrz pytanie #6
  fieldValues: Record<string, ExtractedValue>;        // klucz: ProfileField.id
  collections: Record<string, ExtractedCollectionEntry[]>; // klucz: ProfileCollection.id
  diagnostics: Diagnostic[];
}

interface ExtractedValue {
  raw: string;          // dokładny znaleziony tekst
  value: unknown;        // po transformacji przez valueMap, typowane wg
                          // ProfileField.dataType
  confidence: number;    // 0..1
  sourceBbox: Rect;
  found: boolean;         // false = nic nie dopasowano -> value jest
                           // pominięte, NIGDY zgadywana wartość domyślna
}

interface ExtractedCollectionEntry {
  fieldValues: Record<string, ExtractedValue>;
  sourceBbox: Rect;
}
```

## Format fixture'ów testowych dla warstwy tekstowej PDF

**Odkryta rozbieżność, do potwierdzenia (pytanie #5):** istniejąca konwencja
w `packages/core/test/synth/` NIE jest prostym JSON-em `{text,x,y,w,h,
fontName,fontSize}` — fixture'y tam budują PRAWDZIWE bajty PDF przez
`PdfWriter`/`ContentStreamBuilder` (rzeczywiste operatory PDF: `Tm`, `Tj`,
`re`...), parsowane z powrotem przez pdf.js i weryfikowane wobec zadeklarowanych
"claims" (`verify-cli.ts`/`verifyClaims.ts`). To gwarantuje, że fixture jest
realistyczny (pdf.js naprawdę tak by go sparsował), kosztem większej
złożoności budowy fixture'a.

Reguła 6 dosłownie prosi o lekki JSON tokenów. Proponuję pogodzić oba przez
**dwie warstwy testów**, jak w zadaniach 3-4 niżej:

1. **Testy jednostkowe silnika detekcji/ekstrakcji** — operują WYŁĄCZNIE na
   lekkim, w pamięci budowanym JSON-ie tokenów, dokładnie jak reguła 6 mówi:
   ```ts
   interface FixtureToken {
     text: string;
     bbox: { minX: number; minY: number; maxX: number; maxY: number };
     fontKey: string;
     pageNumber: number;
   }
   ```
   To dokładnie kształt, jaki silnik detekcji faktycznie konsumuje (już PO
   konwersji transform→bbox w `geometry.ts::textRunBBox`) — silnik nie
   dotyka pdf.js wcale, więc test nie musi budować prawdziwego PDF-a. Ten
   sam duch co usunięty (ale słuszny wzorzec) `inferPatternFromSelection.test.ts`,
   który budował syntetyczne tablice tokenów bez otwierania PDF-a.
2. **Testy integracyjne całego pipeline'u** (PDF → SemanticBlock[] →
   ekstrakcja) — reużywają istniejącą konwencję `test/synth/` (prawdziwe
   bajty PDF), żeby sprawdzić, że silnik poprawnie dostaje dane z
   REALNEGO, zsyntetyzowanego dokumentu, nie tylko z ręcznie sklejonej
   tablicy. Spójne z resztą repo.

Żadna z tych dwóch warstw nie zawiera prawdziwej treści książek (reguła 6 /
stare R1/R6) — obie są w 100% syntetyczne.

## Lista zadań 1-7

### Zadanie 1 — Schemat profilu + walidacja (core)
Zdefiniować `StatblockProfile` (Zod) w `packages/core/src/statblock/profile/`,
wzorem starego `profiles/schema.ts` ale bez żadnej wiedzy o konkretnym
systemie. **Kryteria akceptacji:** `validateProfile()` akceptuje dobrze
sformowany profil, odrzuca każdy z >=5 wariantów złego profilu z czytelnym
komunikatem; zero importów spoza `packages/core`; `npm run check:boundary`
zielony; testy jednostkowe na ręcznie zbudowanych obiektach JSON (nie PDF).

### Zadanie 2 — Introspekcja schematu Actora (module)
Funkcja w `packages/module/src/statblock/schema/`, która dla danego UUID
Actora zwraca drzewo `{path, label, dataType, isArray, children}` przez
rekurencyjne przejście `SchemaField`/`ArrayField`, zero hardkodowanych nazw
pól. **Kryteria akceptacji:** uruchomiona na żywo (w dev-świecie Foundry) na
Actorach z co najmniej DWÓCH różnych zainstalowanych systemów daje sensowne
drzewo dla obu (realny test system-agnostyczności, nie tylko poprawność
typów); potwierdza lub obala niezawodność `CONFIG.Actor.dataModels[type]`
(pytanie #4) i definiuje ścieżkę zapasową, jeśli zawodzi.

### Zadanie 3 — Fundament detekcji/ekstrakcji pól (core)
Czyste funkcje nad `SemanticBlock[]`/strumieniem tokenów: (a) znajdź
wszystkie dopasowania kotwicy wg `detection.anchor` w całym dokumencie, (b)
podziel dokument na kandydackie regiony statbloków wg `detection.boundary`,
(c) dla jednego `ProfileField.capture.relativePosition` znajdź wartość pola
W KAŻDYM regionie. **Kryteria akceptacji:** na syntetycznym strumieniu
tokenów z 3 powtórzonymi blokami (fixture warstwy 1) silnik znajduje
dokładnie 3 regiony; poprawnie relokuje 100% pól, których pozycja faktycznie
się powtarza; dla pola brakującego w jednej instancji produkuje diagnostykę,
nie zgadywaną wartość ani wyjątek.

### Zadanie 4 — Ekstrakcja kolekcji (core)
Rozszerzenie zadania 3 o `collections[]` (reguła podziału + `itemFields`
per wpis). **Kryteria akceptacji:** syntetyczny fixture z powtarzalną
sekcją (np. "ataki") o zmiennej liczbie wpisów (0, 1, 3) w różnych
instancjach ekstrahuje poprawną liczbę wpisów za każdym razem, z wartościami
pól per wpis i diagnostyką dla wpisów nieparsowalnych.

### Zadanie 5 — UI budowania profilu (module)
Nowe okno ApplicationV2 "kreator profilu": użytkownik otwiera PDF +
wybiera wzorcowego Actora, klika przykładową wartość pola na wyrenderowanej
stronie, wybiera pasującą ścieżkę ze zintrospektowanego drzewa (zadanie 2),
powtarza dla kolekcji. Reużywa wzorca modala z `GridPicker`/`TokenPrepApp`
i mechanizmu klikalnego SVG-overlaya z `ReviewScreen`. **Kryteria
akceptacji:** po ręcznym przejściu na jednym przykładowym pliku produkuje
poprawny `StatblockProfile` (przechodzi walidator z zadania 1); zapis/odczyt
profilu działa (mechanizm z pytania #2).

### Zadanie 6 — Uruchomienie na całym dokumencie + podgląd (integracja)
Spięcie zadań 3+4 w akcję "uruchom profil na tym PDF-ie" dającą
`ExtractedActorInstance[]`, plus UI przeglądu (wzorem listy+overlaya z
`ReviewScreen`) pokazujący znalezione instancje z diagnostyką przed
importem. **Kryteria akceptacji:** uruchomienie zbudowanego profilu na TYM
SAMYM syntetycznym pliku, na którym go zbudowano, znajduje każdy statblok
zdefiniowany w ground-truth fixture'a (test recall, nie na prawdziwej
książce — reguła 6).

### Zadanie 7 — Import do Foundry (module)
Generyczny zapis: z `ExtractedActorInstance[]` + `actorType`/ścieżki
schematu z profilu, tworzy prawdziwe dokumenty Actor + embedded Item przez
bezpieczne dla DataModel ścieżki (`Actor.implementation.create` itp.), bez
żadnej wiedzy o konkretnym systemie. Nic nie zapisuje się bez jawnego
potwierdzenia w UI z zadania 6 (człowiek zawsze przegląda przed zapisem —
ten sam duch co reszta modułu). **Kryteria akceptacji:** zweryfikowane na
żywo w prawdziwym świecie Foundry na DWÓCH różnych systemach — karta
utworzonego Actora pokazuje właściwe wartości we właściwych polach dla obu.

## Zrealizowane — Zadanie 1 (SchemaIntrospector + model profilu)

**Zakres:** oryginalne Zadanie 1 (schemat) + Zadanie 2 (introspekcja) z listy
wyżej, połączone przez właściciela w jedno zadanie. Zero UI, zero silnika
ekstrakcji — zgodnie z briefem.

**Core (`packages/core/src/statblock/`):**
- `schema/types.ts` — `FoundryFieldLike` (duck-typed shape realnego pola
  Foundry, ten sam wzorzec co `PdfTextItemLike` dla pdf.js), `SchemaFieldKind`
  (`string|number|boolean|html|choices|array|object|unsupported`),
  `SchemaFieldDescriptor` (path/label/type/choices/min/max/integer/initial/
  currentValue/children).
- `schema/describeSchemaField.ts` — czysta rekurencyjna funkcja
  `describeSchemaField`/`describeSchema`: klasyfikuje pole po
  `className` (zamkniętą mapą, żadnego zgadywania), `choices` ZAWSZE
  nadpisuje bazowy typ prymitywny na `'choices'`, pomija dzieci `readonly`,
  reprezentuje pole tablicowe jako jedno syntetyczne dziecko = kształt
  JEDNEGO elementu (nie N realnych elementów — to schemat, nie dane).
- `schema/attachCurrentValues.ts` — osobny czysty przebieg wypełniający
  `currentValue` z żywych danych `actor.system` (własna, minimalna
  reimplementacja `getProperty` po kropce-ścieżce, bez importu z Foundry).
- `profile/schema.ts` — **zmiana względem wcześniejszego szkicu planu**: typy
  (`StatblockProfile`, `ProfileField`, itd.) są teraz `z.infer<typeof ...>`
  wywiedzione ZE schematu Zod, nie odwrotnie — dokładnie wzorem starego,
  usuniętego `profiles/schema.ts` (unika rozjazdu typ↔walidator). `ProfileFieldDataType`
  to DOKŁADNIE `SchemaFieldKind` minus `'unsupported'` (przetestowane wprost,
  patrz niżej) — dzięki temu `validateProfileAgainstSchema` robi zwykłe
  porównanie równości zamiast tabeli zgodności.
- `profile/validateAgainstSchema.ts` — `validateProfileAgainstSchema(profile,
  actorSchema, itemSchemas)` → `Diagnostic[]` (reużywa istniejący typ
  `Diagnostic`): sprawdza, czy każda `actorSchemaPath` istnieje w BIEŻĄCYM
  drzewie schematu i czy typ się zgadza — osobno od `validateProfile`
  (struktura JSON-a) właśnie po to, żeby wykryć dryf systemu
  (`templateSchemaFingerprint` w profilu jest po to samo, ale jego
  OBLICZANIE odłożone do Zadania 5 — patrz pytanie #4 zaktualizowane niżej).
- `profile/migrate.ts` — szkielet migracji: dziś jedna gałąź (v1 = identity),
  `default` odrzuca z czytelnym powodem zamiast cichej koercji. Wywoływane
  PRZED `validateProfile` przez warstwę storage.

**Module (`packages/module/src/statblock/`):**
- `schema/toFieldLike.ts` — adapter realnego pola Foundry → `FoundryFieldLike`,
  z jedną funkcją `resolveMaybeFunction` rozwiązującą `choices`/`initial`,
  gdy są funkcją zero-argumentową (core nigdy nie wywołuje funkcji, których
  nie zna).
- `schema/introspectActor.ts` — `listDocumentSubtypes('Actor'|'Item')` (z
  `game.system.documentTypes`), `introspectDocumentType(kind, type)` (z
  `CONFIG.Actor|Item.dataModels[type].schema`, zwraca `null` gdy brak
  DataModelu), `introspectDocumentInstance(kind, doc)` (łączy powyższe +
  `attachCurrentValues` na żywych danych), `describeDocumentInstanceViaFallback`
  (dla systemów BEZ DataModelu: `foundry.utils.flattenObject(doc.toObject())`,
  filtrowane do ścieżek `system.*`, typ zgadywany z `typeof` realnej
  wartości), `introspectAllItemTypes()` (pula typów Itemów pod `collections`).
  Krzyżowanie z `game.system.documentTypes[kind][type].htmlFields` nadpisuje
  `'string'` na `'html'` nawet gdy pole to zwykły `StringField` (niektóre
  systemy nie używają klasy `HTMLField` mimo renderowania jako rich text).
- `profile/store.ts` — CRUD na jednym ustawieniu światowym
  `statblockProfiles` (`Record<id, StatblockProfile>`): `listProfiles`,
  `getProfile`, `saveProfile`, `deleteProfile`, `duplicateProfile` (nowe id
  przez `foundry.utils.randomID()`), `exportProfile` (`foundry.utils.saveDataToFile`,
  odzyskuje mechanizm eksportu, którego już nie było w żywym kodzie),
  `importProfileFromFile` (`foundry.utils.readTextFromFile` + migracja +
  walidacja). Każdy odczyt migruje i waliduje PONOWNIE (wpis, który
  przestał być poprawny — np. ręcznie edytowany w bazie świata — jest
  pomijany z ostrzeżeniem w konsoli, nie wywala reszty kolekcji).
- `settings.ts`/`global.d.ts` — nowe ustawienie `statblockProfiles`
  zarejestrowane (`scope: 'world'`, `config: false`, wzorem
  `tokenPrepDefaults`).

**Przy okazji naprawione:** `global.d.ts` importował i deklarował typ
`LastActorProfile`/ustawienie `lastActorProfile`, które usunąłem z
`settings.ts` przy usuwaniu CoC7 w poprzedniej sesji — zostało przeoczone,
bo `skipLibCheck: true` w `tsconfig.base.json` NIE sprawdza plików `.d.ts`,
więc `tsc --noEmit` milczał mimo realnego błędu. Wyczyszczone.

**Testy (`packages/core/test/statblock/`):** 44 nowe testy, wszystkie na
ręcznie budowanych obiektach JS/JSON (zero PDF, zgodnie z regułą 6) —
klasyfikacja typów pól (w tym `choices` nadpisujące typ bazowy, pomijanie
`readonly`, zagnieżdżanie wielopoziomowe, kształt elementu tablicy),
`attachCurrentValues` (ścieżki zagnieżdżone, brakujące, przez
nie-obiekt), `validateProfile` (happy path + >=7 wariantów złych profili,
nigdy nie rzuca wyjątku, test synchronizacji `ProfileFieldDataType`↔`SchemaFieldKind`),
`validateProfileAgainstSchema` (brakująca ścieżka, niezgodny typ, brakujący
typ Itemu kolekcji), `migrateProfileData` (identity, nieznana wersja,
brak `schemaVersion`, śmieciowe wejście). Moduł Foundry-side
(`toFieldLike`/`introspectActor`/`store`) NIE ma testów jednostkowych —
tak jak reszta warstwy Foundry-facing w tym repo, weryfikowany na żywo
(patrz kryteria akceptacji Zadania 2 wyżej — jeszcze niezrealizowane, brak
uruchomionego świata Foundry w tej sesji).

**Bramki:** 664 testy core zielone, typecheck obu pakietów czysty
(`skipLibCheck` już nie kryje nowych błędów — sprawdzone ręcznie), lint,
`check:boundary`/`check:imports`/`check:size` (budżet startowy: 7736 → 7873
bajtów, wzrost wyłącznie z nowego wpisu `game.settings.register`), `build`/
`package` bez zmian w `git status`.

**Czego NIE zrobiono (zgodnie z briefem "nie rób jeszcze UI ani
ekstrakcji"):** UI kreatora profilu, silnik detekcji/ekstrakcji (Zadania
3-4/6-7), obliczanie `templateSchemaFingerprint` (potrzebne dopiero, gdy
faktycznie powstaje profil — odłożone do Zadania 5), empiryczna weryfikacja
introspekcji na dwóch różnych żywych systemach Foundry (Zadanie 2 w
oryginalnej liście, kryterium akceptacji jeszcze nie spełnione).

## Zrealizowane — Zadanie 2 (silnik ekstrakcji pól, `extract/`)

**Zakres:** jeden już-zlokalizowany blok (`ExtractionBlock` — bbox + jego
własne elementy tekstowe) w środku, jedno pole na wyjściu. Znajdowanie GRANIC
statbloków w całym dokumencie (mój pierwotny szerszy "Zadanie 3") to
OSOBNE, późniejsze zadanie — ten silnik go zakłada jako dane wejściowe, nie
buduje go. Zero UI, zero Foundry, zero DOM — sprawdzone: `check:boundary`
zielony, wszystkie testy uruchamiają się w czystym Node przez vitest.

**Prymityw wejściowy — `PageTextElement`:** `{text, x, y, w, h, fontName,
fontSize, bold, italic}` dokładnie jak w briefie. Własna decyzja
projektowa (brief nie podał wprost): `x`/`y` to róg MIN (lewy/dolny), ta
sama konwencja PDF-space (Y rośnie w górę) co cały `packages/core`
(`geometry.ts::Rect`) — nie baseline, nie top-left-w-dół-ekranu.
Celowo NIE reużyto `CleanItem`/`TextLine` z `text/`/`layout/` (te niosą
surową macierz transformacji PDF i są związane z całodokumentową higieną/
statystyką odstępów/rangowaniem ról fontów — nadmiarowe dla ekstrakcji
garści pól z już-zlokalizowanego bloku); nowy, mniejszy typ `ReconstructedLine`
zamiast tego (nazwa inna niż istniejące `layout/lineCluster.ts`'s `TextLine`
— kolizja nazw przy re-eksporcie z głównego barrela wykryta przez `tsc`,
naprawiona zmianą nazwy).

**Rekonstrukcja linii i kolumn (`reconstructLines.ts`):** grupowanie po
nakładaniu się Y w wiersze, potem podział wiersza w miejscu nietypowo
szerokiej przerwy poziomej (mediana przerw w wierszu × 4, próg
bezwzględny 24pt gdy przerw jest za mało, żeby policzyć sensowną
medianę) — praktyczny przypadek: dwie niezależne pary etykieta/wartość
obok siebie w tym samym wierszu wizualnym (np. "HP: 12    AC: 15") nie
zlepiają się w jeden bezsensowny string. **Błąd złapany przez własne
testy i naprawiony:** dla wiersza z DOKŁADNIE dwoma elementami (jedna
przerwa) mediana tej jednej przerwy to ona sama — mnożenie jej przez 4
nigdy nie mogło przekroczyć progu, więc podział kolumnowy nigdy by się nie
uruchomił dla najprostszego, najczęstszego przypadku (dokładnie dwa pola
obok siebie). Naprawione: próg bezwzględny sam w sobie, gdy przerw jest
mniej niż 2.

**Trzy źródła (`sources/`):**
- `label` — dopasowanie NA POZIOMIE ELEMENTU (jeden element = cała
  etykieta, bez łączenia wieloelementowych etykiet w tym zadaniu),
  `stopAt` przez rekonstruowane linie: `endOfLine` (reszta bieżącej linii),
  `endOfBlock` (wszystkie kolejne linie), `nextLabel` (kolejne linie, aż
  któraś dopasuje `nextLabelPattern` — wymagany, błąd konfiguracji gdy go
  brak).
- `region` — prostokąt znormalizowany 0..1 względem bboxa bloku,
  włączenie przez ŚRODEK elementu w prostokącie (ten sam wzorzec co stary,
  usunięty `inferPatternFromSelection.ts`'s zaznaczenie myszą).
- `styleFilter` — font/rozmiar/pogrubienie/kursywa jako kryteria AND;
  `largestFontInBlock` komponuje się z pozostałymi kryteriami (np.
  "największy POGRUBIONY font w bloku" zawęża do max rozmiaru WŚRÓD już
  przefiltrowanych elementów, nie wszystkich w bloku).

**Łańcuch transformacji (`transforms/`):** wszystkie 11 z brifu:
`trim`, `normalizeWhitespace` (czyści białe znaki W LINII, zachowuje
podziały linii — łączenie linii to osobny krok), `joinWrappedLines`
(dehyfenacja: linia kończąca się myślnikiem + kolejna zaczynająca się
małą literą → sklejone bez myślnika/spacji; wielka litera → zwykła spacja,
myślnik zostaje), `stripLigaturesAndOddChars` (ligatury ﬁﬂﬀﬃﬄ, znaki
kontrolne, PUA), `regexExtract` (z grupą), `parseNumber`, `nthNumber`,
`split`/`join`, `valueMap` (dysponuje NA `ValueMap.kind` z Zadania 1:
`stripUnits`, `regexReplace`, `diceNotation` — TYLKO kosmetyczna
normalizacja, nie parser kostek, `lookupTable` — fuzzy+case-insensitive,
patrz niżej), `textToHtml`, `defaultValue`. Każdy krok NIGDY nie rzuca
wyjątku — degraduje do `undefined`/no-op, więc `defaultValue` na końcu
łańcucha niezawodnie łapie KAŻDĄ wcześniejszą porażkę, nie tylko brak
dopasowania źródła.

**`parseNumber` — dziwne minusy i ułamki:** rozpoznaje `+`, zwykły
`-`, U+2212 MINUS SIGN, U+2013 EN DASH (używany jako minus w niektórych
fontach) jako znak liczby; samotny myślnik bez cyfr CELOWO nie parsuje się
jako liczba (częsta konwencja "brak" w statblokach — `defaultValue` po tym
kroku obsługuje taki przypadek, jeśli potrzeba). Ułamki: unikodowe
wulgarne (½⅓⅔¼¾...) samodzielnie lub jako liczba mieszana ("1½").
**Błąd złapany przez własne testy i naprawiony:** pierwsza wersja regexa
próbowała najpierw gałęzi "zwykła liczba", która zachłannie dopasowywała
samą część całkowitą "1" z "1½" i NIGDY nie sprawdzała gałęzi ułamkowej
(alternacja regexowa nie cofa się do innej, też poprawnej gałęzi po
sukcesie wcześniejszej) — "1½" dawało błędnie `1` zamiast `1.5`. Naprawione
zmianą kolejności alternatyw (gałąź ułamkowa pierwsza).

**`valueMap` typu `lookupTable` — fuzzy, case-insensitive (główny wymóg
brifu):** trzy poziomy, każdy próbowany tylko gdy poprzedni nic nie
znalazł: (1) dokładne dopasowanie, case-insensitive domyślnie; (2) przy
`fuzzy:true` — dopasowanie po znormalizowaniu (tylko litery/cyfry,
usuwa różnice w interpunkcji/białych znakach); (3) przy `fuzzy:true` —
najbliższy klucz odległością Levenshteina w progu proporcjonalnym do
długości (żeby nie dopasować dwóch naprawdę niezwiązanych wartości).

**Rzutowanie na typ + walidacja (`castAndValidate.ts`):** niezgodność
typu (np. pole liczbowe dostało string) to błąd, wartość odrzucona;
naruszenie ograniczenia (min/max/integer/choices) to ostrzeżenie, wartość
ZOSTAJE (nadal użyteczna do przeglądu). `ProfileFieldDataType` (z Zadania
1) to bezpośrednio słownik typów tutaj — ten sam zestaw
string/number/boolean/html/choices/array/object.

**Diagnostyka — napotkane ograniczenie typu:** `Diagnostic.params` jest
typowany `Record<string, string | number>` (feeduje szablon lokalizacji),
nie `unknown` — każde miejsce chcące zgłosić obiekt/tablicę (np. cały
`StyleFilter` albo listę `choices`) przechodzi przez `toParamValue()`
(JSON.stringify z fallbackiem na `String()`), nowy mały helper
(`diagnosticParam.ts`).

**Testy:** 133 nowe testy jednostkowe (72 pliki testowe w core razem,
816 testów w sumie), wszystkie na ręcznie budowanych `PageTextElement[]`/
stringach — zero PDF, zero prawdziwych statbloków. Pokryte explicite
wskazane przez właściciela przypadki brzegowe: brak etykiety
(`STATBLOCK_LABEL_NOT_FOUND`), pusty tekst (etykieta bez wartości →
`found:true, raw:''` + diagnostyka info; pusty region/filtr →
`found:false`), zawinięte linie (dehyfenacja z wielką/małą literą po
myślniku, kilka łączeń pod rząd, puste linie), dziwne minusy (wszystkie 4
warianty znaku, samotny myślnik bez cyfr, myślnik jako separator a nie
znak). Dwa prawdziwe błędy w PIERWSZEJ wersji kodu złapane właśnie przez
pisanie tych testów (opisane wyżej) — dokładnie po to reguła 10 każe
testować szeroko, nie tylko "happy path".

**Bramki:** 816 testów core zielone, typecheck obu pakietów czysty, lint,
`check:boundary`/`check:imports`/`check:size` (budżet bez zmian — 7873
bajtów, `extract/` nie jest jeszcze podpięty pod żaden punkt wejścia UI),
`build`/`package` bez zmian w `git status`.

**Czego NIE zrobiono / założenia do potwierdzenia:** patrz nowe pytania
#12-#16 niżej — m.in. dopasowanie wieloelementowej etykiety, sygnał granicy
kolumn kalibrowany "na oko" (nie na realnych danych, bo reguła 6 zakazuje
prawdziwej treści), `diceNotation` to kosmetyka, nie parser.

## Zrealizowane — Zadanie 3 (detekcja statblocków, `pdf/`)

**Zakres:** dokładnie brief właściciela — znajdowanie GRANIC statbloków w
całym dokumencie (to, co Zadanie 2 celowo zostawiło jako założenie
wejściowe). Logika czysta w `packages/core/src/statblock/pdf/` (zero pdf.js,
zero Foundry, testowalna w Node) + jeden plik cienkiej integracji z
istniejącym pipeline'em pdf.js modułu (`buildPagesForDetection.ts`).

**Rewizja schematu profilu (wymagana, odkryta w trakcie):** brief Zadania 3
podał precyzyjną sygnaturę detekcji, inną i bogatszą niż moje własne,
wcześniejsze, spekulatywne `DetectionConfig` z fazy planowania —
`profile/schema.ts` zrewidowany:
- `anchor`: `{kind:'textPattern'|'headingStyle', pattern?, patternIsRegex?,
  styleFilter?}` z `.refine()` wymagającym `pattern` dla `textPattern` i
  `styleFilter` dla `headingStyle`.
- `boundary`: `{kind:'nextAnchor'|'verticalGap'|'endOfColumnOrPage'|
  'endLabel', gapThreshold?, endLabelPattern?, endLabelIsRegex?}` z
  `.refine()`ami wymagającymi `gapThreshold`/`endLabelPattern` tam, gdzie
  sensowne.
- nowe `requiredLabels: {pattern, isRegex}[]` na poziomie `DetectionConfig`.
- `ProfileField` dostał NOWE pole `source: FieldSource` (ogólna,
  uruchamialna w czasie detekcji reguła ekstrakcji — dyskryminowana unia
  `label`/`region`/`styleFilter`, faktycznie te same kształty co Zadania 2
  `sources/`) OBOK już istniejącego `capture` (pojedynczy przykład
  zaznaczony w UI) — te dwa pola służą różnym celom i oba zostały: `capture`
  to "co użytkownik kliknął", `source` to "jak to znaleźć w dowolnej innej
  instancji statblocka".
- `FieldSource`/`StyleFilter`/`LabelSource`/`RegionSource`/`NormalizedRect`/
  `StyleFilterSource` PRZENIESIONE z bycia ręcznie pisanym interfejsem w
  `extract/sources/types.ts` do kanonicznych, walidowanych Zod definicji w
  `profile/schema.ts` (skoro `ProfileField.source` niesie je teraz jako
  realne, niezaufane dane profilu) — `extract/sources/types.ts` re-eksportuje.

**Kolejność czytania (`readingOrder.ts`):** kolumnowo — CAŁA kolumna 1
(góra-dół) przed kolumną 2, strona po stronie. To świadomy wybór
architektoniczny: to właśnie pozwala statblockowi legalnie kontynuować się z
dołu jednej kolumny na górę następnej (wymaganie brifu wprost), a jednocześnie
(przy `boundary.kind:'endOfColumnOrPage'`) dwóm statblokom obok siebie w tym
samym rzędzie nigdy się nie skleić. Nazwa `buildStatblockReadingOrder`
(zamiast `buildReadingOrder`) — kolizja nazwy przy re-eksporcie z
`layout/readingOrder.ts`'s własnym `buildReadingOrder`, wykryta przez `tsc`.

**Dopasowanie kotwicy (`matchAnchor.ts`):** `textPattern` — dopasowanie
tekstu linii (string lub regex); `headingStyle` — KAŻDY element linii musi
spełniać `StyleFilter` (font/rozmiar/pogrubienie/kursywa jako AND, jak w
Zadaniu 2); `largestFontInBlock` reinterpretowany na poziomie STRONY
(przekazywany przez wywołującego jako precomputed max), bo w Zadaniu 3 nie ma
już pojedynczego "bloku" do porównania — cała strona jest przeszukiwana pod
kątem kotwic.

**Reguła końca kandydata (`findCandidateEnd.ts`):** wszystkie 4 warianty z
brifu. Dwie reguły projektowe stosowane spójnie:
1. **Kolejna kotwica to zawsze niejawny twardy limit** — niezależnie od
   `boundary.kind`, żaden kandydat nigdy nie wychodzi poza start kolejnego
   dopasowania kotwicy (dwa statbloki nie mogą się nakładać).
2. **Przekroczenie granicy kolumny/strony NIE jest samo w sobie sygnałem
   stopu** dla `verticalGap`/`endLabel`/`nextAnchor` (odstęp pionowy jest
   RESETOWANY na granicy, nigdy traktowany jako naruszenie progu) — TYLKO
   `endOfColumnOrPage` traktuje przekroczenie jako twardy stop. To dokładnie
   to, co pozwala "statblokom łamanym między kolumnami/stronami" działać przy
   pozostałych trzech regułach, a "dwóm statblokom obok siebie nigdy się nie
   sklejać" przy `endOfColumnOrPage`.

**Wskaźnik pewności (`computeCandidateConfidence.ts`):** confidence =
(znalezione sygnały) / (wszystkie skonfigurowane sygnały), domyślnie `1`
(zaufaj kotwicy), gdy nie skonfigurowano żadnego sygnału. Sygnały = wszystkie
`requiredLabels` + wszystkie `fields` mające `source` zdefiniowane. **Celowe
uproszczenie:** używa WYŁĄCZNIE warstwy dopasowania źródła z Zadania 2
(`extractRawValue`), NIE pełnego `extractField` (łańcuch transformacji +
rzutowanie na typ) — bo `ProfileField` nie ma jeszcze tablicy
`transforms: TransformStep[]` (tylko `source` + `valueMapId`), więc pełny
potok "cast-to-type" nie jest jeszcze w pełni spięty od końca do końca. Patrz
nowe pytanie #17 niżej.

**Fałszywe trafienia nigdy nie znikają po cichu:** dopasowanie kotwicy, które
nie ma w pobliżu żadnej wymaganej etykiety, WCIĄŻ produkuje
`DetectionCandidate` (z niską/zerową pewnością), nigdy nie jest filtrowane
przez sam detektor — zgodne z ogólną konwencją projektu "never silently
disappear" (właściciel przegląda i odrzuca ręcznie w UI, nie silnik po
cichu).

**Wynik (`detectStatblocks.ts`):** `DetectionCandidate {id, regions[]
(numer strony + bbox, może być kilka gdy kandydat przecina kolumnę/stronę),
elements[] (elementy tekstu bloku), confidence, foundRequiredLabels,
missingRequiredLabels}`. Jeden kandydat na dopasowaną kotwicę, bezwarunkowo.

**Cienka warstwa integracji (`buildPagesForDetection.ts`):** reużywa
PRAWDZIWY, już wdrożony pipeline — `buildInventory` → `buildTextLayout` →
`buildPageLayouts`, DOKŁADNIE te same trzy wywołania, które już orkiestruje
`buildCIFFromDocument.ts` (reguła 5 — żadnej drugiej ścieżki dostępu do
pdf.js) — dając prawdziwe kolumny (`PageLayout.columns`) i ramki wektorowe
(`VectorRegion[]`) za darmo, bez ponownego pisania detekcji układu.
Konwersja `SemanticBlock[]` → `PageTextElement[]` per token (`TextLine.tokens`),
z fontem rozwiązywanym przez dopasowanie bbox tokenu do `TextLine.runs`
(spójne odcinki tego samego fontu), z fallbackiem na `line.dominantFont`, gdy
`tokens`/`runs` są nieobecne. **Znane ograniczenie, udokumentowane w
nagłówku pliku:** `bold`/`italic` są WYWNIOSKOWANE heurystycznie (czy nazwa
fontu zawiera "bold"/"black"/"heavy"/"italic"/"oblique") — osadzone fonty PDF
nie eksponują niezawodnie prawdziwych flag wagi/stylu (to samo ustalenie, co
komentarz nagłówkowy starego, usuniętego `fontRegistry.ts`). Parsowanie
partiami z `onProgress`/`AbortSignal` między stronami (`checkAborted()` rzuca
`DOMException('Aborted','AbortError')`, nie `AbortSignal.prototype.
throwIfAborted` — unika ryzyka wersji lib TS), ten sam kontrakt co już
istniejący `buildImageExtraction.ts`.

**Brak automatycznego testu dla `buildPagesForDetection.ts` — decyzja
świadoma, nie przeoczenie:** sprawdziłem wprost, czy istnieje precedens w
repo dla testowania w Node kodu otwierającego pdf.js z konfiguracją
`assetBaseUrl`/`GlobalWorkerOptions.workerSrc`/`wasmUrl`/
`standardFontDataUrl` (dokładny wzorzec tego pliku) — **`buildCIFFromDocument.ts`,
JEDYNY inny plik w repo z identycznym wzorcem `openDocument()`, NIE MA
własnego pliku testowego w ogóle.** Testowana jest wyłącznie logika PO stronie
czystej (`buildCIFDocument.test.ts`, na ręcznie budowanych obiektach), nigdy
sama integracja z pdf.js/workerem/assetami. `buildPagesForDetection.ts`
podąża za tym samym, już istniejącym w projekcie podziałem odpowiedzialności
— czysta logika (`readingOrder`/`matchAnchor`/`findCandidateEnd`/
`computeCandidateConfidence`/`detectStatblocks`) w pełni pokryta testami,
integracyjna warstwa `assetBaseUrl`-owa weryfikowana na żywo, nie
jednostkowo. Patrz nowe pytanie #21.

**Testy:** 55 nowych testów (871 w sumie w core): `readingOrder.test.ts` (8),
`matchAnchor.test.ts` (8), `findCandidateEnd.test.ts` (10),
`computeCandidateConfidence.test.ts` (7), `detectStatblocks.test.ts` (11 —
wszystkie sześć scenariuszy wskazanych explicite przez właściciela: 1 kolumna,
2 kolumny obok siebie nigdy się nie łączące, przez granicę kolumny, przez
granicę strony, brak statblocków, fałszywe trafienia), plus nowe testy
rewizji schematu w `schema.test.ts`/`validateAgainstSchema.test.ts` (walidacja
nowych kształtów `anchor`/`boundary`/`requiredLabels`/`field.source`). Dwa
prawdziwe błędy złapane podczas pisania WŁASNYCH testów (nie w kodzie
produkcyjnym): dwa scenariusze "przez granicę kolumny/strony" w
`detectStatblocks.test.ts` miały elementy kontynuacji umieszczone w NIEWŁAŚCIWEJ
kolumnie/na niewłaściwej stronie (przez pomyłkę we współrzędnych testu, nie w
algorytmie) — poprawione, wszystkie 871 testów zielone.

**Bramki:** 871 testów core zielone, typecheck obu pakietów czysty, lint,
`check:boundary`/`check:imports`/`check:size` (budżet bez zmian — 7873
bajtów, `pdf/` nie jest jeszcze podpięty pod żaden punkt wejścia UI),
`check:lang`, `build` bez błędów. Bez `package`/podbicia wersji — jak w
Zadaniach 1-2, nic jeszcze nie jest widoczne dla użytkownika końcowego.

**Czego NIE zrobiono / założenia do potwierdzenia:** patrz nowe pytania
#17-#21 niżej — m.in. czy `ProfileField` potrzebuje `transforms:
TransformStep[]` dla pełnej wierności pewności/ekstrakcji, semantyka
`largestFontInBlock` przemianowana na poziom strony, ograniczenie heurystyki
bold/italic, brak testu integracyjnego `buildPagesForDetection.ts` (decyzja
świadoma, patrz wyżej).

## Zrealizowane — Zadanie 4 (ActorBuilder, `import/`)

**Zakres:** "z wyników ekstrakcji buduje dane Actora" — brakujący łącznik
między Zadaniem 3 (kandydaci z pewnością, ale bez PRAWDZIWYCH wartości pól —
Q17) a zapisem do Foundry. Czysta logika w
`packages/core/src/statblock/import/` (budowanie+walidacja danych, w pełni
testowalna mockami) + cienka warstwa integracji w
`packages/module/src/statblock/import/importStatblocks.ts` (jedyne miejsce
dotykające `Actor.create`/`fromUuid`/`game.actors` — reguła 1/A1).

**Rewizja schematu profilu (domyka pytanie #17 z Zadania 3):**
- `ProfileField` dostał nowe pole `transforms: ProfileTransformStep[]`
  (domyślnie `[]`) — brakujący łańcuch transformacji, bez którego
  `extractField` (Zadanie 2) nie miał jak rzutować surowego tekstu na
  docelowy typ dla PRAWDZIWEJ ekstrakcji (Zadanie 3 celowo używało tylko
  `extractRawValue`, patrz jego własny komentarz). `ProfileTransformStep`
  lustrzanie odwzorowuje `TransformStep` z `extract/transforms/types.ts`
  MINUS wariant `valueMap` — `valueMapId` (Zadanie 1, dotąd martwe, nigdy
  niepodpięte nigdzie) został OŻYWIONY zamiast dublowany: `import/
  resolveTransformChain.ts` rozwiązuje `valueMapId` przez `profile.valueMaps`
  i dokleja go jako OSTATNI krok łańcucha — udokumentowane uproszczenie
  (patrz nowe pytanie #22), nie twarde ograniczenie formatu.
- Nowe top-level `StatblockProfile.nameSource: FieldSource` oraz
  `ProfileCollection.nameSource: FieldSource` — drukowana nazwa
  stworzenia/pozycji kolekcji nie mieści się w `ProfileField.actorSchemaPath`
  (ścieżka WEWNĄTRZ `system`, a `name` Dokumentu jest siostrą `system`, nie
  jego częścią) — reużywa dokładnie ten sam mechanizm `FieldSource`
  (label/region/styleFilter) zamiast wymyślać drugi.
- `CollectionSplitRule` dostał `sectionHeaderIsRegex`/`entryBoundaryIsRegex`
  (spójność z resztą schematu, gdzie każdy `*Pattern` ma swój `*IsRegex` —
  przeoczone w Zadaniu 1, bo `splitRule` nie miał jeszcze żadnego
  konsumenta).

**`import/extractInstance.ts` — brakujący łącznik Zadanie 3 → Zadanie 4:**
`extractStatblockInstance(candidate, profile): ExtractedActorInstance`
uruchamia PRAWDZIWĄ ekstrakcję (Zadanie 2, `extractField`) dla `nameSource`,
każdego `fields[]` z `source`, i każdej pozycji każdej kolekcji (po
podziale — patrz niżej) — dokładnie to, czego Zadanie 3 świadomie NIE
robiło. Użyto tego samego precedensu co
`computeCandidateConfidence`/`detectStatblocks.ts`: `candidate.regions[0]`
jako jedyny bbox dla źródeł typu `region` (kandydat rozciągnięty na kilka
stron/kolumn nie ma sensownej sumy bboxów między stronami).

**`import/splitCollectionEntries.ts` — pierwszy realny konsument
`splitRule`:** dzieli już-zlokalizowany fragment tekstu na pozycje WYŁĄCZNIE
po CAŁYCH liniach (rekonstruowanych przez `reconstructLines`, Zadanie 2 —
nigdy w połowie linii, bo `PageTextElement`y to już dyskretne tokeny).
`sectionHeaderThenEntries` pomija linię nagłówka; oba warianty z etykietą
podziału (`repeatingLinePattern`/`sectionHeaderThenEntries`) traktują linię
dopasowaną do `entryBoundaryPattern` jako POCZĄTEK nowej pozycji (włącznie);
`fixedDelimiter` traktuje dopasowaną linię jako czysty SEPARATOR (wyłączony
z obu sąsiednich pozycji, np. linia z samymi myślnikami). Degradacja, nigdy
wyjątek ani cichy pusty wynik: brak `entryBoundaryPattern` → każda linia
staje się osobną pozycją; linie PRZED pierwszym dopasowaniem (możliwe tylko
dla `repeatingLinePattern`, bo nagłówek już konsumuje wstęp) trafiają do
własnej, prawdopodobnie niepełnej pozycji zamiast zniknąć po cichu.

**`import/buildActorData.ts` — budowanie + walidacja, bez Foundry:**
`setPath.ts` (własny, czysty odpowiednik `foundry.utils.setProperty` — core
nie może go importować). Każde mapowane pole przechodzi `castAndValidate`
(Zadanie 2) PO RAZ DRUGI — pierwszy raz przy ekstrakcji (wobec gołego
`dataType` z profilu), drugi raz tutaj (wobec PRAWDZIWEGO opisu schematu
Actora/Itemu z introspekcji, z min/max/choices) — niezgodność typu = błąd
(wartość pominięta), naruszenie ograniczenia (choices/min/max) = ostrzeżenie
(wartość zostaje, tak jak w Zadaniu 2). Brak deskryptora dla ścieżki =
błąd (dryf schematu/literówka w profilu); brak schematu Itemu dla całej
kolekcji (nierozwiązany `templateItemUuid`) = JEDNO ostrzeżenie zamiast
jednego na pole. `inheritUnmappedFromTemplate` (**domyka pytanie #8**:
zastosowano DOKŁADNIE tę samą globalną flagę profilu na poziomie pozycji
kolekcji, nie tylko Actora — najprostsza spójna interpretacja) kopiuje
`currentValue` z deskryptora szablonu na każdą NIEOBJĘTĄ ścieżkę-liść.
Brak znalezionej nazwy (Actora lub pozycji) nigdy nie blokuje importu —
degraduje do generycznego fallbacku ("Unnamed"/"Unnamed Item", żadna nazwa
systemowa) z ostrzeżeniem, reszta danych i tak się buduje.

**`import/nearestImage.ts` — serwis przypisania obrazu (heureza):** czysta
geometria (`rectGapDistance`, już istniejące w `geometry.ts`), zero I/O —
wybiera najbliższy obraz na TEJ SAMEJ stronie co pierwszy region kandydata
(inne strony nigdy nie są "najbliższe", niezależnie od surowych liczb —
przestrzenie współrzędnych różnych stron nie są porównywalne). Zamiana
wybranego id na realną ścieżkę pliku i RĘCZNA zmiana przez użytkownika to
zadanie warstwy UI (Zadanie 5) — ta funkcja dostarcza tylko DOMYŚLNY wybór.

**`import/resolveDuplicateAction.ts` — obsługa duplikatów:** samo
wyszukanie istniejącego Actora (`game.actors`) zostaje w module (zapytanie
Foundry), ale DECYZJA "co zrobić, mając odpowiedź tak/nie" to mała, czysta
funkcja (`skip`→pomiń, `overwrite`→aktualizuj, `copy`→zawsze twórz nowy) —
testowalna bez żywego świata.

**`packages/module/src/statblock/import/importStatblocks.ts` — orkiestracja
Foundry:** jedyne miejsce z `fromUuid`/`Actor.create`/`game.actors`/
`createEmbeddedDocuments` dla tej funkcji. Dla każdego kandydata: ekstrakcja
(Zadanie 3 → `extractStatblockInstance`) → budowanie danych
(`buildActorData`) → sprawdzenie duplikatu → zapis (`Actor.create({...,
items})` dla nowego — "razem z Actorem" z brifu — albo `update` +
`createEmbeddedDocuments` po usunięciu starych zarządzanych Itemów dla
nadpisania — "osobno" z brifu). Błąd zapisu JEDNEJO statbloku nigdy nie
przerywa całego przebiegu — łapany i raportowany per-instancja (`status:
'error'`), z postępem przez `onProgress`/`AbortSignal` (ten sam kontrakt co
Zadanie 3). **Brak automatycznego testu — decyzja świadoma, ten sam
precedens co `buildPagesForDetection.ts`** (`buildCIFFromDocument.ts` też go
nie ma) — zweryfikowane ręcznie, instrukcja niżej.

### Instrukcja ręcznego testu w Foundry (Zadanie 4)

1. W świecie testowym z zainstalowanym dowolnym systemem: utwórz wzorcowego
   Actora (dowolny typ, np. "npc") z co najmniej jednym polem liczbowym
   (np. HP) i jedną kolekcją embedded Itemów (np. bronie/ataki) z co
   najmniej jednym wzorcowym Itemem.
2. Ręcznie złóż `StatblockProfile` jako JSON (Zadanie 5 dostarczy kreator —
   do tego czasu: albo edycja ręczna, albo mały skrypt w konsoli
   przeglądarki wołający `game.settings.set(...)` bezpośrednio), wskazując
   `templateActorUuid`/`templateItemUuid` na Actora/Item z kroku 1,
   `nameSource`/`fields[].source`/`collections[].nameSource`/`itemFields`
   na realne etykiety w testowym PDF-ie.
3. Wywołaj `detectStatblocks` (Zadanie 3) na tekście z testowego PDF-a, żeby
   uzyskać `DetectionCandidate[]`.
4. Wywołaj `importStatblocks(profile, candidates, { duplicatePolicy: 'skip' })`
   z konsoli przeglądarki (po zaimportowaniu modułu w konsoli deweloperskiej
   Foundry).
5. Sprawdź: utworzony Actor ma poprawną nazwę i wartość HP pod właściwą
   ścieżką schematu; embedded Itemy odpowiadają pozycjom w PDF-ie z
   poprawnymi wartościami pól; uruchomienie PONOWNIE z `duplicatePolicy:
   'skip'` NIE tworzy duplikatu; z `'overwrite'` aktualizuje istniejącego
   Actora i podmienia jego zarządzane Itemy; z `'copy'` tworzy dodatkowego
   Actora o tej samej nazwie.
6. Sprawdź `ImportReport` zwrócony z wywołania: liczby `created`/`updated`/
   `skipped`/`failed` zgadzają się z tym, co faktycznie powstało w świecie,
   a `diagnostics` per instancja wskazują na realne, zrozumiałe problemy
   (np. usuń jedno wymagane pole z profilu i sprawdź, że pojawia się
   odpowiednie ostrzeżenie zamiast cichego pominięcia).

**Testy:** 58 nowych testów jednostkowych (929 w sumie w core) na
ręcznie budowanych mockach (`ExtractedActorInstance`/`SchemaFieldDescriptor`/
`DetectionCandidate` — zero PDF, zero Foundry) pokrywających: budowanie
ścieżek (`setPath`), wyciąganie ograniczeń/liści z drzewa deskryptorów,
rozwiązywanie łańcucha transformacji (w tym `valueMapId` nieznaleziony),
wszystkie warianty `splitCollectionEntries` (w tym degradacje), pełną
ekstrakcję instancji (nazwa/pola/kolekcje, w tym pole bez źródła i etykieta
nieznaleziona), budowanie danych Actora (mapowanie/błąd ścieżki/ostrzeżenie
braku wartości/porażka rzutowania/miękkie naruszenie ograniczenia/
dziedziczenie z szablonu/kolekcje/fallback nazwy), heurystykę najbliższego
obrazu, i tabelę decyzyjną duplikatów.
`importStatblocks.ts` (warstwa Foundry) celowo bez testu — patrz wyżej.

**Bramki:** 929 testów core zielone, typecheck obu pakietów czysty
(wymagało przebudowania `packages/core`'s `dist/`, żeby moduł widział nowe
eksporty — `@bindery/core` rozwiązuje się do zbudowanego pakietu, nie
źródeł), lint, `check:boundary`/`check:imports`/`check:size` (budżet bez
zmian — `import/` niepodpięty pod żaden punkt wejścia UI)/`check:lang`,
`build` bez błędów. Bez `package`/podbicia wersji, jak w poprzednich
zadaniach.

**Czego NIE zrobiono / założenia do potwierdzenia:** patrz nowe pytania
#22-#24 niżej — kolejność `valueMapId` zawsze na końcu łańcucha,
`candidates` w `importStatblocks` jako surowe `DetectionCandidate[]`
(ekstrakcja dzieje się WEWNĄTRZ tej funkcji, nie przed nią) zamiast
gotowych `ExtractedActorInstance[]`, i `templateSchemaFingerprint` wciąż
nigdzie nieporównywany (obliczony i zapisany, ale nic go jeszcze nie
sprawdza przy imporcie).

## Zrealizowane — Zadanie 5 (UI kreatora profilu, `ui/`)

**Zakres:** ApplicationV2 okno `ProfileBuilderApp`
(`packages/module/src/statblock/ui/ProfileBuilderApp.ts` +
`templates/statblock-profile-builder.hbs`), otwierane z nowej pozycji w menu
ustawień modułu (`game.settings.registerMenu`, wzorem `openWizard`/
`ImportWizard`). Makieta układu pokazana i zaakceptowana przez właściciela
PRZED napisaniem kodu (zgodnie z brifem). Realizuje wszystkie 8 funkcji z
brifu — szczegóły i świadome uproszczenia niżej.

**"UI ma być cienkie" — zweryfikowane strukturalnie:** klasa NIE zawiera
żadnej logiki ekstrakcji/detekcji/walidacji własnej — woła WYŁĄCZNIE moduły z
Zadań 1-4 (`validateProfile`, `introspectDocumentInstance`,
`openPreviewDocument`, `buildPagesForDetection`, `extractField`,
`resolveTransformChain`, `detectStatblocks`, `profile/store.ts`'s CRUD).
Własna logika tego pliku to WYŁĄCZNIE: stan UI (która zakładka, co
zaznaczone, tryb prosty/zaawansowany), budowanie kontekstu Handlebars z tego
stanu, i wiązanie zdarzeń DOM.

**`@bindery/core` (i wszystko pod `../schema/`/`../profile/`, co go
statycznie importuje) ładowane WYŁĄCZNIE dynamicznym `import()` wewnątrz
metod** — ta sama dyscyplina co `ImportWizard.ts` (ryzyko I3/`check:size`):
`registerMenu` wymaga referencji do klasy w `settings.ts`, więc SAMA klasa
trafia do eager bundle'a świata, ale jej WŁASNY kod (bez `@bindery/core`)
musi się w nim zmieścić. Budżet `check:size` nadal zielony (35217/40960
bajtów), ale zużyty w ~86% — **obserwacja, nie usterka**: sama definicja
klasy `ProfileBuilderApp` (spora, ~700 linii) urosła z 7873 do 35217 bajtów w
eager-loaded `api-*.js`. Patrz nowe pytanie #25 — kolejne zadania UI (6-7)
mogą już nie zmieścić się w budżecie bez dalszego rozbicia/leniwego
ładowania.

**Makieta okna (zakładka "Pola", najbardziej złożona):** trzy kolumny —
podgląd strony PDF z nakładką SVG pokazującą elementy tekstu jako klikalne
prostokąty (reużycie `pageOverlayGeometry.ts`'s `pdfRectToScreen`/
`screenRectToPdf`, dokładnie ten sam wzorzec pointerdown/move/up co
`ReviewScreen.ts`'s "Select and crop", napisany od nowa jako własna, prostsza
wersja — metody `ReviewScreen`'a są prywatne, nie do reużycia bezpośrednio);
środkowa kolumna: przeszukiwalne, płaskie drzewo pól z SchemaIntrospectora
(Zadanie 1), zmapowane oznaczone haczykiem; prawa kolumna: konfiguracja
źródła + edytor łańcucha transformacji + podgląd na żywo.

**Wybór Actora wzorcowego i PDF-a (zakładka "Źródło"):** `<select>` po
`game.actors.contents` (wybór po `id`, ustawia `templateActorUuid`/
`actorType` z żywego dokumentu — introspekcja przez `introspectDocumentInstance`,
Zadanie 1) + `<input type=file accept=".pdf">` (wzorzec `ImportWizard`'a),
ładujący RAZEM `openPreviewDocument` (podgląd strony) i
`buildPagesForDetection` (Zadanie 3 — CAŁY dokument od razu, cache'owany w
pamięci na czas edycji, żeby podgląd na żywo/test detekcji na dowolnej
stronie nie musiały niczego przeliczać).

**Przypisanie zaznaczenia do pola:** klik na element w nakładce SVG →
`FieldSource` typu `label` (dokładny, przycięty tekst klikniętego elementu,
`labelIsRegex:false`) — WYŁĄCZNIE ten jeden, konkretny sposób budowy
etykiety w v1 (autor może ręcznie przełączyć na regex w polu tekstowym
obok). Przeciągnięcie prostokąta → `FieldSource` typu `region`.
**Udokumentowane uproszczenie:** `normalizedRect` liczony względem CAŁEJ
STRONY, nie "bboxa statblocka" (zamierzone znaczenie `RegionSource` z
Zadania 2) — w momencie przechwytywania nie ma jeszcze ustalonego regionu
jednego statblocka (detekcja niekoniecznie uruchomiona). Profil zbudowany
tak działa poprawnie WYŁĄCZNIE dla układów z jednym statblockiem na stronę,
chyba że autor ręcznie poprawi znormalizowany prostokąt później. Patrz nowe
pytanie #26.

**Kolekcje:** dodawanie/usuwanie sekcji, wybór typu Itemu + UUID
wzorcowego Itemu (wpisywany wprost — brak własnego pickera dokumentów w tym
module; po wpisaniu UUID moduł sam introspektuje Item i uzupełnia
`itemType`), reguła podziału (3 warianty z Zadania 4, uproszczony tekst
wzorca w trybie prostym). **Udokumentowane uproszczenie:** brak osobnego
drzewa schematu PER TYP ITEMU — pola pozycji kolekcji dodaje się wpisując
ścieżkę schematu wprost (tekstowo), nie klikając w drzewo jak dla pól
Actora. To rozwiązanie asymetryczne, ale unika budowania DRUGIEGO,
kontekstowego drzewa schematu w tej samej sesji edycji. Patrz nowe pytanie
#27.

**Podgląd na żywo:** liczony WEWNĄTRZ `_prepareContext` (nie jako efekt
uboczny `_onRender` wołający `this.render()` ponownie — **błąd złapany i
naprawiony PRZED commitem**: pierwsza wersja robiła to jako
`_onRender`-owy efekt uboczny, co wchodziło w NIESKOŃCZONĄ pętlę renderowania,
bo `#selectedTarget` wciąż był ustawiony po każdym renderze). Woła
`extractField` (Zadanie 2) na elementach BIEŻĄCEJ strony podglądu z
rozwiązanym łańcuchem transformacji (`resolveTransformChain`, Zadanie 4).

**Edytor łańcucha transformacji:** lista chipów + jeden generyczny formularz
"dodaj krok" (wybór rodzaju + jeden parametr tekstowy, znaczenie zależne od
rodzaju) zamiast osobnego formularza per rodzaj kroku — **udokumentowane
uproszczenie**: `regexExtract.group` i `split.separatorIsRegex` NIE są
ustawialne z UI w v1 (zawsze `undefined`/`false`) — zaawansowany użytkownik
może je dodać ręcznie edytując wyeksportowany JSON. Edytor `valueMaps` NIE
został zbudowany osobno w v1 — `valueMapId` istnieje w schemacie i silniku
(Zadanie 4), ale UI go jeszcze nie wystawia. Patrz nowe pytanie #28.

**Detekcja:** kotwica (tryb prosty: tylko tekst nagłówka; zaawansowany:
`textPattern`/`headingStyle` + minimalny `styleFilter` — pogrubienie +
"największy font w bloku", bez pełnego edytora filtra stylu), granica (4
warianty z Zadania 3), lista wymaganych etykiet, przycisk "Testuj na całym
PDF-ie" wołający `detectStatblocks` (Zadanie 3) na już scache'owanych
stronach, lista wyników klikalna do przeskoczenia podglądu na daną stronę.

**Zapis/eksport/import/duplikowanie/usuwanie:** przez `profile/store.ts`
(Zadanie 1) wprost — okno samo nie ma żadnej logiki persystencji. "Zapisz"
najpierw uruchamia `validateProfile` (Zadanie 1) i pokazuje czytelne błędy
zamiast zapisywać nieprawidłowy profil.

**Tryb prosty/zaawansowany:** rzeczywisty, działający przełącznik (nie
kosmetyczny) — ukrywa/pokazuje: kotwicę `headingStyle` i jej filtr stylu,
granice `verticalGap`/`endOfColumnOrPage`/`endLabel` (prosty pokazuje tylko
`nextAnchor`), warianty transformacji `regexExtract`/`nthNumber`/`split`/
`join`/`defaultValue`, wariant podziału kolekcji `fixedDelimiter`.

**Bramki:** typecheck obu pakietów czysty, lint czysty, `build` bez błędów,
`check:boundary`/`check:imports` zielone, `check:lang` zielony (wszystkie
nowe klucze `BINDERY.statblockProfileBuilder.*` w en I pl, ten sam zestaw),
`check:size` zielony (patrz obserwacja o budżecie wyżej), 929 testów core
bez zmian (Zadanie 5 to czysto moduł-side UI — zero nowych testów
automatycznych, ten sam precedens co `ReviewScreen.ts`/`ImportWizard.ts`/
`GridPicker.ts`/`TokenPrepApp.ts`, żaden z których nie ma testu). **Nie
zweryfikowane na żywym Foundry** — brak dostępnego środowiska w tej sesji,
instrukcja ręcznego testu niżej.

### Instrukcja ręcznego testu w Foundry (Zadanie 5)

1. W świecie testowym: Ustawienia modułu → "Kreator profilu statblocka…" —
   powinno otworzyć się okno z pustą listą profili (lub istniejącą z Zadania
   4, jeśli dodano ręcznie do `statblockProfiles`).
2. "Nowy profil" → przejście do edytora, zakładka "Źródło" aktywna.
3. Wybierz dowolnego Actora z listy (dowolny system) — sprawdź, że
   `actorType` i `templateActorUuid` ustawiają się poprawnie (bez błędów w
   konsoli).
4. Wczytaj syntetyczny/testowy PDF (NIE prawdziwy statblock — reguła 6) —
   sprawdź, że podgląd strony 1 się renderuje i licznik stron jest poprawny.
5. Zakładka "Pola": kliknij dowolny element tekstu na podglądzie — powinien
   pojawić się pasek "Zaznaczenie: <tekst>"; kliknij pole w drzewie schematu
   po prawej, potem "Przypisz do zaznaczonego pola" — sprawdź, że pole
   dostaje haczyk w drzewie i podgląd na żywo pokazuje surowy tekst/wartość.
6. Dodaj krok transformacji (np. "Rozpoznaj liczbę" dla pola liczbowego) —
   sprawdź, że podgląd na żywo aktualizuje wartość.
7. Przeciągnij prostokąt na podglądzie strony — sprawdź, że pasek zaznaczenia
   pokazuje "region" zamiast tekstu etykiety.
8. Zakładka "Kolekcje": dodaj kolekcję, wpisz UUID wzorcowego Itemu z Actora
   wybranego w kroku 3 — sprawdź, że typ Itemu uzupełnia się automatycznie.
9. Zakładka "Detekcja": skonfiguruj prostą kotwicę tekstową pasującą do
   czegoś w testowym PDF-ie, kliknij "Testuj na całym PDF-ie" — sprawdź, że
   lista wyników pokazuje sensowne strony/pewności; kliknięcie wyniku
   przeskakuje podgląd na właściwą stronę.
10. "Zapisz" — sprawdź komunikat potwierdzający; zamknij i otwórz okno
    ponownie, "Edytuj" ten sam profil — sprawdź, że WSZYSTKIE wprowadzone
    dane (pola, kolekcje, detekcja) wracają niezmienione.
11. Wypróbuj tryb "Zaawansowany" — sprawdź, że dodatkowe kontrolki (kotwica
    stylu nagłówka, więcej wariantów granicy/transformacji) się pojawiają i
    nie psują trybu prostego po powrocie.
12. Eksportuj profil do pliku, usuń go z listy, zaimportuj z powrotem —
    sprawdź, że dane się zgadzają.

## Zrealizowane — Zadanie 7 (dopracowanie)

**Zakres:** audyt + naprawa na całej funkcji statblock-import (Zadania 1-5),
bez nowych funkcji — dokładnie 7 punktów brifu właściciela.

**1. Audyt nazw systemów RPG / zahardkodowanych ścieżek `system.*`:** grep +
ręczny przegląd `statblock/` w obu pakietach. **Zero rzeczywistych naruszeń
znalezionych** — trzy komentarze wspominające "CoC7" to legalne odniesienia
historyczne (kontrastują NOWY, bezsystemowy kod ze STARYM, usuniętym
adapterem — dokładnie ta sama narracja co sekcja "Dlaczego od zera" tego
dokumentu), a `'system.'` w `introspectActor.ts` to nazwa WŁASNEGO pola
Dokumentu Foundry (uniwersalna dla każdego systemu), nie ścieżka
systemowo-specyficzna. Nowy skrypt CI `tools/check-no-system-names.mjs`
(`npm run check:no-system-names`, wpięty w `npm run build`) — skanuje
`statblock/` (oba pakiety) + `templates/`+`lang/` pod kątem (a) znanej listy
id systemów Foundry jako CYTOWANEGO literału (nie prozy w komentarzu) i (b)
literału `system.<cokolwiek>` z czymś po kropce W TEJ SAMEJ parze cudzysłowów
(bary prefiks `'system.'` nie łapie się — to legalne użycie).

**2. Kompletność/spójność lokalizacji en/pl:** nowy skrypt
`tools/check-lang-usage.mjs` (`npm run check:lang-usage`, wpięty w `build`)
— skanuje `packages/module/src`+`templates` pod kątem literałów
`BINDERY.x.y`, porównuje z kluczami w `en.json`. **Znaleziono i naprawiono
jeden prawdziwy brakujący klucz:** `BINDERY.statblockProfileBuilder.loadingPdf`
(Zadanie 5, ustawiane w kodzie, nigdy niezdefiniowane w `lang/`, i NIGDY
niewyświetlane w szablonie w ogóle — druga, powiązana usterka, patrz niżej).
**70 kluczy zgłoszonych jako "nieużyte"** (ostrzeżenie, nie błąd — skrypt
nie widzi konstrukcji dynamicznych) — w tym CAŁA istniejąca sekcja
`diagnostic.*` (odkrycie opisane w punkcie 3 niżej) oraz garść PRAWDZIWIE
martwych kluczy sprzed tej sesji (`BINDERY.wizard.fieldFileName`/
`resultTitle`, `BINDERY.review.tabJournals`/`tabScenes`/`journals`/`scenes`/
itd. — pozostałości po wcześniejszej wersji `ReviewScreen`, poza zakresem tej
funkcji, NIE usunięte — patrz "Dług techniczny" niżej).

**3. Obsługa błędów/komunikaty z kontekstem — dwie prawdziwe usterki
znalezione i naprawione:**
- **Zaginiony `busy` wskaźnik:** Zadanie 5 ustawiało `this.#busy` podczas
  ładowania PDF-a, ale NIGDY nie renderowało go w szablonie — użytkownik nie
  widział ŻADNEJ informacji zwrotnej podczas (potencjalnie długiego, patrz
  punkt 4) wczytywania dużego PDF-a. Naprawione: `{{#if busy}}` w zakładce
  "Źródło" + brakujący klucz z punktu 2.
- **Diagnostyki w podglądzie na żywo gubiły `params` (stronę/pole/wartość)
  całkowicie** — pokazywały goły `"severity: KOD"`. **Odkryty, udokumentowany,
  ale NIGDY niezaimplementowany mechanizm** w samym rdzeniu:
  `localizableMessage.ts`/`text/types.ts` (core) wprost mówią "warstwa
  modułu formatuje `code`+`params` przez `game.i18n.format`... zobacz
  `packages/module/src/i18n.ts`" — **ten plik nie istniał**. Utworzony teraz:
  `packages/module/src/i18n.ts::formatDiagnostic(diagnostic)` — używa
  `game.i18n.format('BINDERY.diagnostic.' + code, params)` gdy szablon
  istnieje (fallback na goły kod, gdy nie — `game.i18n.has(key, false)`),
  dokleja stronę/pole/surową wartość jako JEDNOLITY sufiks NIEZALEŻNIE od
  tego, czy sam szablon je referencuje (uzasadnienie w komentarzu pliku: ten
  sam kod bywa wzbogacany o `field`/`raw` W JEDNYM miejscu emisji
  (`buildActorData.ts`), a nie w innym (`castAndValidate.ts` wprost) —
  szablon odwołujący się do `{field}` pokazywałby dosłowny, niepodstawiony
  placeholder tam, gdzie go nie ma). Dodano **37 nowych szablonów**
  `BINDERY.diagnostic.STATBLOCK_*` (en+pl, dopasowane dokładnie do realnych
  kluczy `params` każdego kodu, zweryfikowane grepem źródła) — pierwsza
  faktyczna treść dla WSZYSTKICH kodów diagnostycznych Zadań 2-4. Wpięte w
  `ProfileBuilderApp`'s podgląd na żywo.

**4. Wydajność na dużym PDF-ie — dwie prawdziwe usterki znalezione i
naprawione w `ProfileBuilderApp.ts`, plus jeden nowy test regresyjny:**
- **Wyciek `URL.createObjectURL` + zbędne ponowne dekodowanie strony PDF na
  KAŻDYM renderze okna** (nie tylko przy zmianie strony) — ApplicationV2
  podmienia CAŁY DOM przy każdym `render()` (ustalona konwencja tego
  projektu), a stary kod wołał `previewDoc.renderPage()` (kosztowne
  dekodowanie+kodowanie WebP) i tworzył NOWY `createObjectURL` przy KAŻDYM
  `_onRender`, nigdy nie zwalniając poprzedniego — klik w dowolne pole,
  wpisanie znaku w wyszukiwarce, wszystko na zakładce "Pola" ponownie
  dekodowało obraz strony i pogłębiało wyciek. Naprawione reużyciem
  DOKŁADNIE sprawdzonego wzorca `ReviewScreen.ts`'s
  `#pageImageCache`/`#ensurePageImage` (cache z LRU, rozmiar 5, `img.src`
  wiązany przez kontekst Handlebars, nie imperatywnie w `_onRender`) — ten
  sam kod, nie wymyślony od nowa.
- **Wyciek `PreviewDocument` (uchwyt pdf.js) przy zmianie PDF-a/profilu** —
  otwarcie drugiego przykładowego PDF-a w tej samej sesji, edycja innego
  profilu, czy powrót do listy nigdy nie wołały `previewDoc.destroy()`
  (tylko zamknięcie CAŁEGO okna to robiło). Naprawione nowym
  `#teardownPreviewDoc()` wołanym z wszystkich czterech miejsc (nowy PDF,
  reset edytora, powrót do listy, zamknięcie okna).
- **Nowy test regresyjny** (`test/statblock/pdf/largeDocumentPerformance.test.ts`,
  931 testów w sumie w core): syntetyczny dokument 300 stron (bez
  prawdziwego PDF-a — reguła 6, to co jest zagrożone to WŁASNY algorytm
  `detectStatblocks`, nie prędkość dekodowania pdf.js) potwierdza `detectStatblocks`
  znajduje dokładnie 1 kandydata na stronę z pewnością 1 w < 5s (budżet
  hojny, to strażnik regresji, nie SLA), plus test porównujący czas
  `buildStatblockReadingOrder` dla 100 vs 1000 stron — potwierdza skalowanie
  W PRZYBLIŻENIU LINIOWE, nie kwadratowe. `buildPagesForDetection`'s
  "wczytaj cały dokument naraz" pozostawiono BEZ ZMIAN — to ten sam,
  ISTNIEJĄCY WCZEŚNIEJ wzorzec architektoniczny całego pipeline'u CIF
  (`buildCIFFromDocument.ts` robi identycznie), nie nowe ryzyko wprowadzone
  przez tę funkcję — udokumentowane jako rekomendacja na później, nie
  naprawione teraz.

**5-6. README:** nowa sekcja "Statblock import (profile-based) — in
development" — workflow 6 kroków (buduj profil → mapuj pola → kolekcje →
detekcja+test → zapis), przykład na w pełni abstrakcyjnych polach
(`attributeA`, `resourceB`, sekcja "Actions") zamiast jakiegokolwiek
realnego systemu, jawne ograniczenia (brak OCR, jeden profil na layout,
wymaga istniejącego Actora/Itemu jako wzorca, uproszczenie normalizacji
regionu z Zadania 5), i podsekcja "Extension points" (OCR jako warstwa
PRZED detekcją, podpowiedzi mapowania jako sugestie do potwierdzenia, nie
automat). **Naprawiona przy okazji nieaktualność** flagowana w pytaniu #11:
stara sekcja "What's not in this release" mówiła "Funkcja jest zbudowana i
przetestowana" o STARYM, USUNIĘTYM silniku sprzed tej całej przebudowy —
zaktualizowana na uczciwy status "w budowie na osobnym branchu, niedostępne
w tym wydaniu".

**7. Dług techniczny — patrz nowa sekcja niżej i nowe pytania #29-31.**

**Bramki:** 931 testów core zielone (2 nowe testy wydajności), typecheck
obu pakietów czysty, lint czysty, `build` (z nowymi `check:lang-usage`/
`check:no-system-names` w łańcuchu) bez błędów, `check:boundary`/
`check:imports` zielone, `check:size` zielony ale ciaśniej (36368/40960
bajtów, ~89% — `i18n.ts` dodał ~1.1KB do eager bundle'a; patrz pytanie #25
z Zadania 5, wciąż otwarte i coraz bardziej naglące).

### Dług techniczny — pełna lista (Zadanie 7, punkt 7)

Zebrane z całej sesji (pytania #1-28 wyżej wciąż otwarte) plus nowe z tego
audytu:

- **Martwe klucze lokalizacji sprzed tej sesji** (`BINDERY.wizard.
  fieldFileName`/`resultTitle`, `BINDERY.review.tabJournals`/`tabScenes`/
  `journals`/`scenes`/`journalsOptInHint`/`journalGroupApply`/
  `journalGroupHint`/`selectedCount`/`destinationLabel`/`cancelledHint`) —
  prawdopodobnie pozostałości po wcześniejszej wersji `ReviewScreen` (osobne
  zakładki Journals/Scenes, później skonsolidowane). Poza zakresem tej
  funkcji — nie usunięte, tylko odnotowane.
- **`ReviewScreen.ts`'s wiersz diagnostyki nadal pokazuje goły `[severity]
  KOD × liczba`**, nie korzysta z nowego `formatDiagnostic()` — teraz, gdy
  ten helper istnieje, `ReviewScreen` mógłby z niego skorzystać dla dużo
  czytelniejszych komunikatów (wymaga dopisania szablonów dla kodów spoza
  `STATBLOCK_*`, które już je mają).
- **`buildPagesForDetection`'s wczytywanie całego dokumentu naraz** —
  akceptowalne teraz (ten sam wzorzec co reszta pipeline'u), ale przy
  naprawdę dużych książkach (setki stron gęstego tekstu) mogłoby skorzystać
  na leniwym/strumieniowym przetwarzaniu per strona zamiast budowania
  całego `PageForDetection[]` naraz — większa zmiana architektoniczna, nie
  punktowa naprawa.
- **Budżet `check:size` na 89%** (patrz pytanie #25) — coraz pilniejsze po
  Zadaniu 7's `i18n.ts`.
- Wszystkie pytania #1-28 z poprzednich zadań (patrz sekcja wyżej) —
  najbardziej dojrzałe do domknięcia: #17 (już domknięte w Zadaniu 4), #8
  (już domknięte w Zadaniu 4), #22-24 (Zadanie 4, wciąż otwarte), #25-28
  (Zadanie 5, wciąż otwarte).

## Zrealizowane — Poprawki po teście na żywo (po Zadaniu 7)

Przejście kreatora na prawdziwym Foundry (v14, syntetyczny PDF) wykryło
błędy, których testy jednostkowe nie mogły: 

- **Domyślna nazwa profilu / sufiks kopii** były zahardkodowane po polsku
  — przeniesione do locale (`defaultProfileName`, `copySuffix`).
- **Klikanie napisu na podglądzie nic nie robiło** — `setPointerCapture`
  na SVG przekierowuje `click` na SVG; trafienie w prostokąt ustalane teraz
  przez `document.elementsFromPoint` na `pointerup` (`#rectLabels`).
- **Pasek zaznaczenia** był poza widocznym obszarem okna — przeniesiony nad
  podgląd strony.
- **Pole wyszukiwania pól schematu traciło fokus po każdej literze**
  (ApplicationV2 podmienia DOM przy każdym `render()`) — fokus i kursor
  przywracane w `_onRender`.
- **Wyszukiwanie nie znajdowało pól, których nazwa jest na grupie
  nadrzędnej** (liść "Flat" pod grupą "Armor Class") — wyszukiwanie i
  etykieta w wynikach uwzględniają teraz etykiety przodków.
- **Mniej klikania dla pól liczbowych**: `castAndValidate` dla celu typu
  number czyta pierwszą liczbę z tekstu (etykieta bierze resztę linii, więc
  "7 AC: 15" wcześniej dawało błąd bez ręcznego kroku Parse number).
  Jawne `parseNumber`/`nthNumber` nadal działają i mają pierwszeństwo.
- **Wdrożenie**: katalog repo i katalog modułu w Foundry to dwa różne
  katalogi, a `sync:local` zakłada, że to jedno — kopiowanie ręczne;
  po każdym buildzie otwarte karty Foundry wymagają twardego reloadu
  (nazwy chunków mają hash).

Zweryfikowane na żywo przez właściciela: klik → przypisanie → podgląd →
test detekcji → zapis. Nadal nieprzetestowane na żywo: przeciąganie
regionu, kolekcje z prawdziwym Itemem szablonowym, eksport/import/
duplikowanie/usuwanie profilu, faktyczny import Actorów.


## Zrealizowane — Import statblocków w kreatorze importu PDF (wstęp do Zadania 6)

**Podział odpowiedzialności** (decyzja właściciela): kreator profilu
(`ProfileBuilderApp`) TYLKO tworzy i testuje profil (zakładka Detection
zostaje jako test profilu); import Actorów dzieje się w istniejącym
kreatorze importu PDF (`ImportWizard`). W oknie importu, po analizie PDF-a,
jest przycisk "Importuj statblocki jako Actorów…", który otwiera lekkie
okno `StatblockImportApp` (ładowane leniwie) dla JUŻ wczytanego pliku —
bez ponownego wybierania PDF-a. Okno: wybór zapisanego profilu (jeden
profil jest wybierany sam i od razu uruchamia wyszukiwanie), walidacja
profilu, lista znalezionych statblocków (str./pewność/pierwszy tekst),
polityka duplikatów (pomiń / nadpisz / kopia), potwierdzenie, raport
(utworzono/zaktualizowano/pominięto/błędy + zlokalizowane diagnostyki).
Bez przypisywania obrazów i wyboru folderu (świadomie, kolejny krok).

**Budżet `check:size`**: kreator profilu i okno importu ładowane leniwie
(`ProfileBuilderLauncher`, dynamiczne importy) — paczka startowa ~8,7 KB
(~21% budżetu). Domyka pytanie #25.

**Poprawki z kolejnych prób na żywo**: (a) kotwica zwykłego tekstu
dopasowuje linię ZAWIERAJĄCĄ tekst (wcześniej całą linię); dokładne
dopasowanie przez regex `^…$`; (b) etykieta zwykłego tekstu ignoruje
końcowy dwukropek; (c) komunikaty w zakładce Detection (brak PDF-a, brak
wyników); (d) `templateSchemaFingerprint` nigdy nie był obliczany, więc
KAŻDY profil był odrzucany przez `validateProfile` — dodano
`computeSchemaFingerprint` (core, hash struktury: ścieżki+typy+
ograniczenia, bez etykiet i wartości), liczony przy wyborze Actora
szablonowego; profile utworzone przed poprawką trzeba przepiąć na Actora.
Nadal nic nie porównuje fingerprintu przy imporcie (pytanie #24).

**Wdrożenie lokalne**: repo i folder modułu w Foundry to różne katalogi.
Kod logiki (core) ładuje się z `lib/core/` — ręczne kopiowanie samego
`scripts/lang/templates/styles` zostawiało STARY core (stąd "is not a
function" i brak działania poprawek core). Nowy skrypt
`npm run deploy:foundry` (zmienna `BINDERY_FOUNDRY_MODULE_DIR`) kopiuje
cały zbudowany moduł, w tym `lib/`; sprawdza, że cel to folder modułu o tym
samym `id`.

**Kotwica przez klikanie** (zakładka Detection): podgląd strony jest
teraz widoczny też tam (wspólny układ z zakładką Fields). Kliknięcie
pierwszej linii statblocka ustawia kotwicę automatycznie i od razu uruchamia
detekcję ("Znaleziono statblocków: N"). Wybór reguły: jeśli styl klikniętego
tekstu (rozmiar zaokrąglony do 0,5 + pogrubienie) NIE jest dominującym
stylem strony → "po wyglądzie" (`headingStyle` z `minFontSize`/`maxFontSize`
= rozmiar ±0,5 i `bold` gdy pogrubiony); w przeciwnym razie → "po tekście"
(`textPattern`, linia zawiera tekst). Dwa przyciski przełączają regułę bez
ponownego klikania. W trybie prostym znikają: pole wzorca, wybór rodzaju
kotwicy, granica, wymagane etykiety i przycisk testu (zostają w
zaawansowanym). Przeciąganie regionu w tej zakładce jest wyłączone.
Uproszczenie: dominujący styl liczony per strona (waga = długość tekstu).

**Ręczny test**: opis w rozmowie z właścicielem. Nadal nieprzetestowane
na żywo: sam import Actora, polityki `overwrite`/`copy`, kolekcje.

## Pytania i założenia wymagające Twojej decyzji

1. **Mechanizm "uczenia" profilu** — zakładam interaktywne klikanie w
   renderowaną stronę PDF (następca Profile Studio, ale NIE jego dokładne
   odtworzenie — nowe okno, węższy zakres). Czy to dobry kierunek, czy
   wolisz inny mechanizm (np. formularz bez live-podglądu PDF-a)?
2. ~~**Perzystencja profilu**~~ — **ROZSTRZYGNIĘTE przez właściciela w
   briefie Zadania 1: oboma.** `game.settings` (`statblockProfiles`, per
   świat) jako główne miejsce + `exportProfile`/`importProfileFromFile`
   (`foundry.utils.saveDataToFile`/`readTextFromFile`) do dzielenia się
   profilem jako plikiem `.json`. Zaimplementowane w `profile/store.ts`.
3. **Niezgodność wersji `fvtt-types`** — pakiet w `packages/module` jest
   przypięty do typów Foundry 13, a `module.json` deklaruje minimum 14. Typy
   pól schematu (SchemaField/ArrayField/etc.) są w praktyce stabilne
   13→14, ale to założenie, nie pewnik — **nadal otwarte**, udokumentowane
   wprost w komentarzu `packages/module/src/statblock/schema/toFieldLike.ts`
   (kod działa na tym założeniu, nie zablokowałem się na nim). Zaktualizować
   `fvtt-types` najpierw, czy jechać dalej i zweryfikować empirycznie na
   żywym Foundry v14?
4. **Niezawodność `CONFIG.Actor.dataModels`** — **częściowo rozstrzygnięte
   przez implementację, nie empirię:** `introspectDocumentType` zwraca
   `null`, gdy brak DataModelu, i `introspectDocumentInstance` w takim
   wypadku automatycznie spada na `describeDocumentInstanceViaFallback`
   (`foundry.utils.flattenObject`) — więc stare, `template.json`-owe
   systemy NIE są wykluczone, tylko dostają uboższy wynik (bez
   label/choices/min/max, same ścieżki+typ+wartość). Nadal nie
   zweryfikowałem na żywo, że `CONFIG.Actor.dataModels` faktycznie bywa
   puste dla takich systemów w Foundry v14 (czy fallback kiedykolwiek się
   realnie uruchomi) — to wymaga żywego świata z takim systemem
   zainstalowanym.
5. **Format fixture'ów** — proponuję dwuwarstwowe podejście opisane wyżej
   (lekki JSON tokenów dla testów silnika, prawdziwe syntetyczne PDF-y przez
   istniejący `test/synth/` dla integracji). Akceptowalne, czy chcesz
   WYŁĄCZNIE prostego JSON-a nawet dla warstwy integracyjnej?
6. **Rozszerzenie CIF** — `CIFDocument` nie ma już pola `actors`. Czy nowy
   silnik ma dodać nowe pole/typ do CIF (spójność z resztą pipeline'u), czy
   `ExtractedActorInstance[]` ma być całkowicie osobnym, równoległym
   strumieniem danych, nigdy niełączonym z `CIFDocument`?
7. **Sygnał granicy statblocka** — czy `VectorRegion` (ramki
   prostokątne wykryte w `inventory/`) mają być pierwszorzędnym sygnałem
   `detection.boundary.kind: 'vectorFrame'` od zadania 3, czy to
   rozszerzenie odłożone na później (start wyłącznie na wzorcach
   tekstowych/fontowych)?
8. **Dziedziczenie nieobjętych pól przy kolekcjach** — `inheritUnmappedFromTemplate`
   jest jasne dla pól skalarnych (skopiuj z `templateActorUuid`). Co ma się
   stać z nieobjętymi polami WEWNĄTRZ jednego wpisu kolekcji (np. pole
   Itemu ataku, którego profil nie mapuje) — dziedziczyć z
   `templateItemUuid`, czy zostawić puste?
9. **R-kody/A-kody** — nie znalazłem ich scentralizowanej definicji nigdzie
   w repo (prawdopodobnie żyją tylko w lokalnym, niepodanym mi pliku MDD).
   Opisuję zasady wprost, bez numerków. Chcesz podać mi brakujące
   definicje, żebym mógł się do nich precyzyjnie odwoływać, czy zostajemy
   przy opisie słownym?
10. **Branch `etap-a`** — nadal istnieje lokalnie (6 commitów, adapter
    `dnd5e` hardkodowany), koliduje z nowym podejściem. Usunąć teraz, czy
    zostawić jako referencję do danych pomiarowych (SRD 5.2.1)?
11. **README.md jest już nieaktualny** — sekcja "What's not in this
    release" wciąż mówi "The feature is built and tested" o silniku, który
    właśnie usunęliśmy w v0.2.4. Poprawić teraz (na coś w stylu "not yet
    built"), czy poczekać aż ta funkcja czegoś dostarczy?
12. **Dopasowanie wieloelementowej etykiety** — `label` źródło dopasowuje
    etykietę na poziomie JEDNEGO elementu (cały trymowany tekst). Prawdziwe
    PDF-y czasem rozbijają jedną etykietę na dwa elementy (np. "Hit" +
    "Points:"). Czy to wystarczający zakres na start (profil autor może
    dobrać `labelPattern` z regexem obejmującym wariant), czy potrzebne
    dopasowanie po SKLEJONYM tekście sąsiednich elementów?
13. **Kalibracja progu podziału kolumn** — mediana×4 / próg bezwzględny
    24pt w `reconstructLines.ts` to rozsądna, ale NIEKALIBROWANA heureza
    (reguła 6 zakazuje testowania na prawdziwej treści, więc nie mam na
    czym skalibrować). Czy to akceptowalne jako punkt startowy do
    ewentualnej kalibracji później (analogicznie do `gapStatistics.ts` w
    starym pipeline), czy wolisz inne podejście do "obsługi kolumn" już
    teraz?
14. **`diceNotation` to tylko kosmetyka** — normalizuje wielkość liter i
    spacje wokół `+`/`-`, NIE parsuje/nie oblicza notacji kostek (poza
    zakresem tego zadania wg mojej interpretacji brifu — "łańcuch
    transformacji tekstu", nie "silnik reguł gry"). Wystarczy, czy
    potrzebny pełny parser (np. do walidacji, że "1d6+2" to poprawna
    notacja)?
15. **`textToHtml` jest linia-po-linii, nie akapit-po-akapicie** — każda
    zrekonstruowana linia to osobny `<p>`; wielolinijkowa proza NIE jest
    łączona w jeden akapit (to robi `joinWrappedLines`, ale on produkuje
    zwykły string, nie HTML). Czy potrzebny wariant łączący WIELE linii w
    jeden `<p>` (np. przez pustą linię jako separator akapitów), czy
    obecny, prostszy "jedna linia = jeden `<p>`" wystarczy na razie?
16. **`castAndValidate`'s "choices" nie odrzuca, tylko ostrzega** — wartość
    spoza `choices` zostaje (z ostrzeżeniem), zamiast być odrzucona jak przy
    niezgodności typu. Decyzja: "choices" to zamknięta lista wobec REALNEGO
    systemu (np. rozmiar stworzenia), ale ekstrakcja mogła znaleźć coś
    spoza niej przez błąd OCR/parsowania — pokazanie tego do ręcznej
    korekty wydało się bezpieczniejsze niż ciche odrzucenie. Zgadzasz się z
    tą interpretacją, czy "choices" powinno być tak samo twarde jak typ?
17. **`ProfileField` bez `transforms: TransformStep[]`** — wskaźnik pewności
    (Zadanie 3) i przyszłe pełne uruchomienie profilu na dokumencie oba
    potrzebują w końcu przejść przez PEŁNY łańcuch z Zadania 2 (`source` +
    `transforms` + `valueMapId` → `castAndValidate`), nie tylko samo
    dopasowanie źródła. Dziś `computeCandidateConfidence` świadomie używa
    WYŁĄCZNIE `extractRawValue` (patrz wyżej). Dodać `transforms` do
    `ProfileField` teraz (rozszerzenie schematu bez migracji, bo pole może
    być opcjonalne z domyślnym `[]`), czy poczekać do zadania, które faktycznie
    tworzy `ExtractedActorInstance[]` z pełnym rzutowaniem na typ?
18. **`largestFontInBlock` przemianowany na poziom strony w Zadaniu 3** —
    Zadanie 2 definiowało go względem JEDNEGO już-zlokalizowanego bloku;
    Zadanie 3 przeszukuje całą stronę pod kątem kotwic, więc semantyka
    przesunęła się na "największy font na tej stronie" (przekazywany przez
    wywołującego). Czy to akceptowalna reinterpretacja tej samej nazwy pola w
    `StyleFilter`, czy potrzebny osobny wariant (np. `largestFontOnPage`) dla
    jasności?
19. **Heureza bold/italic w `buildPagesForDetection.ts`** — wnioskowana z
    nazwy fontu (podłańcuchy "bold"/"italic"/itp.), nie z prawdziwych flag
    (te nie są niezawodnie dostępne w osadzonych fontach PDF, ustalenie z
    Zadania... właściwie ze starego, usuniętego `fontRegistry.ts`). Profil
    autora polegający na `styleFilter.bold`/`.italic` dziedziczy to
    ograniczenie. Akceptowalne jako punkt startowy, czy potrzebny dokładniejszy
    sygnał (np. porównanie grubości kreski glifu) zanim ktoś zacznie budować
    profile na kotwicy `headingStyle`?
20. **Sygnał `vectorFrame` (ramki wektorowe) wciąż nieużyty jako granica** —
    pytanie #7 wciąż otwarte: `inventory.vectors`/`VectorRegion[]` są już
    przekazywane do `PageForDetection.vectorFrames` przez
    `buildPagesForDetection.ts`, ale sam detektor (`findCandidateEnd.ts`) ich
    jeszcze nie używa jako piątego `boundary.kind`. Rozszerzyć teraz, czy
    zostawić jako zadanie 3b/4?
21. **Brak automatycznego testu dla `buildPagesForDetection.ts`** — zgodne z
    istniejącym w repo precedensem (`buildCIFFromDocument.ts` też nie ma
    testu, patrz wyżej), ale to wciąż oznacza, że cała ścieżka integracji
    pdf.js→`PageForDetection[]` jest zweryfikowana tylko przez typecheck +
    bramki statyczne, nigdy uruchomieniowo, aż do pierwszego użycia na żywym
    Foundry. Akceptowalne dalej, czy chcesz w którymś momencie jednorazowy
    spike (`spike/`, usuwany po użyciu, konwencja tego projektu) weryfikujący
    to na prawdziwym syntetycznym PDF-ie z `test/synth/`?
22. **`valueMapId` zawsze jako OSTATNI krok łańcucha transformacji** —
    `import/resolveTransformChain.ts` dokleja rozwiązany `ValueMap` po
    wszystkich krokach z `ProfileField.transforms`, bez możliwości wstawienia
    go w środku (np. przed późniejszym `regexExtract`). Wystarczające na
    start (każde pole napisane dziś potrzebuje tylko jednego wyszukania, na
    końcu, po normalizacji tekstu), czy `valueMapId` powinien stać się
    zamiast tego kolejnym wariantem `kind` wewnątrz `transforms` (z
    referencją do `valueMaps[].id`), żeby autor profilu mógł go dowolnie
    pozycjonować?
23. **`importStatblocks(profile, candidates, options)` przyjmuje SUROWE
    `DetectionCandidate[]`** (z Zadania 3), nie gotowe
    `ExtractedActorInstance[]` — ekstrakcja (`extractStatblockInstance`)
    dzieje się WEWNĄTRZ tej funkcji, per kandydat, tuż przed budowaniem
    danych. Zgodne z dosłownym brzmieniem brifu Zadania 4 ("candidates"), ale
    oznacza, że wywołujący (przyszłe UI Zadania 5/6) nie ma możliwości
    obejrzenia/edycji wyekstrahowanych wartości PRZED zapisem bez wywołania
    `extractStatblockInstance` osobno, poza `importStatblocks`, tylko po to
    żeby zbudować podgląd — powielenie tej samej ekstrakcji dwa razy dla tego
    samego kandydata. Akceptowalne (podgląd Zadania 6 i tak prawdopodobnie
    potrzebuje własnego wywołania `extractStatblockInstance` do wyświetlenia
    diagnostyki przed potwierdzeniem), czy `importStatblocks` powinien
    zamiast tego przyjmować `ExtractedActorInstance[]` już gotowe, a
    ekstrakcję zostawić wyłącznie wywołującemu?
24. **`templateSchemaFingerprint` wciąż niewykorzystywany przy imporcie** —
    liczony i zapisywany przy budowie profilu (Zadanie 1), ale
    `importStatblocks`/`buildActorData` nigdy go nie porównują z aktualnym
    stanem schematu Actora/Itemu przed zapisem (pytanie #3 z sekcji Zadania
    1 wciąż otwarte w praktyce) — dryf schematu ujawnia się dziś WYŁĄCZNIE
    pośrednio, przez pojedyncze `STATBLOCK_IMPORT_PATH_NOT_FOUND` na
    zdryfowane pole, nigdy jako jedno zbiorcze ostrzeżenie "ten profil może
    być nieaktualny". Domykać teraz, czy zostawić jako osobne, późniejsze
    usprawnienie?
25. **Budżet `check:size` zużyty w ~86% po Zadaniu 5** — sama definicja
    `ProfileBuilderApp` (eager-loaded przez `registerMenu`) zajęła ~27KB z
    40KB budżetu. Kolejne zadania UI (6: uruchomienie+podgląd, 7: import do
    Foundry) prawdopodobnie dodadzą WIĘCEJ kodu do TEGO SAMEGO okna (albo
    nowego) — czy rozbić `ProfileBuilderApp` na mniejsze, leniwie ładowane
    części teraz (zanim budżet faktycznie pęknie), czy poczekać, aż
    `check:size` faktycznie zacznie czerwienić się w kolejnym zadaniu?
26. **`RegionSource.normalizedRect` liczony względem CAŁEJ STRONY w
    kreatorze, nie bboxa statblocka** — działa poprawnie tylko dla jednego
    statblocka na stronę (patrz wyżej). Czy to akceptowalne dla v1 (autor
    poprawia ręcznie dla układów wielokolumnowych/wielu-statblocków-na-
    stronę), czy kreator powinien wymagać najpierw uruchomienia testu
    detekcji i normalizować względem bboxa NAJBLIŻSZEGO kandydata zamiast
    całej strony?
27. **Brak osobnego drzewa schematu dla pól pozycji kolekcji** — dodawane
    przez wpisanie ścieżki wprost, nie przez klikanie w drzewo (asymetryczne
    względem pól Actora). Czy warto zbudować analogiczne drzewo per typ
    Itemu (`itemDescriptorsByCollectionId` już jest zbierane, tylko
    niewyświetlane), czy zostawić jako "advanced" wpisywanie ręczne?
28. **Edytor `valueMaps` niezbudowany w v1** — `ProfileField.valueMapId`
    istnieje i działa w silniku (Zadanie 4), ale UI nie pozwala jeszcze
    zdefiniować/wybrać `ValueMap`. Priorytet na Zadanie 6, czy domykać teraz
    jako uzupełnienie Zadania 5?
29. **Martwe klucze lokalizacji sprzed tej sesji** (`wizard.fieldFileName`/
    `resultTitle`, garść `review.*` związanych z zakładkami Journals/Scenes)
    — usunąć teraz (mały, izolowany PR sprzątający), czy zostawić na osobne,
    świadome sprzątanie `ReviewScreen`, żeby nie mieszać z branchem
    statblock-import?
30. **`ReviewScreen.ts` nie korzysta z nowego `formatDiagnostic()`** — jego
    własny wiersz diagnostyki wciąż pokazuje goły `[severity] KOD × liczba`
    bez podstawionych parametrów, mimo że mechanizm formatujący TERAZ
    istnieje (Zadanie 7). Wdrożyć tam też (wymaga dopisania szablonów
    lokalizacji dla kodów spoza `STATBLOCK_*`), czy zostawić jako osobne
    zadanie nie mieszające się z tym branchem?
31. **`buildPagesForDetection`'s wczytywanie całego dokumentu naraz** —
    zaakceptowane jako spójne z resztą pipeline'u (`buildCIFFromDocument.ts`
    robi to samo), ale przy naprawdę dużych książkach mogłoby skorzystać na
    leniwym przetwarzaniu per strona. Wystarczające na teraz (bramka
    wydajnościowa z Zadania 7 przeszła), czy to już wystarczający sygnał,
    żeby zaplanować większą zmianę architektoniczną?

## Log postępu

- **2026-09-30** — dokument założony jako szkielet po ustaleniu 10 twardych
  zasad z właścicielem.
- **2026-09-30** — pełna analiza repo (pipeline PDF, wzorce UI, introspekcja
  DataModel Foundry, konwencje testowe) przez trzy równoległe agenty
  badawcze; plan architektury, schematy JSON, lista zadań 1-7 i lista pytań
  napisane. Zero kodu. Czeka na odpowiedzi właściciela na pytania powyżej.
- **2026-09-30** — Zadanie 1 (SchemaIntrospector + model profilu, briefu
  właściciela) zaimplementowane: `packages/core/src/statblock/`
  (schema: types/describeSchemaField/attachCurrentValues; profile:
  schema/validateAgainstSchema/migrate) + `packages/module/src/statblock/`
  (schema: toFieldLike/introspectActor; profile: store) + nowe ustawienie
  `statblockProfiles`. 44 nowe testy jednostkowe (zero PDF, hand-built
  fixtures). Przy okazji naprawiony przeoczony wcześniej błąd w
  `global.d.ts` (martwy import `LastActorProfile` po usunięciu CoC7,
  niewykryty przez `tsc` z powodu `skipLibCheck: true`). Wszystkie bramki
  zielone. Zweryfikowane empirycznie w fvtt-types (nie w żywym Foundry):
  `SchemaField.entries/.fields`, `ArrayField.element`,
  `NumberField.min/max/integer/choices`, `HTMLField extends StringField`,
  `game.system.documentTypes`, `foundry.utils.flattenObject/saveDataToFile/
  readTextFromFile`, `foundry.utils.randomID`. Nie zrobiono: UI, silnik
  ekstrakcji, `templateSchemaFingerprint`, weryfikacja na żywym świecie —
  szczegóły w sekcji "Zrealizowane — Zadanie 1" i zaktualizowanych
  pytaniach #2 (rozstrzygnięte)/#4 (częściowo) wyżej. Czeka na dalsze
  wskazówki właściciela (np. Zadanie 2 z oryginalnej listy: weryfikacja na
  żywo w dwóch systemach, albo od razu UI kreatora profilu).
- **2026-09-30** — Zadanie 2 (silnik ekstrakcji pól, briefu właściciela)
  zaimplementowane: `packages/core/src/statblock/extract/` — `types.ts`
  (`PageTextElement`, `ExtractionBlock`, `ReconstructedLine`),
  `reconstructLines.ts` (grupowanie w wiersze + podział kolumnowy),
  `sources/` (label/region/styleFilter), `transforms/` (wszystkich 11 z
  brifu + `runChain.ts`), `castAndValidate.ts`, `extractField.ts` (spina
  wszystko). Zero UI, zero silnika znajdowania GRANIC statbloków w całym
  dokumencie (osobne, późniejsze zadanie) — zgodnie z briefem. 133 nowe
  testy jednostkowe (816 w sumie w core), w tym explicite wskazane
  przypadki brzegowe (brak etykiety, pusty tekst, zawinięte linie, dziwne
  minusy). Dwa prawdziwe błędy złapane i naprawione W TRAKCIE pisania
  testów (nie po fakcie): próg podziału kolumn nigdy nie mógł się
  uruchomić dla dokładnie dwuelementowych wierszy (mediana jednej przerwy
  mnożona przez siebie), i `parseNumber`'s regex gubił część ułamkową
  liczby mieszanej przez kolejność alternatyw. Napotkane i rozwiązane
  ograniczenie typu: `Diagnostic.params` jest `Record<string,string|number>`,
  nie `unknown` — dodany `diagnosticParam.ts::toParamValue()` dla
  diagnostyk niosących obiekt/tablicę. Wszystkie bramki zielone, budżet
  startowy bez zmian (extract/ jeszcze niepodpięty pod UI). 5 nowych pytań
  (#12-16) o zakres dopasowania wieloelementowej etykiety, kalibrację progu
  kolumn, głębokość `diceNotation`/`textToHtml`, i semantykę "choices" w
  walidacji.
- **2026-09-30** — Zadanie 3 (detekcja statblocków, briefu właściciela)
  zaimplementowane: `packages/core/src/statblock/pdf/` — `types.ts`
  (`PageForDetection`, `DetectionCandidate`, `DetectionRegion`,
  `DetectionProgress`), `readingOrder.ts` (`buildStatblockReadingOrder`,
  kolumnowo góra-dół, kolumna-po-kolumnie, strona-po-stronie),
  `matchAnchor.ts` (`textPattern`/`headingStyle`), `findCandidateEnd.ts`
  (wszystkie 4 warianty `boundary.kind`, "kolejna kotwica = twardy limit",
  "przekroczenie kolumny/strony nie jest samo w sobie naruszeniem odstępu"),
  `computeCandidateConfidence.ts` (świadome uproszczenie: `extractRawValue`,
  nie pełny `extractField` — patrz pytanie #17), `detectStatblocks.ts`
  (orkiestracja), plus `buildPagesForDetection.ts` (cienka warstwa
  integracji reużywająca `buildInventory`/`buildTextLayout`/
  `buildPageLayouts`, dokładnie jak `buildCIFFromDocument.ts` — reguła 5).
  Wymagana rewizja schematu profilu: `DetectionConfig.anchor`/`.boundary`
  zastąpione precyzyjną sygnaturą z brifu (`textPattern`/`headingStyle`,
  `nextAnchor`/`verticalGap`/`endOfColumnOrPage`/`endLabel`,
  `requiredLabels`), nowe pole `ProfileField.source: FieldSource` obok
  istniejącego `capture`, typy `FieldSource`/`StyleFilter`/itp. przeniesione
  do `profile/schema.ts` jako kanoniczne Zod definicje. 55 nowych testów
  (871 w sumie w core), pokrywających wszystkie sześć scenariuszy wskazanych
  explicite przez właściciela (1 kolumna, 2 kolumny obok siebie nigdy się
  nie łączące — z i bez `endOfColumnOrPage`, by pokazać dlaczego jest
  potrzebny, przez granicę kolumny, przez granicę strony — w tym wariant
  specyficzny dla `verticalGap`, brak statblocków — pusta strona i pusty
  dokument, fałszywe trafienia — kotwica bez wymaganych etykiet wciąż
  produkuje kandydata z pewnością 0) plus testy rewizji schematu. Dwa błędy
  złapane i naprawione W TRAKCIE pisania WŁASNYCH testów (błędne
  współrzędne kolumny/strony w dwóch scenariuszach testowych, nie błąd
  algorytmu). Sprawdzone i udokumentowane jako decyzja świadoma, nie
  przeoczenie: `buildPagesForDetection.ts` nie ma własnego testu
  integracyjnego, dokładnie jak istniejący w repo precedens
  `buildCIFFromDocument.ts` (identyczny wzorzec `openDocument()` z
  `assetBaseUrl`/workerem, też bez testu). Wszystkie bramki zielone (871
  testów, lint, typecheck obu pakietów, `check:boundary`/`check:imports`/
  `check:size` bez zmian budżetu/`check:lang`/`build`), bez `package`/
  podbicia wersji (jak w Zadaniach 1-2, `pdf/` jeszcze niepodpięty pod UI).
  5 nowych pytań (#17-21) o `transforms` na `ProfileField`, reinterpretację
  `largestFontInBlock` na poziom strony, ograniczenie heurystyki
  bold/italic, sygnał `vectorFrame` jako granicę, i brak testu
  integracyjnego.
- **2026-09-30** — Zadanie 4 (ActorBuilder, briefu właściciela)
  zaimplementowane: `packages/core/src/statblock/import/` — `types.ts`
  (`ExtractedActorInstance`, `BuiltActorData`, `ImportReport`, ...),
  `setPath.ts` (odpowiednik `foundry.utils.setProperty` bez Foundry),
  `descriptorLookup.ts`, `resolveTransformChain.ts` (domyka pytanie #17,
  ożywia dotąd martwe `valueMapId`), `splitCollectionEntries.ts` (pierwszy
  realny konsument `splitRule`), `extractInstance.ts` (brakujący łącznik
  Zadanie 3→4: prawdziwa ekstrakcja przez `extractField` zamiast samej
  lokalizowalności), `buildActorData.ts` (budowanie+podwójna walidacja przez
  `castAndValidate`, dziedziczenie z szablonu — domyka pytanie #8 dla
  kolekcji), `nearestImage.ts`, `resolveDuplicateAction.ts`. Plus
  `packages/module/src/statblock/import/importStatblocks.ts` — jedyna
  warstwa dotykająca `fromUuid`/`Actor.create`/`game.actors`/
  `createEmbeddedDocuments`. Wymagana rewizja schematu: `ProfileField.
  transforms`, top-level `StatblockProfile.nameSource`/`ProfileCollection.
  nameSource` (drukowana nazwa nie mieści się w `actorSchemaPath`, który jest
  ściśle wewnątrz `system`), `sectionHeaderIsRegex`/`entryBoundaryIsRegex` na
  `CollectionSplitRule` (spójność z resztą schematu). 58 nowych testów (929
  w sumie w core) na ręcznie budowanych mockach — zero PDF, zero Foundry;
  `importStatblocks.ts` celowo bez testu automatycznego, ten sam precedens
  jak `buildPagesForDetection.ts` (`buildCIFFromDocument.ts` też go nie ma) —
  instrukcja ręcznego testu w Foundry dodana do sekcji "Zrealizowane —
  Zadanie 4". Wszystkie bramki zielone (wymagało przebudowania `packages/
  core`'s `dist/`, żeby `packages/module` widziało nowe eksporty — `@bindery/
  core` rozwiązuje się do zbudowanego pakietu). 3 nowe pytania (#22-24): czy
  `valueMapId` powinien móc być pozycjonowany w środku łańcucha zamiast
  zawsze na końcu, czy `importStatblocks` powinien przyjmować gotowe
  `ExtractedActorInstance[]` zamiast surowych `DetectionCandidate[]` (unikając
  podwójnej ekstrakcji, gdy Zadanie 6 zbuduje podgląd przed zapisem), i czy
  `templateSchemaFingerprint` powinien być porównywany zbiorczo przy
  imporcie zamiast ujawniać dryf schematu wyłącznie pośrednio, pole po polu.
- **2026-09-30** — Zadanie 5 (UI kreatora profilu, briefu właściciela)
  zaimplementowane: `packages/module/src/statblock/ui/ProfileBuilderApp.ts`
  (ApplicationV2+HandlebarsApplicationMixin, wzorem `ImportWizard`/
  `GridPicker`) + `templates/statblock-profile-builder.hbs`, otwierane z
  nowej pozycji menu ustawień (`registerMenu`). Makieta pokazana i
  zaakceptowana PRZED kodowaniem (widget mockup, zakładka "Pola"), zgodnie z
  brifem. Wszystkie 8 funkcji z brifu: wybór Actora wzorcowego + PDF-a;
  podgląd strony z nakładką SVG (elementy tekstu jako klikalne prostokąty,
  własna wersja "Select and crop" — `ReviewScreen.ts`'s metody są prywatne,
  nie do reużycia — reużywająca `pageOverlayGeometry.ts` wprost);
  przypisanie zaznaczenia do pola przez przeszukiwalne, płaskie drzewo
  SchemaIntrospectora z haczykami na zmapowanych; kolekcje z regułą
  podziału (Zadanie 4); podgląd na żywo przez `extractField`/
  `resolveTransformChain` (Zadania 2/4), liczony INLINE w `_prepareContext`
  (błąd nieskończonej pętli renderowania złapany i naprawiony PRZED
  commitem — pierwsza wersja liczyła podgląd jako efekt uboczny
  `_onRender` wołający `render()` ponownie); edytor łańcucha transformacji
  (formularz generyczny, nie per-rodzaj); reguły detekcji + "Testuj na
  całym PDF-ie" (`detectStatblocks`, Zadanie 3) z listą wyników klikalną do
  przeskoczenia strony; pełny CRUD profilu przez `profile/store.ts`
  (Zadanie 1) z walidacją przed zapisem. Tryb prosty/zaawansowany
  rzeczywiście działający (ukrywa/pokazuje regex/styl/warianty
  zaawansowane). `@bindery/core` i moduł-side statblock helpery ładowane
  WYŁĄCZNIE dynamicznym `import()` (dyscyplina `ImportWizard.ts`, ryzyko
  I3) — sama klasa (eager, przez `registerMenu`) urosła eager bundle z 7873
  do 35217 bajtów (wciąż pod budżetem 40960, ale ~86% zużyte — nowe pytanie
  #25). Udokumentowane uproszczenia v1: region capture znormalizowany
  względem CAŁEJ strony nie bboxa statblocka (#26), brak osobnego drzewa
  schematu dla pól pozycji kolekcji — wpisywane wprost (#27), edytor
  `valueMaps` niezbudowany (#28). Zero nowych testów automatycznych —
  Zadanie 5 to czysto moduł-side UI, ten sam precedens co
  `ReviewScreen.ts`/`ImportWizard.ts`/`GridPicker.ts`/`TokenPrepApp.ts`
  (żaden nie ma testu); instrukcja ręcznego testu w Foundry dodana do
  sekcji "Zrealizowane — Zadanie 5" (NIE zweryfikowane na żywo w tej sesji —
  brak dostępnego środowiska Foundry). Wszystkie bramki statyczne zielone
  (typecheck obu pakietów, lint, build, `check:boundary`/`check:imports`/
  `check:size`/`check:lang`, 929 testów core bez zmian).
- **2026-09-30** — Zadanie 7 (dopracowanie, briefu właściciela)
  zaimplementowane: (1) `tools/check-no-system-names.mjs` — nowa bramka CI,
  zero rzeczywistych naruszeń reguły 1 znalezionych po audycie `statblock/`
  (trzy komentarze "CoC7" to legalne odniesienia historyczne). (2)
  `tools/check-lang-usage.mjs` — nowa bramka CI (brakujące/nieużyte klucze),
  znalazła i naprawiła prawdziwy brakujący klucz
  (`statblockProfileBuilder.loadingPdf`) plus 70 zgłoszeń "nieużyte"
  (głównie martwe klucze sprzed tej sesji + cała sekcja `diagnostic.*`,
  patrz punkt 3). (3) DWIE prawdziwe usterki napotkane i naprawione:
  wskaźnik `busy` ustawiany ale nigdy niewyświetlany (Zadanie 5), i
  diagnostyki w podglądzie na żywo gubiące `params` całkowicie — co
  doprowadziło do odkrycia, że `packages/module/src/i18n.ts` był
  UDOKUMENTOWANY (w komentarzach `localizableMessage.ts`/`text/types.ts`,
  core) ale NIGDY nie zbudowany — utworzony teraz (`formatDiagnostic()`,
  `game.i18n.format` + jednolity sufiks strona/pole/wartość) wraz z 37
  nowymi szablonami `BINDERY.diagnostic.STATBLOCK_*` (en+pl, pierwsza
  rzeczywista treść dla wszystkich kodów diagnostycznych Zadań 2-4). (4)
  DWIE prawdziwe usterki wydajności/pamięci w `ProfileBuilderApp.ts`
  znalezione i naprawione: wyciek `URL.createObjectURL` + zbędne ponowne
  dekodowanie strony PDF na KAŻDYM renderze (nie tylko zmianie strony) —
  naprawione reużyciem DOKŁADNEGO wzorca `ReviewScreen.ts`'s
  `#pageImageCache`/`#ensurePageImage` (LRU, rozmiar 5); wyciek
  `PreviewDocument` przy zmianie PDF-a/profilu bez zamknięcia okna —
  naprawione nowym `#teardownPreviewDoc()`. Nowy test regresyjny
  (syntetyczny dokument 300 stron, 931 testów w sumie w core) potwierdza
  `detectStatblocks`/`buildStatblockReadingOrder` skalują się liniowo, nie
  kwadratowo. (5-6) Nowa sekcja README "Statblock import (profile-based)"
  — workflow, przykład na w pełni abstrakcyjnych polach, ograniczenia (brak
  OCR, jeden profil na layout), punkty rozszerzenia (OCR, podpowiedzi
  mapowania) — plus naprawiona nieaktualna sekcja "What's not in this
  release" (mówiła o STARYM, usuniętym silniku). (7) Pełna lista długu
  technicznego spisana (sekcja "Dług techniczny" + nowe pytania #29-31).
  Wszystkie bramki zielone, w tym dwie nowe (`check:no-system-names`,
  `check:lang-usage`, obie wpięte w `npm run build`); budżet `check:size`
  na ~89% (36368/40960) — coraz pilniejsze, patrz pytanie #25.

- **Poprawki po teście na żywo** — patrz sekcja "Poprawki po teście na
  żywo (po Zadaniu 7)": lokalizacja nazwy domyślnej, klikanie w podgląd,
  pasek zaznaczenia, fokus wyszukiwarki, wyszukiwanie po etykietach
  przodków, leniwy cast liczb. Właściciel potwierdził działanie całego
  przepływu pola → detekcja → zapis.

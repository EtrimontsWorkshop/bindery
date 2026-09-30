# Import statblocków z PDF — plan architektury (system-agnostyczny)

**Status: Zadanie 1 (SchemaIntrospector + model profilu) zaimplementowane
i przetestowane jednostkowo.** Stary silnik statbloków
(`packages/core/src/profiles/`), Profile Studio i adapter CoC7 zostały w
całości usunięte w `v0.2.4` (commit `dd28f67`). Ten dokument jest źródłem
prawdy o architekturze tej funkcji między sesjami — aktualizować po każdym
zadaniu (reguła 10 poniżej).

**Uwaga o numeracji zadań:** właściciel zgrupował moje pierwotne "Zadanie 1"
(schemat profilu) i "Zadanie 2" (introspekcja) w JEDNO "Zadanie 1". Sekcja
"Lista zadań 1-7" niżej zachowuje oryginalną numerację jako punkt odniesienia
architektonicznego; sekcja "Zrealizowane" poniżej opisuje, co faktycznie
powstało pod nazwą właściciela "Zadanie 1".

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

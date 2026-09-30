# Import statblocków z PDF — plan architektury (system-agnostyczny)

**Status: świeży start.** Stary silnik statbloków (`packages/core/src/profiles/`),
Profile Studio i adapter CoC7 zostały w całości usunięte w `v0.2.4`
(commit `dd28f67`). Ten dokument jest źródłem prawdy o architekturze tej
funkcji między sesjami — aktualizować po każdym zadaniu (reguła 10 poniżej).

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

Poprzednie podejście (CoC7 adapter, potem spike'owany adapter `dnd5e` na
branchu `etap-a`, nigdy niescalonym) hardkodowało nazwę i strukturę
konkretnego systemu w kodzie — dokładnie to, co reguła 1 teraz zakazuje.
Branch `etap-a` (6 commitów, adapter `dnd5e`, profil SRD 5.2.1) jest
prawdopodobnie martwy w obecnym kształcie — do potwierdzenia z właścicielem
przed ponownym użyciem czegokolwiek stamtąd. Dane pomiarowe z tamtej pracy
(np. sposób łamania tokenów w SRD 5.2.1) mogą się przydać jako dane
kalibracyjne, ale sam adapter nie.

## Co przetrwało z poprzedniej architektury (do reużycia, reguła 5)

Prawdziwy, wysyłany pipeline obrazów/scen/journali w `packages/core` jest
nietknięty i to na nim ma się oprzeć nowa funkcja:
- `buildInventory` (fonty, obrazy, wektory) — `packages/core/src/inventory/`
- `buildTextLayout` — `packages/core/src/text/`
- `buildPageLayouts`/bloki semantyczne — `packages/core/src/layout/`,
  `packages/core/src/semantic/`
- CIF (obrazy/sceny/journale) — `packages/core/src/cif/` (bez `CIFActor` —
  usunięty razem ze starym silnikiem, do zaprojektowania na nowo pod nowe
  zasady)
- granica `packages/core` (bez Foundry) vs `packages/module` (Foundry),
  wymuszana przez `check:boundary` — ta sama granica obowiązuje nową
  strukturę `schema/`/`profile/`/`pdf/`/`extract/` (core, bez Foundry) vs
  `ui/`/`import/` (module, z Foundry).

## Struktura docelowa (reguła 8) — jeszcze nie utworzona

Żaden z tych katalogów jeszcze nie istnieje — zostaną założone w miarę
postępu prac, z realną zawartością, nie jako puste szkielety:

- `schema/` — introspekcja schematu Actora/Itemu w runtime (core, bez
  Foundry-specific typów w logice testowalnej; adapter do żywego
  `CONFIG.Actor.dataModels`/`game.system` w warstwie module).
- `profile/` — mechanizm, którym użytkownik uczy moduł układu statblocka.
  **Nie zaprojektowany jeszcze** — Profile Studio (usunięty) było starym,
  odrzuconym rozwiązaniem tego problemu; nowy mechanizm to osobna decyzja
  architektoniczna, nie automatyczne odtworzenie Studio.
- `pdf/` — ponowne wykorzystanie istniejącego pdf.js/cache (reguła 5), nie
  nowa warstwa.
- `extract/` — detekcja/ekstrakcja wartości z tekstu PDF, czysta logika.
- `ui/` — warstwa Foundry-facing (ApplicationV2).
- `import/` — zapis do Actor/Item przez DataModel, sterowany schematem z
  `schema/`, nie hardkodowanymi ścieżkami.

## Otwarte pytania (do rozstrzygnięcia przed/w trakcie pierwszego zadania)

- Jak dokładnie użytkownik "uczy" moduł profilu (zamiennik Profile Studio)?
  Klikanie w PDF jak dawniej, inny mechanizm, czy coś pośredniego?
- Jaki jest pierwszy krok implementacji — introspekcja schematu (`schema/`)
  jako fundament, czy coś innego?

## Log postępu

- **2026-09-30** — dokument założony jako szkielet po ustaleniu 10 twardych
  zasad z właścicielem. Zero kodu napisane. Czeka na pierwsze konkretne
  zadanie.

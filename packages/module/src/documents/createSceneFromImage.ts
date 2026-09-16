/**
 * Mapy -> sceny (KROK-8 Z5, faza 7 MDD). Wymiary sceny WPROST z bitmapy
 * (`packages/core` juz zdekodowalo obraz i zna `width`/`height`) — zero
 * automatycznego wykrywania siatki (poza MVP, brief).
 *
 * [KROK-8, odkrycie #1] Foundry v14 przebudowal tlo sceny na model
 * wielopoziomowy (`Level` — embedded document, kazdy ze swoim `background.src`)
 * — STARE, plaskie pole `Scene#background.src` (v10-v13) jest dzis WYLACZNIE
 * getterem kompatybilnosci wstecznej (`BaseScene.shimData`, `scene.mjs`),
 * rekonstruowanym z PIERWSZEGO Levelu, BEZ odpowiadajacego mu settera —
 * `Scene.create({background: {src}})` NIE dziala w v14 (cicho ignorowane, tlo
 * zostaje puste). Zweryfikowane wprost w zrodle
 * (`resources/app/common/documents/{scene,level}.mjs`), nie zgadywane —
 * CLAUDE.md: "zawsze weryfikuj wzgledem faktycznie zainstalowanej wersji".
 *
 * [KROK-8, odkrycie #2 — zlapane empirycznie na prawdziwym Foundry, nie w
 * kodzie zrodlowym] `Scene.create()` ZAWSZE tworzy jeden DOMYSLNY, PUSTY
 * Level o stalym ID `defaultLevel0000` (`BaseScene.metadata.defaultLevelId`,
 * `scene.mjs`) i ustawia `initialLevel` na ten wlasnie poziom. Pierwsza wersja
 * tego kodu wolala `scene.createEmbeddedDocuments('Level', [...])`, co
 * DODAWALO DRUGI, NOWY Level z prawdziwym tlem — scena powstawala poprawnie,
 * ale WCIAZ pokazywala pusty domyslny poziom (bo `initialLevel` nigdy nie
 * zostal zmieniony), a nowy poziom z obrazem byl "ukryty" w tle. Objaw:
 * "scena sie tworzy, ale bez obrazka" — potwierdzone bezposrednim odczytem
 * bazy LevelDB swiata (`worlds/<world>/data/scenes/*.log`): obie encje
 * `Level` istnialy, ale `initialLevel` wskazywal na ta PUSTA. Naprawa:
 * UAKTUALNIJ (nie twórz nowy) domyslny Level pod jego stalym ID — jeden
 * poziom, poprawne tlo, `initialLevel` juz na niego wskazuje z automatu.
 */

const DEFAULT_LEVEL_ID = 'defaultLevel0000';

export interface CreateSceneFromImageInput {
  name: string;
  imagePath: string;
  width: number;
  height: number;
  grid: { size: number; offsetX: number; offsetY: number };
  /** [KROK-11 Z6] Id folderu `Scene` (patrz `ensureFolder.ts`) — `undefined` = korzen. */
  folder?: string;
}

export async function createSceneFromImage(input: CreateSceneFromImageInput): Promise<foundry.documents.BaseScene> {
  const sceneData = {
    name: input.name,
    width: input.width,
    height: input.height,
    padding: 0,
    folder: input.folder,
    grid: {
      size: input.grid.size,
    },
    // [KROK-17, zgloszony na zywo blad] `grid.offsetX`/`offsetY` (wybrane
    // recznie w GridPicker albo zasugerowane przez `detectGrid.ts`) CELOWO
    // NIE trafiaja do `shiftX`/`shiftY` — zweryfikowane wprost na zywym
    // Foundry (`scene.getDimensions()`): `padding:0` daje `dimensions.x=0`,
    // wiec `sceneX = -shiftX` — KAZDA niezerowa wartosc przesuwa `sceneRect`
    // (aktywny/interaktywny obszar sceny) wzgledem canvasu o tyle pikseli,
    // odcinajac dokladnie tyle samo z PRZECIWNEJ krawedzi obrazu poza obszar
    // sceny. To NIE jest kosmetyczne przesuniecie linii siatki (jak mozna by
    // zgadnac po nazwie) — to permanentne przesuniecie calej granicy sceny.
    // Ten sam mechanizm byl juz raz naprawiony (KROK-16, uzytkownik potwierdzil
    // "Wygląda teraz ok" po wyzerowaniu) blednym uzyciem STAREJ, przedawnionej
    // wartosci `lastGridConfig` — GridPicker/auto-detekcja z tego kroku
    // wprowadzily NOWA, poprawna dla TEGO obrazu wartosc offsetu, ale
    // podleganie DOKLADNIE TEMU SAMEMU mechanizmowi Foundry oznacza, ze
    // regresja wrocila identycznym objawem ("scena ucieta"), niezaleznie od
    // tego, ze offset jest teraz poprawnie policzony. `shiftX`/`shiftY`
    // zostaja na domyslnym 0 (nie ustawiane w ogole) — dopasowanie siatki do
    // konkretnych pikseli obrazu (poza `grid.size`) to zadanie dla wlasnego
    // narzedzia Foundry "Configure Grid" PO utworzeniu sceny, ktore swiadomie
    // przyjmuje ten sam kompromis (przesuniecie = utrata krawedzi) jako
    // interaktywna decyzje GM-a, nie cichy skutek uboczny importu.
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SceneCls = (foundry.documents as any).Scene ?? (globalThis as any).Scene;
  const scene = await SceneCls.create(sceneData);
  if (!scene) {
    throw new Error('Bindery | nie udalo sie utworzyc sceny');
  }

  // [odkrycie #2 powyzej] AKTUALIZUJ domyslny Level (juz istnieje, `initialLevel`
  // juz na niego wskazuje) — NIE twórz drugiego. `updateEmbeddedDocuments`
  // z pasujacym `_id` modyfikuje istniejacy wpis embedded collection.
  await scene.updateEmbeddedDocuments('Level', [
    {
      _id: DEFAULT_LEVEL_ID,
      name: input.name,
      background: { src: input.imagePath },
    },
  ]);

  return scene;
}

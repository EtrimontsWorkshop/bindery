import { ImportWizard } from './apps/ImportWizard.js';
import { ProfileStudioLauncher } from './apps/ProfileStudioLauncher.js';
import { STATBLOCKS_ENABLED } from './features.js';

export const MODULE_ID = 'bindery';

/** Sciezka bazowa assetow pdf.js wzgledem korzenia web-servera Foundry (ryzyko I1/I3). */
export const ASSET_BASE_URL = `modules/${MODULE_ID}/lib/`;

export function registerSettings(): void {
  // Wywolywane w hooku 'init' — game.settings jest juz zainicjalizowane na tym etapie
  // cyklu zycia Foundry, mimo ze typ 'game' dopuszcza stan przed-inicjalizacyjny.
  game.settings!.registerMenu(MODULE_ID, 'openWizard', {
    name: 'BINDERY.settings.openWizardMenuLabel',
    hint: 'BINDERY.settings.openWizardMenuHint',
    label: 'BINDERY.settings.openWizardMenuLabel',
    icon: 'fa-solid fa-file-import',
    type: ImportWizard,
    restricted: true,
  });

  // [KROK-22 Z1] Profile Studio — przycisk OBOK "Importuj PDF..." (brief:
  // "Studio to inny tryb pracy, dla innej osoby, w innym momencie"). `type`
  // wskazuje na cienki `ProfileStudioLauncher`, NIE na prawdziwy `ProfileStudio`
  // — patrz komentarz w `ProfileStudioLauncher.ts` (I3, budzet <40KB startu swiata).
  //
  // [KROK-44 Z1] Ukryte za `STATBLOCKS_ENABLED` — patrz `features.ts` po
  // uzasadnienie i warunek przywrocenia. Wpis menu po prostu nie jest
  // rejestrowany, gdy flaga jest wylaczona — Foundry nie pokazuje go w ogole
  // w ustawieniach modulu, zero martwego przycisku.
  if (STATBLOCKS_ENABLED) {
    game.settings!.registerMenu(MODULE_ID, 'openProfileStudio', {
      name: 'BINDERY.settings.openProfileStudioMenuLabel',
      hint: 'BINDERY.settings.openProfileStudioMenuHint',
      label: 'BINDERY.settings.openProfileStudioMenuLabel',
      icon: 'fa-solid fa-flask',
      type: ProfileStudioLauncher,
      restricted: true,
    });
  }

  // Zgoda z komunikatu prawnego §2.2 MDD — zapisywana jednorazowo per swiat.
  game.settings!.register(MODULE_ID, 'legalNoticeAcknowledged', {
    name: 'Legal notice acknowledged',
    scope: 'world',
    config: false,
    type: Boolean,
    default: false,
  });

  // [KROK-8 Z4] Folder w skonfigurowanym zrodle przechowywania (domyslnie 'data'),
  // do ktorego trafiaja wyeksportowane obrazy — konfigurowalny, bo swiaty
  // roznia sie konwencja katalogow (i bo R6/A1: to WYLACZNIE miejsce zapisu,
  // zadna logika decyzyjna).
  game.settings!.register(MODULE_ID, 'uploadPath', {
    name: 'BINDERY.settings.uploadPathLabel',
    hint: 'BINDERY.settings.uploadPathHint',
    scope: 'world',
    config: true,
    type: String,
    default: `worlds/${game.world?.id ?? 'world'}/bindery-imports`,
  });

  // [KROK-8 Z5] Ostatnio uzyte ustawienie siatki (GridPicker) — zapamietane
  // per swiat, nie pokazywane w ekranie ustawien (uzytkownik zmienia je
  // WYLACZNIE przez sam GridPicker).
  game.settings!.register(MODULE_ID, 'lastGridConfig', {
    name: 'Last grid config',
    scope: 'world',
    config: false,
    type: Object,
    default: { size: 100, offsetX: 0, offsetY: 0 },
  });

  // [KROK-11 Z6] Foldery docelowe + prefiks nazw z ekranu celu — zapamietane
  // per swiat (brief: "Ustawienia zapamietywane per swiat"), NIE pokazywane w
  // ekranie ustawien (uzytkownik zmienia je WYLACZNIE przez sam ekran celu),
  // ten sam wzorzec co `lastGridConfig`. `imagePath` NIE duplikuje `uploadPath`
  // powyzej — ekran celu edytuje/pokazuje TA SAMA wartosc (`uploadPath` jest
  // juz per-swiat, config:true, ustawione od kroku 8).
  game.settings!.register(MODULE_ID, 'importTargets', {
    name: 'Import target folders',
    scope: 'world',
    config: false,
    // [KROK-19 Z3] `actorFolder` dolozony do TEGO SAMEGO obiektu (nie osobny
    // klucz `game.settings`) — ten sam wzorzec co `sceneFolder`/`journalFolder`
    // powyzej, zeby ekran celu (kiedy dostanie zakladke aktorow) mogl
    // odczytac/zapisac wszystkie foldery jednym wywolaniem `.get`/`.set`.
    default: { sceneFolder: '', journalFolder: '', actorFolder: '', namePrefix: '' },
  });

  // [KROK-21 Z1] Ostatnio wczytany profil aktorow (plik JSON wybrany w
  // ImportWizard) — zapamietany PER SWIAT, zeby nie trzeba bylo wskazywac go
  // przy kazdym imporcie. Przechowuje SUROWA (jeszcze niewalidowana przy
  // odczycie) tresc pliku + jego nazwe do wyswietlenia — walidacja
  // (`validateProfile`) uruchamiana PONOWNIE przy kazdym odczycie w
  // `ImportWizard`, nigdy zaufana bez sprawdzenia (ten sam wymog co przy
  // pierwszym wczytaniu — profile pochodza od nieznanych autorow, R2/schema.ts).
  // `config:false` — jak `lastGridConfig`/`importTargets`, uzytkownik zmienia
  // to WYLACZNIE przez sam ImportWizard, nie przez ekran ustawien.
  //
  // [R3] To pole przechowuje TRESC dostarczona przez UZYTKOWNIKA, we WLASNYM
  // swiecie Foundry (baza danych jego serwera) — nie w tym repozytorium i nie
  // hostowane przez ten projekt dla innych. Analogiczne do zapisania obrazu
  // czy aktora zaimportowanego z tego samego pliku; R3 dotyczy TEGO repo, nie
  // danych swiata uzytkownika.
  //
  // [zmierzony wprost w kroku 21] CELOWO bez `type: Object` — z nim
  // `ClientSettings.register` (typy `fvtt-types`) rzuca `Type 'ObjectConstructor'
  // is not assignable to type 'undefined'` dla TEGO konkretnego wpisu (zawezone
  // przez bisekcje: znika przy usunieciu `type`, wraca niezaleznie od nazwy
  // klucza i ksztaltu interfejsu — wyglada na limit inferencji generykow przy
  // trzecim/kolejnym ustawieniu typu Object w tym samym module, nie na blad w
  // tym kodzie). `default` sam w sobie wystarcza Foundry do wywnioskowania typu.
  game.settings!.register(MODULE_ID, 'lastActorProfile', {
    name: 'Last loaded actor profile',
    scope: 'world',
    config: false,
    default: { fileName: '', profile: null },
  });
}

/** Ksztalt `lastActorProfile` — patrz komentarz przy rejestracji wyzej. `fileName === ''` = brak zapamietanego profilu. */
export interface LastActorProfile {
  fileName: string;
  /** Surowy JSON z pliku, jeszcze NIEWALIDOWANY — walidacja przy kazdym odczycie. `null` gdy `fileName === ''`. */
  profile: unknown;
}

/** Ksztalt `importTargets` — patrz komentarz przy rejestracji wyzej. */
export interface ImportTargets {
  /** Nazwa folderu `Scene` (Foundry `Folder.name`, tworzony jesli nie istnieje) — pusty = korzen. */
  sceneFolder: string;
  /** Nazwa folderu `JournalEntry` — pusty = korzen. */
  journalFolder: string;
  /** [KROK-19 Z3] Nazwa folderu `Actor` — pusty = korzen. */
  actorFolder: string;
  /** Opcjonalny prefiks nazw tworzonych dokumentow (sceny/journale/aktorzy) — pusty = brak prefiksu. */
  namePrefix: string;
}

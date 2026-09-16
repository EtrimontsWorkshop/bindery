import type { Rect } from '../geometry.js';
import type { ImageTargetKind } from '../images/finalize.js';
import type { PageRoute } from '../profiles/pageRoute.js';
import type { Diagnostic } from '../text/types.js';

/**
 * CIF — Canonical Intermediate Format (KROK-9 Z3, MDD §5.3). Format neutralny:
 * nie zawiera pojec zadnego konkretnego systemu gry ani Foundry.
 *
 * MDD v1.2 definiuje `CIFDocument`/`CIFActor`/`CIFScene`/`Provenance`/`Diagnostic`
 * wprost, ale WYLACZNIE UZYWA (nie definiuje) `CIFJournal`/`CIFImage` w typach pol
 * — te dwa musialy zostac zaprojektowane tutaj od zera (zweryfikowane grepem po
 * MDD, brak `interface CIFJournal`/`interface CIFImage` gdziekolwiek w pliku).
 *
 * `CIFActor` (statblocki) swiadomie POMINIETY — brief KROK-9 wprost: "MVP nie
 * potrzebuje CIFActor (statblocki to v2.0)". Gdy pojawi sie w v2.0, dodanie pola
 * `actors: CIFActor[]` do `CIFDocument` jest zmiana ADDYTYWNA (opcjonalna lub z
 * defaultem), nie musi byc breaking/major — ale KAZDA zmiana ksztaltu
 * ISTNIEJACYCH pol (schemaVersion:1) wymaga bumpu major (brief, KROK-9).
 */

export interface Provenance {
  pageNumber: number;
  bbox: Rect;
  blockIds: string[];
}

/**
 * [KROK-18 Z6] `CIFActor` — dokladnie z MDD §5.3 (byl swiadomie pominiety w
 * `CIFDocument` przy pierwszym projekcie CIF-u w kroku 9, "MVP nie potrzebuje
 * CIFActor" — patrz komentarz na gorze pliku). Dodanie tutaj jest zmiana
 * ADDYTYWNA: nowe typy, `CIFDocument.actors?: CIFActor[]` opcjonalne, zero
 * zmian w istniejacych polach — `schemaVersion` zostaje `1`.
 *
 * [Zawezenie zakresu, KROK-18, doprecyzowane KROK-20 Z2b, rozszerzone KROK-39
 * Z1] Poczatkowo ten krok budowal CIFActor WYLACZNIE dla NPC/potworow (Z0: 15
 * z 27 "siatek" w ksiazce testowej, pregeny Badaczy swiadomie poza zakresem).
 * Od kroku 39 `route` (nizej) rozroznia obie kategorie — patrz
 * `profiles/pageRoute.ts` i `profiles/assembleStatblocks.ts`. `traits`/`equipment`/`spells` NIE sa
 * wypelniane przez `buildCIFActor` (zaden wzorzec do ich parsowania nie
 * zostal zbudowany); zostaja puste tablice, nie zgadywane wartosci
 * placeholder. `skills` wypelniane od KROK-20 Z2b, ale WYLACZNIE gdy profil
 * skonfigurowal `entityAssembly.skillsPattern` — starsze/inne profile nadal
 * dostaja pusta tablice. Pola istnieja w typie (zgodnie z MDD), bo naleza do
 * `CIFActor` jako calosci, nawet gdy akurat nie wypelnione.
 */
export interface CIFActor {
  id: string;
  name: string;
  /**
   * [KROK-20 Z2] Czy `name` jest realna nazwa z podrecznika (pewnosc >= progu,
   * `entityAssembly.nameConfidenceThreshold`) czy placeholder. Bez tego pola
   * ekran przegladu musialby zgadywac po TRESCI stringa (np. dopasowywac
   * szablon `namePlaceholder` z profilu) — kruche, bo szablon jest
   * konfigurowalny per profil, wiec kazdy odczytujacy `CIFActor` musialby
   * znac profil, ktory go wyprodukowal. Jawne pole, addytywne.
   */
  nameConfident: boolean;
  /**
   * [KROK-19 Z4, zmierzony na zywo brak] Wypelnione WYLACZNIE gdy `name` jest
   * placeholderem (pewnosc ponizej progu) — lista kandydatow rozwazanych
   * przez parowanie geometryczne (`entityAssembly`), zeby uzytkownik mial
   * SZANSE ustalic, ktora prawdziwa postac z ksiazki kryje sie pod
   * placeholderem "NPC ze str. N (#k)", zamiast zgadywac z samej strony.
   * Bez tego pola informacja byla policzona (`AssembledStatblock.name.
   * candidates`) ale gubiona przy budowaniu `CIFActor` — dokladnie luka,
   * ktorej DoD Z1 wymagal ("Nazwa poniżej progu → placeholder z listą
   * kandydatów"), zaznaczona jako spelniona zanim faktycznie taka byla.
   */
  nameCandidates?: readonly string[];
  /** Swobodna etykieta z podrecznika: "Cultist", "Zbir", "Ghoul". Bez interpretacji. */
  typeLabel?: string;
  /** Klucze KANONICZNE (§5.4 MDD), nie nazwy z podrecznika — `LabelledPairMatchEntry.canonicalKey`. */
  statistics: Record<string, CIFStat>;
  skills: CIFNamedValue[];
  attacks: CIFAttack[];
  traits: CIFNamedText[];
  equipment: CIFNamedText[];
  spells: CIFNamedText[];
  description?: string;
  /** Id z `CIFImage[]`. */
  imageRef?: string;
  /** ZAWSZE wypelnione (A3). */
  rawText: string;
  provenance: Provenance;
  /** Pola, ktorych profil nie umial zaklasyfikowac. Traja do notatek dokumentu. */
  unmapped: CIFNamedText[];
  /**
   * [KROK-34 Z2] Bloki prozy dolaczone geometrycznie (`entityAssembly.notesPatterns`)
   * — patrz `AssembledStatblock.notes`. `[]`, gdy profil nie ma takiego wzorca
   * LUB zaden nie trafil (A10). Opcjonalne — pole addytywne (jak
   * `attackBelowTexts` w `AssembledStatblock`), zeby kod konstruujacy
   * `CIFActor` bezposrednio (fixtury testowe sprzed tego pola) nie musial sie zmieniac.
   */
  notes?: { label: string; text: string }[];
  /**
   * [KROK-39 Z1] Trasa, ktorej zestawem wzorcow ta encja zostala zbudowana —
   * `'npc'` (potwor/NPC) albo `'playerCharacter'` (gotowy Badacz). Adapter
   * (`packages/module/src/adapters/coc7.ts`) uzywa jej do wyboru typu aktora
   * Foundry (`npc` vs `character`). Opcjonalne — pole addytywne (jak `notes`
   * powyzej), zeby kod konstruujacy `CIFActor` bezposrednio (fixtury testowe
   * sprzed tego pola) nie musial sie zmieniac; `undefined` traktowany przez
   * adapter jak `'npc'` (zachowanie sprzed kroku 39).
   */
  route?: PageRoute;
}

export interface CIFStat {
  /** Wartosc surowa, tak jak w ksiazce. */
  raw: string;
  numeric?: number;
  unit?: 'percent' | 'plain' | 'dice' | 'modifier';
  /** Etykieta oryginalna — do wyswietlenia w przegladzie i do notatek. */
  sourceLabel: string;
  confidence: number;
  /** [KROK-33 Z1] Przypis znaleziony na wlasnym wierszu tuz po bloku, powiazany z ta wartoscia bo TYLKO ona w bloku konczy sie gola gwiazdka — patrz `LabelledPairMatchEntry.footnoteText` (profiles/patterns.ts). */
  footnoteText?: string;
  /** [KROK-34 Z1] Opis odciety od `raw` PO liczbie na poczatku tej samej wartosci ("Pancerz: 5, niezwykle gruba skóra" -> `raw`="5", to pole="niezwykle gruba skóra") — patrz `LabelledPairMatchEntry.descriptionText` (profiles/patterns.ts). */
  descriptionText?: string;
}

export interface CIFAttack {
  name: string;
  /** Surowy string; adapter parsuje wg wlasnych regul (MDD §5.3 — nie CIF-owa interpretacja). */
  toHit?: string;
  damage?: string;
  range?: string;
  properties: string[];
  rawText: string;
  /** [KROK-33 Z4] Opis znaleziony w prozie ponizej sekcji ATAKI, wprowadzony wlasnym podnaglowkiem zaczynajacym sie od pelnej nazwy tego ataku — patrz `attackDescriptionCrossReference.ts`. `undefined`, gdy nic nie znaleziono. */
  belowText?: string;
}

/** [KROK-18, zaprojektowane od zera — MDD uzywa tego typu w polu `skills`, nigdy go nie definiuje] Nazwa + pojedyncza wartosc, np. umiejetnosc + procent. */
export interface CIFNamedValue {
  name: string;
  value: string;
  confidence?: number;
}

/** [KROK-18, zaprojektowane od zera — jw., pola `traits`/`equipment`/`spells`/`unmapped`] Nazwa + dowolny tekst towarzyszacy. */
export interface CIFNamedText {
  name: string;
  text: string;
}

/**
 * [KROK-9 odkrycie] MDD definiuje `CIFScene` BEZ `rawText`, ale brief KROK-9
 * wymaga wprost "rawText z oryginalna trescia (zalozenie A3) dla KAZDEGO
 * elementu" — rozszerzenie MDD-owego typu o `rawText` (pusty string, gdy scena
 * nie ma zadnego towarzyszacego tekstu — nagłowka/podpisu).
 */
export interface CIFScene {
  id: string;
  name: string;
  imageRef: string;
  /** null = nie wykryto. NIE zgaduj (MDD) — auto-detekcja siatki poza MVP. */
  suggestedGrid: { sizePx: number; offsetX: number; offsetY: number } | null;
  rawText: string;
  provenance: Provenance;
}

/** [KROK-9, zaprojektowane od zera — patrz komentarz na gorze pliku] Obraz neutralny (mapa/handout/portret), niezalezny od tego, czy trafi na scene czy do journala. */
export interface CIFImage {
  id: string;
  targetKind: ImageTargetKind;
  width: number;
  height: number;
  format: string;
  /** Referencja do bajtow obrazu — wypelniana przez warstwe importu (poza CIF-em, ktory jest czysto danymi), NIE binarna zawartosc. */
  assetRef: string;
  /** Podpis/tekst towarzyszacy (blok `caption` w poblizu), jesli byl. */
  caption?: string;
  /**
   * [KROK-11 Z4, pole ADDYTYWNE — nie zmienia schemaVersion:1] `'content'`
   * lub `'undecided'` — WYLACZNIE te dwie wartosci trafiaja do CIF
   * (`decoration`/`mask` sa odrzucane wczesniej, patrz `buildCIFDocument.ts`).
   * Ekran przegladu (faza 9) uzywa tego pola do domyslnego
   * zaznaczenia/sortowania — `packages/module` NIE liczy klasyfikacji samo,
   * tylko CZYTA to, co juz zdecydowal `core` (A1/check:boundary).
   */
  classification: 'content' | 'undecided';
  /** [KROK-11 Z4, pole ADDYTYWNE] Patrz `ClassifiedImage.confidence` w `images/classify.ts`. */
  confidence: number;
  /**
   * [KROK-17, pole ADDYTYWNE] Sugestia auto-detekcji siatki z pikseli
   * (`images/detectGrid.ts`) — best-effort, `undefined` gdy nic nie znaleziono.
   * WYLACZNIE sugestia do wstepnego wypelnienia recznego kalibratora
   * (`GridPicker`, `packages/module`) — `packages/core` NIE decyduje, czy jest
   * "wystarczajaco pewna", zeby ja pokazac (ta decyzja to polityka UI, patrz
   * komentarz w `detectGrid.ts`).
   */
  suggestedGrid?: { size: number; offsetX: number; offsetY: number; confidence: number };
  rawText: string;
  provenance: Provenance;
}

/** [KROK-9, zaprojektowane od zera] Jedna strona journala — odpowiednik `JournalEntryPage` (Foundry), ale neutralny. */
export interface CIFJournalPage {
  id: string;
  name: string;
  /** 1-6, poziom naglowka Z KTOREGO powstala ta strona (Foundry `title.level`). */
  headingLevel: number;
  /** HTML juz SANITYZOWANY (Z5) — gotowy do `JournalEntryPage.text.content`. */
  html: string;
  /** `CIFImage.id` osadzonych w tresci tej strony, w kolejnosci wystapienia. */
  imageRefs: string[];
  rawText: string;
  provenance: Provenance;
}

/** [KROK-9, zaprojektowane od zera] Jeden wpis journala — odpowiednik `JournalEntry` (Foundry), ale neutralny; drzewo zakladek splaszczone do (JournalEntry -> strony), patrz `buildJournalHierarchy.ts`. */
export interface CIFJournal {
  id: string;
  name: string;
  pages: CIFJournalPage[];
  rawText: string;
  provenance: Provenance;
}

export interface CIFDocument {
  schemaVersion: 1;
  source: {
    fileName: string;
    fileHash: string;
    pageCount: number;
    detectedProfileId: string | null;
    detectedLanguage: string | null;
    /** ISO 8601. */
    extractedAt: string;
  };
  journals: CIFJournal[];
  scenes: CIFScene[];
  images: CIFImage[];
  /** [KROK-18 Z6, pole ADDYTYWNE — nie zmienia schemaVersion:1] Statbloki NPC/potworów, patrz `cif/buildCIFActor.ts`. Opcjonalne: dokumenty budowane przed tym krokiem (i wszystkie testy je konstruujące) nadal poprawne bez tego pola. */
  actors?: CIFActor[];
  diagnostics: Diagnostic[];
}

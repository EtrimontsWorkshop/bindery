import type { AdapterResult } from '@bindery/core';
import { escapeHtmlBasic, type Coc7ActorPayload, type Coc7EmbeddedItemSpec } from '../adapters/coc7.js';

/**
 * [KROK-19 Z3] `Actor.createDocuments()` batchem (nigdy w petli) + embedded
 * `Item` (skill/weapon) na kazdego utworzonego aktora, z poprawnym
 * powiazaniem `weapon -> skill` przez `system.skill.main.id`. Konsument
 * `AdapterResult<Coc7ActorPayload>[]` z `coc7Adapter.fromActor` (Z1) —
 * adapter WYLACZNIE zwraca dane, TA funkcja jest jedynym miejscem, ktore
 * faktycznie tworzy dokumenty (A5-zgodny podzial: decyzje "co" zapadaja
 * wczesniej/gdzie indziej, "zapisz to do bazy" jest tutaj, mechanicznie).
 */

const NON_WEAPON_ATTACK_NAMES = new Set(['unik', 'dodge', 'uniknięcie']);

export interface CreateActorsInput {
  results: readonly AdapterResult<Coc7ActorPayload>[];
  /** [KROK-11 Z6 wzorzec] Id folderu `Actor` (patrz `ensureFolder.ts`) — `undefined` = korzen. */
  folder?: string;
  signal?: AbortSignal;
}

export interface CreatedActorEntry {
  actor: foundry.documents.BaseActor;
  notes: AdapterResult<Coc7ActorPayload>['notes'];
  issues: AdapterResult<Coc7ActorPayload>['issues'];
}

/** `weapon` pomijany dla pozycji ATAKI, ktore sa w rzeczywistosci reakcja obronna (Unik/Dodge), nie broniom — decyzja opisana (i swiadomie odlozona) w komentarzu `Coc7EmbeddedItemSpec` w `adapters/coc7.ts`. */
function isDodgeLikeAttackName(name: string): boolean {
  return NON_WEAPON_ATTACK_NAMES.has(name.trim().toLowerCase());
}

function buildSkillItemData(spec: Coc7EmbeddedItemSpec & { kind: 'skill' }): object {
  // [Pulapka H4, potwierdzona ponownie w Z1] `system.value` to GETTER — pisac
  // TYLKO przez `system.adjustments.base`.
  return { name: spec.name, type: 'skill', system: { skillName: spec.name, adjustments: { base: spec.basePercent ?? 0 } } };
}

function buildWeaponItemData(spec: Coc7EmbeddedItemSpec & { kind: 'weapon' }, skillIdByName: ReadonlyMap<string, string>): object {
  const linkedName = spec.linkedSkillName ?? spec.name;
  // [KROK-33 Z4, POPRAWKA po zgloszeniu "Additional atack description does
  // not appear in Notes"] `system.description` na karcie broni CoC7 to
  // TRZY OSOBNE pola: `value` (opis, ten sam co `spec.description` ponizej —
  // dziala od kroku 20), `special` i `keeper` ("Notatki Strażnika" — WŁASNA
  // zakładka na karcie, oddzielna od "Opis"). Pierwsza wersja tej naprawy
  // dopisywala `belowText` do `value` — TECHNICZNIE widoczne, ale nie tam,
  // gdzie uzytkownik naturalnie szuka "notatki" (potwierdzone bezposrednio:
  // `Item.create({type:'weapon'})` w zywym Foundry zwraca
  // `system.description = {value, special, keeper}` — `keeper` to
  // WLASCIWE miejsce na informacje DLA STRAZNIKA znalezione POZA sama
  // pozycja ataku, nie domieszka do jej opisu). Etykieta ("Z tekstu
  // poniżej...") wciaz dopisywana — sama zakladka "Notatki Strażnika" nie
  // tlumaczy, SKAD ten tekst pochodzi (mogloby wygladac jak wlasna notatka
  // Strażnika, nie zrodlowy fragment ksiazki).
  const keeperNotes = spec.belowText ? `<p><em>${game.i18n!.localize('BINDERY.coc7.attackBelowTextLabel')}</em> ${spec.belowText}</p>` : undefined;
  return {
    name: spec.name,
    type: 'weapon',
    // [KROK-41, zgloszenie na zywo] CoC7's own `defaultImg` dla typu "weapon"
    // to zawsze `icons/svg/sword.svg` — TEN SAM dla walki wrecz i dystansowej
    // (potwierdzone w zrodle systemu), wiec bez tego kazda zaimportowana
    // bron dostawala identyczna, mieczowa ikone, nawet pistolet/karabin.
    // Dla broni dystansowej nadpisujemy jawnie realna ikona broni palnej z
    // wbudowanych zasobow Foundry (ta sama, ktora nosza gotowe pozycje
    // kompendium CoC7 dla broni palnej) — dla walki wrecz NIC nie ustawiamy,
    // zeby zachowac dotychczasowy (poprawny) domyslny miecz systemu.
    ...(spec.ranged ? { img: 'icons/weapons/guns/gun-wood.webp' } : {}),
    system: {
      skill: { main: { name: linkedName, id: skillIdByName.get(linkedName) ?? null } },
      range: { normal: { value: '', damage: spec.damage ?? '' } },
      // [KROK-40, zgloszenie na zywo] CoC7 domyslnie tworzy KAZDA bron jako
      // walke wrecz (`properties.rngd` init `false`, brak osobnego pola
      // "melee") — bez tego kazdy zaimportowany pistolet/karabin ladowal sie
      // na karcie postaci jako walka wrecz. `spec.ranged` pochodzi z profilu
      // (`SectionListPattern.rangedKeywords`), nie z zadanej tu logiki.
      properties: { rngd: spec.ranged ?? false },
      // [KROK-20 Z2, zmierzony na zywo brak] Bez tego zakladka "Opis" karty
      // broni jest pusta — `spec.description` niesie surowy tekst dopasowania
      // z ksiazki (adapters/coc7.ts), jedyne miejsce, gdzie po imporcie widac
      // ZRODLOWY zapis tego konkretnego ataku (np. przypisy w nawiasach).
      description: { value: spec.description ?? '', ...(keeperNotes ? { keeper: keeperNotes } : {}) },
    },
  };
}

/**
 * [zgloszenie uzytkownika po KROK-33 Z4, "nie widze zadnego opisu w
 * notatkach"] `belowText` (opis znaleziony w prozie PONIZEJ sekcji ATAKI)
 * trafial WYLACZNIE do wlasnej zakladki "Notatki Strażnika" KAZDEJ broni z
 * osobna (`buildWeaponItemData` powyzej) — uzytkownik sprawdzal GLOWNA
 * zakladke "Notatki" calej postaci (`biography.personalDescription`,
 * celowo puste od KROK-20 Z2) i nie znajdowal tam nic. Kopiuje TE SAME opisy
 * (nie caly surowy statblok — KROK-20 Z2 pozostaje w mocy, cechy/ataki/
 * umiejetnosci sa juz widoczne gdzie indziej na karcie, wiec dublowanie ICH
 * byloby szumem) TAKZE do notatek postaci, jedno podpisane nazwa ataku
 * zdanie na kazdy znaleziony opis. Pusty string, gdy zaden atak nie ma
 * `belowText` (A7 — brak czegokolwiek do skopiowania to poprawny wynik).
 *
 * [KROK-34 Z2] `entityNotes` (bloki prozy dolaczone geometrycznie,
 * `Coc7ActorPayload.entityNotes`) DOKLADANE do TEJ SAMEJ notatki, kazdy
 * podpisany WLASNA etykieta wzorca (np. "Opis"), NIE sklejone w jeden ciag
 * (brief kroku 34: "W notatce aktora bloki rozdzielone naglowkami z etykiet").
 *
 * [zgloszenie uzytkownika, "Niewidzialność Niewidzialność: zdolność..."]
 * Etykieta bloku (wpisana przez autora profilu w Studio) czesto powiela
 * WLASNY podnaglowek ksiazki, ktory i tak jest PIERWSZYM slowem dopasowanej
 * tresci (bo notatka geometrycznie zaczyna sie OD tego podnaglowka — patrz
 * `proseBlock.ts`) — pokazanie OBU daje "Niewidzialność Niewidzialność: ...".
 * Gdy tresc juz zaczyna sie (bez wzgledu na wielkosc liter) od etykiety, ten
 * WLASNY fragment (z dwukropkiem) jest POGRUBIANY zamiast dopisywac drugi,
 * oddzielny naglowek. Etykiety GENUINE niepowiazane z tekstem (autor nadal
 * moze wpisac cokolwiek) nadal pokazywane jak dotychczas (wlasny pogrubiony
 * naglowek + spacja + cala tresc).
 *
 * [zgloszenie uzytkownika, "Niewidzialność, Zaklęcia i Utrata Poczytalności
 * powinno być pogrubione"] Poprzednia wersja przy trafieniu (tresc juz
 * zaczyna sie od etykiety) rezygnowala z pogrubienia CALKOWICIE, zeby
 * uniknac duplikatu — ale notatka wygladala wtedy jak zwykly akapit bez
 * zadnego naglowka. `splitLeadingLabel` zamiast tego wydziela DOKLADNIE ten
 * fragment tekstu (z oryginalna wielkoscia liter i dwukropkiem), zeby mozna
 * go bylo pogrubic zamiast pomijac.
 *
 * [ZGŁOSZENIE na zywo po Kroku 39, "Historia badacza Historia badacza: ..."]
 * Dwukropek byl WYMAGANY zaraz po etykiecie — dzialalo dla ksiazek, gdzie
 * podnaglowek notatki ma postac "Etykieta:" (np. "Niewidzialność:"), ale NIE
 * dla "Wrak.pdf" Badaczy: "Historia Badacza" to GLOWNY naglowek sekcji (rola
 * `heading`, bez dwukropka) — dwukropek pojawia sie WYLACZNIE na
 * PODetykietach WEWNATRZ tej sekcji ("Wygląd:", "Przymioty:"), nie na niej
 * samej. Bez dwukropka `splitLeadingLabel` zawsze zwracalo `null` dla tego
 * bloku, wiec zduplikowany fragment nigdy nie byl wydzielany. Dwukropek
 * teraz OPCJONALNY (`:?`) — nadal wymaga DOKLADNEGO dopasowania tekstu
 * etykiety na samym poczatku (male ryzyko falszywego trafienia), ale juz nie
 * wymaga konkretnej interpunkcji po niej.
 */
function splitLeadingLabel(label: string, text: string): { prefix: string; rest: string } | null {
  const normalizedLabel = label.trim().replace(/:$/, '');
  if (normalizedLabel.length === 0) return null;
  const leadingWhitespace = text.length - text.trimStart().length;
  const match = new RegExp(`^${normalizedLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:?`, 'iu').exec(text.slice(leadingWhitespace));
  if (!match) return null;
  return { prefix: text.slice(leadingWhitespace, leadingWhitespace + match[0].length), rest: text.slice(leadingWhitespace + match[0].length) };
}

/**
 * [ZGŁOSZENIE na zywo, "wszystko jest jedno za drugim, powinno byc jak w
 * PDF, jedno pod drugim zaczynajace sie od nowej linii"] `stopAtSameFontRole`
 * (silnik, `proseBlock.ts`) wstawia `"\n\n"` tam, gdzie zbieranie PRZELECIALO
 * przez podnaglowek zamiast sie na nim zatrzymac (np. "Wygląd:" wewnatrz
 * "Historia Badacza") — jeden `<p>` z surowym `"\n\n"` w srodku renderowalby
 * sie jako JEDEN akapit (HTML zwija biale znaki), gubiac dokladnie ten
 * podzial. Dzieli wiec na osobne `<p>` — jeden na akapit/pozycje, tak jak
 * wyglada wizualnie w PDF-ie. Dla tekstu bez `"\n\n"` (kazdy dotychczasowy
 * profil) zachowanie identyczne jak wczesniej — pojedynczy `<p>`.
 */
function paragraphsToHtml(text: string): string {
  return text
    .split('\n\n')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => `<p>${escapeHtmlBasic(p)}</p>`)
    .join('');
}

function buildActorNotesValue(items: readonly Coc7EmbeddedItemSpec[], entityNotes: readonly { label: string; text: string }[]): string {
  const label = game.i18n!.localize('BINDERY.coc7.attackBelowTextLabel');
  const attackParts = items
    .filter((it): it is Coc7EmbeddedItemSpec & { kind: 'weapon' } => it.kind === 'weapon' && !!it.belowText)
    .map((it) => `<p><strong>${escapeHtmlBasic(it.name)}</strong> — <em>${label}</em> ${it.belowText}</p>`);
  const entityParts = entityNotes.map((n) => {
    const split = splitLeadingLabel(n.label, n.text);
    const body = split ? split.rest : n.text;
    const leadHtml = split ? `<strong>${escapeHtmlBasic(split.prefix)}</strong>` : `<strong>${escapeHtmlBasic(n.label)}</strong> `;
    const paragraphs = body
      .split('\n\n')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (paragraphs.length === 0) return `<p>${leadHtml}</p>`;
    const [first, ...rest] = paragraphs;
    return [`<p>${leadHtml}${escapeHtmlBasic(first!)}</p>`, ...rest.map((p) => `<p>${escapeHtmlBasic(p)}</p>`)].join('');
  });
  return [...attackParts, ...entityParts].join('');
}

/**
 * [KROK-39 Z4] `character`'s `biography` to `ArrayField` obiektow `{title,
 * value}` (Krok 38, zmierzone wprost ze zrodla systemu — patrz
 * `adapters/coc7.ts`), NIE jedno pole tekstowe jak u `npc`
 * (`buildActorNotesValue` powyzej). Kazdy blok notatki (`entityNotes`, np.
 * "Historia Badacza"/"Wygląd") staje sie WLASNYM wpisem tablicy — pasuje 1:1
 * do zmierzonej struktury, bez sklejania w jeden akapit (co dla postaci
 * gracza gubiloby czytelny podzial na sekcje karty). Opisy atakow spod ATAKI
 * (`belowText`) dostaja WLASNY wpis, podpisany nazwa ataku — ten sam powod co
 * `buildActorNotesValue` (rzadkie u gotowych Badaczy, ale mozliwe, gdyby
 * profil skonfigurowal `attackDescriptionCrossReference` na tej trasie).
 */
function buildCharacterBiographyArray(
  items: readonly Coc7EmbeddedItemSpec[],
  entityNotes: readonly { label: string; text: string }[],
): { title: string; value: string }[] {
  const label = game.i18n!.localize('BINDERY.coc7.attackBelowTextLabel');
  const attackEntries = items
    .filter((it): it is Coc7EmbeddedItemSpec & { kind: 'weapon' } => it.kind === 'weapon' && !!it.belowText)
    .map((it) => ({ title: it.name, value: `<p><em>${label}</em> ${it.belowText}</p>` }));
  // [ZGŁOSZENIE na zywo po Kroku 39, "Historia badacza Historia badacza: ..."]
  // W odroznieniu od `buildActorNotesValue` (NPC, JEDNO pole tekstowe, wiec
  // pogrubiony prefiks to JEDYNE miejsce, gdzie etykieta w ogole jest
  // widoczna) — tutaj `title` JUZ NIESIE etykiete jako WLASNE, ODDZIELNE pole
  // `ArrayField` (naglowek sekcji na karcie CoC7, Krok 38). Pogrubianie
  // wydzielonego prefiksu WEWNATRZ `value` pokazywaloby etykiete PONOWNIE,
  // tuz pod jej wlasnym naglowkiem — dokladnie ten sam duplikat, tylko
  // pogrubiony zamiast zwykly. Gdy `split` sie powiedzie, prefiks jest wiec
  // PO PROSTU POMIJANY (nie pogrubiony) — `title` juz go pokazuje.
  const noteEntries = entityNotes.map((n) => {
    const split = splitLeadingLabel(n.label, n.text);
    const value = paragraphsToHtml((split ? split.rest : n.text).trimStart());
    return { title: n.label, value };
  });
  return [...attackEntries, ...noteEntries];
}

/**
 * Bezposredni odczyt klasy dokumentu Foundry — ten sam wzorzec co
 * `createSceneFromImage.ts`/`ensureFolder.ts` (`foundry.documents.X` w
 * nowszych wersjach, `globalThis.X` jako fallback wstecznej zgodnosci).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getDocumentClass(name: 'Actor' | 'Item'): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (foundry.documents as any)[name] ?? (globalThis as any)[name];
}

export async function createActorsFromAdapterResults(input: CreateActorsInput): Promise<CreatedActorEntry[]> {
  input.signal?.throwIfAborted();
  if (input.results.length === 0) return [];

  const ActorCls = getDocumentClass('Actor');
  const ItemCls = getDocumentClass('Item');

  // [KROK-39 Z4] Ksztalt `biography` rozgalezia sie po `actorData.type`
  // (`'character'` vs `'npc'`, ustawionym przez adapter na podstawie
  // `CIFActor.route` — patrz `adapters/coc7.ts`), NIE po jakims osobnym
  // parametrze tutaj — jedno zrodlo prawdy o typie aktora.
  const actorDataArray = input.results.map((r) => {
    const actorData = r.data.actorData as { type?: string; system?: Record<string, unknown> } & Record<string, unknown>;
    if (actorData.type === 'character') {
      const biography = buildCharacterBiographyArray(r.data.items, r.data.entityNotes);
      if (biography.length === 0) return { ...actorData, folder: input.folder };
      return { ...actorData, folder: input.folder, system: { ...actorData.system, biography } };
    }
    const notesValue = buildActorNotesValue(r.data.items, r.data.entityNotes);
    if (!notesValue) return { ...actorData, folder: input.folder };
    return {
      ...actorData,
      folder: input.folder,
      system: { ...actorData.system, biography: { personalDescription: { value: notesValue } } },
    };
  });

  // [DoD Z3] Actor.createDocuments() BATCHEM — jedno wywolanie dla WSZYSTKICH
  // aktorow z tej ksiazki, nigdy petla `for (...) Actor.create(...)`.
  const createdActors: { id: string; name: string }[] = await ActorCls.createDocuments(actorDataArray);
  if (!createdActors || createdActors.length !== input.results.length) {
    throw new Error(`Bindery | Actor.createDocuments zwrocil ${createdActors?.length ?? 0} dokumentow, oczekiwano ${input.results.length}`);
  }

  // [KROK-19 Z4, zmierzony na zywo problem] NIE zakladaj, ze `createdActors`
  // wraca w TEJ SAMEJ kolejnosci co `actorDataArray` — zmierzone na zywo w
  // Foundry (uzytkownik: "NPC ze str 55 #3 to tak naprawde Pasożytnicza...")
  // dane jednego aktora ladowaly sie pod IMIENIEM innego. Kod Foundry
  // (`client-backend.mjs`) nie daje TWARDEJ, udokumentowanej gwarancji
  // kolejnosci przez cala petle preCreate/hook/socket-response, wiec zamiast
  // polegac na pozycji w tablicy, kazdy utworzony dokument jest kojarzony ze
  // swoim wynikiem adaptera PO NAZWIE (unikalna w tym batchu z konstrukcji —
  // kazdy placeholder niesie wlasny numer strony+porzadkowy). Duplikaty nazw
  // (nie powinny sie zdarzyc, ale bez zgadywania) dostaja PIERWSZY jeszcze
  // niewykorzystany wpis z kolejki, stabilnie wg oryginalnej kolejnosci
  // wejsciowej — nie losowo.
  const resultQueueByName = new Map<string, number[]>();
  input.results.forEach((r, idx) => {
    const name = (r.data.actorData as { name: string }).name;
    const queue = resultQueueByName.get(name) ?? [];
    queue.push(idx);
    resultQueueByName.set(name, queue);
  });

  const entries: CreatedActorEntry[] = [];
  try {
    for (let i = 0; i < createdActors.length; i++) {
      input.signal?.throwIfAborted();
      const actorDoc = createdActors[i]!;
      const queue = resultQueueByName.get(actorDoc.name);
      const resultIndex = queue?.shift();
      if (resultIndex === undefined) {
        throw new Error(
          `Bindery | nie udalo sie skojarzyc utworzonego aktora "${actorDoc.name}" z zadnym wynikiem adaptera (niespojnosc nazw miedzy zadaniem a odpowiedzia Foundry) — przerwano, zeby nie przypisac Item-ow niewlasciwemu aktorowi`,
        );
      }
      const result = input.results[resultIndex]!;

      const skillSpecs = result.data.items.filter((it): it is Coc7EmbeddedItemSpec & { kind: 'skill' } => it.kind === 'skill');
      const weaponSpecs = result.data.items.filter(
        (it): it is Coc7EmbeddedItemSpec & { kind: 'weapon' } => it.kind === 'weapon' && !isDodgeLikeAttackName(it.name),
      );

      const skillIdByName = new Map<string, string>();
      if (skillSpecs.length > 0) {
        const skillDocs: { id: string; name: string }[] = await ItemCls.createDocuments(
          skillSpecs.map(buildSkillItemData),
          { parent: actorDoc },
        );
        for (const doc of skillDocs) skillIdByName.set(doc.name, doc.id);
      }

      input.signal?.throwIfAborted();

      // Bron wymaga `system.skill.main.id` z JUZ utworzonego Item-u
      // umiejetnosci (powyzej) — stad DWA sekwencyjne wywolania na aktora,
      // nie jedno.
      if (weaponSpecs.length > 0) {
        await ItemCls.createDocuments(
          weaponSpecs.map((spec) => buildWeaponItemData(spec, skillIdByName)),
          { parent: actorDoc },
        );
      }

      entries.push({ actor: actorDoc as unknown as foundry.documents.BaseActor, notes: result.notes, issues: result.issues });
    }
  } catch (err) {
    // [DoD Z3] AbortSignal (albo jakikolwiek inny blad w trakcie tworzenia
    // Item-ow) przerywa BEZ pozostawiania smieci — kasujemy WSZYSTKICH juz
    // utworzonych aktorow (embedded Item kasuje sie kaskadowo z rodzicem w
    // Foundry), nie tylko tych, ktore zdazyly dostac swoje Item-y.
    const ids = createdActors.map((a) => a.id);
    await ActorCls.deleteDocuments(ids).catch(() => {});
    throw err;
  }

  return entries;
}

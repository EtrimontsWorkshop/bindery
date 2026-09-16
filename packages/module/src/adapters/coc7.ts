import type { AdapterIssue, AdapterResult, CIFActor, ImportContext, LocalizableMessage, SystemAdapter } from '@bindery/core';

/**
 * [KROK-19 Z1] Adapter CoC7 — MDD §5.6, faza 6. Schemat pol odczytany w
 * spike'u H4 kroku 13 (`spike/statblocks2/h4-create-actors.js`), ZWERYFIKOWANY
 * DZIALAJACO — 3 prawdziwe Actor+Item utworzone w realnym Foundry. Kanoniczne
 * klucze `CIFActor.statistics` zweryfikowane w KROK-19 Z0 (`P` = Poczytalnosc/
 * sanity, nie hitPoints — patrz `RAPORT-KROK-19.md`).
 *
 * **Czysta funkcja** (kontrakt §5.6 pkt 4) — zero wywolan Foundry API, zero
 * tworzenia dokumentow. Zwraca DANE; `documents/createActors.ts` (Z3) je
 * konsumuje i faktycznie tworzy `Actor`/`Item`.
 *
 * [Pulapka ze spike'u H4, potwierdzona] `skill.system.value` jest GETTEREM w
 * systemie CoC7 — zapisywac trzeba `system.adjustments.base`, nigdy `value`
 * wprost.
 */

const CHARACTERISTIC_KEY_MAP: Readonly<Record<string, string>> = {
  strength: 'str',
  charisma: 'app',
  constitution: 'con',
  willpower: 'pow',
  size: 'siz',
  education: 'edu',
  dexterity: 'dex',
  intelligence: 'int',
};

/**
 * [KROK-19 Z1, naprawiony blad] "PW" bywa zapisane jako "N*(M)" — ale
 * zmierzone na dwoch RÓŻNYCH realnych statblokach, ze DWOMA różnymi
 * znaczeniami: Joshua Thomas ("PW 5*(7)", przypis "* Zmniejszona liczba PW ze
 * względu na wcześniejszy atak") — 5 to biezaca (obnizona), 7 to oryginalna.
 * Bestia str. 31 ("PW 24*(12)", przypis o POŁOWIE PW przy nieukończonej
 * przemianie) — 24 to normalna wartosc, 12 to WARUNKOWA alternatywa (polowa),
 * NIE "maksimum" wiekszej od niej liczby 24. Nie da sie tego odroznic
 * strukturalnie (obie maja identyczny ksztalt "N*(M)") — wymaga przeczytania
 * konkretnego przypisu. Zamiast zgadywac ktora interpretacja, bierz PIERWSZA
 * liczbe jako najlepsze przyblizenie i oznacz `needsReview` (A10).
 */
type HitPointsParseReason = 'ok' | 'empty' | 'asterisk' | 'unparseable';

function parseHitPoints(raw: string | undefined): { value: number | null; max: number | null; reason: HitPointsParseReason } {
  if (!raw) return { value: null, max: null, reason: 'empty' };
  const trimmed = raw.trim();
  const withAsterisk = /^(\d+)\*\(\d+\)$/.exec(trimmed);
  if (withAsterisk) return { value: Number(withAsterisk[1]), max: null, reason: 'asterisk' };
  const n = Number(trimmed);
  if (Number.isFinite(n)) return { value: n, max: n, reason: 'ok' };
  // [KROK-19 Z4, naprawiony blad] Poprzednia wersja oznaczala TO SAMO
  // `needsReview` dla "N*(M)" (naprawde niejednoznaczne, wymaga przeczytania
  // przypisu) i dla zwyklego "–" (po prostu brak wartosci u tej istoty) —
  // notatka w `fromActor` zawsze mowila "zawiera adnotacje (*)", co dla "–"
  // jest po prostu NIEPRAWDA. Rozroznione tutaj, zeby notatka opisywala to,
  // co faktycznie sie stalo (A3/A10 — nie tylko "nic nie zgubione", ale tez
  // "wyjasnienie prawdziwe").
  return { value: null, max: null, reason: trimmed.length > 0 ? 'unparseable' : 'empty' };
}

/**
 * [KROK-19 Z4, naprawiony blad] Poprzednia wersja zwracala `null` bez zadnej
 * notatki, gdy wartosc nie byla liczba (np. Ruch "12/12 latając" — istota
 * latajaca, opisowa wartosc) — cichy spadek danych, A3. Teraz zwraca tez
 * powod, zeby wolajacy mogl dodac notatke.
 *
 * Dodatkowo: goly koncowy "*" (np. "14 *" — odnosnik do przypisu, BEZ
 * adnotacji w nawiasie jak przy PW "N*(M)") jest jednoznaczny — nic po nim
 * nie zostalo (przypis zostal juz odciety przez `terminateSectionBefore` w silniku
 * wzorcow), wiec liczba PRZED gwiazdka jest bezpieczna do uzycia, z notatka
 * "sprawdz przypis" zamiast calkowitego porzucenia wartosci.
 */
function parseNumberOrNull(raw: string | undefined): { value: number | null; failed: boolean; hasFootnoteMarker: boolean } {
  if (raw === undefined) return { value: null, failed: false, hasFootnoteMarker: false };
  const trimmed = raw.trim();
  const withFootnoteMarker = /^(\d+)\s*\*$/.exec(trimmed);
  if (withFootnoteMarker) return { value: Number(withFootnoteMarker[1]), failed: false, hasFootnoteMarker: true };
  const n = Number(trimmed);
  if (Number.isFinite(n)) return { value: n, failed: false, hasFootnoteMarker: false };
  return { value: null, failed: trimmed.length > 0, hasFootnoteMarker: false };
}

/**
 * [KROK-33 Z1, zmierzony na zywo brak, Sciapod str. 24 "Wrak.pdf"] Ruch bywa
 * zapisany jako "N/M*" (podstawowa wartosc / wariant warunkowy, np.
 * pływanie/latanie), z przypisem na WLASNYM wierszu ponizej ("*Pływanie") —
 * standardowa konwencja CoC dla wartosci zaleznych od warunkow, nie przypadek
 * brzegowy. Poprzednio: `parseNumberOrNull` nie rozpoznawal `/`, wiec cala
 * wartosc szla do `failed`, `mov.auto` zostawal `true`, a system CoC7
 * przeliczal wlasna (bledna) liczbe z cech zamiast uzyc zrodlowej. Pierwsza
 * wartosc (przed `/`) to KANONICZNA wartosc Ruchu w zrodle — wariant i
 * przypis nie giną (A3), trafiaja do notatki `MOVEMENT_RATIO_VARIANT`
 * (patrz wywolanie), nigdy do samego pola liczbowego.
 */
type MovementParseReason = 'ok' | 'empty' | 'ratio' | 'unparseable';

function parseMovement(raw: string | undefined): { value: number | null; reason: MovementParseReason; alternate?: string } {
  if (raw === undefined) return { value: null, reason: 'empty' };
  const trimmed = raw.trim();
  const ratio = /^(\d+)\s*\/\s*(\d+)\*?$/.exec(trimmed);
  if (ratio) return { value: Number(ratio[1]), reason: 'ratio', alternate: ratio[2] };
  const n = Number(trimmed);
  if (Number.isFinite(n)) return { value: n, reason: 'ok' };
  return { value: null, reason: trimmed.length > 0 ? 'unparseable' : 'empty' };
}

/**
 * [KROK-26 Z3, zmierzony na Walter Corbitt/Quick-Start] W odroznieniu od pol
 * czysto liczbowych, DB legalnie bywa notacja koscia ("1D4", "2D6"), wiec nie
 * moglo isc przez `parseNumberOrNull` — ale to znaczylo, ze surowy tekst z
 * `cif.statistics['damageBonus'].raw` trafial do Foundry BEZ ZADNEJ walidacji.
 * Sklejenie etykiety z wartoscia w jeden token pdf.js (ten sam mechanizm co
 * S1 w `patterns.ts`) dawalo np. ": +1D4" zamiast "1D4" — karta pokazywalaby
 * doslownie ten smiec zamiast poprawnego modyfikatora. Czysci wiodacy
 * separator/plus i polska notacje K->d (jak `polishDiceToFoundry` dla broni,
 * ktora nigdy nie byla tu stosowana), potem odrzuca wszystko, co nadal nie
 * wyglada jak liczba/kosc — degraduje do notatki + `auto: true`, tak jak inne
 * pola (A7), zamiast ciszej propagacji smiecia (A3).
 */
function parseDamageBonus(raw: string | undefined): { value: string | null; failed: boolean } {
  if (raw === undefined) return { value: null, failed: false };
  const cleaned = polishDiceToFoundry(raw.trim().replace(/^[:;,]+\s*/, '').replace(/^\+/, ''));
  if (/^-?\d+(?:d\d+)?$/i.test(cleaned)) return { value: cleaned, failed: false };
  return { value: null, failed: cleaned.length > 0 };
}

export function escapeHtmlBasic(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * [KROK-19 Z5, zgloszony na zywo brak] Polskie podreczniki zapisuja kosci
 * jako "1K3" ("K" = kostka) — silnik rzutow Foundry (`new Roll(formula)`)
 * rozumie WYLACZNIE notacje "NdM". Bez tego zapisany string trafia do pola
 * `system.range.normal.damage` doslownie i jest nierozpoznawalny jako
 * formula. Tlumaczenie WYLACZNIE notacji (K->d), nigdy tresci — oryginalny
 * zapis z ksiazki i tak zostaje osobno w `rawText` biografii (A3).
 */
function polishDiceToFoundry(damage: string): string {
  return damage.replace(/(\d)[kK](\d)/g, '$1d$2');
}

/** Jeden Item do embedowania po utworzeniu Actora (Z3) — skill zawsze, weapon tylko gdy atak wyglada na uzbrojony (nazwa != "Unik"/dodge, sedno decyzji zostaje w createActors.ts, nie tutaj — to WCIAZ tylko dane). */
export interface Coc7EmbeddedItemSpec {
  kind: 'skill' | 'weapon';
  name: string;
  /** Tylko `kind: 'skill'`. */
  basePercent?: number;
  /** Tylko `kind: 'weapon'` — nazwa umiejetnosci, do ktorej wiaze sie ta bron (`system.skill.main.name`, `id` dopisywane w Z3 PO utworzeniu Item-u umiejetnosci). */
  linkedSkillName?: string;
  damage?: string;
  /**
   * [KROK-20 Z2, zmierzony na zywo brak] Tylko `kind: 'weapon'` — surowy tekst
   * dopasowania z ksiazki (`CIFAttack.rawText`, np. "Przyssanie 40%(20/8)
   * 1K4+1"), trafia do `system.description.value` utworzonego Item-u. Bez
   * tego karta broni po imporcie ma PUSTA zakladke Opis — jedyne miejsce z
   * tekstem zrodlowym danego ataku (nazwa, procent, obrazenia w oryginalnym
   * zapisie z przypisami) po prostu nigdzie nie trafialo, mimo ze `rawText`
   * bylo juz policzone w CIF (A3 — nic nie ginie w ciszy — zlamane na
   * ostatnim metrze, nie w silniku parsujacym).
   */
  description?: string;
  /**
   * [KROK-33 Z4] Tylko `kind: 'weapon'` — opis znaleziony w prozie PONIZEJ
   * sekcji ATAKI (`CIFAttack.belowText`), juz HTML-escapowany, BEZ etykiety
   * "skad pochodzi" — etykieta jest tekstem jezyka swiata, wiec doklejana
   * dopiero w `createActors.ts` (dostep do `game.i18n`), nie tutaj (`fromActor`
   * ma pozostac czysta funkcja, patrz naglowek pliku). `undefined`, gdy nic
   * nie znaleziono.
   */
  belowText?: string;
  /** [KROK-40] Tylko `kind: 'weapon'` — `true`, gdy `CIFAttack.properties` niesie `'ranged'` (profil rozpoznal nazwe jako bron dystansowa, patrz `SectionListPattern.rangedKeywords`). Steruje `system.properties.rngd` utworzonego Item-u (domyslnie CoC7 traktuje kazda bron jako walke wrecz). */
  ranged?: boolean;
}

export interface Coc7ActorPayload {
  actorData: object;
  items: readonly Coc7EmbeddedItemSpec[];
  /**
   * [KROK-34 Z2] Bloki prozy dolaczone geometrycznie (`CIFActor.notes`) —
   * surowy tekst + etykieta jezyka zrodla (np. "Opis"), BEZ HTML/i18n (`fromActor`
   * ma pozostac czysta funkcja, patrz naglowek pliku) — kompozycja z notatkami
   * z ataków (Krok-33 Z4) i finalny HTML dzieja sie w `createActors.ts`
   * (dostep do Foundry). `[]`, gdy CIF nic nie mial (A10).
   */
  entityNotes: readonly { label: string; text: string }[];
}

export const coc7Adapter: SystemAdapter = {
  id: 'coc7-native',
  systemId: 'CoC7',
  systemVersion: '>=8.0.0',
  accepts: ['coc7'],
  produces: ['actors', 'items'],
  label: 'Call of Cthulhu 7. edycja (natywny)',

  fromActor(cif: CIFActor, ctx: ImportContext): AdapterResult<Coc7ActorPayload> {
    // [KROK-27 Z1] `notes`/`issues` nosza WYLACZNIE `{code, params}` (patrz
    // `LocalizableMessage`), nigdy gotowego zdania — ten adapter zyje w
    // `packages/module` i formalnie MOGLBY wywolac `game.i18n` wprost, ale
    // `fromActor` ma pozostac CZYSTA FUNKCJA (kontrakt §5.6 pkt 4, patrz
    // naglowek pliku) testowalna bez Foundry (`tools/verify-coc7-adapter.ts`)
    // — lokalizacja dzieje sie dopiero w `ReviewScreen.ts`
    // (`#renderActorNotesInto`, `localizeMessage('coc7', ...)`).
    const notes: LocalizableMessage[] = [];
    const issues: AdapterIssue[] = [];

    const characteristics: Record<string, { value: number | null }> = {};
    for (const [cifKey, coc7Key] of Object.entries(CHARACTERISTIC_KEY_MAP)) {
      const stat = cif.statistics[cifKey];
      characteristics[coc7Key] = { value: stat?.numeric ?? null };
      if (stat && stat.numeric === undefined) {
        notes.push({ code: 'CHARACTERISTIC_NOT_NUMERIC', params: { label: stat.sourceLabel, raw: stat.raw } });
      }
    }

    const hp = parseHitPoints(cif.statistics['hitPoints']?.raw);
    if (!cif.statistics['hitPoints']) notes.push({ code: 'HIT_POINTS_MISSING' });
    if (hp.reason === 'asterisk') {
      notes.push({ code: 'HIT_POINTS_ASTERISK', params: { raw: cif.statistics['hitPoints']?.raw ?? '' } });
    } else if (hp.reason === 'unparseable') {
      notes.push({ code: 'HIT_POINTS_UNPARSEABLE', params: { raw: cif.statistics['hitPoints']?.raw ?? '' } });
    }
    const magicPoints = parseNumberOrNull(cif.statistics['magicPoints']?.raw);
    if (magicPoints.failed) notes.push({ code: 'MAGIC_POINTS_UNPARSEABLE', params: { raw: cif.statistics['magicPoints']?.raw ?? '' } });
    if (magicPoints.hasFootnoteMarker) {
      notes.push({ code: 'MAGIC_POINTS_FOOTNOTE', params: { raw: cif.statistics['magicPoints']?.raw ?? '' } });
    }
    const sanity = cif.statistics['sanity'];
    if (sanity && sanity.numeric === undefined && sanity.raw !== '–') {
      notes.push({ code: 'SANITY_UNPARSEABLE', params: { raw: sanity.raw } });
    }
    const movement = parseMovement(cif.statistics['movement']?.raw);
    if (movement.reason === 'unparseable') {
      notes.push({ code: 'MOVEMENT_UNPARSEABLE', params: { raw: cif.statistics['movement']?.raw ?? '' } });
    } else if (movement.reason === 'ratio') {
      const footnote = cif.statistics['movement']?.footnoteText;
      notes.push({
        code: 'MOVEMENT_RATIO_VARIANT',
        params: {
          raw: cif.statistics['movement']?.raw ?? '',
          base: String(movement.value),
          alternate: movement.alternate ?? '',
          footnoteNote: footnote ? ` (${footnote})` : '',
        },
      });
    }
    const build = parseNumberOrNull(cif.statistics['build']?.raw);
    if (build.failed) notes.push({ code: 'BUILD_UNPARSEABLE', params: { raw: cif.statistics['build']?.raw ?? '' } });
    const damageBonus = parseDamageBonus(cif.statistics['damageBonus']?.raw);
    if (damageBonus.failed) {
      notes.push({ code: 'DAMAGE_BONUS_UNPARSEABLE', params: { raw: cif.statistics['damageBonus']?.raw ?? '' } });
    }
    // [KROK-34 Z1, zmierzony na zywo brak, Sciapod str. 24 "Wrak.pdf"] Do tego
    // kroku `armor` bylo ZAWSZE `{value: null}` — profil nie mial NAWET
    // SZANSY nakarmic tego pola, niezaleznie od tego, czy autor sklikal
    // etykiete "Pancerz" w Studiu. Ta sama degradacja co reszta pol liczbowych
    // (`build`/`magicPoints`): wartosc czysto opisowa ("brak", "2-punktowa
    // gruba skóra" — bez wiodacej liczby, silnik profilu jej NIE dzieli, patrz
    // `patterns.ts` `VALUE_WITH_DESCRIPTION`) trafia w calosci do notatki
    // (`ARMOR_UNPARSEABLE`), NIE ginie w ciszy (A3), a `armor.value` zostaje
    // `null`/`auto:true` — system policzy cos rozsadnego zamiast pokazac zero.
    const armor = parseNumberOrNull(cif.statistics['armour']?.raw);
    if (armor.failed) notes.push({ code: 'ARMOR_UNPARSEABLE', params: { raw: cif.statistics['armour']?.raw ?? '' } });
    const armorDescription = cif.statistics['armour']?.descriptionText;
    if (armorDescription) notes.push({ code: 'ARMOR_DESCRIPTION', params: { raw: armorDescription } });

    // [KROK-39 Z4] Klucz kanoniczny `luck` istnieje w `canon/statKeys.ts`
    // (hints: "Luck"/"Szczęście"/"Fortuna") od wersji 1.1 MDD — do tego kroku
    // po prostu NIGDY nie mial skad sie wziac: zaden profil NPC nie mial
    // etykiety odpowiadajacej Szczesciu (statbloki potworow/NPC w CoC7 go nie
    // niosa), wiec `cif.statistics['luck']` bylo ZAWSZE `undefined`, a ta
    // notatka byla wiec BEZWARUNKOWA. Gotowi Badacze (trasa `playerCharacter`,
    // `pageRoute.ts`) MAJA Szczescie — profil `Wrak.json` mapuje "Szczęście:"
    // na ten klucz (Krok 39 Z5) — wiec notatka teraz odzwierciedla, czy TEN
    // KONKRETNY profil je rozpoznal, zamiast zawsze twierdzic, ze nie.
    const luck = parseNumberOrNull(cif.statistics['luck']?.raw);
    if (!cif.statistics['luck']) notes.push({ code: 'LUCK_NOT_RECOGNIZED' });
    else if (luck.failed) notes.push({ code: 'LUCK_UNPARSEABLE', params: { raw: cif.statistics['luck']?.raw ?? '' } });

    // [KROK-25, zmierzony na zywo blad] Zainstalowany system CoC7
    // (`models/actor/global-system.js`, `prepareBaseData`/`prepareDerivedData`)
    // PRZELICZA hp/mp/mov/db/build/san Z CECH przy KAZDYM cyklu przygotowania
    // danych, dopoki `attribs.<pole>.auto` zostaje na domyslnym `true`
    // (`initial: true` w schemacie) — dokladnie ten sam mechanizm co
    // `flags.locked` (KROK-19). Efekt zmierzony wprost: RAT PACK ma w
    // podreczniku "Move: 9", ale STR(35) rowne SIZ(35) (nie WIEKSZE) przy
    // DEX(70) > SIZ daje ze wzoru CoC7 tylko 8 — zaimportowany aktor
    // pokazywal 8, bo `mov.auto` zostawal wlaczony i system nadpisywal nasza
    // wartosc przy pierwszym renderze. Naprawa: `auto: false` WYLACZNIE gdy
    // faktycznie mamy sparsowana wartosc zrodlowa (null = brak w zrodle,
    // wtedy zostawiamy systemowi policzenie czegos rozsadnego zamiast
    // zablokowanego `null` — A7, degraduj bez bledu).
    const attribs = {
      hp: { value: hp.value, max: hp.max, auto: hp.value === null },
      mp: { value: magicPoints.value, max: magicPoints.value, auto: magicPoints.value === null },
      // [KROK-39 Z4] BEZ `auto` — w odroznieniu od hp/mp/mov/db/build/san
      // (Krok 25, komentarz przy `attribs` ponizej), Szczescie NIE jest w CoC7
      // przeliczane ZE CECH (rzucane raz w chargenie, nie wzorem), wiec ten
      // sam mechanizm nadpisywania nie ma tu zastosowania — niezweryfikowane
      // wprost w zrodle (brak dostepu do zywego Foundry w tej sesji), wiec
      // pole zostaje w KSZTALCIE sprzed tego kroku (`{value}`, bez dodatkowych
      // pol), zamiast zgadywac nieistniejacy klucz schematu.
      lck: { value: luck.value },
      san: { value: sanity?.numeric ?? null, auto: sanity?.numeric === undefined },
      mov: { value: movement.value, auto: movement.value === null },
      db: { value: damageBonus.value, auto: damageBonus.value === null },
      build: { value: build.value, auto: build.value === null },
      armor: { value: armor.value, auto: armor.value === null },
    };

    if (cif.attacks.length === 0) notes.push({ code: 'NO_ATTACKS_SECTION' });
    const items: Coc7EmbeddedItemSpec[] = [];
    // [KROK-25, zgloszony na zywo brak] Manewr walki (np. angielskie "Overwhelm
    // (fighting maneuver)") nie ma WLASNEGO procentu trafienia w zrodle — w
    // zasadach CoC7 zawsze korzysta z umiejetnosci ataku, PO KTORYM stoi w
    // ksiazce (Fighting -> Overwhelm), nigdy wlasnej, osobnej umiejetnosci.
    // Bez tego kazdy taki wariant dostawal wlasna umiejetnosc "0%" (zle) —
    // teraz atak BEZ rozpoznanego `toHit` laczy sie z NAJBLIZSZYM wczesniejszym
    // atakiem, ktory MIAL wlasny procent, zamiast tworzyc nowa umiejetnosc.
    let lastSkillName: string | null = null;
    for (const attack of cif.attacks) {
      const toHitValue = parseNumberOrNull(attack.toHit).value;
      let linkedSkillName: string;
      if (toHitValue !== null) {
        items.push({ kind: 'skill', name: attack.name, basePercent: toHitValue });
        linkedSkillName = attack.name;
        lastSkillName = attack.name;
      } else if (lastSkillName) {
        linkedSkillName = lastSkillName;
        notes.push({ code: 'ATTACK_LINKED_TO_PREVIOUS_SKILL', params: { attackName: attack.name, linkedSkillName: lastSkillName } });
      } else {
        // Brak jakiegokolwiek wczesniejszego ataku do powiazania (np. ten
        // atak jest PIERWSZY na liscie) — nie powinno sie zdarzyc w realnych
        // ksiazkach (manewry zawsze nastepuja PO swojej bazowej umiejetnosci),
        // ale degraduj zamiast cichego bledu (A7): wlasna umiejetnosc 0%,
        // jawna notatka do recznej poprawy.
        items.push({ kind: 'skill', name: attack.name, basePercent: 0 });
        linkedSkillName = attack.name;
        lastSkillName = attack.name;
        notes.push({ code: 'ATTACK_NO_TOHIT_NO_PREVIOUS', params: { attackName: attack.name } });
      }
      // [KROK-19 Z5] `itemPattern` (patrz packages/core) przechwytuje obrazenia
      // od Z5 — jesli mimo to brak (broń bez rozpoznanej formuly w zrodle,
      // np. opisana proza), jawnie oznaczone w `notes` (A3/A10), nigdy
      // zgadywane z nazwy ataku. `polishDiceToFoundry` tlumaczy WYLACZNIE
      // notacje kosci ("1K3" -> "1d3"), zeby `system.range.normal.damage`
      // bylo poprawna formula dla silnika rzutow Foundry.
      const damage = attack.damage ? polishDiceToFoundry(attack.damage) : '';
      // [KROK-33 Z4] `belowText` — opis znaleziony w prozie PONIZEJ sekcji
      // ATAKI (patrz `attackDescriptionCrossReference.ts`) — juz escapowany
      // HTML-owo tutaj (`fromActor` MA pozostac czysta funkcja, patrz naglowek
      // pliku), ale CELOWO bez etykiety/oznaczenia "skad pochodzi" — to jest
      // TEKST DO WYSWIETLENIA (jezyk swiata Foundry), nie diagnostyka (`notes`
      // ida przez `LocalizableMessage`+`game.i18n` w `ReviewScreen.ts`), wiec
      // etykieta powstaje dopiero w `createActors.ts`, ktore MA dostep do
      // `game.i18n`, nie tutaj.
      const belowText = attack.belowText ? escapeHtmlBasic(attack.belowText) : undefined;
      const ranged = attack.properties.includes('ranged');
      items.push({ kind: 'weapon', name: attack.name, linkedSkillName, damage, description: `<p>${escapeHtmlBasic(attack.rawText)}</p>`, belowText, ranged });
      if (!attack.damage) notes.push({ code: 'WEAPON_DAMAGE_UNRECOGNIZED', params: { attackName: attack.name } });
      // [KROK-40 Z3, zgloszenie na zywo "nacisk na dodanie amunicji nic nie
      // robi"] CoC7 liczy pojemnosc magazynka (`system.bullets`) osobno od
      // ilosci NABOI W magazynku (`system.ammo`) — przycisk "przeladuj" na
      // karcie Aktora robi `Math.min(ammo+1, bullets)`, wiec przy domyslnym
      // `bullets: null` (parsowane jako 0) ZAWSZE wychodzi `min(1,0)=0`, czyli
      // zapis identyczny z obecna wartoscia — cichy no-op, bez bledu. Ten
      // profil (i og. schemat "ATAKI" w tej ksiazce) nigdy nie podaje
      // pojemnosci magazynka przy POZYCJI broni w statbloku postaci (w
      // odroznieniu od cech typu obrazenia/toHit) — nie ma wiec skad tego
      // wziac bez zgadywania (R2: profil niesie instrukcje parsowania, nie
      // wymyslona tresc). Zamiast fabrykowac liczbe, ostrzezenie GM-owi, ze
      // pole wymaga recznego uzupelnienia, zanim przycisk zadziala.
      if (ranged) notes.push({ code: 'WEAPON_AMMO_CAPACITY_UNKNOWN', params: { attackName: attack.name } });
    }

    // [KROK-20 Z2b, zgloszony na zywo brak] `cif.skills` — lista umiejetnosci
    // OGOLNYCH statbloku ("Umiejętności: Historia 75%, Okultyzm 60%..."),
    // odrebna od atakow. Bez tego cala ta lista po prostu nigdy nie trafiala
    // na karte — nie byla nawet parsowana (patrz `buildCIFActor.ts`).
    // Pomijaj nazwe juz zajeta przez umiejetnosc powiazana z atakiem (rzadkie,
    // ale mozliwe przy nazwach pokrywajacych sie miedzy ATAKI a Umiejetnosci)
    // — nie twórz dwoch Item-ow o tej samej nazwie, ktore myliyby GM-a.
    const existingSkillNames = new Set(items.filter((it) => it.kind === 'skill').map((it) => it.name));
    for (const skill of cif.skills) {
      if (existingSkillNames.has(skill.name)) continue;
      const basePercent = parseNumberOrNull(skill.value).value ?? 0;
      items.push({ kind: 'skill', name: skill.name, basePercent });
      existingSkillNames.add(skill.name);
    }

    if (cif.name.startsWith('NPC ze str.')) {
      // [KROK-19 Z4, zmierzony na zywo brak] Bez listy kandydatow uzytkownik
      // dostaje wylacznie "coś jest niepewne na str. 55" i musi sam przeczesac
      // cala strone PDF-a, zeby ustalic, ktora postac to jest — zmierzony na
      // zywo problem ("nie jestem w stanie zweryfikować którego NPC to
      // dotyczy z tej strony"). Kandydaci pochodza z geometrycznego parowania
      // (entityAssembly), nie z gadania — to WCIAZ jest "przy niepewnosci nie
      // zgaduj, zaznacz" (A10), tylko z realnie uzyteczna podpowiedzia.
      issues.push({ severity: 'warning', code: 'UNCERTAIN_NAME', params: { name: cif.name } });
      if (cif.nameCandidates && cif.nameCandidates.length > 0) {
        issues.push({ severity: 'warning', code: 'UNCERTAIN_NAME_CANDIDATES', params: { candidates: cif.nameCandidates.join(' | ') } });
      }
    }

    // [KROK-35 Z1/Z2] Token/portret aktora — WYLACZNIE jawny wybor uzytkownika
    // w zakladce Aktorow ekranu przegladu, przekazany jako id obrazu
    // (`CIFImage.id`), nigdy zgadywany geometrycznie (`images.associateWithEntity`
    // z profilu, MDD §5.5, swiadomie NIEUZYTE tutaj — decyzja produktowa
    // kroku 35: zero automatycznego dopasowania). `imagePathResolver`
    // rozwiazuje id na FAKTYCZNIE juz wgrana sciezke (obrazy sa wgrywane
    // PRZED utworzeniem aktorow w `#runImport`) — gdy autor wybral obraz, ktory
    // z jakiegos powodu NIE zostal wgrany (odznaczony w zakladce Obrazy, blad
    // uploadu), resolver zwraca `null` i aktor powstaje BEZ tokenu/portretu
    // plus jawne ostrzezenie, NIGDY ze sciezka do nieistniejacego pliku
    // (A3/A7 — ten sam wzorzec degradacji co reszta pol tego adaptera).
    const tokenImageRef = ctx.tokenImageRef ?? null;
    const portraitImageRef = ctx.portraitImageRef ?? null;
    const tokenImagePath = tokenImageRef ? ctx.imagePathResolver(tokenImageRef) : null;
    const portraitImagePath = portraitImageRef ? ctx.imagePathResolver(portraitImageRef) : null;
    if (tokenImageRef && !tokenImagePath) issues.push({ severity: 'warning', code: 'ACTOR_TOKEN_IMAGE_NOT_UPLOADED', params: { imageRef: tokenImageRef } });
    if (portraitImageRef && !portraitImagePath) issues.push({ severity: 'warning', code: 'ACTOR_PORTRAIT_IMAGE_NOT_UPLOADED', params: { imageRef: portraitImageRef } });

    // [KROK-39 Z4] `CIFActor.route` (`pageRoute.ts`, opcjonalne — patrz jej
    // komentarz w `cif/types.ts`) decyduje o typie aktora Foundry. `undefined`
    // (fixtury/wywolania sprzed kroku 39, konstruujace `CIFActor` bezposrednio
    // bez tego pola) traktowane jak `'npc'` — DOKLADNIE zachowanie sprzed tego
    // kroku, zero zmiany dla istniejacych profili/testow.
    const isPlayerCharacter = cif.route === 'playerCharacter';

    // [ZGŁOSZENIE na zywo po Kroku 39, "Zawód: ma Wiek:"] `cif.typeLabel`
    // zaklada, ze zawod/typ jest WLASNYM, samodzielnie stylowanym naglowkiem
    // (`typeLabelPattern`, fontRoleCandidate) — w Wrak.pdf "Zawód:" to zwykle
    // pole etykieta+wartosc (jak "PW:"/"Krzepa:"), a jego WARTOSC jest stylem
    // `body`, strukturalnie wykluczonym przez `excludeRoles`, wiec ten
    // mechanizm nigdy nie mogl tego zlapac. Fallback na
    // `cif.statistics['occupation']`/`['age']` — wypelniane, gdy autor profilu
    // doda "Zawód:"/"Wiek:" jako zwykla etykiete do dowolnego `labelledPairs`
    // (np. wzorca pochodnych), bez potrzeby wlasnego `fontRoleCandidate`.
    // `cif.typeLabel` ma pierwszenstwo (ksiazki, gdzie zawod NAPRAWDE jest
    // osobnym naglowkiem) — obie sciezki opisuja TO SAMO pole systemu.
    const occupation = cif.typeLabel ?? cif.statistics['occupation']?.raw;
    const age = cif.statistics['age']?.raw;

    // [KROK-39 Z4, Krok 38 P5] `actorLink`/`disposition` swiadomie NIGDY nie
    // ustawiane tutaj — `character-system.js`'s `_preCreateChanges` nadpisuje
    // OBA bezwarunkowo przez `mergeObject` (`actorLink: true`, `disposition: 1`)
    // NIEZALEZNIE od tego, co przyszloby z tego adaptera. Proba ustawienia
    // czegokolwiek innego byloby martwym kodem — udajacym kontrole, ktorej
    // faktycznie nie ma.
    const actorData = {
      name: cif.name,
      type: isPlayerCharacter ? 'character' : 'npc',
      folder: ctx.folderId,
      // [KROK-35 Z2, A13 sprawdzone wprost w zrodle CoC7 (`document-class.js`
      // `_preCreate`, `hooks/create-token.js`)] Klucz `img` pomijany
      // CALKOWICIE (nie `img: undefined`/`null`), gdy autor wybral "brak" —
      // `_preCreate` systemu podstawia WLASNY domyslny obrazek NPC
      // (`npc-system.js` `defaultImg`, "cultist.svg") WYLACZNIE gdy
      // `data.img` jest `undefined` (albo dosl. mystery-man Foundry) — jawnie
      // ustawiona, inna sciezka NIGDY nie jest nadpisywana. `prototypeToken`
      // analogicznie: token upuszczony na scene dostaje `actor.img` WYLACZNIE
      // gdy jego `texture.src` jest WCIAZ mystery-manem (`create-token.js`) —
      // jawnie ustawiona, inna sciezka od razu w `prototypeToken.texture.src`
      // nigdy nie trafia w ten warunek, wiec przezywa upuszczenie na scene
      // bez zmian (Z3 punkt 5).
      ...(portraitImagePath ? { img: portraitImagePath } : {}),
      ...(tokenImagePath ? { prototypeToken: { texture: { src: tokenImagePath } } } : {}),
      system: {
        characteristics,
        attribs,
        // [KROK-20 Z2, zmierzony na zywo problem] Poprzednia wersja wpisywala
        // tu `cif.rawText` w calosci — CALY dopasowany tekst statbloku
        // (cechy+pochodne+ataki+umiejetnosci). Skutek na zywo: notatki
        // duplikowaly WSZYSTKO, co juz widac gdzie indziej na karcie
        // (siatka cech, karty broni, umiejetnosci), bez zadnej wartosci
        // dodanej dla GM-a — czysty szum, nie "bezpiecznik" A3. `rawText`
        // nadal istnieje w CIF i jest widoczny w ekranie przegladu PRZED
        // importem (notatki adaptera, KROK-20 Z2) — to tam ma realna
        // wartosc (weryfikacja parsowania), nie na gotowej karcie Actora.
        // Pozostawione puste raczej niz usuniete pole: gdy `CIFActor.unmapped`
        // zacznie byc faktycznie wypelniane (obecnie zawsze `[]`), TU ma
        // trafiac wylacznie TO, co nie zmiescilo sie nigdzie indziej.
        // [zgloszenie uzytkownika po KROK-33 Z4, rozszerzone KROK-39 Z4]
        // `createActors.ts` NADPISUJE to pole opisami atakow/notatkami
        // encji znalezionymi w prozie — świadomie NIE tutaj, `fromActor` ma
        // pozostac czysta funkcja (patrz naglowek pliku). Placeholder MUSI
        // juz miec docelowy KSZTALT (`buildCharacterBiographyArray`/
        // `buildActorNotesValue` w `createActors.ts` rozgaleziaja sie po
        // `actorData.type`, nie po `route` — jedno zrodlo prawdy o ksztalcie):
        // `character` ma `biography` jako `ArrayField` obiektow `{title,
        // value}` (Krok 38, zmierzone wprost ze zrodla systemu), `npc` —
        // pojedyncze pole `{personalDescription: {value}}`.
        biography: isPlayerCharacter ? [] : { personalDescription: { value: '' } },
        // [KROK-19 Z5, zgloszony na zywo brak] Zweryfikowane wprost w zrodle
        // systemu (`npc-system.js`): pole NPC domyslnie startuje jako
        // `flags.locked = false` ("w trakcie edycji GM-a") — karta walki w
        // TYM stanie pokazuje edytowalne pola (nazwa/umiejetnosc), NIE
        // klikalna akcje rzutu. Automatycznie zaimportowany aktor jest z
        // definicji "gotowy do przejrzenia i uzycia" (A5), wiec startuje
        // zablokowany — dokladnie ten sam stan, w ktorym GM recznie
        // "zatwierdza" karte po wlasnym utworzeniu.
        // [KROK-39 Z4, NIEZWERYFIKOWANE dla `character`] Zrodlo NPC-systemu
        // potwierdzono wprost (Krok 19 Z5) — dla `character` to pole zostaje
        // ustawione IDENTYCZNIE, bez analogicznej weryfikacji w zrodle
        // `character-system.js` (Krok 38 sprawdzil TAM WYLACZNIE
        // `_preCreateChanges`, nie ten konkretny flag). Zachowanie
        // najbardziej spojne z reszta karty (aktor "gotowy do przejrzenia",
        // A5) w razie braku pola Foundry je po prostu zignoruje — ale A13
        // wymaga sprawdzenia na zywym aktorze (Z6, wlasciciel produktu),
        // nie zakladania.
        flags: { locked: true },
        // [ZGŁOSZENIE po kroku 30, "Rozdzielenie nazwy od typu/zawodu"]
        // `occupation`/`age` (obliczone wyzej) -> `system.infos.*` —
        // zweryfikowane wprost w zrodle systemu: oba to zwykle `StringField`,
        // dokladnie po to samo co ten wolny tekst z podrecznika (nie
        // `infos.type`, ktory w CoC7 oznacza raczej klasyfikacje istoty niz
        // zawod postaci). Pominiete calkowicie, gdy zadne zrodlo ich nie
        // dostarczylo (wsteczna zgodnosc — pole systemu zostaje przy wlasnej
        // wartosci domyslnej).
        ...(occupation || age ? { infos: { ...(occupation ? { occupation } : {}), ...(age ? { age } : {}) } } : {}),
      },
    };

    // [zgloszenie uzytkownika, "teraz zniknął pancerz z notatek"] Opis
    // odcięty od wartosci liczbowej (`descriptionText`, patrz komentarz przy
    // `armorDescription` wyzej) trafial DOTAD wylacznie do `notes`
    // (diagnostyka ekranu przegladu PRZED importem — `ARMOR_DESCRIPTION`),
    // NIGDY na sama karte Actora. Dopoki autor profilu mial WLASNY, recznie
    // wskazany blok `proseBlock` celujacy w ten sam akapit, to ON (przez
    // `cif.notes`) byl JEDYNYM sposobem, w jaki ten tekst w ogole trafial do
    // notatek postaci — usuniecie tego bloku (bo kolidowal geometrycznie z
    // teraz poprawnie rozpoznawana etykieta "Pancerz:", patrz `proseBlock.ts`)
    // usunelo wiec opis CALKOWICIE, nie tylko zbedny duplikat. Naprawa:
    // dolacz go do `entityNotes` WPROST z `cif.statistics`, tym samym
    // mechanizmem co reszta notatek (etykieta + tekst, z tym samym
    // odrzucaniem powielonego naglowka) — dziala NIEZALEZNIE od tego, czy
    // autor profilu w ogole skonfigurowal jakikolwiek `proseBlock`.
    const entityNotes = [...(cif.notes ?? [])];
    if (armorDescription) {
      const armorLabel = (cif.statistics['armour']?.sourceLabel ?? 'Pancerz').replace(/:\s*$/, '');
      entityNotes.push({ label: armorLabel, text: armorDescription });
    }

    return { data: { actorData, items, entityNotes }, notes, issues };
  },
};

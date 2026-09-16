import type { Rect } from '../geometry.js';
import { findColumnBand, isWithinColumnBand } from './columnBand.js';

/**
 * [KROK-29 Z1] `itemPattern` (`sectionList`) jest jedynym polem w Profile
 * Studio wymagajacym recznego napisania wyrazenia regularnego (O1, RAPORT
 * testu akceptacyjnego kroku 28: wystapilo trzy razy w jednym przebiegu).
 * Zamiast generowac DOWOLNY regex z przykladow (nieprzewidywalne, nieczytelne
 * dla czlowieka), rozpoznajemy OGRANICZONA RODZINE ksztaltow spotykanych w
 * statblockach CoC7 (brief kroku 29, tabela): nazwa+procent[+reszta po
 * przecinku] (ataki, jedna pozycja na "linie" bufora sekcji) i
 * nazwa+procent (umiejetnosci, ciag oddzielony przecinkami na jednej "linii").
 * Autor klika przyklady, wzorzec dobiera i dostraja KSZTALT — nie buduje
 * wyrazenia od podstaw.
 *
 * Dwie rodziny maja INNY ksztalt matchowania, bo `matchSectionList` (patterns.ts)
 * laczy CALA sekcje w jeden plaski bufor tekstowy (spacje zamiast prawdziwych
 * podzialow linii) i dopasowuje `itemPattern` globalnie do calego bufora:
 * - Umiejetnosci: kazda pozycja SAMA SIE konczy wlasnym "NN%" (nastepna zaczyna
 *   sie od razu po przecinku) — `matchAll` bez lookaheadu wystarcza.
 * - Ataki: PO procencie (i opcjonalnym stosunku w nawiasie) bywa dowolnie dlugi
 *   opis obrazen ("obrażenia 1K3+1K4") — bez granicy regex polknalby TEZ
 *   nastepna pozycje. Wymaga lookaheadu "tu zaczyna sie kolejna pozycja albo
 *   koniec bufora", DOKLADNIE ten sam mechanizm co juz istniejacy, RECZNIE
 *   napisany `itemPattern` w `spike/statblocks2/coc7-niczas-pl.json` (attacki).
 *
 * [zmierzone wprost na str. 23 "Zew Cthulhu 7ed. Wrak.pdf", Calhoun] Jedna
 * pozycja ataku bywa opisana BEZ procentu wcale — "pałka 1K4+1K4" (ta sama
 * umiejetnosc walki co "Walka wręcz", inna tylko bron/obrazenia). Stad druga,
 * "bezprocentowa" gal'z rodziny ATAKOW, dolaczana do pierwszej PRZEZ
 * alternatywe (`(?:...|...)`), TAK SAMO jak juz robi to recznie napisany
 * `itemPattern` w `profiles/coc7-quickstart-en.json` (dwie alternatywy jednej
 * grupy nazwanej `name`/`damage` w wzajemnie wykluczajacych sie galeziach —
 * potwierdzone, ze silnik regex (Node/V8, ta sama rodzina co przegladarka)
 * to obsluguje).
 *
 * Nazwa NIE wymaga wielkiej litery na poczatku — zmierzone wprost: "pałka"
 * (bron, nie pelna nazwa wlasna) zaczyna sie mala litera. `\p{L}` (dowolna
 * litera dowolnego jezyka), NIGDY `[A-Za-z]` (brief kroku 29: profil PL
 * potknal sie dokladnie o to przy "Nasłuchiwanie"/"Spostrzegawczość").
 */

export type ItemShapeCode = 'shapePercentRest' | 'shapeValueOnly' | 'shapeMixed' | 'shapePercentList';

export interface ItemPatternInference {
  itemPattern: string;
  /** Kod ksztaltu do wyswietlenia w UI (lokalizacja WYLACZNIE w `packages/module`, jak kazdy inny komunikat w tym projekcie). */
  shape: ItemShapeCode;
}

/**
 * [Zmierzony na zywo blad, kolejny eksport Actora "Sciapod" z Foundry, str. 24
 * "Wrak.pdf"] Kropka byla dotad dopuszczona w klasie znakow nazwy — bez
 * uzasadnienia w danych (zaden prawdziwy przyklad w tym projekcie nie ma
 * kropki WEWNATRZ nazwy pozycji), za to z POWAZNYM kosztem: sekcja "Ataki" ma
 * DLUGI akapit fabularny miedzy naglowkiem a pierwsza prawdziwa pozycja
 * ("może użyć swojej stopy... łuku. Walka wręcz (Bijatyka) 60%...") —
 * dopasowanie global/leftmost-first probuje NAJPIERW pozycje startowa na
 * poczatku tego akapitu, a skoro kropka byla dozwolona, `(?<name>...)` mogl
 * pochlonac CALY akapit AZ do prawdziwej nazwy, dajac nazwe pozycji rowna
 * calemu zdaniu fabularnemu + prawdziwa nazwe sklejone razem. Usuniecie kropki
 * z klasy oznacza, ze taka proba w ogole nie moze dopasowac calosci (po drodze
 * jest kropka, ktorej klasa juz nie zawiera) — silnik regex sam przesuwa
 * pozycje startowa dalej, az trafi na prawdziwy poczatek nazwy ("Walka..."),
 * bez potrzeby `skipAfterHeader` w profilu (mechanizm nadal dostepny jako
 * dodatkowe zabezpieczenie, ale przestaje byc JEDYNA obrona przed tym
 * ksztaltem bledu).
 */
/**
 * [ZGŁOSZENIE na zywo, "Wrak.pdf" Badacze, "Broń Palna (pistolet .22)"]
 * Cyfry/kropka byly CALKOWICIE wykluczone (patrz komentarz powyzej) — poprawne
 * dla gołej prozy (Sciapod), ale bledne dla broni z kalibrem w NAWIASIE
 * ("(pistolet .22)"): lookahead szukajacy KOLEJNEJ pozycji nie rozpoznawal
 * takiej nazwy jako poprawnego startu, wiec `.*?` PRZED nim polykal cala
 * pozycje pistoletu razem z Walka Wręcz jako jedna, zamiast zatrzymac sie na
 * jego granicy — zmierzone wprost, prawdziwy eksport Actora "Siren"/"Ellen
 * Gray" z Foundry ("Wrak.pdf" str. 27/30): pistolet znikal calkowicie z listy
 * broni.
 *
 * Naprawa NIE poszerza klasy globalnie (to properz odtworzyloby blad
 * Sciapoda) — cyfry/kropka dozwolone WYLACZNIE wewnatrz WLASNEGO, w pelni
 * domknietego nawiasu `(...)` (`\([^()]*\)`), ktory moze wystapic dowolna
 * ilosc razy w nazwie. Zdanie fabularne Sciapoda ("...luku.") nie ma ZADNYCH
 * nawiasow wokol swojej koncowej kropki, wiec nadal nie pasuje do tej klasy —
 * zweryfikowane wprost, test "dlugi akapit fabularny... NIE zanieczyszcza
 * jej nazwy" nadal przechodzi z tym wzorcem.
 */
const NAME_CLASS = '\\p{L}[\\p{L} /-]*?(?:\\([^()]*\\)[\\p{L} /-]*?)*';
const PERCENT_ITEM_RE = /\d{1,3}%/g;

/**
 * [Zmierzony na zywo blad, prawdziwy eksport Actora "Sciapod" z Foundry]
 * Ksztalt "wartosc" (`valueItem`, i lookahead wykrywajacy jego poczatek) byl
 * `\d[\p{L}\d+]*` -- CYFRA, potem DOWOLNA mieszanka liter/cyfr/plusa, W TYM
 * ZERO znakow. To dopuszczalo SAM GOLY numer ("6", "180", "40") jako
 * "wartosc obrazen", mimo ze notacja kostek CoC7 (i kazdego innego zmierzonego
 * w tym projekcie systemu) ZAWSZE ma literowy wskaznik typu kosci (K/D:
 * "1K3", "5K6", "1d8"). Sciapod (str. 24 "Wrak.pdf") ma po czystych
 * pozycjach atakow DLUGI opis zdolnosci specjalnych pelen zwyklych liczb w
 * prozie ("o dlugosci 6 stop (ok. 180 cm)... zasieg... ok. 40 m") -- kazda z
 * nich, poprzedzona jakimkolwiek slowem, wygladala jak poprawna "pozycja
 * bez procentu" (`shapeMixed`, galaz `valueItem`), dajac w prawdziwym
 * eksporcie fantomowe bronie ("stóp (ok.", "cm). Podstawowy zasięg tej broni
 * to ok.") z bezsensownymi wartosciami obrazen (180, 40). Naprawa: wymagaj
 * PRZYNAJMNIEJ JEDNEJ litery w wartosci -- prawdziwa notacja kostek zawsze ja
 * ma, goly opisowy numer w prozie nigdy. `pałka 1K4+1K4` (str. 23, przypadek,
 * dla ktorego ten ksztalt w ogole powstal) nadal pasuje (litera "K" jest).
 */
const DICE_VALUE = '\\d[\\d]*\\p{L}[\\p{L}\\d+]*';

function countPercentOccurrences(text: string): number {
  return (text.match(PERCENT_ITEM_RE) ?? []).length;
}

/**
 * Umiejetnosci: kazda pozycja samowystarczalna ("Nazwa NN%"), bez lookaheadu
 * -- kolejna pozycja zaczyna sie natychmiast po przecinku, wiec `matchAll`
 * globalnie po calym buforze wystarcza (zmierzone: 17/17 pozycji str. 23).
 */
function buildSkillsPattern(): ItemPatternInference {
  return { itemPattern: `(?<name>${NAME_CLASS}) (?<value>\\d{1,3})%`, shape: 'shapePercentList' };
}

/**
 * [KROK-19 dziedzictwo, poszerzone w KROK-30 Z3] Dodatkowa siatka
 * bezpieczenstwa -- podnaglowek stylu "Wielka Litera:" tez konczy pozycje,
 * niezaleznie od `terminateSectionBefore`/hardStop (ktore i tak juz to zwykle
 * wylapuja WCZESNIEJ, na poziomie calej sekcji).
 *
 * [zmierzony na zywo blad, str. 24 "Zew Cthulhu 7ed. Wrak.pdf", Sciapod]
 * Pierwotna klasa znakow `[\p{L} ]*` (WYLACZNIE litery i spacje) nie
 * rozpoznawala realnych podnaglowkow zdolnosci specjalnych typu "Chwyt i
 * miażdżenie (manewr):" ani "Kryształowy łuk (atak dystansowy):" -- nawiasy w
 * dopisku nie mieszcza sie w tej klasie, wiec caly ten branch lookaheadu
 * nigdy sie nie uaktywnial dla takich naglowkow. Klasa poszerzona wtedy do
 * `()./-` (nawiasy, kropka, ukosnik, lacznik) -- w tamtym momencie identyczna
 * jak `NAME_CLASS`. [Od naprawy kropki w `NAME_CLASS`, patrz jej komentarz,
 * juz NIE identyczna -- to jest naglowek/GRANICA pozycji, nie SAMA nazwa
 * pozycji, wiec ryzyko "przeciagniecia przez zdanie" jej nie dotyczy w ten
 * sam sposob; kropka zostaje tutaj celowo.]
 */
const NEXT_HEADER_LIKE = `\\s*\\p{Lu}[\\p{L} ()./-]*:`;

/**
 * [KROK-29 Z1, wersja pierwotna] "Walka wręcz (Bijatyka) 30% (15/6),
 * obrażenia 1K3+1K4" -- procent + opcjonalny stosunek w nawiasie + opcjonalna
 * reszta do konca pozycji.
 *
 * [KROK-30 Z2, zmierzony na zywo blad] `damage` byl pierwotnie `(?<damage>.*?)`
 * -- SUROWY, dowolny fragment tekstu do granicy pozycji (lookahead), wiec
 * niosl ze soba przecinek, sam SLOWNY OPIS ("obrażenia" -- to ETYKIETA, nie
 * WARTOSC) i dyndajacy lacznik ("lub", bez alternatywy po nim, bo ta jest juz
 * WLASNA, OSOBNA pozycja "pałka 1K4+1K4"). Wynik: `CIFAttack.damage` =
 * ", obrażenia 1K3+1K4 lub" zamiast czystego "1K3+1K4". Naprawa: opcjonalnie
 * pomin JEDNO slowo etykiety (dowolny jezyk -- nie slownik "obrażenia"/
 * "damage" zaszyty na sztywno), potem przechwyc WYLACZNIE sama wartosc
 * kostkowa (`\d[\p{L}\d+]*` -- ten sam ksztalt co `valueItem`).
 *
 * [zmierzony na zywo problem PRZY TEJ naprawie] Sama czysta wartosc jako
 * KONIEC dopasowania psuje lookahead: gdy po wartosci zostaje jeszcze
 * dyndajacy tekst ("lub", ewentualnie "lub pałka 1K4+1K4" gdy autor NIE dal
 * jeszcze przykladu bezprocentowego), ZADNA pozycja w tym tekscie nie
 * wyglada jak "NAME+procent" (ani, w ksztalcie mieszanym, jak wykluczone
 * "NAME+wartosc") -- dopasowanie CALEJ pozycji zawodzi, zamiast po prostu
 * konczyc sie wczesniej. Dopisany NIENAZWANY, leniwy `.*?` PO czystej
 * wartosci nadal chlonie taki dyndajacy tekst (tak jak stara wersja), ale
 * TERAZ poza grupa `damage` -- czysta wartosc zostaje czysta, a dopasowanie
 * calej pozycji nadal potrafi dosiegnac kolejnej prawdziwej pozycji.
 *
 * [KROK-33 Z3, zmierzony na zywo blad, Sciapod str. 24 "Wrak.pdf"] Pierwsza
 * wersja szukala slowa wprowadzajacego TUZ PO procencie/stosunku, oddzielone
 * WYLACZNIE przecinkiem — "Chwyt i miażdżenie (manewr) 60% (30/12):
 * pochwycenie, miażdżenie odbywa się w następnej rundzie, obrażenia 5K6"
 * zgubil `damage` calkowicie, bo separator to DWUKROPEK, a samo slowo
 * wprowadzajace stoi na KONCU dlugiego opisu, nie zaraz po nim. Naprawa:
 * gdy znane sa juz slowa wprowadzajace (`introWords`, wyodrebnione z
 * WLASNYCH przykladow procentowych autora — patrz `extractDamageIntroWords`,
 * NIGDY slownik jezykowy), szukaj ich GDZIEKOLWIEK w reszcie pozycji
 * (leniwe `.*?` PRZED, nie ograniczone do zaraz-po-separatorze), niezaleznie
 * od tego, czy separator to przecinek czy dwukropek — oba po prostu wchodza
 * w ten sam dowolny `.*?`. `WORD_START_GUARD` (nie `\b`) z tych samych
 * powodow co w `valueItem`: `\b` w JS nie liczy liter spoza ASCII jako
 * "znak slowa", wiec zawodzilby na slowach zaczynajacych sie od polskiej
 * litery. Brak `introWords` (autor jeszcze nie kliknal zadnego przykladu
 * procentowego z opisem obrazen) -> zachowanie sprzed tej naprawy (jedno
 * opcjonalne slowo TUZ po separatorze), zeby nie regresowac prostszych
 * ksztaltow, ktore juz dzialaly.
 */
function percentItem(introWords: readonly string[]): string {
  const restClause =
    introWords.length > 0
      ? `(?:.*?${WORD_START_GUARD}(?:${introWords.join('|')})\\s+(?<damage>${DICE_VALUE}))?.*?`
      : `(?:,?\\s*\\p{L}[\\p{L}]*)?\\s*(?<damage>${DICE_VALUE})?.*?`;
  return `(?<name>${NAME_CLASS}) \\*?(?<toHit>\\d{1,3})%(?:\\s*\\(\\d+/\\d+\\))?${restClause}`;
}

/**
 * [zmierzone str. 23, "pałka 1K4+1K4"] Pozycja BEZ procentu -- nazwa + wartosc
 * (dowolna mieszanka cyfr/liter, np. zapis kostek). `nameExclusion` (patrz
 * `extractDamageIntroWords`) uniemozliwia temu ksztaltowi mylenie WLASNEGO
 * opisu obrazen POPRZEDNIEJ pozycji procentowej ("obrażenia 1K3+1K4" -- to
 * SAMO "slowo + wartosc-kostkowa" co prawdziwa pozycja "pałka 1K4+1K4") z
 * poczatkiem NOWEJ pozycji -- ksztaltu regexowego SAMEGO W SOBIE nie da sie
 * odroznic, oba przypadki sa identyczne geometrycznie w splaszczonym buforze
 * (`matchSectionList` laczy cala sekcje jedna spacja, gubiac podzial na
 * linie). Jedyny niezawodny sygnal to slowo WPROWADZAJACE opis obrazen
 * ("obrażenia"/"damage"), wprost odczytane z WLASNEGO przykladu procentowego
 * autora -- nie slownik jezykowy zaszyty na sztywno (MDD: niezaleznosc od
 * jezyka/systemu).
 */
/**
 * [zmierzony na zywo problem przy pierwszej wersji tego pliku] Samo
 * `(?!obrażenia\b)` NIE wystarcza -- odrzuca WYLACZNIE dopasowanie
 * zaczynajace sie DOKLADNIE na poczatku wykluczonego slowa, ale silnik regex
 * probuje TEZ pozycji o jeden znak dalej ("brażenia" zamiast "obrażenia"),
 * gdzie asercja juz nie widzi calego wykluczonego slowa i przepuszcza
 * dopasowanie w polowie wyrazu. Wymagaj NAJPIERW prawdziwej granicy wyrazu
 * (poprzedni znak to NIE litera) -- wtedy wykluczenie faktycznie dziala,
 * zamiast dac sie ominac przesunieciem o jeden znak.
 */
const WORD_START_GUARD = '(?<!\\p{L})';

function valueItem(nameExclusion: string): string {
  return `(?<name>${WORD_START_GUARD}${nameExclusion}${NAME_CLASS}) (?<damage>${DICE_VALUE})`;
}

function lookahead(includeValueBranch: boolean, nameExclusion: string): string {
  const branches = [`\\s*${NAME_CLASS} \\*?\\d{1,3}%`];
  if (includeValueBranch) branches.push(`\\s*${WORD_START_GUARD}${nameExclusion}${NAME_CLASS} ${DICE_VALUE}`);
  branches.push(NEXT_HEADER_LIKE, '$');
  return `(?=${branches.join('|')})`;
}

/**
 * "Walka wręcz (Bijatyka) 30% (15/6), obrażenia 1K3+1K4 lub" -> ["obrażenia",
 * "lub"] -- KAZDE slowo z "reszty" przykladu procentowego (wszystko PO
 * procencie/opcjonalnym stosunku), nie tylko to bezposrednio po przecinku.
 * [zmierzony na zywo problem, druga iteracja tej funkcji] Pierwsza wersja
 * lapala WYLACZNIE slowo TUZ PO przecinku ("obrażenia") -- "lub" (dalej w tej
 * samej reszcie, po wartosci kostkowej) przechodzil bez przeszkod i "lub
 * pałka" sklejaly sie w jedna (bledna) nazwe. Opis obrazen bywa dluzszy niz
 * jedno slowo intro -- wykluczaj WSZYSTKO, co tam stoi.
 */
function extractDamageIntroWords(percentExamples: readonly string[]): readonly string[] {
  const words = new Set<string>();
  const tailRe = /\d{1,3}%(?:\s*\(\d+\/\d+\))?(.*)$/su;
  for (const example of percentExamples) {
    const tail = tailRe.exec(example)?.[1] ?? '';
    for (const m of tail.matchAll(/\p{L}{2,}/gu)) words.add(m[0]);
  }
  return [...words];
}

function buildAttacksPattern(percentExamples: readonly string[], valueOnlyExamples: readonly string[]): ItemPatternInference | null {
  const hasPercentExample = percentExamples.length > 0;
  const hasValueOnlyExample = valueOnlyExamples.length > 0;
  // [KROK-33 Z3] Wyliczane ZAWSZE, gdy sa jakiekolwiek przyklady procentowe —
  // nie tylko w ksztalcie mieszanym jak poprzednio. `percentItem` uzywa tego
  // TERAZ TEZ do szukania obrazen (patrz jej komentarz), nie tylko `valueItem`
  // do wykluczania nazw.
  const introWords = hasPercentExample ? extractDamageIntroWords(percentExamples) : [];
  if (hasPercentExample && hasValueOnlyExample) {
    const exclusion = introWords.length > 0 ? `(?!(?:${introWords.join('|')})\\b)` : '';
    return { itemPattern: `(?:${percentItem(introWords)}|${valueItem(exclusion)})${lookahead(true, exclusion)}`, shape: 'shapeMixed' };
  }
  if (hasPercentExample) return { itemPattern: `${percentItem(introWords)}${lookahead(false, '')}`, shape: 'shapePercentRest' };
  if (hasValueOnlyExample) return { itemPattern: `${valueItem('')}${lookahead(true, '')}`, shape: 'shapeValueOnly' };
  return null;
}

/**
 * Wnioskuje `itemPattern` z 1+ przykladowych tekstow pozycji klikniętych przez
 * autora profilu (kazdy przyklad to jedna "pozycja", np. jedna linia ataku
 * albo jedno wystapienie umiejetnosci na liscie). `kind` odpowiada zakladce,
 * na ktorej autor klika (Ataki/Umiejetnosci) -- decyduje o nazwach grup
 * dopasowania, ktorych oczekuje dalszy potok (`buildCIFActor.ts`:
 * `name`+`toHit`+`damage` dla atakow, `name`+`value` dla umiejetnosci).
 *
 * `null` = zaden przyklad nie pasuje do zadnego znanego ksztaltu (np. autor
 * kliknal pozycje bez zadnej liczby) -- UI ma wtedy poprosic o inny przyklad,
 * NIGDY nie zgadywac dowolnego wyrazenia.
 */
export function inferItemPatternFromExamples(kind: 'attacks' | 'skills', exampleTexts: readonly string[]): ItemPatternInference | null {
  const examples = exampleTexts.map((t) => t.trim()).filter(Boolean);
  if (examples.length === 0) return null;

  if (kind === 'skills') {
    const hasPercent = examples.some((t) => countPercentOccurrences(t) >= 1);
    return hasPercent ? buildSkillsPattern() : null;
  }

  const percentExamples = examples.filter((t) => countPercentOccurrences(t) >= 1);
  const valueOnlyExamples = examples.filter((t) => countPercentOccurrences(t) === 0 && /\d/.test(t));
  return buildAttacksPattern(percentExamples, valueOnlyExamples);
}

export interface RowTextToken {
  text: string;
  bbox: Rect;
}

/**
 * [UI, klikniecie przykladu] Zbiera tekst CALEGO wizualnego wiersza, do
 * ktorego nalezy klikniety token -- "ten sam wiersz" = zachodzace zakresy Y
 * (identyczny test co `mergeTouchingTokens`), posortowane po X, polaczone
 * pojedyncza spacja. W PRAKTYCE pdf.js czesto juz sklejyl cala linie w JEDEN
 * token (zmierzone wprost na str. 23 "Wrak.pdf" -- kazda linia ataku to JEDEN
 * `TextItem`), wiec ta funkcja zwykle zwraca po prostu tekst klikniętego
 * tokenu -- ale nie zaklada tego, zeby dzialac tez tam, gdzie pdf.js NIE
 * scalil linii.
 *
 * [KROK-30, zmierzony na zywo blad] "Ten sam wiersz" liczony WYLACZNIE po Y
 * (bez znajomosci kolumn) na stronie dwulamowej lapal TEZ proze z SASIEDNIEJ
 * kolumny lezacej na tej samej wysokosci co klikniety wiersz — zmierzone
 * wprost: klikniecie w "Walka wręcz..." (lewa lama, str. 23) wciagalo do tego
 * samego przykladu przypadkowe slowa opisu Sciapoda z prawej lamy ("ślimaków",
 * "robi", "szybciej"), ktore potem lądowaly w wykluczeniach `itemPattern`
 * (`extractDamageIntroWords`) jako fantomowe "slowa etykiety". Ten sam
 * mechanizm co naprawa granicy sekcji (`findColumnBand`/`isWithinColumnBand`,
 * `columnBand.ts`) — na stronie jednolamowej pasmo obejmuje cala tresc, zero
 * zmiany zachowania.
 */
export function collectRowText(tokens: readonly RowTextToken[], clickedIndex: number): string {
  const clicked = tokens[clickedIndex];
  if (!clicked) return '';
  const sameLine = (a: Rect, b: Rect): boolean => Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) > 0;
  const band = findColumnBand(tokens, clicked.bbox);
  return tokens
    .filter((t) => sameLine(t.bbox, clicked.bbox) && isWithinColumnBand(t.bbox, band))
    .slice()
    .sort((a, b) => a.bbox.minX - b.bbox.minX)
    .map((t) => t.text)
    .join(' ');
}

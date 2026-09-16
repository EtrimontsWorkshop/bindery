import { z } from 'zod';

/**
 * [KROK-18 Z2] Schemat profilu v2 — implementacja `Bindery-MDD-v2.1.md` §5.5
 * DOSLOWNIE (ksztalt JSON z brifu, pole za polem). Profile pochodza od
 * nieznanych autorow (spoza tego repo, MDD §10 `registerProfile`/
 * `loadProfileFromURL`) — walidacja przy ladowaniu jest OBOWIAZKOWA, nigdy
 * `as`/zaufanie strukturze bez sprawdzenia.
 *
 * [R2, status blokujacy] Profil to WYLACZNIE instrukcje parsowania (etykiety
 * pol, regexy, progi odleglosci, naglowki sekcji jako wzorzec) — NIGDY
 * wartosci tresci (nazwy postaci, opisy, listy zaklec). Ten schemat wymusza
 * to WYLACZNIE strukturalnie (typy pol) — nie umie odroznic "S" (etykieta,
 * dozwolone) od "Cthulhu" (tresc, niedozwolone) wpisanych w to samo pole
 * `labels`, bo oba sa poprawnymi stringami. Audyt tresci pozostaje
 * odpowiedzialnoscia recenzenta profilu (analogicznie do R1 w tym repo —
 * wymuszanego brakiem commitowania probek, nie automatycznym skanerem).
 */

const pageRangeSchema = z.tuple([z.number().int(), z.number().int()]);

const excludeZoneSchema = z.object({
  kind: z.string(),
  yFrom: z.number().min(0).max(1),
  yTo: z.number().min(0).max(1),
});

const pagesSchema = z.object({
  include: z.array(pageRangeSchema).min(1),
  excludeZones: z.array(excludeZoneSchema).optional().default([]),
});

const fingerprintSchema = z.object({
  metadata: z.record(z.string(), z.string()).optional().default({}),
  keywords: z.array(z.string()).optional().default([]),
  antiKeywords: z.array(z.string()).optional().default([]),
  minScore: z.number().min(0).max(1),
});

/** `labelledPairs` — siatka cech / blok pochodnych (zbior etykiet, DOWOLNA kolejnosc i liczba — S2). */
const labelledPairsPatternSchema = z.object({
  kind: z.literal('labelledPairs'),
  /** Etykieta (klucz PDF) -> klucz kanoniczny wyniku. Same etykiety, NIE wartosci (R2). */
  labels: z.record(z.string(), z.string()).refine((v) => Object.keys(v).length > 0, 'labels must not be empty'),
  valuePattern: z.string(),
  minPairs: z.number().int().min(1),
  maxPairs: z.number().int().optional(),
  terminate: z
    .object({
      onRepeatedLabel: z.boolean().optional().default(false),
      maxGapPt: z.number().positive().optional(),
    })
    .optional()
    .default({}),
  /** [S1] Wartosc bywa rozbita dywizacja/spacja na kilka tokenow (np. "12/12" + "latając") — sklej przed dopasowaniem. */
  allowTrailingWords: z.boolean().optional().default(false),
  unit: z.string().optional(),
  /**
   * [KROK-19 Z4, zmierzony na realnej ksiazce blad] `allowTrailingWords`
   * sprawdza TYLKO etykiety WLASNEGO wzorca (`looksLikeLabel`), zeby wiedziec
   * kiedy przestac chlonac slowa opisowe — ale nie ma pojecia o naglowkach
   * INNYCH wzorcow (np. sekcji `ATAKI`). Zmierzone wprost: ostatnia para
   * `derivedBlock` ("Punkty Magii") bez kolejnej etykiety WLASNEGO wzorca po
   * sobie wchlonela literalny token "ATAKI" NASTEPNEJ sekcji (plus jej
   * preambule "Ataki w rundzie:") jako "slowa opisowe". Jesli podany, kazdy
   * token pasujacy do tego wzorca natychmiast przerywa chlanianie (token NIE
   * jest konsumowany).
   *
   * [KROK-27 Z2, zmiana nazwy] Dawne `stopBeforeToken` — ta sama nazwa co w
   * `sectionList` ponizej sugerowala TEN SAM zasieg (mylila mnie samego przy
   * pisaniu briefu kroku 26, patrz RAPORT-KROK-26.md odkrycie #4), a to
   * DWA ROZNE mechanizmy: to pole ogranicza chlanianie slow opisowych DLA
   * JEDNEJ PARY (patrz `allowTrailingWords` obok), `terminateSectionBefore`
   * w `sectionList` konczy CALA SEKCJE. Nowa nazwa czyta sie razem z
   * `allowTrailingWords` jako jedna spojna cecha, zamiast dwoch niepowiazanych
   * pol o identycznej nazwie i innym znaczeniu.
   */
  trailingWordsStopBefore: z.string().optional(),
});

/** `sectionList` — naglowek sekcji (regex) + lista pozycji dopasowanych `itemPattern`. */
const sectionListPatternSchema = z.object({
  kind: z.literal('sectionList'),
  sectionHeader: z.string(),
  // [KROK-34, zmierzony na zywo blad, "Wrak.pdf"] Pusty `itemPattern` kompiluje
  // sie do `new RegExp('', 'gu')` — dopasowuje PUSTY string na KAZDEJ pozycji
  // bufora, wiec `matchSectionList` zwraca setki pozycji bez ZADNEJ grupy
  // (`groups: {}`), a `name` kazdej z nich to pusta wartosc, ktora Foundry
  // (`StringField`, `blank:false`) zamienia na `undefined` przy walidacji —
  // "name: may not be undefined" przy tworzeniu Item-u, ZAMIAST czytelnego
  // bledu profilu w momencie wczytania. Wymaganie niepustego wzorca tutaj
  // (A7 — degraduj przy wczytaniu profilu, nie awaryjnie glęboko w Foundry)
  // przenosi ten sam blad w miejsce, gdzie autor moze go naprawic.
  itemPattern: z.string().min(1, 'itemPattern must not be empty'),
  /** [S1] Opis bywa rozbity dywizacja na kilka tokenow — sklej przed dopasowaniem. */
  rejoinHyphenated: z.boolean().optional().default(false),
  /**
   * [KROK-19 Z1, naprawiony blad] Naglowek KOLUMNY tabeli (np. polskie "%
   * obrażenia" w ksiazkach CoC7-PL) bezposrednio PO naglowku sekcji, PRZED
   * pierwsza prawdziwa pozycja — zmierzone wprost: bez pominiecia tego
   * naglowka, lapczywa grupa nazwy w `itemPattern` polykala go razem z
   * pierwsza prawdziwa nazwa ("obrażenia Przyssanie" zamiast "Przyssanie").
   * Wykluczanie tego z samego `itemPattern` (negatywny lookahead) okazalo sie
   * kruche — dziala tylko na POCZATKU dopasowania, nie wewnatrz rozrastajacej
   * sie lapczywej grupy. Zamiast tego: jesli tekst BEZPOSREDNIO po naglowku
   * sekcji pasuje do tego wzorca, pomin go calkowicie PRZED zbudowaniem
   * bufora pozycji.
   */
  skipAfterHeader: z.string().optional(),
  /**
   * [KROK-19 Z4, zmierzony na realnej ksiazce blad] Bufor pozycji sekcji
   * (miedzy jej naglowkiem a NASTEPNYM wystapieniem `sectionHeader` albo
   * koncem strumienia tokenow) nie mial ZADNEGO ograniczenia dla OSTATNIEJ
   * sekcji na stronie — gdy po niej nie ma juz kolejnego "ATAKI", bufor lecial
   * az do konca strony, lapiac tresc zupelnie innej postaci (np. liste
   * umiejetnosci "Historia 75%, Okultyzm 60%..." nastepujaca PO opisie ataku,
   * fałszywie rozpoznana jako kolejne pozycje ataku). Jesli podany, kazdy
   * token dopasowany do tego wzorca PRZERYWA budowanie bufora (token NIE jest
   * juz konsumowany) — profilowy odpowiednik "tu konczy sie ta sekcja",
   * niezalezny od obecnosci kolejnego naglowka `sectionHeader`. W tej ksiazce
   * dziala jako "dowolny samodzielny token wygladajacy jak Naglowek:"
   * (`^\p{Lu}[\p{L} ]*:$`, np. "Umiejętności:", "Utrata Poczytalności:").
   *
   * [KROK-27 Z2, zmiana nazwy] Dawne `stopBeforeToken` — nazwa nie mowila nic
   * o ZASIEGU (konczy CALA SEKCJE, nie pojedyncza pozycje), co mylilo kolejne
   * sesje (brief kroku 26, jego wlasny raport, posrednio tez analiza w kroku
   * 20 — patrz RAPORT-KROK-27.md). Odpowiedz na "jak ograniczyc POJEDYNCZA
   * pozycje" jest w `itemPattern`, przez lookahead rozpoznajacy granice
   * kolejnej pozycji (naprawa str. 56 z kroku 26) — INNY mechanizm niz to
   * pole, celowo, patrz `docs/writing-profiles.md`.
   */
  terminateSectionBefore: z.string().optional(),
  /**
   * [KROK-40, zgloszenie na zywo] Slowa/frazy (dowolny jezyk ksiazki), po
   * ktorych rozpoznajemy, ze pozycja listy jest broni DYSTANSOWA (np. polskie
   * "Broń Palna") — case-insensitive dopasowanie jako PODCIAG grupy `name`
   * dopasowanej pozycji. Adapter systemowy (np. CoC7) interpretuje obecnosc
   * takiego dopasowania jako flage `ranged` w `CIFAttack.properties`, NIGDY
   * odwrotnie zaszyte w silniku/adapterze (R2 — jezykowy slownik to tresc
   * profilu, nie logika silnika). Celowo ODDZIELONE od `itemPattern`: gdyby
   * to byla dodatkowa grupa regexu wewnatrz `itemPattern`, kazde ponowne
   * "Zacznij od nowa" + klikniecie przykladow w Profile Studio (patrz
   * `inferItemPatternFromExamples.ts`) nadpisywaloby ja bez sladu — to samo
   * ryzyko trwalosci, ktore juz raz doprowadzilo do bledu "pistolet .22
   * znika" (patrz `NAME_CLASS` w `inferItemPatternFromExamples.ts`). To pole
   * NIE jest wywnioskowywane z klikania przykladow — autor wpisuje je wprost
   * (Profile Studio, "Zaawansowane") i przetrwa kazda regeneracje
   * `itemPattern`. Puste domyslnie — wstecznie zgodne, wszystkie pozycje
   * traktowane jak dotad (nigdy `ranged`).
   */
  rangedKeywords: z.array(z.string()).optional().default([]),
});

/** `fontRoleCandidate` — kandydat na nazwe encji: krotki tekst o roli fontu != wykluczonych (S3, filtr WEJSCIOWY do parowania geometrycznego, nie samodzielne rozstrzygniecie). */
const fontRoleCandidatePatternSchema = z.object({
  kind: z.literal('fontRoleCandidate'),
  excludeRoles: z.array(z.string()).optional().default(['body']),
  maxLength: z.number().int().positive().optional().default(60),
  excludeRepeatedAcrossPages: z.boolean().optional().default(true),
  excludeHyphenContinuations: z.boolean().optional().default(true),
  /**
   * [KROK-29 Z3] Klucz(e) fontu (`ProfileToken.fontKey`, patrz `types.ts`)
   * wyuczone z klikniecia w Profile Studio, zakladka "Nazwa" — DODATKOWY
   * warunek DO (nie zamiast) `excludeRoles`: gdy niepuste, token musi miec
   * `fontKey` NALEZACY do tego zbioru, zeby zostac kandydatem. Zawezenie
   * O RZAD WIELKOSCI dla precyzji samej roli fontu (H2 kroku 12: sama rola
   * "!= body" daje 2401 kandydatow na 15 encji w polskiej ksiazce — rola to
   * RANKING czestosci/rozmiaru per DOKUMENT, obejmujacy WIELE roznych
   * krojow, nie identyfikator KONKRETNEGO kroju uzywanego akurat na nazwy).
   * Opcjonalne i puste domyslnie — WSTECZNIE ZGODNE: brak = zachowanie
   * identyczne jak przed KROK-29 (oba istniejace profile CoC7 dzialaja dalej
   * bez zmian, brief kroku wprost tego wymaga).
   */
  requireFontKeys: z.array(z.string()).optional().default([]),
});

/**
 * [KROK-34 Z2] "Notatki wskazywane w PDF-ie" — blok prozy dolaczany
 * GEOMETRYCZNIE do kotwicy encji, nie przez dopasowanie tekstu (opisy
 * stworow/taktyka lezace w prozie kolo statbloku nie maja zadnego wspolnego
 * naglowka/regexu do zlapania — w odroznieniu od `labelledPairs`/`sectionList`,
 * ktore ZAWSZE maja jakis tekstowy marker). Zgodnie z R2 ("profil niesie
 * instrukcje parsowania, nigdy tresc") — `offset` to WYLACZNIE polozenie
 * WZGLEDEM KONCA WLASNEJ TRESCI TEJ ENCJI (ostatni token siatki/pochodnych/
 * atakow/umiejetnosci — `proseBlock.ts`'s `lastClaimedTokenBbox`, NIE
 * poczatku kotwicy — zmierzony na zywo blad pokazal, ze stala odleglosc OD
 * KOTWICY zalamuje sie, gdy rozne encje maja rozne dlugosci wlasnej tresci),
 * zmierzone RAZ przez autora profilu (Studio, "Zmierz") na jednym przykladzie,
 * NIGDY literalny tekst PDF-a. Rzeczywisty ZASIEG bloku (jak daleko w dol siega) NIE
 * jest przechowywany jako stala wysokosc — liczony w locie przy dopasowaniu, a
 * zatrzymywany na granicy encji/kolumny (`hardStopTokenIndices`/`columnBand`,
 * kroki 29-31, patrz `proseBlock.ts`), zgodnie z "Zabezpieczenia" briefu.
 */
const proseBlockPatternSchema = z.object({
  kind: z.literal('proseBlock'),
  /** Etykieta W WYNIKOWEJ notatce (np. "Opis", "Taktyka") — tekst jezyka swiata dopisywany przy skladaniu notatki, NIE szukany w PDF-ie. */
  label: z.string().min(1),
  offset: z.object({
    /** Przesuniecie X od `anchor.bbox.minX` do lewej krawedzi przykladu. */
    dxPt: z.number(),
    /** Przesuniecie Y od `anchor.bbox.minY` do GORNEJ krawedzi przykladu (PDF: wieksze Y = wyzej na stronie). */
    dyPt: z.number(),
  }),
  /** [Zaawansowane] Twardy limit dlugosci pojedynczego bloku — degradacja (przyciecie) zamiast bez ograniczen, gdyby granica encji/kolumny zawiodla na nietypowym ukladzie. */
  maxLengthChars: z.number().int().positive().optional().default(2000),
  /** Promien tolerancji (pt) wokol wyliczonego punktu startowego, w ktorym szukany jest najblizszy token — jak `maxDistancePt` reszty silnika. */
  searchRadiusPt: z.number().positive().optional().default(60),
  /**
   * [ZGŁOSZENIE na zywo po Kroku 39, "Wrak.pdf" Badacze] Domyslnie (`false`/
   * brak) `offset` liczy sie WZGLEDEM TEGO SAMEGO stalego punktu co reszta
   * pol (koniec siatki cech/pochodnych/atakow/umiejetnosci) — dziala
   * doskonale, gdy pola notatek maja STALA pozycje (typowy uklad: siatka,
   * potem zawsze te same pola w tych samych miejscach). Zawodzi jednak, gdy
   * pola notatek sa UKLADANE JEDNO POD DRUGIM ZE ZMIENNA DLUGOSCIA miedzy
   * nimi (np. dluzsza biografia jednej postaci przesuwa WSZYSTKIE kolejne
   * pola nizej niz u innej postaci o krotszej biografii) — zmierzone wprost:
   * na 6 stronach Badaczy tej ksiazki pozycja "Wygląd" wzgledem stalego
   * punktu wahala sie o ponad 70pt, znacznie ponad `searchRadiusPt`. `true`
   * liczy `offset` zamiast tego WZGLEDEM KONCA POPRZEDNIEJ notatki na liscie
   * `notesPatterns` (pierwsza notatka na liscie zawsze uzywa stalego punktu,
   * bo nie ma poprzedniczki) — stabilne niezaleznie od dlugosci tekstu
   * powyzej, pod warunkiem ze `notesPatterns` sa w tej samej kolejnosci, w
   * jakiej pola faktycznie wystepuja na stronie. Domyslnie wylaczone —
   * dodatkowe, wsteczna-zgodne pole (istniejace profile, ktore juz dzialaja
   * ze stalym punktem, nie zmieniaja zachowania).
   */
  chainFromPrevious: z.boolean().optional().default(false),
  /**
   * [ZGŁOSZENIE na zywo, "Wrak.pdf" Badacze — "zaznaczam tylko te dwa, a do
   * nich wpisywane są wszystkie informacje z tych akapitów"] Domyslnie
   * (`false`) zbieranie zatrzymuje sie na PIERWSZYM kolejnym tokenie roli
   * `accent` zakonczonym dwukropkiem — dziala dobrze, gdy notatka ma lapac
   * WYLACZNIE tresc do najblizszego PODnaglowka. Ale gdy autor chce, zeby
   * JEDEN klik (np. "Historia Badacza", zawsze uzywajacy WIEKSZEGO stylu
   * `heading`, 11pt w tej ksiazce, w odroznieniu od mniejszych `accent`
   * podnaglowkow typu "Wygląd:"/"Przymioty:") zlapal WSZYSTKO az do
   * NASTEPNEGO naglowka TEGO SAMEGO stylu (tu: "Twoi przyjaciele:", tez
   * `heading`) — pomijajac PO DRODZE dowolna liczbe mniejszych podnaglowkow
   * — `true` porownuje rolem fontu STOPUJACEGO tokenu do roli WLASNEGO
   * tokenu startowego (klikniętego przykladu), zamiast na sztywno do
   * `accent`. Dwukropek na koncu wciaz wymagany (ten sam sygnal co domyslnie
   * — realne podnaglowki w tej ksiazce ZAWSZE go maja, patrz komentarz przy
   * silniku w `proseBlock.ts`).
   */
  stopAtSameFontRole: z.boolean().optional().default(false),
  /**
   * [ZGŁOSZENIE na zywo, "Wrak.pdf" Badacze, "Twoi przyjaciele" w prawej
   * kolumnie] Domyslnie (`false`) `offset` (gdy `chainFromPrevious` jest
   * wylaczone) liczy sie wzgledem konca CALEJ WLASNEJ tresci encji (siatka +
   * pochodne + ATAKI + Umiejetnosci) — poprawne zalozenie, gdy notatka lezy
   * PONIZEJ tej tresci w TEJ SAMEJ kolumnie. Zawodzi jednak dla notatki w
   * OSOBNEJ kolumnie, niezaleznej od dlugosci listy Umiejetnosci — zmierzone
   * wprost: pozycja "Twoi przyjaciele:" wzgledem stalego punktu wlacznie z
   * Umiejetnosciami wahala sie o >70pt miedzy 6 postaciami (rozna liczba
   * umiejetnosci = inna dlugosc listy = inny koniec), ale wzgledem SAMEJ
   * siatki cech (bez atakow/umiejetnosci) jest stabilna (+/-12pt). `true`
   * liczy `offset` wylacznie wzgledem konca siatki-kotwicy, ignorujac
   * ataki/umiejetnosci przy wyznaczaniu punktu odniesienia.
   */
  anchorGridOnly: z.boolean().optional().default(false),
});

const patternSchema = z.discriminatedUnion('kind', [labelledPairsPatternSchema, sectionListPatternSchema, fontRoleCandidatePatternSchema, proseBlockPatternSchema]);

const attachRuleSchema = z.object({
  /** Id wzorca z `patterns` (nie literal — dowolny klucz zdefiniowany przez autora profilu). */
  pattern: z.string(),
  /**
   * [KROK-18 Z7, `nearest` dopisane po pomiarze na calej ksiazce] MDD §5.5
   * definiuje tylko `nearestBelow`/`nearestAbove` (uklad pionowy: nazwa nad
   * siatka, pochodne pod siatka). Zmierzone wprost na `Zew_Cthulhu_Nie_czas_
   * na_krzyk_v1_0.pdf`: strony z wieloma postaciami ("Kawalki" i inne) ukladaja
   * siatke i jej blok pochodnych OBOK SIEBIE w tej samej linii (kolumny), nie
   * jedna pod druga — `nearestBelow` nigdy nie znajduje kandydata, niezaleznie
   * od `maxDistancePt`, bo warunek kierunkowy nigdy nie jest spelniony. `nearest`
   * to ten sam mechanizm bez wymogu kierunku — sam dystans euklidesowy miedzy
   * bboksami. Autor profilu wybiera strategie per wzorzec/publikacje, silnik
   * nie zgaduje sam ukladu strony.
   */
  strategy: z.enum(['nearestBelow', 'nearestAbove', 'nearest']),
  maxDistancePt: z.number().positive(),
  /** [S3] Nazwa i podtytul stoja blisko w tym samym kroju — preferuj WCZESNIEJSZEGO (nad/przed) sasiada w bliskiej odleglosci pionowej. */
  preferEarlierSibling: z
    .object({
      maxDeltaYPt: z.number().positive(),
    })
    .optional(),
});

const entityAssemblySchema = z.object({
  anchor: z.string(),
  attach: z.array(attachRuleSchema).optional().default([]),
  /** [S4] Ponizej progu NIE zgaduj nazwy — placeholder + kandydaci w przegladzie. Bledna nazwa gorsza niz jej brak. */
  nameConfidenceThreshold: z.number().min(0).max(1),
  namePlaceholder: z.string(),
  /** [S1] Statblock potrafi przechodzic przez granice stron. */
  allowCrossPage: z.boolean().optional().default(false),
  /**
   * [KROK-20 Z2b] Id wzorca (klucz `patterns`, musi byc `sectionList`, musi
   * miec odpowiadajacy wpis w `attach`) do wypelnienia `CIFActor.skills` —
   * lista umiejetnosci ogolnych statbloku ("Umiejętności: Historia 75%,
   * Okultyzm 60%..."), oddzielna od sekcji ATAKI. Opcjonalne i JAWNE
   * (nie zgadywane po `kind`), bo profil moze miec WIECEJ NIZ JEDEN wzorzec
   * `sectionList` (ATAKI + Umiejetnosci) — bez jawnego wskazania silnik nie
   * ma jak odroznic, ktory jest ktorym (`kind` sam w sobie nie wystarcza,
   * gdy jest ich dwa). Brak tego pola = zachowanie identyczne jak przed
   * KROK-20 Z2b (jedyny `sectionList` w `attach` to zawsze ataki).
   */
  skillsPattern: z.string().optional(),
  /**
   * [ZGŁOSZENIE po kroku 30, "Rozdzielenie nazwy od typu/zawodu"] Id wzorca
   * (klucz `patterns`, musi byc `fontRoleCandidate`, musi miec odpowiadajacy
   * wpis w `attach`) do wypelnienia `CIFActor.typeLabel` — swobodna etykieta
   * zawodu/typu z podrecznika ("kapitan jachtu", "Cultist", "Ghoul"), ODDZIELNA
   * od nazwy encji. Ten sam powod istnienia co `skillsPattern` wyzej: profil
   * moze miec DWA wzorce `fontRoleCandidate` (nazwa + zawod/typ) — bez jawnego
   * wskazania silnik nie ma jak odroznic, ktory jest ktorym. Brak tego pola =
   * zachowanie identyczne jak przed tym zgloszeniem (jedyny `fontRoleCandidate`
   * w `attach` to zawsze nazwa, `typeLabel` nigdy nie jest wypelniane).
   */
  typeLabelPattern: z.string().optional(),
  /**
   * [KROK-34 Z2] Id-ki wzorcow `proseBlock` ("Notatki wskazywane w PDF-ie") do
   * wypelnienia `CIFActor.notes` — kazdy dolaczany do kotwicy NIEZALEZNIE,
   * WLASNYM `offset`-em (nie przez `attach`, w odroznieniu od reszty pol: sam
   * `offset` JEST kompletna instrukcja geometrycznego dopasowania, nie ma
   * osobnej listy "kandydatow" do parowania strategia/maxDistancePt jak przy
   * labelledPairs/sectionList/fontRoleCandidate). Kilka id-kow = kilka
   * niezaleznie oznakowanych blokow w notatce koncowej (np. "Opis"/"Taktyka"),
   * rozdzielonych, nie sklejonych. Puste domyslnie — brak = zachowanie
   * identyczne jak przed tym krokiem (`CIFActor.notes` zawsze `[]`).
   */
  notesPatterns: z.array(z.string()).optional().default([]),
});

const imageAssociationSchema = z.object({
  associateWithEntity: z
    .object({
      strategy: z.enum(['nearest']),
      searchDirection: z.array(z.enum(['above', 'below', 'left', 'right'])).min(1),
      sameColumnOnly: z.boolean().optional().default(false),
      maxDistancePt: z.number().positive(),
    })
    .optional(),
  /**
   * [na zyczenie uzytkownika, ksiazka z bespoke tlem na kazdej stronie]
   * Domyslnie `Z1-full-bleed-background`/`Z9-high-body-text-coverage`
   * (`classify.ts`) traktuja obraz pod spadem drukarskim z gestym tekstem NA
   * WIERZCHU jako dekoracje — kalibrowane na 95.7% precyzji na zestawie
   * referencyjnym (nie w tym repo), gdzie taki uklad
   * niemal zawsze oznacza powtarzalna teksture tla. Niektore publikacje (np.
   * Wrak, kazda strona z unikalna ilustracja pod spadem) lamia to zalozenie —
   * ta flaga pozwala per-profil ZREZYGNOWAC z obu regul dekoracji dla
   * obrazow pod pelnym spadem, bez zmiany globalnie skalibrowanej heurystyki
   * dla innych ksiazek. Domyslnie wylaczone (zachowanie bez zmian).
   */
  treatFullBleedAsContent: z.boolean().optional().default(false),
  /**
   * [na zyczenie uzytkownika, EKSPERYMENTALNE] Dla obrazow ujawnionych przez
   * `treatFullBleedAsContent` (`Z1-full-bleed-forced-content` w classify.ts),
   * probuje wykryc i przyciac PUSTY, jednolity margines wokol faktycznej
   * ilustracji analizujac PIKSELE juz zdekodowanego obrazu — patrz
   * `images/cropUniformMargins.ts` po pelne uzasadnienie i znane ograniczenia
   * (to heurystyka, nie parsowanie struktury PDF-a; strony wypelnione trescia
   * niemal do krawedzi celowo NIE zostana przyciete). Bez znaczenia, gdy
   * `treatFullBleedAsContent` jest wylaczone. Domyslnie wylaczone.
   */
  autoCropUniformMargins: z.boolean().optional().default(false),
  /**
   * [na zyczenie uzytkownika, po naprawie przyciecia "Wrak"] Przyciete
   * obrazy (`autoCropUniformMargins`) tracą sąsiedztwo jasnego marginesu
   * strony, ktory w PDF-ie optycznie je rozjasnial (efekt kontrastu, nie
   * blad dekodowania — pixel-w-piksel zgodnosc ze zrodlem zmierzona wprost,
   * patrz `brightenImage.ts`). Ta flaga to SWIADOME, kosmetyczne odejscie od
   * wiernosci pikseli — stad osobny, jawny przelacznik zamiast domyslnego
   * zachowania. Bez znaczenia, gdy `autoCropUniformMargins` jest wylaczone
   * albo dany obraz nie zostal faktycznie przyciety. Domyslnie wylaczone.
   */
  brightenAutoCroppedImages: z.boolean().optional().default(false),
  /**
   * [KROK-42 Z1] Wartosc startowa przelacznika "usun tlo" w panelu
   * przygotowania tokenu (`TokenPrepApp`, `packages/module`) dla obrazow z
   * TEGO profilu — WYLACZNIE ustawia poczatkowy stan kontrolki w panelu,
   * uzytkownik moze go zmienic per-obraz przed zatwierdzeniem. Nie wplywa na
   * `buildImageExtraction.ts` (ekstrakcja/klasyfikacja obrazow bez zmian) —
   * usuwanie tla dzieje sie WYLACZNIE w panelu, w momencie recznego
   * przygotowania tokenu, nigdy automatycznie/w tle. Domyslnie wylaczone.
   */
  removeTokenBackgroundDefault: z.boolean().optional().default(false),
});

/**
 * [KROK-39 Z2] Zestaw wzorcow + reguly skladania encji dla JEDNEJ trasy
 * importu (`PageRoute`, `pageRoute.ts`) — dokladnie to, co profil mial na
 * poziomie root od kroku 18 (`patterns`/`entityAssembly`), teraz wydzielone,
 * zeby ta SAMA struktura mogla wystapic DRUGI RAZ dla trasy `playerCharacter`
 * (patrz `playerCharacter` na `profileV2Schema` nizej).
 */
const patternSetSchema = z.object({
  patterns: z.record(z.string(), patternSchema).refine((v) => Object.keys(v).length > 0, 'patterns must not be empty'),
  entityAssembly: entityAssemblySchema,
});

export const profileV2Schema = z.object({
  schemaVersion: z.literal(2),
  id: z.string().min(1),
  /** Edycja OBOWIAZKOWO w identyfikatorze linii wydawniczej (np. "coc7"). */
  gameLine: z.string().min(1),
  language: z.string().min(2),
  title: z.string().min(1),
  /** [S2] Profil celuje w KONKRETNA publikacje, nie cala linie wydawnicza. */
  publication: z.string().min(1),
  author: z.string().optional(),
  license: z.string().optional(),
  provides: z.array(z.enum(['actors', 'scenes', 'images', 'journals'])).min(1),
  fingerprint: fingerprintSchema,
  pages: pagesSchema,
  /** Wzorce dla trasy `npc` (`pageRoute.ts`) — nazwa pol bez zmian od kroku 18, wsteczna zgodnosc z KAZDYM istniejacym profilem. */
  patterns: patternSetSchema.shape.patterns,
  entityAssembly: patternSetSchema.shape.entityAssembly,
  images: imageAssociationSchema.optional(),
  /**
   * [KROK-39 Z2] Druga, OPCJONALNA sekcja wzorcow — trasa `playerCharacter`
   * (gotowi do gry Badacze, `pageRoute.ts`). Struktura identyczna jak
   * `patterns`/`entityAssembly` powyzej — te same rodzaje wzorcow, ten sam
   * ksztalt `entityAssembly` — CELOWO NIE aliasy/wspolne etykiety z trasa
   * `npc`: ta sama ksiazka moze uzywac `WG` u NPC-ow i `WYG` u Badaczy (krok
   * 38, odkrycie #1), a uklad kart (siatka+pochodne osobno vs. siatka+
   * Poczytalnosc+PW w jednym wierszu, lista umiejetnosci po przecinku vs.
   * jeden skill na wiersz) rozni sie bardziej niz jedna etykieta — jeden
   * wzorzec z aliasami ryzykowalby zlapanie etykiety NPC-a przez kartę gracza
   * i odwrotnie. Brak tej sekcji = trasa `playerCharacter` nieobslugiwana =
   * strony tej trasy pomijane (z `Diagnostic`, `buildActorsForDocument.ts`) —
   * KAZDY istniejacy profil (bez tego pola) zachowuje sie DOKLADNIE jak przed
   * tym krokiem, bez zadnej flagi.
   */
  playerCharacter: patternSetSchema.optional(),
});

export type ProfileV2 = z.infer<typeof profileV2Schema>;
export type PatternSet = z.infer<typeof patternSetSchema>;
export type LabelledPairsPattern = z.infer<typeof labelledPairsPatternSchema>;
export type SectionListPattern = z.infer<typeof sectionListPatternSchema>;
export type FontRoleCandidatePattern = z.infer<typeof fontRoleCandidatePatternSchema>;
export type ProseBlockPattern = z.infer<typeof proseBlockPatternSchema>;
export type PatternDef = z.infer<typeof patternSchema>;

export interface ProfileValidationOk {
  ok: true;
  profile: ProfileV2;
}
export interface ProfileValidationFailed {
  ok: false;
  /** Czytelne bledy walidacji (sciezka pola + komunikat) — NIGDY wyjatek (DoD kroku 18 Z2). */
  issues: string[];
}

/** Waliduje niezaufany JSON jako profil v2. Nigdy nie rzuca — zly profil = `ok: false` + czytelne bledy. */
export function validateProfile(input: unknown): ProfileValidationOk | ProfileValidationFailed {
  const result = profileV2Schema.safeParse(input);
  if (result.success) return { ok: true, profile: result.data };
  const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  return { ok: false, issues };
}

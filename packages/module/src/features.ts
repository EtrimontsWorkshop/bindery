/**
 * [KROK-44 Z1, "wersja publiczna — pierwsze wydanie obejmuje wylacznie
 * obrazy"] Jedna flaga, nie rozsiane warunki — decyzja produktowa: statbloki,
 * Profile Studio i trasa `playerCharacter` zostaja w wersji roboczej (dzialaja,
 * ale wymagaja profilu, ktorego dla podrecznikow komercyjnych nie
 * dostarczamy — R3). Wariant B (ukrycie za flaga, NIE usuniecie kodu) — ten
 * sam wzorzec co `provides` w kroku 37: usuniecie kodu rozjechaloby galezie
 * natychmiast, a pusta zakladka Aktorzy uczy uzytkownika, ze interfejs klamie.
 *
 * Kod/schemat/adapter/silnik wzorcow i trasy pozostaja NIETKNIETE — ta flaga
 * steruje WYLACZNIE widocznoscia w interfejsie: wejscie do Profile Studio
 * (`settings.ts`), sekcja wczytywania profilu aktorow (`ImportWizard.ts`),
 * zakladka Aktorzy w ekranie przegladu (`ReviewScreen.ts`). Wszystko inne
 * (foldery/liczniki aktorow w ekranie celu) juz samo degraduje sie do zera,
 * bo `actorCount`/`hasActorProfile` i tak zawsze wychodza puste/false, gdy
 * profilu nigdy nie da sie wczytac przez UI — zero dodatkowych warunkow tam.
 *
 * WARUNEK PRZYWROCENIA: profile dla podrecznikow komercyjnych dostarczane
 * przez spolecznosc (R3 pozwala na to — community-hosted, nigdy linkowane z
 * tego repo) ALBO wbudowany profil dla tresci darmowej (np.
 * `coc7-quickstart-en.json`, juz istnieje). Gdy jeden z tych warunkow sie
 * spelni, przywrocenie to jedna zmiana wartosci ponizej na `true`.
 */
export const STATBLOCKS_ENABLED = false;

import type { Rect } from '../geometry.js';
import type { SemanticBlock } from '../semantic/blockBuilder.js';

/**
 * Konwersja `SemanticBlock[]` (juz w kolejnosci czytania) na HTML strony
 * journala (KROK-9 Z5, MDD faza 8). Tabela mapowania wprost z brief
 * `KROK-9-journale.md`. Sanityzacja OBOWIAZKOWA — trescia sterowana jest tu
 * WYLACZNIE struktura (ktore tagi), a CALY tekst (pochodzacy z pliku
 * uzytkownika) jest escape'owany przed wstawieniem — nigdy nie parsujemy ani
 * nie przepuszczamy zadnego surowego HTML z zewnatrz, wiec pelny sanitizer
 * (np. DOMPurify, wymaga DOM/jsdom) jest niepotrzebny: same konstruujemy
 * KAZDY tag, tekst jest ZAWSZE tylko zawartoscia, nigdy struktura.
 */

/** Ucieka znaki specjalne HTML — jedyna linia obrony, bo CALA struktura tagow jest nasza wlasna, nigdy z wejscia uzytkownika. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export interface EmbeddedImageForHtml {
  /** `CIFImage.id`. */
  id: string;
  /** Sciezka/URL obrazu do atrybutu `src` — placeholder wypelniany dopiero po wgraniu (warstwa Foundry), tutaj tylko wstawiony, nie interpretowany. */
  assetRef: string;
  pageNumber: number;
  bbox: Rect;
  caption?: string;
}

function joinLines(text: string): string {
  return text.replace(/\n/g, ' ').trim();
}

/**
 * [KROK-9, kontrola zywa w Foundry; potwierdzone/utrzymane w KROK-11] Ponizej
 * tej dlugosci (znaki, po przycieciu) blok `heading` NIE dostaje wlasnego
 * <h#> — renderowany jako zwykly <p>. Zabezpieczenie CZESCIOWE: lapie
 * pojedyncze/podwojne znaki ("m", "mn", "h").
 *
 * [KROK-11, Z1] Dluzsze zlepki (np. Za_lini_wroga str. 24/68 "Operacja Straz
 * Przednia"+"Poziom trudnosci...", Wrath & Glory "drocZEniE buntu") maja
 * TERAZ realne, dedykowane zrodlo naprawy — `layout/lineEdgeSplit.ts` (Z1),
 * ktory rozcina linie z etykieta na BRZEGU (poczatku lub koncu) — wiec
 * niniejszy prog dlugosci JUZ NIE jest jedyna linia obrony dla tej klasy.
 * NIE obnizone/usuniete: kontrola na `Cienie_posrod_mgie.pdf` str. 20
 * ("DOM MLOTOW", "DOSKONALI DOSTAWCY") pokazala, ze cz. tych zlepkow ma
 * GLEBSZA przyczyne, ktorej Z1 celowo nie rusza (etykieta w PRAWDZIWYM
 * SRODKU tablicy `runs`, otoczona ta sama rodzina fontu z obu stron —
 * wynik scalenia kilku fizycznych linii/kolumn w jedna przez wczesniejszy
 * etap klastrowania, nie prosty przypadek brzegowy) — patrz komentarz w
 * `lineEdgeSplit.ts` i RAPORT-KROK-11.md. Dopoki TA klasa bledu nie ma
 * wlasnej naprawy u zrodla, prog dlugosci zostaje jako siatka bezpieczenstwa.
 * Swiadomy, czesciowy kompromis (ryzyko: realny bardzo krotki tytul, np. "I"
 * czy "A", tez trafi do zwyklego akapitu) — zaakceptowany przez uzytkownika po
 * zywej kontroli w Foundry (KROK-9), potwierdzony ponownie w KROK-11.
 */
const MIN_HEADING_TEXT_LENGTH = 3;

function figureHtml(img: EmbeddedImageForHtml): string {
  const caption = img.caption ? `<figcaption>${escapeHtml(img.caption)}</figcaption>` : '';
  return `<figure><img src="${escapeHtml(img.assetRef)}" alt="">${caption}</figure>`;
}

/** Jeden blok -> jeden fragment HTML, wg tabeli mapowania z brief. `header`/`footer` obsluzone PRZED wywolaniem (pomijane w tresci) — ta funkcja ich nie oczekuje. */
function blockToHtmlFragment(b: SemanticBlock): string {
  switch (b.kind) {
    case 'heading': {
      const text = joinLines(b.rawText);
      if (text.length < MIN_HEADING_TEXT_LENGTH) return `<p>${escapeHtml(text)}</p>`;
      const level = Math.min(6, Math.max(1, b.headingLevel ?? 2));
      return `<h${level}>${escapeHtml(text)}</h${level}>`;
    }
    case 'body':
      return `<p>${escapeHtml(joinLines(b.rawText))}</p>`;
    case 'sidebar':
      return `<aside class="bindery-sidebar">${escapeHtml(joinLines(b.rawText))}</aside>`;
    case 'caption':
      return `<figcaption>${escapeHtml(joinLines(b.rawText))}</figcaption>`;
    case 'table':
      // Zgrubna rekonstrukcja — jeden wiersz na linie zrodlowa, bez odtwarzania komorek (brief: poza zakresem).
      return `<table><tbody>${b.lines.map((l) => `<tr><td>${escapeHtml(l.text)}</td></tr>`).join('')}</tbody></table>`;
    case 'marginalia':
      return `<p>${escapeHtml(joinLines(b.rawText))}</p>`; // opakowane w <aside> zbiorczy przez wywolujacego (patrz blocksToHtml)
    case 'statblock':
    case 'unknown':
    default:
      // `statblock` poza MVP (v2.0, brief KROK-9 "czego NIE robic"), `unknown` to
      // to, co przetrwalo wszystkie reguly (Z1a) — oba dostaja bezpieczny fallback
      // zamiast zniknac (A3: nic nie ginie, nawet nierozpoznane trafia do tresci).
      return `<p class="bindery-${b.kind}">${escapeHtml(joinLines(b.rawText))}</p>`;
  }
}

/**
 * Buduje HTML jednej strony journala z jej blokow (juz w kolejnosci czytania,
 * moze obejmowac WIELE fizycznych stron PDF-a — `JournalPageDraft.blocks` z
 * `buildJournalHierarchy.ts`) + obrazy do osadzenia. Obraz miedzy dwoma
 * blokami w kolejnosci czytania (ta sama strona PDF-a, pozycja Y) trafia
 * MIEDZY odpowiadajace im fragmenty (brief: "wymaga tego wprost").
 * `header`/`footer` pomijane w tresci (ale ich `rawText` przetrwal osobno w
 * `CIFJournalPage.rawText`, budowanym przez wywolujacego z PELNEJ listy
 * blokow — A3). `marginalia` zbierane do jednego `<aside>` na KONCU strony
 * (brief: "nie wplecione w tok").
 */
export function blocksToHtml(blocks: readonly SemanticBlock[], images: readonly EmbeddedImageForHtml[]): { html: string; imageRefs: string[] } {
  const imagesByPage = new Map<number, EmbeddedImageForHtml[]>();
  for (const img of images) {
    const arr = imagesByPage.get(img.pageNumber) ?? [];
    arr.push(img);
    imagesByPage.set(img.pageNumber, arr);
  }

  // Bloki juz posortowane strona-rosnaco + kolejnosc czytania wewnatrz strony
  // (`buildPageLayouts`) — grupujemy w przebiegi PO STRONIE zachowujac tę
  // kolejnosc, zeby polaczyc kazda strone z JEJ WLASNYMI obrazami.
  const pageGroups: { pageNumber: number; blocks: SemanticBlock[] }[] = [];
  for (const b of blocks) {
    const last = pageGroups[pageGroups.length - 1];
    if (last && last.pageNumber === b.pageNumber) last.blocks.push(b);
    else pageGroups.push({ pageNumber: b.pageNumber, blocks: [b] });
  }

  const parts: string[] = [];
  const marginaliaParts: string[] = [];
  const imageRefs: string[] = [];
  const usedImageIds = new Set<string>();

  type Entry = { y: number; kind: 'block'; block: SemanticBlock } | { y: number; kind: 'image'; image: EmbeddedImageForHtml };

  for (const group of pageGroups) {
    const pageImages = (imagesByPage.get(group.pageNumber) ?? []).filter((img) => !usedImageIds.has(img.id));
    const entries: Entry[] = [
      ...group.blocks.map((b): Entry => ({ y: b.bbox.maxY, kind: 'block', block: b })),
      ...pageImages.map((img): Entry => ({ y: img.bbox.maxY, kind: 'image', image: img })),
    ];
    // Y maleje w dol strony w ukladzie PDF — kolejnosc czytania (gora->dol) to malejace Y.
    entries.sort((a, b) => b.y - a.y);

    for (const entry of entries) {
      if (entry.kind === 'image') {
        usedImageIds.add(entry.image.id);
        imageRefs.push(entry.image.id);
        parts.push(figureHtml(entry.image));
        continue;
      }
      const b = entry.block;
      if (b.kind === 'header' || b.kind === 'footer') continue; // pomijane w tresci (rawText zachowany osobno)
      if (b.kind === 'marginalia') {
        marginaliaParts.push(blockToHtmlFragment(b));
        continue;
      }
      parts.push(blockToHtmlFragment(b));
    }
  }

  // Obrazy bez ZADNEGO bloku tekstowego na tej samej stronie (np. strona
  // czysto-graficzna) trafiaja na koniec — nie gubimy ich calkowicie (A3).
  for (const img of images) {
    if (usedImageIds.has(img.id)) continue;
    usedImageIds.add(img.id);
    imageRefs.push(img.id);
    parts.push(figureHtml(img));
  }

  if (marginaliaParts.length > 0) {
    parts.push(`<aside class="bindery-marginalia">${marginaliaParts.join('')}</aside>`);
  }

  return { html: parts.join('\n'), imageRefs };
}

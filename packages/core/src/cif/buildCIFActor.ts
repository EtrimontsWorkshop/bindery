import { unionRect, type Rect } from '../geometry.js';
import type { AssembledStatblock } from '../profiles/assembleStatblocks.js';
import type { CIFActor, CIFAttack, CIFNamedValue, CIFStat, Provenance } from './types.js';

/**
 * [KROK-18 Z6] `AssembledStatblock` (profiles/, wynik Z4) -> `CIFActor` (§5.3
 * MDD). Czysta transformacja ksztaltu — zero decyzji, ktorych Z1-Z4 juz nie
 * podjely (A9: tworzymy dokumenty, nie prezentujemy danych — ale TWORZENIE
 * dokumentu Foundry to `packages/module`, ten builder zostaje po stronie CIF,
 * neutralny wobec systemu, zgodnie z A1).
 *
 * [Zawezenie zakresu, doprecyzowane KROK-20 Z2b] `traits`/`equipment`/`spells`
 * NIE wypelniane — patrz komentarz przy `CIFActor` w `cif/types.ts`. `skills`
 * wypelniane WYLACZNIE gdy profil wskazuje `entityAssembly.skillsPattern`
 * (starsze profile bez tego pola dostaja `skills: []` jak dotychczas — pole
 * addytywne, nie zmienia zachowania niczego, co juz istnialo). `rawText`
 * sklada WSZYSTKIE dopasowane fragmenty (etykieta+wartosc siatki, pochodne,
 * surowy tekst atakow, surowy tekst umiejetnosci) w jeden czytelny string —
 * fundament A3 (nic nie ginie w ciszy), naslladuje dokladnie format uzyty w
 * spike'u H4 kroku 13 (`spike/statblocks2/h4-create-actors.js`, pole
 * `rawText`). Ten string zostaje w CIF (przeglad przed importem korzysta z
 * niego wprost — `notatki adaptera`, KROK-20 Z2) — ale adapter (`packages/
 * module/src/adapters/coc7.ts`) NIE kopiuje go juz calego do biografii
 * utworzonego Actora, zeby nie dublowac danych, ktore i tak trafiaja na karte
 * strukturalnie (cechy, ataki, umiejetnosci) — zmierzone na zywo jako czysty
 * szum, nie "nic nie ginie w ciszy" w praktyce.
 */

export interface BuildCIFActorInput {
  statblock: AssembledStatblock;
  page: number;
  /** Domyslnie `actor-p{page}-{ordinal}` — nadpisz gdy wolisz wlasne id (np. deterministyczne przez cala ksiazke). */
  id?: string;
}

function parseNumeric(raw: string): number | undefined {
  const trimmed = raw.trim();
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : undefined;
}

function statsFromGrid(grid: AssembledStatblock['grid']): { statistics: Record<string, CIFStat>; rawParts: string[] } {
  const statistics: Record<string, CIFStat> = {};
  const rawParts: string[] = [];
  for (const pair of grid.pairs) {
    statistics[pair.canonicalKey] = {
      raw: pair.value,
      numeric: parseNumeric(pair.value),
      unit: 'plain',
      sourceLabel: pair.label,
      confidence: 1,
      footnoteText: pair.footnoteText,
      descriptionText: pair.descriptionText,
    };
    rawParts.push(`${pair.label}${pair.value}`);
    if (pair.footnoteText) rawParts.push(pair.footnoteText);
    if (pair.descriptionText) rawParts.push(pair.descriptionText);
  }
  return { statistics, rawParts };
}

function attacksFrom(attacks: AssembledStatblock['attacks'], belowTexts: AssembledStatblock['attackBelowTexts']): { attacks: CIFAttack[]; rawParts: string[] } {
  if (!attacks) return { attacks: [], rawParts: [] };
  const result: CIFAttack[] = attacks.items.map((item, i) => ({
    name: (item.groups['name'] ?? '').trim(),
    toHit: item.groups['toHit'],
    damage: item.groups['damage']?.trim() || undefined,
    range: item.groups['range'],
    properties: item.ranged ? ['ranged'] : [],
    rawText: item.raw,
    belowText: belowTexts?.[i] ?? undefined,
  }));
  const rawParts = result.flatMap((a) => (a.belowText ? [a.rawText, a.belowText] : [a.rawText]));
  return { attacks: result, rawParts };
}

/** [KROK-20 Z2b] `AssembledStatblock.skills` (lista "Umiejętności: Historia 75%, ...") -> `CIFNamedValue[]`. Zwraca dopasowania takze jako `rawParts` (surowy tekst kazdej pozycji) do zlaczenia w `rawText` (A3), tak samo jak `attacksFrom`. */
function skillsFrom(skills: AssembledStatblock['skills']): { skills: CIFNamedValue[]; rawParts: string[] } {
  if (!skills) return { skills: [], rawParts: [] };
  const result: CIFNamedValue[] = skills.items.map((item) => ({
    name: (item.groups['name'] ?? '').trim(),
    value: (item.groups['value'] ?? '').trim(),
  }));
  return { skills: result, rawParts: skills.items.map((item) => item.raw) };
}

export function buildCIFActor(input: BuildCIFActorInput): CIFActor {
  const { statblock, page } = input;
  const id = input.id ?? `actor-p${page}-${statblock.ordinal}`;

  const { statistics: gridStats, rawParts: gridRaw } = statsFromGrid(statblock.grid);
  const { statistics: derivedStats, rawParts: derivedRaw } = statblock.derived ? statsFromGrid(statblock.derived) : { statistics: {}, rawParts: [] };
  const { attacks, rawParts: attackRaw } = attacksFrom(statblock.attacks, statblock.attackBelowTexts);
  const { skills, rawParts: skillsRaw } = skillsFrom(statblock.skills);

  const name = statblock.name.kind === 'confident' ? statblock.name.text : statblock.name.placeholder;
  const nameConfident = statblock.name.kind === 'confident';
  const nameCandidates = statblock.name.kind === 'placeholder' && statblock.name.candidates.length > 0 ? statblock.name.candidates : undefined;
  // [ZGŁOSZENIE po kroku 30] `typeLabel` istnialo w typach od kroku 18 (MDD
  // §5.3), ale nigdy nie mialo skad sie wziac — dopiero rozdzielenie nazwy od
  // zawodu/typu (osobny wzorzec `fontRoleCandidate`, `entityAssembly.
  // typeLabelPattern`) daje mu zrodlo. Dolaczone TEZ do `rawText` (A3, nic nie
  // ginie w ciszy) — ten sam wzorzec co reszta pol ponizej.
  const typeLabel = statblock.typeLabel ?? undefined;

  const bboxes: Rect[] = [statblock.grid.bbox];
  if (statblock.derived) bboxes.push(statblock.derived.bbox);
  for (const item of statblock.attacks?.items ?? []) bboxes.push(item.bbox);
  for (const item of statblock.skills?.items ?? []) bboxes.push(item.bbox);
  const bbox = bboxes.reduce((acc, b) => unionRect(acc, b));

  const provenance: Provenance = { pageNumber: page, bbox, blockIds: [] };

  return {
    id,
    name,
    nameConfident,
    nameCandidates,
    typeLabel,
    statistics: { ...gridStats, ...derivedStats },
    skills,
    attacks,
    traits: [],
    equipment: [],
    spells: [],
    imageRef: undefined,
    rawText: [...gridRaw, ...derivedRaw, ...attackRaw, ...skillsRaw, ...(typeLabel ? [typeLabel] : []), ...(statblock.notes ?? []).map((n) => n.text)].join(' '),
    provenance,
    unmapped: [],
    notes: statblock.notes,
    route: statblock.route,
  };
}

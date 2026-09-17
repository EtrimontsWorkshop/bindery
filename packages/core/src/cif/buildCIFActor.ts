import { unionRect, type Rect } from '../geometry.js';
import type { AssembledStatblock } from '../profiles/assembleStatblocks.js';
import type { CIFActor, CIFAttack, CIFNamedValue, CIFStat, Provenance } from './types.js';

/**
 * [Step 18 Z6] `AssembledStatblock` (profiles/, result of Z4) -> `CIFActor`
 * (MDD §5.3). A pure shape transformation — zero decisions that Z1-Z4
 * haven't already made (A9: we create documents, we don't present data —
 * but CREATING the Foundry document is `packages/module`'s job; this
 * builder stays on the CIF side, system-neutral, per A1).
 *
 * [Scope narrowing, clarified in Step 20 Z2b] `traits`/`equipment`/`spells`
 * are NOT populated — see the comment on `CIFActor` in `cif/types.ts`.
 * `skills` is populated ONLY when the profile specifies
 * `entityAssembly.skillsPattern` (older profiles without this field get
 * `skills: []` as before — an additive field, it does not change the
 * behavior of anything that already existed). `rawText` concatenates ALL
 * matched fragments (grid label+value, derived values, raw attack text, raw
 * skills text) into one readable string — the foundation of A3 (nothing is
 * lost silently), mirroring exactly the format used in the Step 13 H4
 * spike (`spike/statblocks2/h4-create-actors.js`, the `rawText` field).
 * This string stays in the CIF (the pre-import review uses it directly —
 * "adapter notes", Step 20 Z2) — but the adapter (`packages/
 * module/src/adapters/coc7.ts`) no longer copies all of it into the created
 * Actor's biography, to avoid duplicating data that ends up on the sheet
 * structurally anyway (traits, attacks, skills) — measured live as pure
 * noise, not "nothing is lost silently" in practice.
 */

export interface BuildCIFActorInput {
  statblock: AssembledStatblock;
  page: number;
  /** Defaults to `actor-p{page}-{ordinal}` — override if you prefer your own id (e.g. deterministic across the whole book). */
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

/** [Step 20 Z2b] `AssembledStatblock.skills` (a list "Skills: History 75%, ...") -> `CIFNamedValue[]`. Also returns matches as `rawParts` (raw text of each item) to be concatenated into `rawText` (A3), the same as `attacksFrom`. */
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
  // [ISSUE raised after Step 30] `typeLabel` existed in the types since
  // Step 18 (MDD §5.3), but never had a source to come from — only
  // separating the name from the occupation/type (a dedicated
  // `fontRoleCandidate` pattern, `entityAssembly.typeLabelPattern`) gives it
  // a source. Also included in `rawText` (A3, nothing is lost silently) —
  // the same pattern as the rest of the fields below.
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

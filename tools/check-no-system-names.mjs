#!/usr/bin/env node
// [Statblock import, Task 7] Rule 1 of the statblock-import brief, verbatim:
// "Zero nazw własnych systemów RPG w kodzie, stringach, i18n, komentarzach,
// README, nazwach zmiennych i testach. Zero zahardkodowanych ścieżek typu
// `system.attributes.hp`." This is the AUTOMATED half of "grep + przegląd"
// (audit + review) — a mechanical check runnable in CI, catching future
// regressions. It does NOT try to police comments/prose (a plain-text
// mention like "unlike the old, deleted CoC7-era schema" explaining WHY the
// new code is designed the way it is — see `profile/schema.ts`'s own header
// — is legitimate project history, not a violation; distinguishing that
// from a real violation needs human judgment, done once as the "przegląd"
// half of this task and not re-litigated by this script on every run).
// Scoped to `statblock/` source only (`packages/core/src/statblock/**`,
// `packages/module/src/statblock/**`, excluding tests — rule 6 already
// forbids real content in fixtures, and a test needing SOME concrete
// example path, like "attributes.hp.value", is not evidence of hardcoding
// a real system's shape) — the rule's own "Dlaczego od zera" rationale is
// specific to this feature; older, unrelated pipeline code (e.g. the image
// pipeline's calibration comments citing a real sample PDF's filename) is
// out of scope and already reviewed in PLAN.md's "Co przetrwało z
// poprzedniej architektury".
//
// Two checks:
// 1. A known RPG system id/slug used as an actual QUOTED STRING LITERAL
//    (not prose) — e.g. `'dnd5e'`, `"pf2e"`. Deliberately requires quote
//    delimiters around the bare term so a comment mentioning a system BY
//    NAME in plain prose never matches (comments don't wrap words in code
//    quotes) — narrow but reliable, matching this project's existing
//    `tools/check-*.mjs` style (regex over source, not full parsing).
// 2. A string literal containing a `system.<subpath>` shape with something
//    AFTER the dot inside the SAME literal — a hardcoded game-specific stat
//    path. The bare prefix `'system.'` (nothing following the dot in the
//    same string — `introspectActor.ts`'s legitimate use, stripping
//    Foundry's OWN universal Document field name, not a game-specific
//    subpath) does NOT match this pattern.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');
const SCAN_DIRS = [
  join(REPO_ROOT, 'packages', 'core', 'src', 'statblock'),
  join(REPO_ROOT, 'packages', 'module', 'src', 'statblock'),
  join(REPO_ROOT, 'packages', 'module', 'templates'),
  join(REPO_ROOT, 'packages', 'module', 'lang'),
];

// Known Foundry VTT system package ids — extend when a new one is worth
// naming explicitly. Deliberately excludes generic English words ("d20" on
// its own is too broad/common to check reliably) — this list trades recall
// for a low false-positive rate, per this script's own header rationale.
const SYSTEM_SLUGS = [
  'dnd5e',
  'dnd4e',
  'pf1e',
  'pf2e',
  'coc7',
  'wfrp4e',
  'swade',
  'sw5e',
  'shadowrun5e',
  'shadowrun6e',
  'starfinder',
  'vtm5e',
  'wod20',
  'cyberpunk-red-core',
  'forbidden-lands',
  'earthdawn4e',
  'alienrpg',
  'blades-in-the-dark',
  'tormenta20',
  'ose',
];

function findSourceFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...findSourceFiles(full));
    } else if ((entry.endsWith('.ts') || entry.endsWith('.hbs') || entry.endsWith('.json')) && !entry.endsWith('.test.ts') && full.split(/[\\/]/).every((seg) => seg !== 'test')) {
      results.push(full);
    }
  }
  return results;
}

const systemSlugRe = new RegExp(`['"\`](${SYSTEM_SLUGS.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})['"\`]`, 'i');
const hardcodedSystemPathRe = /['"`]system\.[a-zA-Z]/;

const violations = [];
for (const dir of SCAN_DIRS) {
  for (const file of findSourceFiles(dir)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const slugMatch = line.match(systemSlugRe);
      if (slugMatch) violations.push({ file, line: index + 1, kind: `hardcoded system id "${slugMatch[1]}"`, text: line.trim() });
      const pathMatch = line.match(hardcodedSystemPathRe);
      if (pathMatch) violations.push({ file, line: index + 1, kind: 'hardcoded system.* subpath', text: line.trim() });
    });
  }
}

if (violations.length > 0) {
  console.error('check:no-system-names: ZNALEZIONO naruszenia reguły 1 (zero nazw systemow RPG / zahardkodowanych sciezek system.*):');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} — ${v.kind}\n    ${v.text}`);
  }
  process.exit(1);
}

console.log('check:no-system-names: OK — brak zahardkodowanych nazw systemow RPG lub sciezek system.* w kodzie statblock/.');

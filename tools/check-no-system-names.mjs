#!/usr/bin/env node
// Statblock import must stay system-agnostic: no RPG system names and no
// hardcoded `system.<path>` strings in its code. This is the AUTOMATED half of
// that guarantee — a mechanical check runnable in CI, catching future
// regressions. It does NOT try to police comments/prose: a plain-text mention
// explaining WHY the code is designed the way it is is legitimate, and telling
// that apart from a real violation needs human judgment.
// Scoped to `statblock/` source only (`packages/core/src/statblock/**`,
// `packages/module/src/statblock/**`), excluding tests: a test needing SOME
// concrete example path, like "attributes.hp.value", is not evidence of
// hardcoding a real system's shape. Older, unrelated pipeline code is out of
// scope.
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
  console.error('check:no-system-names: FOUND violations (RPG system names / hardcoded system.* paths are not allowed in statblock/ code):');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} — ${v.kind}\n    ${v.text}`);
  }
  process.exit(1);
}

console.log('check:no-system-names: OK — no hardcoded RPG system names or system.* paths in statblock/ code.');

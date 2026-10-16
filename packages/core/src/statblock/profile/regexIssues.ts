import { compileProfileRegex, MAX_PATTERN_LENGTH } from '../extract/safeRegex.js';
import type { FieldSource, ProfileField, StatblockProfile, StyleFilter } from './schema.js';

/**
 * The regular expressions of a profile that the engine would refuse to run (too long, or built so that matching can
 * take exponential time — see `extract/safeRegex.ts`), as readable issues for `validateProfile`. A pattern with a
 * plain syntax error is not reported here: it only fails the field that uses it, with its own diagnostic, and
 * refusing the whole profile for it would hide a profile that is otherwise usable.
 */

function check(pattern: string | undefined, path: string, issues: string[]): void {
  if (pattern === undefined) return;
  const compiled = compileProfileRegex(pattern);
  if (compiled.ok || compiled.problem === 'invalid') return;
  issues.push(compiled.problem === 'tooLong' ? `${path}: regular expression is longer than ${MAX_PATTERN_LENGTH} characters` : `${path}: regular expression is too complex (it can take exponential time to match)`);
}

function checkStyleFilter(filter: StyleFilter | undefined, path: string, issues: string[]): void {
  check(filter?.fontNamePattern, `${path}.fontNamePattern`, issues);
}

function checkSource(source: FieldSource | undefined, path: string, issues: string[]): void {
  if (!source) return;
  if (source.kind === 'label') {
    if (source.labelIsRegex) check(source.labelPattern, `${path}.labelPattern`, issues);
    if (source.nextLabelIsRegex) check(source.nextLabelPattern, `${path}.nextLabelPattern`, issues);
  } else if (source.kind === 'styleFilter') {
    checkStyleFilter(source.filter, `${path}.filter`, issues);
  }
}

function checkField(field: ProfileField, path: string, issues: string[]): void {
  checkSource(field.source, `${path}.source`, issues);
  field.transforms.forEach((step, index) => {
    if (step.kind === 'regexExtract') check(step.pattern, `${path}.transforms.${index}.pattern`, issues);
    if (step.kind === 'split' && step.separatorIsRegex) check(step.separator, `${path}.transforms.${index}.separator`, issues);
  });
}

export function collectRegexIssues(profile: StatblockProfile): string[] {
  const issues: string[] = [];
  const { anchor, boundary, requiredLabels } = profile.detection;
  if (anchor.patternIsRegex) check(anchor.pattern, 'detection.anchor.pattern', issues);
  checkStyleFilter(anchor.styleFilter, 'detection.anchor.styleFilter', issues);
  if (boundary.endLabelIsRegex) check(boundary.endLabelPattern, 'detection.boundary.endLabelPattern', issues);
  requiredLabels.forEach((label, index) => {
    if (label.isRegex) check(label.pattern, `detection.requiredLabels.${index}.pattern`, issues);
  });
  checkSource(profile.nameSource, 'nameSource', issues);
  profile.fields.forEach((field, index) => checkField(field, `fields.${index}`, issues));
  profile.collections.forEach((collection, index) => {
    const rule = collection.splitRule;
    if (rule.sectionHeaderIsRegex) check(rule.sectionHeaderPattern, `collections.${index}.splitRule.sectionHeaderPattern`, issues);
    if (rule.sectionEndIsRegex) check(rule.sectionEndPattern, `collections.${index}.splitRule.sectionEndPattern`, issues);
    if (rule.entryBoundaryIsRegex) check(rule.entryBoundaryPattern, `collections.${index}.splitRule.entryBoundaryPattern`, issues);
    checkSource(collection.nameSource, `collections.${index}.nameSource`, issues);
    collection.itemFields.forEach((field, fieldIndex) => checkField(field, `collections.${index}.itemFields.${fieldIndex}`, issues));
  });
  profile.valueMaps.forEach((map, index) => {
    if (map.kind === 'regexReplace' && typeof map.params['pattern'] === 'string') check(map.params['pattern'], `valueMaps.${index}.params.pattern`, issues);
  });
  return issues;
}

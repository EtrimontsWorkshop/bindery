import type { Diagnostic } from '../../text/types.js';
import { toParamValue } from './diagnosticParam.js';
import type { ProfileFieldDataType } from '../profile/schema.js';
import { parseNumber } from './transforms/numberTransforms.js';

/**
 * "Casting the result onto the target field type + validation
 * (min/max, choices)." Runs AFTER the transform chain — the chain is
 * responsible for getting the value into roughly the right JS shape
 * (`parseNumber` for a `'number'` field, etc.); this step is the final
 * gate that confirms it actually landed there and checks the field's own
 * constraints (mirrors `SchemaFieldDescriptor`'s `min`/`max`/`integer`/
 * `choices` from `../schema/types.js` — the SAME constraint vocabulary a
 * profile field's target schema path carries).
 *
 * A string aimed at a `'number'` field is parsed leniently (first number in the text).
 * A type mismatch is an ERROR diagnostic and the value is dropped
 * (`undefined`) — a `'number'` field that got a string means something
 * upstream (usually a missing `parseNumber` step) is genuinely wrong, not
 * a soft warning. A constraint violation (min/max/choices/integer) is a
 * WARNING — the value is kept as-is (still probably useful to show the
 * user for review) but flagged.
 */
export interface FieldTypeConstraints {
  dataType: ProfileFieldDataType;
  min?: number;
  max?: number;
  integer?: boolean;
  choices?: readonly (string | number)[];
}

const TRUTHY_STRINGS = new Set(['true', 'yes', '1', 'x']);
const FALSY_STRINGS = new Set(['false', 'no', '0', '']);

export function castAndValidate(value: unknown, constraints: FieldTypeConstraints): { value: unknown; diagnostics: Diagnostic[] } {
  if (value === undefined) return { value: undefined, diagnostics: [] };

  switch (constraints.dataType) {
    case 'number': {
      // A string headed for a number field is read as its first number, so a profile author doesn't have to add a parse step by hand for the common case (the explicit `parseNumber` / `nthNumber` steps still win when present — they run earlier and hand over a number).
      const original = value;
      if (typeof value === 'string') value = parseNumber(value).value;
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return { value: undefined, diagnostics: [{ severity: 'error', code: 'STATBLOCK_CAST_NOT_NUMBER', params: { value: toParamValue(original) } }] };
      }
      const diagnostics: Diagnostic[] = [];
      if (constraints.integer && !Number.isInteger(value)) diagnostics.push({ severity: 'warning', code: 'STATBLOCK_VALIDATE_NOT_INTEGER', params: { value } });
      if (constraints.min !== undefined && value < constraints.min) diagnostics.push({ severity: 'warning', code: 'STATBLOCK_VALIDATE_BELOW_MIN', params: { value, min: constraints.min } });
      if (constraints.max !== undefined && value > constraints.max) diagnostics.push({ severity: 'warning', code: 'STATBLOCK_VALIDATE_ABOVE_MAX', params: { value, max: constraints.max } });
      return { value, diagnostics };
    }

    case 'string':
    case 'html': {
      if (typeof value !== 'string') return { value: undefined, diagnostics: [{ severity: 'error', code: 'STATBLOCK_CAST_NOT_STRING', params: { value: toParamValue(value) } }] };
      return { value, diagnostics: [] };
    }

    case 'boolean': {
      if (typeof value === 'boolean') return { value, diagnostics: [] };
      if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (TRUTHY_STRINGS.has(normalized)) return { value: true, diagnostics: [] };
        if (FALSY_STRINGS.has(normalized)) return { value: false, diagnostics: [] };
      }
      return { value: undefined, diagnostics: [{ severity: 'error', code: 'STATBLOCK_CAST_NOT_BOOLEAN', params: { value: toParamValue(value) } }] };
    }

    case 'choices': {
      if (!constraints.choices || constraints.choices.length === 0) return { value, diagnostics: [] };
      const isAllowed = constraints.choices.some((choice) => String(choice) === String(value));
      if (!isAllowed) {
        return {
          value,
          diagnostics: [{ severity: 'warning', code: 'STATBLOCK_VALIDATE_NOT_IN_CHOICES', params: { value: toParamValue(value), choices: toParamValue(constraints.choices) } }],
        };
      }
      return { value, diagnostics: [] };
    }

    case 'array': {
      if (!Array.isArray(value)) return { value: undefined, diagnostics: [{ severity: 'error', code: 'STATBLOCK_CAST_NOT_ARRAY', params: { value: toParamValue(value) } }] };
      return { value, diagnostics: [] };
    }

    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { value: undefined, diagnostics: [{ severity: 'error', code: 'STATBLOCK_CAST_NOT_OBJECT', params: { value: toParamValue(value) } }] };
      }
      return { value, diagnostics: [] };
    }
  }
}

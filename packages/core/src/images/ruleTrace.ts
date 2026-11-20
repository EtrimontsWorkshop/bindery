/**
 * A hook for the measuring tool (`tools/measure-images.ts`): told which of the rules that cut, split, turn or trim a
 * picture made it, by the picture's content hash. Unset in the module; nothing calls it there.
 */
export const ruleTrace: { hook: ((rule: string, page: number, contentHash: string) => void) | null } = { hook: null };

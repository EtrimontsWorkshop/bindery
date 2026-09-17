import type { TextLine, LineRun } from './lineCluster.js';

/**
 * [Step 11 Z1] Splits ONE line into several "lines" when its START and/or
 * END is an inline heading label glued onto the first/last row of a
 * paragraph (MDD §5.2). Without this the whole line gets ONE `dominantFont`
 * (the one with the most characters) and the block builder never sees the
 * boundary.
 *
 * REPLACES the Step 9 discriminator (Z1b, the heading<->body role pair, which
 * lived in `semantic/blockBuilder.ts`) — on real files, an inline label often
 * has the `accent` font role, not `heading` (Step 9's Z1a rule assigns
 * `heading` only to blocks that are SINGLE-LINE and VERTICALLY ISOLATED, and
 * a label inside a paragraph is by definition not isolated) — the role pair
 * never fired (Step 10 manual review, Cienie p. 20 / Za_lini_wroga p. 24,
 * 68 / Wrath & Glory, an inline label at the end of a line). The new
 * discriminator is POSITIONAL and doesn't depend on `fontRoles` at all.
 *
 * [Step 11, discovery — the brief only talked about a PREFIX, the data
 * showed a need for SYMMETRY] The first version (only `runs[0]`, exactly per
 * the brief) correctly split Cienie p. 20 and Za_lini_wroga p. 24/68, but NOT
 * the `Wrath & Glory` case — direct inspection of `runs` showed
 * that this SPECIFIC case has the label at the END of the line
 * (`['CaxtonStd-Book@7.5': body 52 chars, 'CaxtonStd-Bold-SC700@19': single
 * connector char 1 char, 'CaxtonStd-Bold-SC700@13.5': label text 15
 * chars]`) — a SUFFIX, not a prefix. The discriminator was therefore generalized
 * symmetrically: FIRST the dominant font of the WHOLE line is computed
 * (by total character count across ALL runs), and then the maximal EDGE run
 * (from the start OR from the end) with a DIFFERENT key than that dominant
 * one is cut off, provided it is SHORTER than the rest of the line. Using
 * the dominant of the WHOLE line (not a separately computed "rest on one
 * side") is key — a naive version computing the dominant separately for each
 * side gets it wrong when the OTHER side of the line itself contains an
 * anomaly (e.g. body-accent-body: computing the "rest" dominant for the
 * suffix without excluding the prefix, the accent might accidentally "win"
 * over body and trigger a false cut) — verified directly in tests (see
 * `lineEdgeSplit.test.ts`).
 *
 * An emphasis in the TRUE MIDDLE of a sentence (surrounded by the dominant
 * font on BOTH sides) is neither a prefix nor a suffix, so it doesn't meet
 * the condition — italics in the middle of a paragraph won't split the
 * block. An emphasis at the VERY START or VERY END of a line MAY be treated
 * as a label (the same documented and accepted trade-off as with the
 * original, one-sided discriminator from the brief — real text that
 * starts/ends with a short emphasis is rarer than mid-sentence emphasis, and
 * a false positive here still just means SPLITTING into two correct blocks,
 * not losing content).
 *
 * [Step 11, discovery] MUST run BEFORE `splitSpanningLines`/`detectColumns`/
 * `gutterRepair.ts`, not in `blockBuilder.ts` like the original Step 9
 * version — on real files, a line with an inline heading label is OFTEN
 * simultaneously classified as `spanning` (wide bbox, multiple runs of
 * different fonts) and CROSSES a detected gutter (Step 10). Running
 * `gutterRepair.ts` first splits such a line into fragments BASED ON
 * `tokens` (not `runs`) and deliberately clears `runs` on every fragment
 * (per `gutterRepair.ts`'s own documentation: "inherited runs may be
 * invalid") — by the time `blockBuilder.ts` tried to split the line by
 * `runs`, that information no longer existed, so the discriminator never
 * fired (verified directly: `Za_lini_wroga.pdf` p. 24, line `p24-0-74` ->
 * fragment `p24-0-74-gutter0` with `runs.length === 0`). Splitting EARLIER
 * (on the raw lines from `lineCluster.ts`, before anything else sees them)
 * produces NARROWER fragments, none of which usually crosses a gutter
 * anymore — `gutterRepair.ts` doesn't need to touch them at all.
 *
 * Each fragment gets its own `dominantFont`/`fonts` (from its run), so the
 * subsequent `shouldBreak` in `blockBuilder.ts` (a `fontKey` change) will
 * ITSELF already separate the fragments into distinct blocks — no separate
 * mechanism is needed.
 *
 * [Step 11, KNOWN LIMITATION, verified on `Cienie_posrod_mgie.pdf`
 * p. 20] Two of the labels from the brief
 * are NOT simple 2-3-run edge cases like Za_lini_wroga p. 24/68 or
 * Wrath & Glory — direct inspection showed 4 (first label) and 3
 * (second label) runs, where the label sits in the MIDDLE of the
 * `runs` array, and the runs on BOTH its sides belong to the SAME body font
 * family (`MinionPro-Regular`, only with a small size difference: @10.5 vs
 * @10) — while also sitting on CLEARLY different Y bands (not one physical
 * line, but several lines/columns merged into one by an earlier clustering
 * stage). This is an EDGE discriminator by design and does NOT catch this
 * (a label in the true middle, surrounded by the same font family on both
 * sides — exactly the case this discriminator is meant NOT to touch, so as
 * not to break genuine mid-sentence emphasis). Fixing it would require a
 * different signal (e.g. a gap in the Y band between adjacent runs of the
 * same font "family") — deliberately NOT added at this step (risk of new
 * false cuts), left as an open item for a future step. See
 * RAPORT-KROK-11.md.
 */
export function splitLineByEdgeRun(line: TextLine): TextLine[] {
  const runs = line.runs ?? [];
  if (runs.length < 2) return [line];

  const totalLength = runs.reduce((sum, r) => sum + r.text.length, 0);
  const dominantKey = dominantRunFontKey(runs);

  let prefixEnd = 0;
  while (prefixEnd < runs.length && runs[prefixEnd]!.fontKey !== dominantKey) prefixEnd++;
  const prefixLength = runs.slice(0, prefixEnd).reduce((sum, r) => sum + r.text.length, 0);
  const hasPrefix = prefixEnd > 0 && prefixEnd < runs.length && prefixLength < totalLength - prefixLength;

  let suffixStart = runs.length;
  while (suffixStart > prefixEnd && runs[suffixStart - 1]!.fontKey !== dominantKey) suffixStart--;
  const suffixLength = runs.slice(suffixStart).reduce((sum, r) => sum + r.text.length, 0);
  const hasSuffix = suffixStart < runs.length && suffixStart > 0 && suffixLength < totalLength - suffixLength;

  if (!hasPrefix && !hasSuffix) return [line];

  // Each run in an edge zone (prefix/suffix) gets its OWN fragment (not one
  // combined fragment) — on real data the edge zone can be non-uniform
  // (Za_lini_wroga p. 24: oblique-title + a different-font label, TWO
  // different fonts within the prefix alone) and must be split further so
  // that `blockBuilder.ts`'s `shouldBreak` (a fontKey change) sees EVERY
  // boundary. The MIDDLE (dominant) zone stays one fragment.
  const effectivePrefixEnd = hasPrefix ? prefixEnd : 0;
  const effectiveSuffixStart = hasSuffix ? suffixStart : runs.length;

  const groups: LineRun[][] = [];
  for (let i = 0; i < effectivePrefixEnd; i++) groups.push([runs[i]!]);
  if (effectiveSuffixStart > effectivePrefixEnd) groups.push(runs.slice(effectivePrefixEnd, effectiveSuffixStart));
  for (let i = effectiveSuffixStart; i < runs.length; i++) groups.push([runs[i]!]);

  return groups.map((group, i) => {
    const text = group.map((r) => r.text).join('');
    const bbox = group.reduce(
      (acc, r) => ({
        minX: Math.min(acc.minX, r.bbox.minX),
        minY: Math.min(acc.minY, r.bbox.minY),
        maxX: Math.max(acc.maxX, r.bbox.maxX),
        maxY: Math.max(acc.maxY, r.bbox.maxY),
      }),
      group[0]!.bbox,
    );
    const groupDominantKey = dominantRunFontKey(group);
    const fontEntry = line.fonts.find((f) => f.key === groupDominantKey) ?? line.dominantFont;
    return {
      id: `${line.id}-run${i}`,
      text,
      bbox,
      columnIndex: line.columnIndex,
      crossAxisPosition: line.crossAxisPosition,
      fonts: [fontEntry],
      dominantFont: fontEntry,
      syntheticBold: line.syntheticBold,
      runs: group,
    };
  });
}

/** The font key with the largest total character count among the given runs. */
function dominantRunFontKey(runs: readonly LineRun[]): string {
  const counts = new Map<string, number>();
  for (const r of runs) counts.set(r.fontKey, (counts.get(r.fontKey) ?? 0) + r.text.length);
  let best = runs[0]?.fontKey ?? '';
  let bestCount = -1;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

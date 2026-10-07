import { describe, expect, it } from 'vitest';
import { splitLineByEdgeRun } from '../../src/layout/lineEdgeSplit.js';
import type { TextLine } from '../../src/layout/lineCluster.js';

function line(id: string, text: string, minX: number, maxX: number, y: number, fontKey = 'Body@10'): TextLine {
  return {
    id,
    text,
    bbox: { minX, minY: y, maxX, maxY: y + 10 },
    columnIndex: 0,
    crossAxisPosition: y,
    fonts: [{ key: fontKey, size: 10 }],
    dominantFont: { key: fontKey, size: 10 },
    syntheticBold: false,
  };
}

describe('splitLineByEdgeRun — a mid-paragraph heading label (prefix/suffix), a positional discriminator', () => {
  it('a run AT THE START of a line, a different font, a LONGER remainder (accent, not heading) — splits despite the lack of a heading role', () => {
    // Real bug: a mid-paragraph label often has the `accent` role, not `heading` (a real two-column
    // page) — the new discriminator is POSITIONAL and doesn't look at `fontRoles` at all, so this
    // case is now correctly split.
    const mixedLine: TextLine = {
      ...line('mix0', 'TITLE TEXT body text of the line follows here', 72, 400, 700, 'Accent@14'),
      runs: [
        { fontKey: 'Accent@14', text: 'TITLE TEXT', bbox: { minX: 72, minY: 700, maxX: 160, maxY: 712 } },
        { fontKey: 'Body@10', text: 'body text of the line follows here', bbox: { minX: 162, minY: 700, maxX: 400, maxY: 712 } },
      ],
      fonts: [
        { key: 'Accent@14', size: 14 },
        { key: 'Body@10', size: 10 },
      ],
    };
    const split = splitLineByEdgeRun(mixedLine);
    expect(split).toHaveLength(2);
    expect(split[0]!.text).toBe('TITLE TEXT');
    expect(split[0]!.dominantFont.key).toBe('Accent@14');
    expect(split[1]!.text).toBe('body text of the line follows here');
    expect(split[1]!.dominantFont.key).toBe('Body@10');
  });

  it('an emphasis IN THE TRUE MIDDLE of a sentence (the dominant font on BOTH sides) — does NOT split', () => {
    // The dominant font of the line (by total character count) is Body@10 (9+26=35 characters),
    // Accent@10 has only 17 — the accent is an ISLAND in the middle, surrounded by the dominant font
    // on both sides, so neither the prefix nor the suffix catches it.
    const mixedLine: TextLine = {
      ...line('mix1', 'The word truly emphasized continues normally', 72, 500, 700, 'Body@10'),
      runs: [
        { fontKey: 'Body@10', text: 'The word ', bbox: { minX: 72, minY: 700, maxX: 130, maxY: 712 } }, // 9 characters
        { fontKey: 'Accent@10', text: 'truly emphasized', bbox: { minX: 130, minY: 700, maxX: 240, maxY: 712 } }, // 17 characters
        { fontKey: 'Body@10', text: ' continues normally', bbox: { minX: 240, minY: 700, maxX: 500, maxY: 712 } }, // 20 characters
      ],
      fonts: [
        { key: 'Body@10', size: 10 },
        { key: 'Accent@10', size: 10 },
      ],
    };
    const split = splitLineByEdgeRun(mixedLine);
    expect(split).toHaveLength(1);
    expect(split[0]!.id).toBe('mix1');
  });

  it('a run AT THE END of a line, a different font than the longer beginning — splits as a SUFFIX (the dominant of the whole line, not of the "rest")', () => {
    // The dominant font is computed for the WHOLE line: Accent (42 characters) > Body (10 characters)
    // -> Accent is the line's "true voice", so the shorter Body at the end is an anomaly-suffix and is
    // cut off. This is the SYMMETRIC counterpart of the first test (there the shorter part was the
    // PREFIX).
    const mixedLine: TextLine = {
      ...line('mix2', 'A very long opening label continues into short tail', 72, 500, 700, 'Accent@10'),
      runs: [
        { fontKey: 'Accent@10', text: 'A very long opening label continues into', bbox: { minX: 72, minY: 700, maxX: 400, maxY: 712 } },
        { fontKey: 'Body@10', text: 'short tail', bbox: { minX: 400, minY: 700, maxX: 500, maxY: 712 } },
      ],
      fonts: [
        { key: 'Accent@10', size: 10 },
        { key: 'Body@10', size: 10 },
      ],
    };
    const split = splitLineByEdgeRun(mixedLine);
    expect(split).toHaveLength(2);
    expect(split[0]!.text).toBe('A very long opening label continues into');
    expect(split[1]!.text).toBe('short tail');
  });

  it('a length tie (the edge run EXACTLY half of the whole) — does NOT split (a strict inequality)', () => {
    const tiedLine: TextLine = {
      ...line('mix5', 'AAAAAAAAAA BBBBBBBBBB', 72, 300, 700, 'FontA@10'),
      runs: [
        { fontKey: 'FontA@10', text: 'AAAAAAAAAA', bbox: { minX: 72, minY: 700, maxX: 180, maxY: 712 } }, // 10 characters
        { fontKey: 'FontB@10', text: 'BBBBBBBBBB', bbox: { minX: 180, minY: 700, maxX: 300, maxY: 712 } }, // 10 characters
      ],
      fonts: [
        { key: 'FontA@10', size: 10 },
        { key: 'FontB@10', size: 10 },
      ],
    };
    const split = splitLineByEdgeRun(tiedLine);
    expect(split).toHaveLength(1);
    expect(split[0]!.id).toBe('mix5');
  });

  it('a single `run` (a uniform line) — does NOT split (fewer than 2 runs)', () => {
    const uniformLine: TextLine = {
      ...line('mix3', 'Uniform paragraph text all one font', 72, 400, 700, 'Body@10'),
      runs: [{ fontKey: 'Body@10', text: 'Uniform paragraph text all one font', bbox: { minX: 72, minY: 700, maxX: 400, maxY: 712 } }],
    };
    const split = splitLineByEdgeRun(uniformLine);
    expect(split).toHaveLength(1);
    expect(split[0]!.id).toBe('mix3');
  });

  it('no `runs` at all — does NOT split (safe for hand-built fixtures without this field)', () => {
    const bareLine = line('mix4', 'Plain line without runs metadata at all', 72, 400, 700);
    const split = splitLineByEdgeRun(bareLine);
    expect(split).toHaveLength(1);
    expect(split[0]!.id).toBe('mix4');
  });

  it('3 runs: an oblique title + a different-font label + body — splits into 3 fragments, EACH edge run separately (a real case from a real two-column page)', () => {
    // Exactly this run structure observed on a real two-column page (a line "Operation Vanguard
    // Difficulty level..."): 3 different fonts, TWO different fonts in the prefix alone (a title +
    // a label) — they must be split into TWO SEPARATE fragments, not one combined "prefix".
    const realLine: TextLine = {
      ...line('p24-0-74', 'Alpha Bravo Charlie Del Echo Foxtrot Golf Hotel Ind lorem ipsum dolor sit amet', 401, 594, 291, 'Helvetica@8.5'),
      runs: [
        { fontKey: 'Helvetica-Oblique@8.5', text: 'Alpha Bravo Charlie Del', bbox: { minX: 401, minY: 291, maxX: 507, maxY: 300 } }, // 23
        { fontKey: 'TitleFont@19', text: 'Echo Foxtrot Golf Hotel Ind', bbox: { minX: 401, minY: 300, maxX: 594, maxY: 320 } }, // 27
        {
          fontKey: 'Helvetica@8.5',
          text: 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempo', // 77
          bbox: { minX: 401, minY: 320, maxX: 594, maxY: 329 },
        },
      ],
      fonts: [
        { key: 'Helvetica-Oblique@8.5', size: 8.5 },
        { key: 'TitleFont@19', size: 19 },
        { key: 'Helvetica@8.5', size: 8.5 },
      ],
    };
    const split = splitLineByEdgeRun(realLine);
    expect(split).toHaveLength(3);
    expect(split[0]!.text).toBe('Alpha Bravo Charlie Del');
    expect(split[1]!.text).toBe('Echo Foxtrot Golf Hotel Ind');
    expect(split[2]!.text).toContain('lorem ipsum dolor');
  });

  it('3 runs: a long body + a micro-run in a different font + a suffix label — splits, the suffix broken into separate fragments (a real case from a real page)', () => {
    // Exactly this run structure observed on a real page — the dominant body (52 characters) is much
    // longer than both trailing runs together (1+15=16), so both fall into the suffix zone and are cut
    // off as SEPARATE fragments (the tiny "o" doesn't merge with the label).
    const realLine: TextLine = {
      ...line('p9-0-11', 'The quick brown fox jumps over the lazy dog The quicClosing Label X', 45, 300, 660, 'BodyFont@7.5'),
      runs: [
        {
          fontKey: 'BodyFont@7.5',
          text: 'The quick brown fox jumps over the lazy dog The quic', // 53
          bbox: { minX: 45, minY: 660, maxX: 250, maxY: 669 },
        },
        { fontKey: 'LabelFont@19', text: 'o', bbox: { minX: 250, minY: 655, maxX: 258, maxY: 674 } }, // 1
        { fontKey: 'LabelFont@13.5', text: 'Closing Label X', bbox: { minX: 258, minY: 655, maxX: 300, maxY: 669 } }, // 15
      ],
      fonts: [
        { key: 'BodyFont@7.5', size: 7.5 },
        { key: 'LabelFont@19', size: 19 },
        { key: 'LabelFont@13.5', size: 13.5 },
      ],
    };
    const split = splitLineByEdgeRun(realLine);
    expect(split.length).toBeGreaterThanOrEqual(2);
    // The body text must end up in a SEPARATE fragment from the label — no single fragment may
    // contain both glued together.
    expect(split[0]!.text).toBe('The quick brown fox jumps over the lazy dog The quic');
    expect(split[split.length - 1]!.text).toBe('Closing Label X');
    for (const fragment of split) expect(fragment.text).not.toContain('quicClosing');
  });
});

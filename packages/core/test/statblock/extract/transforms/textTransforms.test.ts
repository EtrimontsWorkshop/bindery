import { describe, expect, it } from 'vitest';
import {
  joinText,
  joinWrappedLines,
  normalizeWhitespace,
  regexExtract,
  splitText,
  stripLigaturesAndOddChars,
  textToHtml,
  trim,
} from '../../../../src/statblock/extract/transforms/textTransforms.js';
import type { PageTextElement } from '../../../../src/statblock/extract/types.js';

describe('trim', () => {
  it('trims leading/trailing whitespace', () => {
    expect(trim('  hello  ').value).toBe('hello');
  });

  it('passes non-string input through unchanged (an earlier step already failed)', () => {
    expect(trim(undefined).value).toBeUndefined();
    expect(trim(42).value).toBe(42);
  });
});

describe('normalizeWhitespace', () => {
  it('collapses runs of spaces/tabs into one space', () => {
    expect(normalizeWhitespace('a   b\t\tc').value).toBe('a b c');
  });

  it('trims each line but preserves line breaks', () => {
    expect(normalizeWhitespace('  line one  \n  line two  ').value).toBe('line one\nline two');
  });
});

describe('joinWrappedLines — dehyphenation and edge cases', () => {
  it('rejoins a hyphen-split word across a line break without a hyphen or space', () => {
    expect(joinWrappedLines('unbeliev-\nable').value).toBe('unbelievable');
  });

  it('does NOT rejoin when the next line starts with an uppercase letter (likely two separate words, not a wrapped one)', () => {
    expect(joinWrappedLines('Twenty-\nTwo').value).toBe('Twenty- Two');
  });

  it('joins non-hyphenated line breaks with a single space', () => {
    expect(joinWrappedLines('first line\nsecond line').value).toBe('first line second line');
  });

  it('drops blank lines instead of introducing a double space', () => {
    expect(joinWrappedLines('first\n\nsecond').value).toBe('first second');
  });

  it('a single line with no breaks passes through unchanged', () => {
    expect(joinWrappedLines('just one line').value).toBe('just one line');
  });

  it('empty string input produces empty string output', () => {
    expect(joinWrappedLines('').value).toBe('');
  });

  it('handles several consecutive wrapped hyphenations', () => {
    expect(joinWrappedLines('super-\ncalifragil-\nistic').value).toBe('supercalifragilistic');
  });
});

describe('stripLigaturesAndOddChars', () => {
  it('replaces common ligature glyphs with plain letters', () => {
    expect(stripLigaturesAndOddChars('ﬁre').value).toBe('fire'); // ﬁre -> fire
    expect(stripLigaturesAndOddChars('ﬂy').value).toBe('fly'); // ﬂy -> fly
  });

  it('strips control characters but preserves newlines', () => {
    expect(stripLigaturesAndOddChars('a\u0000b\nc').value).toBe('ab\nc');
  });

  it('strips Private-Use-Area characters (common embedded-font-subset artifacts)', () => {
    expect(stripLigaturesAndOddChars('ab').value).toBe('ab');
  });

  it('leaves ordinary text untouched', () => {
    expect(stripLigaturesAndOddChars('Hello, World!').value).toBe('Hello, World!');
  });
});

describe('regexExtract', () => {
  it('extracts a capture group', () => {
    const result = regexExtract('HP 12/12', '(\\d+)/(\\d+)', 2);
    expect(result.value).toBe('12');
  });

  it('defaults to the whole match (group 0) when no group is specified', () => {
    const result = regexExtract('abc123', '\\d+');
    expect(result.value).toBe('123');
  });

  it('reports a warning diagnostic and undefined value when the pattern does not match', () => {
    const result = regexExtract('no digits here', '\\d+');
    expect(result.value).toBeUndefined();
    expect(result.diagnostics[0]!.code).toBe('STATBLOCK_REGEX_NO_MATCH');
  });

  it('an invalid regex pattern degrades to a diagnostic instead of throwing', () => {
    expect(() => regexExtract('abc', '(unterminated')).not.toThrow();
    expect(regexExtract('abc', '(unterminated').diagnostics[0]!.code).toBe('STATBLOCK_INVALID_REGEX');
  });

  it('requesting a group index the pattern does not have is an error diagnostic', () => {
    const result = regexExtract('abc123', '\\d+', 5);
    expect(result.diagnostics[0]!.code).toBe('STATBLOCK_REGEX_GROUP_MISSING');
  });
});

describe('splitText / joinText', () => {
  it('splits on a plain separator', () => {
    expect(splitText('a,b,c', ',').value).toEqual(['a', 'b', 'c']);
  });

  it('splits on a regex separator', () => {
    expect(splitText('a1b22c', '\\d+', true).value).toEqual(['a', 'b', 'c']);
  });

  it('joins an array back into a string', () => {
    expect(joinText(['a', 'b', 'c'], '-').value).toBe('a-b-c');
  });

  it('joinText on non-array input is an error diagnostic, value passed through', () => {
    const result = joinText('not an array', '-');
    expect(result.diagnostics[0]!.code).toBe('STATBLOCK_JOIN_NOT_ARRAY');
    expect(result.value).toBe('not an array');
  });
});

function el(text: string, x: number, overrides: Partial<PageTextElement> = {}): PageTextElement {
  return { text, x, y: 0, w: text.length * 6, h: 10, fontName: 'Body', fontSize: 10, bold: false, italic: false, ...overrides };
}

describe('textToHtml', () => {
  it('wraps a plain line in a single <p>', () => {
    const result = textToHtml({ elements: [el('Hello', 0), el('world', 40)] });
    expect(result.value).toBe('<p>Hello world</p>');
  });

  it('wraps a run of consecutive bold elements in <strong>', () => {
    const result = textToHtml({ elements: [el('normal', 0), el('bold', 40, { bold: true }), el('text', 80, { bold: true }), el('end', 120)] });
    expect(result.value).toBe('<p>normal <strong>bold text</strong> end</p>');
  });

  it('produces one <p> per reconstructed line', () => {
    const result = textToHtml({ elements: [el('Top', 0, { y: 20 }), el('Bottom', 0, { y: 0 })] });
    expect(result.value).toBe('<p>Top</p><p>Bottom</p>');
  });

  it('escapes HTML-significant characters', () => {
    const result = textToHtml({ elements: [el('<script>&', 0)] });
    expect(result.value).toBe('<p>&lt;script&gt;&amp;</p>');
  });

  it('empty elements list produces an empty string with an info diagnostic', () => {
    const result = textToHtml({ elements: [] });
    expect(result.value).toBe('');
    expect(result.diagnostics[0]!.code).toBe('STATBLOCK_TEXT_TO_HTML_EMPTY');
  });
});

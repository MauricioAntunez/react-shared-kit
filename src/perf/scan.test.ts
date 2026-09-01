import { describe, expect, it } from 'vitest';
import {
  attr,
  extractImportSpecifiers,
  MAX_MALFORMED_TAG_LENGTH,
  MAX_URL_LENGTH,
  sanitizeTagText,
  scanFontFaces,
  urlsInFontFaceBody,
  urlsInSrcDeclaration,
} from './scan.ts';

describe('urlsInFontFaceBody', () => {
  it('finds the src: url when the trailing semicolon is absent (minified CSS)', () => {
    const body = `font-family:X;src:url(/x.woff2) format("woff2")`;

    const urls = urlsInFontFaceBody(body);

    expect(urls).toEqual([{ value: '/x.woff2', oversized: false }]);
  });

  it('finds every src: url when a trailing semicolon IS present', () => {
    const body = `font-family:X;src:url(/x.woff2) format("woff2");`;

    const urls = urlsInFontFaceBody(body);

    expect(urls).toEqual([{ value: '/x.woff2', oversized: false }]);
  });
});

describe('urlsInSrcDeclaration', () => {
  it('unwraps a double-quoted url()', () => {
    expect(urlsInSrcDeclaration(`url("/a.woff2")`)).toEqual([
      { value: '/a.woff2', oversized: false },
    ]);
  });

  it('unwraps a single-quoted url()', () => {
    expect(urlsInSrcDeclaration(`url('/a.woff2')`)).toEqual([
      { value: '/a.woff2', oversized: false },
    ]);
  });

  it('unwraps an unquoted url()', () => {
    expect(urlsInSrcDeclaration(`url(/a.woff2)`)).toEqual([
      { value: '/a.woff2', oversized: false },
    ]);
  });
});

describe('scanFontFaces', () => {
  it('brace-matches and does not swallow a following unrelated rule', () => {
    const css =
      `@font-face { font-family: 'X'; src: url('/x.woff2'); }\n` + `.after { color: red; }`;

    const { urls, unterminatedBlocks } = scanFontFaces(css);

    expect(unterminatedBlocks).toBe(0);
    expect(urls).toEqual([{ value: '/x.woff2', oversized: false }]);
    // The rule after the block must not have been consumed into the @font-face body — reproduced
    // by checking no @font-face-only field (there is none here, so absence of a second finding
    // for `.after` content is the assertion): only one url is reported, not any spurious match
    // from `.after`'s own text.
  });

  it('counts an unterminated @font-face { block and reports zero urls for it', () => {
    const css = `@font-face { font-family: 'Broken'; src: url('/broken.woff2');`; // no closing brace

    const { urls, unterminatedBlocks } = scanFontFaces(css);

    expect(unterminatedBlocks).toBe(1);
    expect(urls).toEqual([]);
  });
});

describe('attr', () => {
  it('matches a double-quoted attribute value', () => {
    expect(attr('<link rel="stylesheet" href="/a.css">', 'href')).toBe('/a.css');
  });

  it('matches a single-quoted attribute value', () => {
    expect(attr("<link rel='stylesheet' href='/a.css'>", 'href')).toBe('/a.css');
  });

  it('matches case-insensitively on the attribute name', () => {
    expect(attr('<link REL="stylesheet" HREF="/a.css">', 'href')).toBe('/a.css');
  });

  it('returns undefined when the attribute is absent', () => {
    expect(attr('<link rel="stylesheet">', 'href')).toBeUndefined();
  });
});

describe('sanitizeTagText', () => {
  it('strips control characters, escaping them to a visible form', () => {
    expect(sanitizeTagText('a\nb\tc')).toBe('a\\nb\\tc');
  });

  it('caps the result length, appending a truncation marker', () => {
    const long = 'x'.repeat(1000);

    const result = sanitizeTagText(long);

    expect(result.length).toBeLessThan(400);
    expect(result).toContain('truncated');
  });

  // Round-4 review MEDIUM: the doc comment claimed "every control character" while the class was
  // actually [\x00-\x1f\x7f] — NEL, CSI, and the Unicode line separators passed through unescaped.
  // These four pin the widened class; each is REGRESSION-red against the pre-fix class (see PR
  // report for the revert-and-confirm proof).
  it('escapes NEL (U+0085), keeping the surrounding text intact', () => {
    expect(sanitizeTagText(`a\u0085b`)).toBe('a\\x85b');
  });

  it('escapes CSI (U+009B)', () => {
    expect(sanitizeTagText(`a\u009bb`)).toBe('a\\x9bb');
  });

  it('escapes U+2028 LINE SEPARATOR', () => {
    expect(sanitizeTagText(`a\u2028b`)).toBe('a\\u2028b');
  });

  it('escapes U+2029 PARAGRAPH SEPARATOR', () => {
    expect(sanitizeTagText(`a\u2029b`)).toBe('a\\u2029b');
  });

  it('regression: previously-covered cases are unaffected by the widened class', () => {
    expect(sanitizeTagText('\n')).toBe('\\n');
    expect(sanitizeTagText('\r')).toBe('\\r');
    expect(sanitizeTagText('\t')).toBe('\\t');
    expect(sanitizeTagText('\x00')).toBe('\\x00');
    expect(sanitizeTagText('\x7f')).toBe('\\x7f');
    expect(sanitizeTagText('\x1b[31m')).toBe('\\x1b[31m');
  });

  it('still identifies its input: a normal substring survives alongside a new escaped code point', () => {
    const result = sanitizeTagText(`<link href="/font.woff2\u2028">`);

    expect(result).toContain('<link href="/font.woff2');
    expect(result).toContain('\\u2028');
  });

  it('still caps length with the widened class in play', () => {
    const long = `${'x'.repeat(1000)}\u2028`;

    const result = sanitizeTagText(long);

    expect(result.length).toBeLessThan(400);
    expect(result).toContain('truncated');
  });

  // Boundary pins for the escaped class [\x00-\x1f\x7f-\x9f\u2028\u2029]. Reproduced: widening the
  // class to \x7f-\xa0 (so it also escapes NO-BREAK SPACE, a legitimate printable character) left
  // the suite at 26/26 passing before these existed \u2014 nothing here pinned the upper C1 edge.
  it('escapes \\x9f, the last code point in the C1 range', () => {
    expect(sanitizeTagText('a\x9fb')).toBe('a\\x9fb');
  });

  it('leaves \\xa0 (NO-BREAK SPACE), the first code point past the C1 range, unchanged', () => {
    expect(sanitizeTagText('a\xa0b')).toBe('a\xa0b');
  });

  it('escapes \\x1f, the last code point in the C0 range', () => {
    expect(sanitizeTagText('a\x1fb')).toBe('a\\x1fb');
  });

  it('leaves \\x20 (space), the first code point past the C0 range, unchanged', () => {
    expect(sanitizeTagText('a\x20b')).toBe('a b');
  });

  it('leaves \\x7e (tilde), the code point just below DEL, unchanged', () => {
    expect(sanitizeTagText('a\x7eb')).toBe('a~b');
  });
});

// PR #9 security review MEDIUM, reproduced: 'safe.js' + '\u202e' + 'gpj.exe' passed through with
// the RLO byte raw \u2014 a bidi-aware terminal renders everything after it in reverse order, so
// the printed message can visually read as a different string than its bytes. These pin the
// widened class [\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]; each is REGRESSION-red
// against the pre-fix class (see PR report for the revert-and-confirm proof).
describe('sanitizeTagText \u2014 bidi override and isolate characters (PR #9 security review)', () => {
  it('escapes U+202A LEFT-TO-RIGHT EMBEDDING', () => {
    expect(sanitizeTagText('a\u202ab')).toBe('a\\u202ab');
  });

  it('escapes U+202B RIGHT-TO-LEFT EMBEDDING', () => {
    expect(sanitizeTagText('a\u202bb')).toBe('a\\u202bb');
  });

  it('escapes U+202C POP DIRECTIONAL FORMATTING', () => {
    expect(sanitizeTagText('a\u202cb')).toBe('a\\u202cb');
  });

  it('escapes U+202D LEFT-TO-RIGHT OVERRIDE', () => {
    expect(sanitizeTagText('a\u202db')).toBe('a\\u202db');
  });

  it('escapes U+202E RIGHT-TO-LEFT OVERRIDE', () => {
    expect(sanitizeTagText('a\u202eb')).toBe('a\\u202eb');
  });

  it('escapes U+2066 LEFT-TO-RIGHT ISOLATE', () => {
    expect(sanitizeTagText('a\u2066b')).toBe('a\\u2066b');
  });

  it('escapes U+2067 RIGHT-TO-LEFT ISOLATE', () => {
    expect(sanitizeTagText('a\u2067b')).toBe('a\\u2067b');
  });

  it('escapes U+2068 FIRST STRONG ISOLATE', () => {
    expect(sanitizeTagText('a\u2068b')).toBe('a\\u2068b');
  });

  it('escapes U+2069 POP DIRECTIONAL ISOLATE', () => {
    expect(sanitizeTagText('a\u2069b')).toBe('a\\u2069b');
  });

  it("reproduces the reviewer's finding: an RLO-forged filename no longer passes through raw", () => {
    const raw = 'safe.js\u202egpj.exe';

    const result = sanitizeTagText(raw);

    expect(result).not.toContain('\u202e');
    expect(result).toContain('safe.js');
    expect(result).toContain('gpj.exe');
  });

  // Boundary pins, both directions \u2014 the ranges are adjacent to already-covered/uncovered
  // code points, so an off-by-one at either edge would otherwise pass unnoticed.
  it('escapes \\u2029 (already covered) immediately followed by \\u202a (newly covered)', () => {
    expect(sanitizeTagText('\u2029\u202a')).toBe('\\u2029\\u202a');
  });

  it('escapes U+2069 (last isolate) and leaves U+206A, the first code point past the isolates, unchanged', () => {
    expect(sanitizeTagText('a\u2069\u206ab')).toBe('a\\u2069\u206ab');
  });

  // ENUMERATE CONTIGUOUS RUNS, NOT THE RANGE LITERALS AS WRITTEN. The class is spelled with
  // four literals, but \u2028, \u2029 and \u202a-\u202e are adjacent and form ONE
  // run, \u2028-\u202e. Pinning "each literal's edges" looks complete while missing that
  // run's real lower edge, \u2027 - reproduced in PR #9 round 3: adding \u2027 to the
  // class left all 48 tests green. The four runs and the edges each needs (a run starting at
  // \x00 has no lower edge):
  //   \x00-\x1f      upper \x20
  //   \x7f-\x9f      lower \x7e, upper \xa0
  //   \u2028-\u202e  lower \u2027, upper \u202f
  //   \u2066-\u2069  lower \u2065, upper \u206a
  // NOTE for whoever edits this next: write every code point as an escape sequence, never a
  // literal character. A literal \u2028 is a line terminator in JS source and silently
  // breaks the parse - which is how this comment failed on its first attempt.
  it('leaves \\u2027, just below the contiguous bidi run, unchanged, and escapes \\u2028', () => {
    expect(sanitizeTagText('a\u2027\u2028b')).toBe('a\u2027\\u2028b');
  });
  // The over-reach direction at the embed/override range's UPPER edge. PR #9 round-2 review
  // reproduced this gap: widening the class to \u202a-\u202f left all 47 tests green, so nothing
  // would have noticed NARROW NO-BREAK SPACE \u2014 a legitimate printable \u2014 being corrupted in
  // every reported message. Same class as the \xa0 gap the round-1 review found at the C1 edge,
  // reappearing one edge over. Every range edge now has a pin on BOTH sides.
  it('escapes U+202E (last override) and leaves U+202F (NARROW NO-BREAK SPACE), the first code point past the range, unchanged', () => {
    expect(sanitizeTagText('a\u202e\u202fb')).toBe('a\\u202e\u202fb');
  });

  it('leaves U+2065, the last code point before the isolates, unchanged', () => {
    expect(sanitizeTagText('a\u2065b')).toBe('a\u2065b');
  });

  // Regression: zero-width/format characters are DELIBERATELY excluded \u2014 they neither split
  // lines nor reorder rendering, so widening the class to cover them would be a false fix. Pinned
  // so a future widening cannot silently swallow them.
  it('regression: zero-width and format characters still pass through unescaped', () => {
    expect(sanitizeTagText('a\u200bb')).toBe('a\u200bb'); // ZERO WIDTH SPACE
    expect(sanitizeTagText('a\ufeffb')).toBe('a\ufeffb'); // ZERO WIDTH NO-BREAK SPACE / BOM
    expect(sanitizeTagText('a\u200fb')).toBe('a\u200fb'); // RIGHT-TO-LEFT MARK
  });
});

describe('sanitizeTagText \u2014 the cap applies to the ESCAPED length, not the raw length', () => {
  // Reproduced: checking `tag.length <= MAX_MALFORMED_TAG_LENGTH` instead of `escaped.length`
  // left the suite at 26/26 passing \u2014 the PR's own "caps length" tests all use raw input already
  // far over 300, so they can't tell "checks escaped length" from "checks raw length".
  it('truncates when raw input is under the cap but escaping inflates it past the cap', () => {
    const raw = '\x01'.repeat(290); // 290 raw chars \u2014 well under the 300-char cap
    expect(raw.length).toBeLessThan(MAX_MALFORMED_TAG_LENGTH);

    const result = sanitizeTagText(raw);

    // Each \x01 escapes to the 4-char sequence \x01, inflating 290 raw chars to 1160 escaped
    // chars \u2014 comfortably over the cap despite the raw input being comfortably under it.
    expect(result).toBe(`${'\\x01'.repeat(75)}\u2026 [truncated, 1160 chars]`);
  });

  it('does not truncate when the escaped form lands exactly at the cap', () => {
    const raw = '\x01'.repeat(75); // escapes to exactly 300 chars (75 * 4)
    const escaped = '\\x01'.repeat(75);
    expect(escaped.length).toBe(MAX_MALFORMED_TAG_LENGTH);

    expect(sanitizeTagText(raw)).toBe(escaped);
  });
});

describe('MAX_URL_LENGTH bounding — the vacuity trap and the fix', () => {
  it('captures a url() at exactly MAX_URL_LENGTH characters', () => {
    const value = 'a'.repeat(MAX_URL_LENGTH);

    const urls = urlsInSrcDeclaration(`url(${value})`);

    expect(urls).toEqual([{ value, oversized: false }]);
  });

  it('reports oversized: true, never a silent skip, for a url() one char over MAX_URL_LENGTH', () => {
    const value = 'a'.repeat(MAX_URL_LENGTH + 1);

    const urls = urlsInSrcDeclaration(`url(${value})`);

    // Anti-vacuity: the naive fix (bounding only the regex quantifier) makes this url() simply
    // fail to match, so `urls` would come back EMPTY — a silent pass having verified nothing.
    // The real fix must instead report exactly one oversized finding.
    expect(urls).toHaveLength(1);
    expect(urls[0]?.oversized).toBe(true);
    expect(urls[0]?.value.length).toBeLessThan(400); // capped via sanitizeTagText
  });

  it('reports oversized: true for an @import specifier over MAX_URL_LENGTH', () => {
    const specifier = 'a'.repeat(MAX_URL_LENGTH + 500);

    const specifiers = extractImportSpecifiers(`@import "${specifier}";`);

    expect(specifiers).toHaveLength(1);
    expect(specifiers[0]?.oversized).toBe(true);
  });

  it('reports oversized: true for an @import url(...) specifier over MAX_URL_LENGTH', () => {
    const specifier = 'a'.repeat(MAX_URL_LENGTH + 500);

    const specifiers = extractImportSpecifiers(`@import url(${specifier});`);

    expect(specifiers).toHaveLength(1);
    expect(specifiers[0]?.oversized).toBe(true);
  });

  it('preserves document order across mixed @import url() and quoted forms', () => {
    const css = `@import "./a.css"; @import url(./b.css); @import "./c.css";`;

    const specifiers = extractImportSpecifiers(css).map((s) => s.value);

    expect(specifiers).toEqual(['./a.css', './b.css', './c.css']);
  });

  it('TIMING: many repeated url( starts, each followed by a long non-terminator run and no closing paren, completes well under 1000ms with the bound in place', () => {
    // Reproduces the measured quadratic blowup this module exists to fix (3.6ms at 1,000 repeats,
    // 193.6ms at 8,000, never completing at 500,000 -- see MAX_URL_LENGTH's doc comment) and
    // proves the bounded scan does not reintroduce it. Every `url(` occurrence below is followed
    // by 500 chars containing none of `'`, `"`, `)` -- with an UNBOUNDED capture class, each of
    // the 4,000 occurrences backtracks across effectively the rest of the string looking for a
    // closing paren that never comes, which is exactly the O(occurrences x remaining length)
    // shape that made this quadratic on pathological input.
    const REPEATS = 4000;
    const pathological = `url(${'a'.repeat(500)}`.repeat(REPEATS);

    const start = performance.now();
    urlsInSrcDeclaration(pathological);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(1000);
  });
});

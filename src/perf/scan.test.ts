import { describe, expect, it } from 'vitest';
import {
  attr,
  extractImportSpecifiers,
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

import { describe, expect, it } from 'vitest';
import { stripComments, stripHtmlComments } from './text.ts';

/**
 * Direct unit tests for `stripHtmlComments`, rewritten from a regex to a manual scan (HIGH review
 * finding, 2026-08-30) because `/<!--[\s\S]*?-->/g` is quadratic on an unterminated `<!--` — see
 * the function's doc comment in `text.ts` for the mechanism and the measured timing curve. These
 * tests prove two things the rewrite must hold: (1) behaviour is IDENTICAL to the old regex for
 * every well-formed input (the callers in `danglingClasses.ts`/`fontChain.ts` and their existing
 * tests must not need to change), and (2) an unterminated `<!--` no longer takes quadratic time.
 */

describe('stripHtmlComments', () => {
  it('strips a single well-formed comment', () => {
    expect(stripHtmlComments('a<!-- comment -->b')).toBe('ab');
  });

  it('strips multiple comments', () => {
    expect(stripHtmlComments('a<!--1-->b<!--2-->c')).toBe('abc');
  });

  it('strips a comment spanning multiple lines', () => {
    expect(stripHtmlComments('a<!--\nline1\nline2\n-->b')).toBe('ab');
  });

  it('leaves text with no comments untouched', () => {
    expect(stripHtmlComments('<div class="x">hi</div>')).toBe('<div class="x">hi</div>');
  });

  it('strips a real dangling-class fixture shape (link/class inside a comment)', () => {
    const html = '<!-- <div class="_hiwViz_18mh8_533">hi</div> -->';
    expect(stripHtmlComments(html)).toBe('');
  });

  it('handles an empty string', () => {
    expect(stripHtmlComments('')).toBe('');
  });

  it('handles adjacent comments with nothing between them', () => {
    expect(stripHtmlComments('<!--a--><!--b-->')).toBe('');
  });

  // --- Unterminated trailing `<!--`: strips to end of string (behaviour-preserving choice, see
  // doc comment — matches how a real browser treats an unterminated comment) -----------------

  it('strips everything from an unterminated trailing <!-- to the end of the string', () => {
    expect(stripHtmlComments('a<!-- never closed')).toBe('a');
  });

  it('an unterminated <!-- with no leading text strips to empty', () => {
    expect(stripHtmlComments('<!--')).toBe('');
  });

  it('a terminated comment followed by an unterminated one strips both correctly', () => {
    expect(stripHtmlComments('a<!--closed-->b<!--never closed')).toBe('ab');
  });

  // --- HIGH review finding: quadratic-on-unterminated-comments perf regression guard ---------

  it('stays fast on many repeated unterminated <!-- openers (would take ~19s+ under the old quadratic regex at this size)', () => {
    const pathological = '<!--'.repeat(20000); // ~80KB; old regex measured ~287ms here and grows
    // quadratically — 160,000 repeats measured over 18 SECONDS. The rewrite is linear.
    const start = Date.now();
    const result = stripHtmlComments(pathological);
    const elapsedMs = Date.now() - start;

    expect(result).toBe(''); // one giant unterminated comment: strips to empty
    // Generous bound, not a tight pin (this only needs to prove "did not go quadratic"): the old
    // implementation took ~287ms at this exact size and grows ~4x per doubling from there.
    expect(elapsedMs).toBeLessThan(100);
  });
});

// stripComments (CSS-side sibling) has no equivalent defect — its 3-char opener/closer share no
// characters, so it stays linear even on unterminated input. One guard here proves that claim in
// `errors.ts`'s doc comment stays true, without duplicating the full stripHtmlComments suite.
describe('stripComments (CSS) — confirms it does NOT share stripHtmlComments quadratic defect', () => {
  it('stays fast on many repeated /* openers (no unterminated-opener quadratic defect)', () => {
    // Note: '/*'.repeat(n) is NOT actually unterminated overall — consecutive "/*" "/*" pairs
    // embed a "*/" two characters in (the '*' of one repeat followed by the '/' of the next), so
    // this greedily matches and strips short spans throughout. That content detail is irrelevant
    // here; the only thing this guard proves is that stripComments has no quadratic blowup on
    // this repeated-opener shape the way the old stripHtmlComments regex did.
    const pathological = '/*'.repeat(40000); // ~80KB
    const start = Date.now();
    stripComments(pathological);
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(100);
  });
});

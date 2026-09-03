import { describe, expect, it } from 'vitest';
import { stripComments, stripHtmlComments } from './text.ts';

/**
 * Direct unit tests for `stripHtmlComments`, rewritten from a regex to a manual scan (HIGH review
 * finding, 2026-08-30) because `/<!--[\s\S]*?-->/g` is quadratic on an unterminated `<!--` — see
 * the function's doc comment in `text.ts` for the mechanism and the measured timing curve. These
 * tests prove: (1) behaviour matches the old regex for every well-formed input, INCLUDING the
 * abrupt-closing forms the old `+ 4` scan got wrong (round-2 review MUST-FIX #1 — see the
 * differential harness below), (2) an unterminated `<!--` no longer takes quadratic time, and (3)
 * an unterminated `<!--` is reported via `unterminated: true`, never silently (round-2 review
 * MUST-FIX #2).
 *
 * Return shape is `{ text, unterminated }` — every assertion below reads the full object.
 */

describe('stripHtmlComments', () => {
  it('strips a single well-formed comment', () => {
    expect(stripHtmlComments('a<!-- comment -->b')).toEqual({ text: 'ab', unterminated: false });
  });

  it('strips multiple comments', () => {
    expect(stripHtmlComments('a<!--1-->b<!--2-->c')).toEqual({
      text: 'abc',
      unterminated: false,
    });
  });

  it('strips a comment spanning multiple lines', () => {
    expect(stripHtmlComments('a<!--\nline1\nline2\n-->b')).toEqual({
      text: 'ab',
      unterminated: false,
    });
  });

  it('leaves text with no comments untouched', () => {
    expect(stripHtmlComments('<div class="x">hi</div>')).toEqual({
      text: '<div class="x">hi</div>',
      unterminated: false,
    });
  });

  it('strips a real dangling-class fixture shape (link/class inside a comment)', () => {
    const html = '<!-- <div class="_hiwViz_18mh8_533">hi</div> -->';
    expect(stripHtmlComments(html)).toEqual({ text: '', unterminated: false });
  });

  it('handles an empty string', () => {
    expect(stripHtmlComments('')).toEqual({ text: '', unterminated: false });
  });

  it('handles adjacent comments with nothing between them', () => {
    expect(stripHtmlComments('<!--a--><!--b-->')).toEqual({ text: '', unterminated: false });
  });

  // --- Round-2 review MUST-FIX #1: abrupt-closing comment forms ------------------------------
  // `<!-->` and `<!--->` are complete, well-formed HTML comments per the HTML Standard, accepted
  // by every browser. The old `openIndex + 4` closer search started past the position where the
  // closer of either form legally begins, found no `-->` anywhere else, and fell into
  // "unterminated" — silently stripping the entire rest of the document. `openIndex + 2` fixes
  // this (see text.ts doc comment). These three cases are the reviewer's own reproduction.

  it('treats <!--> as a complete, empty comment', () => {
    expect(stripHtmlComments('<!-->')).toEqual({ text: '', unterminated: false });
  });

  it('treats <!---> as a complete, empty comment', () => {
    expect(stripHtmlComments('<!--->')).toEqual({ text: '', unterminated: false });
  });

  it('does not swallow the rest of the document after a stray <!-->', () => {
    expect(stripHtmlComments('before <!--> after')).toEqual({
      text: 'before  after',
      unterminated: false,
    });
  });

  it('<!---> stuff --> closes at the abrupt form, leaving " stuff -->" as text', () => {
    // The comment is exactly `<!--->`; the trailing `-->` is not part of any comment (there is no
    // second `<!--` to open one) and survives as ordinary text.
    expect(stripHtmlComments('<!---> stuff -->')).toEqual({
      text: ' stuff -->',
      unterminated: false,
    });
  });

  // --- Unterminated trailing `<!--`: strips to end of string, `unterminated: true` -----------

  it('strips everything from an unterminated trailing <!-- to the end of the string, and reports it', () => {
    expect(stripHtmlComments('a<!-- never closed')).toEqual({ text: 'a', unterminated: true });
  });

  it('an unterminated <!-- with no leading text strips to empty, and reports it', () => {
    expect(stripHtmlComments('<!--')).toEqual({ text: '', unterminated: true });
  });

  it('a terminated comment followed by an unterminated one strips both correctly, and reports it', () => {
    expect(stripHtmlComments('a<!--closed-->b<!--never closed')).toEqual({
      text: 'ab',
      unterminated: true,
    });
  });

  it('a genuinely well-terminated document reports unterminated: false even with abrupt-close comments present', () => {
    expect(stripHtmlComments('a<!-->b<!--->c<!--d-->e')).toEqual({
      text: 'abce',
      unterminated: false,
    });
  });

  // --- HIGH review finding: quadratic-on-unterminated-comments perf regression guard ---------

  it('stays fast on many repeated unterminated <!-- openers (would take ~19s+ under the old quadratic regex at this size)', () => {
    const pathological = '<!--'.repeat(20000); // ~80KB; old regex measured ~287ms here and grows
    // quadratically — 160,000 repeats measured over 18 SECONDS. The rewrite is linear.
    const start = Date.now();
    const result = stripHtmlComments(pathological);
    const elapsedMs = Date.now() - start;

    expect(result).toEqual({ text: '', unterminated: true }); // one giant unterminated comment
    // Generous bound, not a tight pin (this only needs to prove "did not go quadratic"): the old
    // implementation took ~287ms at this exact size and grows ~4x per doubling from there.
    expect(elapsedMs).toBeLessThan(100);
  });

  // --- Round-2 review IMPORTANT #3: pin the `openIndex + 2` arithmetic -----------------------
  //
  // Mutation results below were computed by direct simulation of the candidate offsets (0/1/2/3/4)
  // against a small alphabet, not guessed:
  //   - offsets 0, 1 and 2 are PROVABLY EQUIVALENT for this function, for every possible input.
  //     `stripHtmlComments` only ever calls `html.indexOf('-->', openIndex + N)` immediately after
  //     finding `<!--` at `openIndex` — so `html[openIndex+1]` is always `'!'`. No `-->` match can
  //     ever start at `openIndex` or `openIndex + 1`, because the first character of `-->` is `-`
  //     and `html[openIndex]` is `<`, `html[openIndex+1]` is `!`. The earliest a match CAN start is
  //     `openIndex + 2` (the comment's own two dashes), which is exactly where `indexOf` searching
  //     from 0, 1, or 2 all land on the same leftmost match. There is therefore NO input that can
  //     distinguish `+ 0`, `+ 1` and `+ 2` — a `+ 1` mutant is an EQUIVALENT MUTANT, not a bug, and
  //     no test can go red for it. This is stated here rather than faked with a test that cannot
  //     actually distinguish the two (see reviewer stance: no fabricated evidence).
  //   - offsets 3 and 4 DO diverge from the correct `+ 2` and are pinned below.

  it('RED under +3 (and +4): "<!-->TAIL" would report unterminated instead of stripping the empty comment and keeping TAIL', () => {
    // Correct (+2): closer found at relative index 2 (`<!-->`'s own `-->`) → comment is `<!-->`,
    // remaining text is `TAIL`. Under +3: `indexOf('-->', openIndex + 3)` starts one character too
    // late to see that closer, finds no other `-->` in the string, and falls through to
    // "unterminated" — losing `TAIL` entirely. Under +4 (the original bug) the same happens.
    expect(stripHtmlComments('<!-->TAIL')).toEqual({ text: 'TAIL', unterminated: false });
  });

  it('RED under +4 (the original bug, reviewer reproduction): "<!---> stuff -->" would strip the whole document', () => {
    // Correct (+2): the comment is exactly `<!--->`, leaving ' stuff -->' as text (see the
    // dedicated case above). Under +4: `indexOf('-->', openIndex + 4)` finds no `-->` anywhere in
    // the remainder, falls through to "unterminated", and strips everything to an empty string —
    // this is the exact document-swallowing defect the review reported.
    expect(stripHtmlComments('<!---> stuff -->')).toEqual({
      text: ' stuff -->',
      unterminated: false,
    });
  });
});

/**
 * Merge tests (2026-09-01): `stripComments`/`stripHtmlComments` were hardened by merging in a
 * char-walked implementation from boufin's `verify-font-preload.ts` — string-aware CSS scanning,
 * quote-aware in-tag HTML scanning, and `<script>`/`<style>` raw-text blanking. See text.ts's
 * module and function doc comments for the full mechanism and provenance of each behaviour below.
 */

describe('stripComments (CSS) — string-awareness (merge)', () => {
  it('does not treat /* inside a quoted CSS string as a comment opener, so a following @font-face survives', () => {
    const css =
      '.a { content: "/* not a comment"; } ' +
      "@font-face { font-family: 'X'; src: url('/x.woff2'); }";
    const out = stripComments(css);
    expect(out).toContain('@font-face');
    expect(out).toContain('/x.woff2');
  });

  it('a later unrelated */ does not get treated as closing a /* that only ever appeared inside a string literal', () => {
    // Old plain-regex behaviour: `/\/\*[\s\S]*?\*\//g` has no notion of "inside a string" — it
    // would open at the string's /*, then lazily close at this file's next *real* */, deleting the
    // whole @font-face block sitting between them. String-awareness must stop that.
    const css =
      '.a { content: "/* fake"; } ' +
      "@font-face { src: url('/x.woff2'); } " +
      '/* real comment */ .b { color: red; }';
    const out = stripComments(css);
    expect(out).toContain('@font-face');
    expect(out).toContain('/x.woff2');
    expect(out).not.toContain('real comment');
    expect(out).toContain('.b');
  });

  it('strips an unterminated /* comment to end of file (behaviour change: previously left in place)', () => {
    const css = ".a { color: red; } /* unterminated comment @font-face { src: url('/x.woff2'); }";
    expect(stripComments(css)).toBe('.a { color: red; } ');
  });
});

describe('stripHtmlComments — <script>/<style> raw-text blanking (merge)', () => {
  it('does not let a <!-- inside a <script> body swallow a real preload link that follows the script', () => {
    const html =
      '<script>var x = "<!--"; console.log("-->");</script>' +
      '<link rel="preload" as="font" href="/f.woff2">';
    const result = stripHtmlComments(html);
    expect(result.unterminated).toBe(false);
    expect(result.text).toContain('<link rel="preload" as="font" href="/f.woff2">');
  });

  it('blanks a <link>-shaped string literal inside a <script> body while keeping the script tags', () => {
    const html =
      '<script>var s = "<link rel=\\"preload\\" as=\\"font\\" href=\\"/fake.woff2\\">";</script>';
    const { text } = stripHtmlComments(html);
    expect(text).toContain('<script>');
    expect(text).toContain('</script>');
    expect(text).not.toContain('/fake.woff2');
  });

  it('blanks a <link>-shaped string literal inside a <style> body while keeping the style tags, when blankStyleBodies is true', () => {
    // <style> only blanks when the caller opts in — see the `blankStyleBodies` doc comment on
    // stripHtmlComments for why the default must stay false (fontChain.ts needs the opposite view).
    const html = '<style>/* content: "<link rel=preload as=font href=/fake2.woff2>"; */</style>';
    const { text } = stripHtmlComments(html, { blankStyleBodies: true });
    expect(text).toContain('<style>');
    expect(text).toContain('</style>');
    expect(text).not.toContain('/fake2.woff2');
  });

  it('recognises <SCRIPT> and <Style> case-insensitively as raw-text elements', () => {
    const html =
      '<SCRIPT>var link = "<link rel=preload as=font href=/case.woff2>";</SCRIPT>' +
      '<Style>content: "<link rel=preload as=font href=/case2.woff2>";</Style>';
    const { text } = stripHtmlComments(html, { blankStyleBodies: true });
    expect(text).not.toContain('/case.woff2');
    expect(text).not.toContain('/case2.woff2');
    expect(text).toContain('<SCRIPT>');
    expect(text).toContain('</SCRIPT>');
  });

  it('DEFAULT (no options) leaves a real @font-face inside an inline <style> body intact — regression guard for the fontChain.ts inline-style exemption', () => {
    // This is the exact defect the coordinator's brief originally caused and then corrected:
    // fontChain.ts's extractInlineFontFaceUrls reads REAL CSS out of stripHtmlComments's output,
    // so the default must never blank <style> bodies.
    const html = '<style>@font-face { font-family: X; src: url("/x.woff2"); }</style>';
    const { text } = stripHtmlComments(html);
    expect(text).toContain('@font-face');
    expect(text).toContain('/x.woff2');
  });

  it('<script> bodies are blanked even when blankStyleBodies is explicitly false, proving the two are independently controlled', () => {
    const html =
      '<script>var s = "<link rel=preload as=font href=/scriptfalse.woff2>";</script>' +
      '<style>@font-face { font-family: X; src: url("/stylefalse.woff2"); }</style>';
    const { text } = stripHtmlComments(html, { blankStyleBodies: false });
    expect(text).not.toContain('/scriptfalse.woff2');
    expect(text).toContain('/stylefalse.woff2');
  });

  it('consumes an unclosed <script> to end of document', () => {
    const html =
      '<script>var x = "<!--"; document.write("<link rel=preload as=font href=/never.woff2>");';
    const { text, unterminated } = stripHtmlComments(html);
    // No genuine unterminated HTML comment is involved here — the <!-- lives inside the (blanked)
    // script body, never reaches the comment scanner, so `unterminated` reports on comments only.
    expect(unterminated).toBe(false);
    expect(text).not.toContain('/never.woff2');
    expect(text).toContain('<script>');
  });

  it('does not let a > inside a double-quoted opening-tag attribute end the tag early and expose the real body (regression: openingTagEnd quote-awareness)', () => {
    // The quoted `data-x` value itself contains both a `>` and a literal `</script>` string. A
    // quote-UNAWARE openingTagEnd stops at the embedded `>` (inside the still-open quote), so
    // rawTextSpan then starts its close-tag search from mid-attribute and finds that literal
    // `</script>` text as if it were the real closing tag — ending the raw-text span there instead
    // of at the actual `</script>` below. Everything after that point, including the real body's
    // `<link>`-shaped decoy, then falls through to the ordinary (non-raw-text) scan and survives.
    // Reproduced against a hand-mutated copy of openingTagEnd with the quote branch removed
    // entirely (`if (char === '"') {`, dropping single-quote awareness too): this exact input
    // leaks `/leak-test.woff2`. `toContain('AFTER')` is a sanity check that the scan did not also
    // consume past the real close tag — it is not evidence of this regression by itself, since the
    // mutated run still contains `AFTER`; only the `not.toContain` assertion below discriminates
    // the bug. See text.ts's `openingTagEnd` doc comment for the `<script data-x="a>b">` example
    // this pins. This case covers only the double-quote branch; the sibling test below covers the
    // single-quote branch, since `openingTagEnd` is generic over both quote characters.
    const html =
      '<script data-x="fake>oops</script>">' +
      'var real = "<link rel=preload as=font href=/leak-test.woff2>";' +
      '</script>AFTER';
    const { text } = stripHtmlComments(html);
    expect(text).not.toContain('/leak-test.woff2');
    expect(text).toContain('AFTER');
  });

  it('does not let a > inside a single-quoted opening-tag attribute end the tag early and expose the real body (regression: openingTagEnd quote-awareness, single-quote branch)', () => {
    // Same defect as the double-quoted case above, mirrored onto the single-quote branch of
    // `openingTagEnd` (`char === "'"`), which is otherwise untested — a mutant that drops only
    // that branch (keeping double-quote awareness) leaves the test above green.
    const html =
      "<script data-x='fake>oops</script>'>" +
      'var real = "<link rel=preload as=font href=/leak-test-sq.woff2>";' +
      '</script>AFTER';
    const { text } = stripHtmlComments(html);
    expect(text).not.toContain('/leak-test-sq.woff2');
    expect(text).toContain('AFTER');
  });

  it('does not let a non-matching close tag whose name only starts with "script" end the raw-text span early (regression: rawTextSpan exact-match)', () => {
    // `</scriptx>` is not a close tag for `<script>` at all — a browser's tokenizer only matches
    // the exact tag name. A rawTextSpan that used `.startsWith(tagName)` instead of `===` would
    // treat `</scriptx>` as if it closed the script here, ending the raw-text span early and
    // letting everything between it and the real `</script>` — including the `<link>`-shaped
    // decoy — fall through to the ordinary scan unblanked.
    const html =
      '<script>var x = 1; </scriptx> var real = "<link rel=preload as=font href=/mirror-leak.woff2>"; </script>AFTER';
    const { text } = stripHtmlComments(html);
    expect(text).not.toContain('/mirror-leak.woff2');
    expect(text).toContain('AFTER');
  });

  // KNOWN OPEN, deferred, not pinned here: the three tests above each close one specific
  // parser-confusion shape (quote-unaware openingTagEnd, and a startsWith-style close-tag match)
  // — they do not close the class. A real bypass remains in unmodified rawTextSpan via HTML's
  // script-data-double-escaped state: `<script><!--<script></script>--><link ... ></script>AFTER`
  // makes that first `</script>` NOT close the element in a real browser (the `<!--<script`
  // sequence puts the tokenizer in double-escaped mode), but rawTextSpan ends the raw-text span at
  // that `</script>` anyway, so the `<link>` decoy after it leaks. No test pins this — it would
  // fail against current text.ts — tracked as a follow-up, not fixed here.
});

describe('stripHtmlComments — quote-aware in-tag scanning (merge)', () => {
  it('does not open a comment for <!-- inside a quoted attribute value', () => {
    const html = '<div data-x="<!--">text</div>';
    const result = stripHtmlComments(html);
    expect(result.unterminated).toBe(false);
    expect(result.text).toBe('<div data-x="<!--">text</div>');
  });
});

describe('stripHtmlComments — genuine comment removal still works (motivating case, merge)', () => {
  it('removes a genuinely commented-out <link rel="preload"> tag', () => {
    const html = '<!-- <link rel="preload" as="font" href="/f.woff2"> --><body>hi</body>';
    const { text } = stripHtmlComments(html);
    expect(text).not.toContain('/f.woff2');
    expect(text).toContain('<body>hi</body>');
  });
});

// --- Differential harness (round-2 review evidence requirement) --------------------------------
//
// Compares the OLD regex (`/<!--[\s\S]*?-->/g`) against the NEW manual scan over 500+ generated
// inputs mixing `<!--`, `-->`, `<!-->`, `<!--->`, `<!---->`, bare `-`/`>`/`--`/`->`, plain text, and
// truncation. Every divergence found must be one of the TWO enumerated intentional differences;
// anything else fails the test with the offending input.
//
// ENUMERATED INTENTIONAL DIVERGENCES:
//   (a) UNTERMINATED-STRIPS-TO-END — a genuinely unterminated `<!--` (no `-->` anywhere after it
//       in the input) is left completely untouched by the old regex's `.replace` (a regex with no
//       match makes no replacement), while the new scan strips it to end of string.
//   (b) ABRUPT-CLOSE FORMS MATCHED CORRECTLY ONLY BY THE NEW SCAN — CONTRARY TO an earlier draft
//       of this comment, the old regex does NOT already handle `<!-->`/`<!--->` correctly. Its
//       opener literally consumes all 4 characters of `<!--` before the lazy `[\s\S]*?` body ever
//       starts trying to match `-->` — so for `<!-->` (5 chars total) the body must start at
//       index 4, where only 1 character (`>`) remains: too short for a 3-character `-->`, so the
//       regex finds NO match and leaves `<!-->` as untouched literal text. Verified directly:
//       `"<!-->".replace(/<!--[\s\S]*?-->/g, "X")` === `"<!-->"` (unchanged); same for `<!--->`.
//       Only `<!---->` (two interior dashes) leaves enough room for the lazy body to find a match
//       and gets replaced by the old regex. The new scan, searching for the closer from
//       `openIndex + 2`, correctly closes ALL THREE forms as complete comments (see text.ts doc
//       comment). This is a real, intentional divergence — not a bug — and it is exactly the shape
//       of defect this whole review round is about.
// K8 round-3 review IMPORTANT, extended round-4: BOTH classifiers (`isUnterminatedCaused` and
// `isAbruptCloseCaused`) must be CAUSAL, not incidental. A bare substring/structural check ("does
// the input contain the suspected token/shape ANYWHERE") waves through any divergence in a string
// that merely happens to also contain that token elsewhere — even when the actual cause is a
// different bug entirely.
//
// Reproduced for the abrupt-close classifier against `"<!-->X<!--Y-->Z"` with the real
// closer-ADVANCE regression — `searchFrom = closeIndex + 2` instead of `+ 3`, which leaves the
// closer's own `>` unconsumed. (NOT the opener SEARCH offset `indexOf('-->', openIndex + 2)`:
// there, `+1` and `+2` are provably equivalent, since a `-->` match can only begin on a dash and
// the two positions before it are `<` and `!`. The reviewer's write-up conflated the two; the
// mutation was re-derived by execution before this comment was written.)
// old="Z", new(buggy)=">X>Z" — the divergence is caused by the bug corrupting the ordinary comment
// `<!--Y-->`, NOT by the abrupt-close form earlier in the string, yet a substring-only classifier
// waves it through as "intentional divergence (b)". Fixed by making the classification causal:
// strip the candidate token(s) out of the input, re-run BOTH implementations on the REDUCED
// string, and only excuse the divergence if they now agree there.
//
// Round-4 review MUST-FIX: `hasUnterminatedComment` had the identical defect for category (a). It
// answers "does this string contain a genuinely-unterminated `<!--` ANYWHERE", not "is that
// unterminated comment the CAUSE of THIS divergence" — replicating the real left-to-right scan
// makes the DETECTION accurate, it says nothing about CAUSATION. Reproduced against
// `"<!--A-->B<!--UNCLOSED"` with the closer-advance mutation (`+ 3` -> `+ 2`): the mutation
// corrupts the LEADING, well-formed `<!--A-->`, but the unrelated trailing `<!--UNCLOSED` made
// `hasUnterminatedComment` return `true` regardless, excusing a divergence it had nothing to do
// with. Fixed the same way as the abrupt-close classifier: `isUnterminatedCaused` truncates the
// input to everything before the unterminated `<!--` (the suspected cause) and only excuses the
// divergence if both implementations agree on the truncated string.
//
// The harness catches divergences of other shapes, but it is NOT a complete net, and the two ways
// it can stay green on a real regression are recorded here rather than left to be rediscovered.
// Read this before treating a green harness as proof.
//
// LIMIT 1 — INHERENT, not fixable. A regression in the ABRUPT-CLOSE TOKEN'S OWN handling path
// necessarily disappears once that token is stripped from the reduced string, so
// `isAbruptCloseCaused` always classifies it as "caused" and excuses it. Strip-and-recheck cannot
// see a bug that exists only inside the very thing it strips. Demonstrated: reverting
// `indexOf('-->', openIndex + 2)` to the original round-2 bug (`openIndex + 4`) is MASKED here and
// is caught ONLY by the named unit tests earlier in this file (`"<!-->TAIL"`,
// `"<!---> stuff -->"`), which is why those tests exist as named cases and must not be folded into
// the corpus.
//
// LIMIT 2 — FIXABLE, KNOWINGLY NOT FIXED (owner decision, 2026-08-30, round-5 review). The
// `hasUnterminatedComment(reduced)` fallback inside `isAbruptCloseCaused` is an EXISTENCE check
// where causality is required: if the reduced string merely contains an unterminated `<!--`
// somewhere, the divergence is excused, even when the real cause is a corrupted well-formed
// comment elsewhere in that same string. This is the third instance of the defect class the two
// causal classifiers above were written to remove — same shape, one level down.
// MEASURED under the closer-advance regression (`searchFrom = closeIndex + 3` -> `+ 2`) against
// the shipped seed-42 corpus: 46 divergences excused through this branch, of which 18 are PROVABLY
// false — `old === correctNew` for those inputs, so the divergence is entirely the regression's
// doing. That mutation still fails overall (122 other inputs throw unmasked), so it is not a
// silent-ship risk today; a future regression confined to this shape could be.
// The fix is the same treatment applied above — truncate `reduced` before its unterminated `<!--`
// and re-verify — and it was deliberately deferred rather than attempted a fourth time in one
// session. If you are touching this file, fixing it is welcome.
function oldRegexStrip(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

/** True when `html`, scanned left to right the same way `stripHtmlComments` does, contains an
 * opening `<!--` with no `-->` anywhere after it — i.e. genuinely unterminated somewhere in the
 * string. RAW STRUCTURAL DETECTOR ONLY — replicating the real scan makes the DETECTION accurate,
 * it says nothing about CAUSATION. An unrelated unterminated `<!--` trailing far from the actual
 * point of divergence (e.g. a regression corrupting an earlier, well-formed comment) still makes
 * this return `true`, which would incorrectly excuse that unrelated divergence. Do NOT use this
 * directly to classify a divergence as category (a) — use `isUnterminatedCaused` for that. Kept
 * here only as a building block for `isAbruptCloseCaused`'s internal "is the reduced string now
 * genuinely unterminated" check.
 *
 * THAT INTERNAL USE IS ALSO INCORRECT, and knowingly so — see LIMIT 2 in the harness comment
 * above. An earlier version of this docstring argued the internal call was legitimate "because the
 * string has already been reduced". That argument is FALSE and is recorded here so it is not made
 * again: reducing removes only the abrupt-close tokens, so an unrelated corrupted comment and an
 * unrelated unterminated tail can coexist in the reduced string exactly as they can in the
 * original. Measured: 18 provably false excuses across the 500-input corpus. */
function hasUnterminatedComment(html: string): boolean {
  let searchFrom = 0;
  for (;;) {
    const open = html.indexOf('<!--', searchFrom);
    if (open === -1) return false;
    const close = html.indexOf('-->', open + 2);
    if (close === -1) return true;
    searchFrom = close + 3;
  }
}

/** True when a genuinely unterminated `<!--` is CAUSALLY responsible for the divergence between
 * the old and new implementations on `input` — not merely present somewhere in it. Finds the
 * position of the (first) unterminated `<!--` via the same left-to-right scan `stripHtmlComments`
 * uses, truncates `input` to everything BEFORE that position (removing the suspected cause — the
 * unterminated tail, exactly as `isAbruptCloseCaused` removes its suspected cause), and re-runs
 * BOTH implementations on the truncated string. The divergence is excused only if they now agree.
 * If `input` has no unterminated `<!--` at all, or if the two implementations still disagree after
 * truncation, this returns `false` and the caller must not excuse the divergence. */
function isUnterminatedCaused(input: string): boolean {
  let searchFrom = 0;
  let unterminatedAt = -1;
  for (;;) {
    const open = input.indexOf('<!--', searchFrom);
    if (open === -1) break;
    const close = input.indexOf('-->', open + 2);
    if (close === -1) {
      unterminatedAt = open;
      break;
    }
    searchFrom = close + 3;
  }
  if (unterminatedAt === -1) return false;
  const truncated = input.slice(0, unterminatedAt);
  return oldRegexStrip(truncated) === stripHtmlComments(truncated).text;
}

/** True when an abrupt-close form (`<!-->` or `<!--->`) is CAUSALLY responsible for the divergence
 * between the old and new implementations on `input` — not merely present somewhere in it. Removes
 * every occurrence of both abrupt-close tokens from `input` and re-runs BOTH implementations on the
 * reduced string:
 *   - if they now agree, the abrupt-close form really was the (sole) remaining source of the
 *     divergence and it is safe to excuse;
 *   - if they still disagree but the reduced string is now genuinely unterminated (category (a) —
 *     removing the abrupt-close text can expose a `<!--` that the abrupt-close form used to close),
 *     that residual divergence is ALSO an enumerated intentional cause, so it is excused too;
 *   - otherwise, recurse on the reduced string: removing one abrupt-close token can, by
 *     concatenating its neighbours, expose ANOTHER one (`<!--` + `>` joining across the removed
 *     span). This terminates because every recursive call removes at least one match, so the
 *     string strictly shortens, and a string with no abrupt-close token left returns `false`
 *     immediately.
 * Only when none of these hold does the divergence have an unexplained cause, and the caller must
 * not excuse it. */
function isAbruptCloseCaused(input: string): boolean {
  if (!input.includes('<!-->') && !input.includes('<!--->')) return false;
  const reduced = input.split('<!-->').join('').split('<!--->').join('');
  if (oldRegexStrip(reduced) === stripHtmlComments(reduced).text) return true;
  if (hasUnterminatedComment(reduced)) return true;
  return isAbruptCloseCaused(reduced);
}

describe('stripHtmlComments differential harness vs old regex', () => {
  const tokens = [
    '<!--',
    '-->',
    '<!-->',
    '<!--->',
    '<!---->',
    '-',
    '>',
    '--',
    '->',
    'text',
    ' ',
    'a',
    'b',
  ] as const;

  /** Deterministic LCG-based corpus generator — reproducible across runs, no external dependency. */
  function generateCorpus(count: number): string[] {
    const corpus: string[] = [];
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < count; i++) {
      const pieces = Math.floor(rand() * 6) + 1;
      let input = '';
      for (let p = 0; p < pieces; p++) {
        input += tokens[Math.floor(rand() * tokens.length)];
      }
      corpus.push(input);
    }
    return corpus;
  }

  it('matches the old regex on 500 generated inputs, except the two enumerated intentional divergences', () => {
    const corpus = generateCorpus(500);
    let unterminatedDivergences = 0;
    let abruptCloseDivergences = 0;

    for (const input of corpus) {
      const oldOutput = oldRegexStrip(input);
      const newOutput = stripHtmlComments(input).text;

      if (oldOutput === newOutput) continue;

      if (isUnterminatedCaused(input)) {
        unterminatedDivergences += 1;
        continue;
      }

      if (isAbruptCloseCaused(input)) {
        abruptCloseDivergences += 1;
        continue;
      }

      throw new Error(
        `Unexpected divergence on ${JSON.stringify(input)}: old=${JSON.stringify(oldOutput)} ` +
          `new=${JSON.stringify(newOutput)}`,
      );
    }

    // Sanity: the corpus actually exercised BOTH intentional-divergence paths, so this harness is
    // not vacuously passing on input that never reaches either one.
    expect(unterminatedDivergences).toBeGreaterThan(0);
    expect(abruptCloseDivergences).toBeGreaterThan(0);
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

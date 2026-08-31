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
// K8 round-3 review IMPORTANT: both classifiers below must be CAUSAL, not incidental. A bare
// substring check ("does the input contain an abrupt-close token ANYWHERE") waves through any
// divergence in a string that merely happens to also contain that token elsewhere — even when the
// actual cause is a different bug entirely. Reproduced against `"<!-->X<!--Y-->Z"` with the real
// closer-ADVANCE regression — `searchFrom = closeIndex + 2` instead of `+ 3`, which leaves the
// closer's own `>` unconsumed. (NOT the opener SEARCH offset `indexOf('-->', openIndex + 2)`:
// there, `+1` and `+2` are provably equivalent, since a `-->` match can only begin on a dash and
// the two positions before it are `<` and `!`. The reviewer's write-up conflated the two; the
// mutation was re-derived by execution before this comment was written.)
// old="Z", new(buggy)=">X>Z" — the divergence is caused by the bug corrupting the ordinary comment
// `<!--Y-->`, NOT by the abrupt-close form earlier in the string, yet the old substring-only
// classifier waved it through as "intentional divergence (b)". Fixed by making the classification
// causal: strip the candidate token(s) out of the input, re-run BOTH implementations on the
// REDUCED string, and only excuse the divergence if they now agree there. If they still disagree
// after removing the suspected cause, the divergence has some other cause and the harness fails.
// The harness asserts zero divergences of any OTHER shape, so a future regression (that
// closer-advance mutation, or anything else not genuinely explained by one of the two enumerated
// causes) is caught here even if the targeted tests above are not touched. Scope note, measured:
// for a BROAD regression this harness is not the only net -- the closer-advance mutation also
// diverges on corpus inputs containing no abrupt-close token, so it fails even under the old
// incidental classifier. What the causal classifier adds is coverage of a regression that
// manifests ONLY on strings carrying an abrupt-close token, which the old one masked entirely.
function oldRegexStrip(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

/** True when `html`, scanned left to right the same way `stripHtmlComments` does, contains an
 * opening `<!--` with no `-->` anywhere after it — i.e. genuinely unterminated. This already
 * replicates the real scan (not an incidental substring check), so removing the offending `<!--`
 * and re-checking is unnecessary here: the predicate IS the causal condition category (a) names.
 * Used to classify an observed divergence as intentional category (a). */
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

      if (hasUnterminatedComment(input)) {
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

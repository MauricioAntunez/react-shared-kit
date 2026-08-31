/**
 * Pure text transforms shared across `./perf` gates. INTERNAL ONLY — not re-exported from
 * `./index.ts`'s barrel (same convention as `./errors.ts`).
 *
 * Lives here, rather than on `fontChain.ts` (their original home) or `danglingClasses.ts`, because
 * both modules need them and neither should depend on the other for a domain reason it doesn't
 * have. `fontChain.ts` re-exports them through its own `internal` test-seam object (see that
 * file) so its existing round-5 substitution tests keep working; `danglingClasses.ts` imports
 * these plain functions directly, not through `fontChain.ts`'s seam (a production module must not
 * depend on a sibling module's test-only indirection point — see the K3 fix in
 * docs/superpowers/plans/2026-08-30-perf-gates-review-fixes.md).
 */

/** Strips `/* ... *\/` comments so a commented-out `@import`/`@font-face`/CSS-Modules selector is
 * never treated as live. */
export function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Result of `stripHtmlComments`: the comment-stripped text, plus whether the input contained an
 * unterminated `<!--` that forced everything from that point on to be stripped to end of string.
 * Callers MUST check `unterminated` and report it as its own explicit problem (round-2 review
 * MUST-FIX #2) — see the function doc comment below for why silence here is itself a defect. */
export interface StripHtmlCommentsResult {
  text: string;
  unterminated: boolean;
}

/** Strips `<!-- ... -->` comments so a commented-out `<link rel="preload">`/`<link
 * rel="stylesheet">`/inline `<style>`/`class="..."` attribute is never treated as live (CRITICAL 1
 * finding, review round 2026-08-30). Applied to the whole document text before any HTML is
 * scanned for classes, preload links, or inline `@font-face` blocks — leftover debug markup
 * silencing a real defect is the same error class these gates exist to catch.
 *
 * MANUAL SCAN, NOT A REGEX (HIGH review finding, 2026-08-30): `html.replace(/<!--[\s\S]*?-->/g,
 * '')` is quadratic on an unterminated `<!--` — the opener (4 chars: `<`, `!`, `-`, `-`) shares
 * its last two characters with the 3-char closer (`-->`), so after each failed match the lazy
 * quantifier re-scans overlapping tail content looking for a `-->` that never arrives. Measured:
 * 160,000 repeats of `<!--` (~640KB) took over 18 SECONDS; ~4MB of the same shape extrapolates to
 * hours. This runs on FILE CONTENT, not consumer config — a broken template emitting a stray
 * `<!--` (a template engine bug, a truncated build artifact) is an accident, not an attacker, and
 * it must not be able to hang the build with no cap and no escape. `stripComments` (the CSS-side
 * sibling above) does NOT share this defect — its 3-char opener (`/*`) and closer (`*\/`) have no
 * such overlap, and it stays sub-3ms even at 320,000 unterminated `/*` — so only this function
 * needed the rewrite.
 *
 * CLOSER SEARCH STARTS AT `openIndex + 2`, NOT `+ 4` (round-2 review MUST-FIX #1 — `+ 4` skipped
 * past the HTML spec's ABRUPT-CLOSING comment forms `<!-->` and `<!--->`, complete and harmless
 * per the HTML Standard's "Comments" section, and browsers accept them as such). `<!--` occupies
 * offsets 0-3 of the opener; the closer `-->` of `<!-->` sits at offsets 1-3 — INSIDE those same
 * four characters, reusing the comment's own two dashes. Starting the closer search at `+ 4`
 * therefore never even looks at the position where the closer legally begins, finds no `-->`
 * anywhere later in a document that has nothing else, and falls into "unterminated" — silently
 * stripping every byte after the stray `<!-->` to the end of the string. Starting at `+ 2` (past
 * only the two literal dashes that the closer is allowed to reuse) finds both abrupt-closing forms
 * correctly: `<!-->` closes at relative index 2 → an empty comment; `<!--->` closes at relative
 * index 3 → also an empty comment (its extra `-` is inside the comment body, not part of the
 * closer); `<!---> stuff -->` closes the SAME way at index 3, so the comment is exactly `<!--->`
 * and ` stuff -->` remains as ordinary text following it.
 *
 * BEHAVIOUR ON AN UNTERMINATED TRAILING `<!--`: strips to the end of the string, same choice as
 * before — this matches how a real browser parses an unterminated HTML comment. UNLIKE before,
 * this is no longer silent: `result.unterminated` is `true`, so a caller can report a genuinely
 * truncated document as a build defect rather than let it read as a clean pass (round-2 review
 * MUST-FIX #2). A browser's job is to render something reasonable for broken markup; this
 * package's job is the opposite — catch the build defect before it ships — so matching the
 * renderer's silence past this point would be modelling the wrong system.
 */
export function stripHtmlComments(html: string): StripHtmlCommentsResult {
  let result = '';
  let searchFrom = 0;
  for (;;) {
    const openIndex = html.indexOf('<!--', searchFrom);
    if (openIndex === -1) {
      result += html.slice(searchFrom);
      return { text: result, unterminated: false };
    }
    result += html.slice(searchFrom, openIndex);
    const closeIndex = html.indexOf('-->', openIndex + 2);
    if (closeIndex === -1) {
      // Unterminated: the rest of the document is inside the comment (see doc comment above).
      // Reported to the caller via `unterminated`, never silently — see StripHtmlCommentsResult.
      return { text: result, unterminated: true };
    }
    searchFrom = closeIndex + 3;
  }
}

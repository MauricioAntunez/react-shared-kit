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
 * BEHAVIOUR ON AN UNTERMINATED TRAILING `<!--`: strips to the end of the string. This matches how
 * a real browser parses an unterminated HTML comment — everything after it is inside the comment
 * and never rendered — so the gates built on top of this function (which reason about what a
 * browser would actually see) stay correct rather than diverging from the platform they model.
 */
export function stripHtmlComments(html: string): string {
  let result = '';
  let searchFrom = 0;
  for (;;) {
    const openIndex = html.indexOf('<!--', searchFrom);
    if (openIndex === -1) {
      result += html.slice(searchFrom);
      return result;
    }
    result += html.slice(searchFrom, openIndex);
    const closeIndex = html.indexOf('-->', openIndex + 4);
    if (closeIndex === -1) {
      // Unterminated: the rest of the document is inside the comment (see doc comment above).
      return result;
    }
    searchFrom = closeIndex + 3;
  }
}

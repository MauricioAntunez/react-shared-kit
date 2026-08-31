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
 * silencing a real defect is the same error class these gates exist to catch. */
export function stripHtmlComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

import { readFileSync } from 'node:fs';
import { brotliCompressSync } from 'node:zlib';

/**
 * Render-blocking CSS byte budget per built document (T3, plan 2026-08-30-deploy-perf-gates).
 *
 * Ported motivation: boufin ships a 37 KB stylesheet, imported by 56 files, render-blocking on
 * all 48 routes — every route pays for every other route's rules. This gate parses built HTML,
 * resolves every render-blocking `<link rel="stylesheet">` to a file, sums bytes, and fails over
 * `maxBytes`.
 *
 * An href that does not resolve to a file is a problem IN ITS OWN RIGHT, never a skipped check.
 * On 2026-08-30 a `React.lazy` boundary in boufin made the build emit
 * `href="/assets/graph-DswA4CsK.css#"` — a literal trailing `#` that resolves to nothing. A gate
 * that silently skipped unresolvable hrefs would have reported a clean 0-byte budget on that
 * broken build. Fail closed.
 */

/** Reads one attribute's raw string value off a tag's source text. */
function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
  return match?.[1];
}

/** HTML boolean attributes are present-or-absent, not value-driven (`disabled`, `disabled=""`,
 * `disabled="disabled"` are all "present"). */
function hasBooleanAttr(tag: string, name: string): boolean {
  return new RegExp(`(^|\\s)${name}(\\s|=|/?>|$)`, 'i').test(tag);
}

/**
 * Lighthouse's render-blocking definition, restricted to what a `media` attribute can express:
 * a stylesheet blocks unless every comma-separated media query in the list is the `print` type
 * (optionally with features we do not need to evaluate — the type keyword alone decides `print`
 * vs. everything else, since this kit runs with no viewport to evaluate a real media query
 * against). Absent/empty `media`, `media="all"`, and `media="screen"` all block, matching
 * Lighthouse's treatment of the default and universal cases.
 */
function isRenderBlockingMedia(media: string | undefined): boolean {
  if (media === undefined || media.trim() === '') return true;
  const queries = media.split(',').map((q) => q.trim().toLowerCase());
  return !queries.every((q) => /^print\b/.test(q));
}

/** One `<link rel="stylesheet">` tag, reduced to what render-blocking status needs. */
interface StylesheetLink {
  href: string;
  renderBlocking: boolean;
}

/** Duplicated minimally from `../image/check/html.ts`'s tag-scanning approach (per-tag regex +
 * attribute lookups) rather than imported: that module is image-scoped and not to be modified for
 * this addition, and the shared shape here is small enough that a second copy is cheaper than a
 * cross-cutting shared helper module for one function. */
function extractStylesheetLinks(html: string): StylesheetLink[] {
  const links: StylesheetLink[] = [];
  for (const match of html.matchAll(/<link\s[^>]*>/gi)) {
    const tag = match[0];
    const rel = attr(tag, 'rel');
    if (rel === undefined || !/\bstylesheet\b/i.test(rel)) continue;
    const href = attr(tag, 'href');
    if (href === undefined) continue;
    const disabled = hasBooleanAttr(tag, 'disabled');
    const renderBlocking = !disabled && isRenderBlockingMedia(attr(tag, 'media'));
    links.push({ href, renderBlocking });
  }
  return links;
}

export type CssBudgetProblemKind = 'unresolvable-href' | 'over-budget';

export type CssBudgetProblem =
  | { kind: 'unresolvable-href'; html: string; href: string; detail: string }
  | { kind: 'over-budget'; html: string; bytes: number; maxBytes: number; detail: string };

export interface VerifyCssBudgetOptions {
  /** Built HTML files to parse. */
  htmlFiles: string[];
  /** href -> file path, consumer-supplied (mirrors `resolveAsset` in `../image/check/html.ts`).
   * Return `undefined` for anything that does not resolve — that is a problem, not a skip. */
  resolveHref: (href: string) => string | undefined;
  /** Budget for total render-blocking CSS per document, in bytes. */
  maxBytes: number;
  /** `'raw'` sums file bytes on disk; `'brotli'` compresses each file first and sums the
   * compressed size, matching what a Brotli-serving edge actually ships over the wire. */
  measure?: 'raw' | 'brotli';
}

export interface VerifyCssBudgetResult {
  ok: boolean;
  problems: CssBudgetProblem[];
}

function measuredSize(file: string, measure: 'raw' | 'brotli'): number {
  const bytes = readFileSync(file);
  return measure === 'brotli' ? brotliCompressSync(bytes).length : bytes.length;
}

/**
 * Sums the resolved render-blocking stylesheets for ONE document and reports its problems.
 * Unresolvable hrefs are reported unconditionally (fail closed) and excluded from the byte sum —
 * there is nothing measurable to add — so a build that emits garbage hrefs can never coast to a
 * clean budget verdict by having nothing left to count.
 */
function checkDocument(
  html: string,
  links: StylesheetLink[],
  resolveHref: (href: string) => string | undefined,
  maxBytes: number,
  measure: 'raw' | 'brotli',
): CssBudgetProblem[] {
  const problems: CssBudgetProblem[] = [];
  let bytes = 0;

  for (const link of links) {
    if (!link.renderBlocking) continue;
    const file = resolveHref(link.href);
    if (file === undefined) {
      problems.push({
        kind: 'unresolvable-href',
        html,
        href: link.href,
        detail: `render-blocking stylesheet href "${link.href}" did not resolve to a file`,
      });
      continue;
    }
    bytes += measuredSize(file, measure);
  }

  if (bytes > maxBytes) {
    problems.push({
      kind: 'over-budget',
      html,
      bytes,
      maxBytes,
      detail: `render-blocking CSS totals ${bytes} bytes (${measure}), over the ${maxBytes} byte budget`,
    });
  }

  return problems;
}

export function verifyCssBudget(options: VerifyCssBudgetOptions): VerifyCssBudgetResult {
  const { htmlFiles, resolveHref, maxBytes, measure = 'raw' } = options;
  const problems: CssBudgetProblem[] = [];

  for (const htmlFile of htmlFiles) {
    const html = readFileSync(htmlFile, 'utf8');
    const links = extractStylesheetLinks(html);
    problems.push(...checkDocument(htmlFile, links, resolveHref, maxBytes, measure));
  }

  return { ok: problems.length === 0, problems };
}

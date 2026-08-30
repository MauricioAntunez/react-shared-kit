import { readFileSync } from 'node:fs';
import { brotliCompressSync } from 'node:zlib';
import { assertResolverReturn, assertStringOption } from './errors.ts';

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
 *
 * FAIL CLOSED extends to every I/O boundary, not just the resolver's `undefined` return, per PR #4
 * review: an unguarded `readFileSync` — of a built HTML file, or of a stylesheet a resolver named —
 * throws `ENOENT` uncaught, and because the main loop had no per-iteration isolation, one missing
 * file used to abort the whole function and DISCARD every problem already collected for earlier
 * documents (a genuinely over-budget document silently lost because an unrelated HTML file in the
 * same batch was missing). Every read and every call into a consumer-supplied callback
 * (`resolveHref` can throw, not just return `undefined`) is now try/caught per item, turned into a
 * problem, and the loop continues — `verifyCssBudget` never throws.
 *
 * An empty `htmlFiles` array is `empty-input` (plan §2 constraint 4: fail closed, never a vacuous
 * `ok: true`) — a wrong output dir, a skipped SSG step, or a typo'd glob would otherwise score a
 * clean scorecard for having examined nothing. An individual HTML file with zero
 * `<link rel="stylesheet">` tags is NOT flagged: unlike an empty file LIST (a batch-level signal
 * that the run itself is misconfigured), a single stylesheet-free document is an ordinary, legal
 * page — flagging it would fire on every fragment or stylesheet-free route a consumer legitimately
 * ships, which `empty-input` at the batch level does not.
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

export type CssBudgetProblemKind =
  | 'empty-input'
  | 'unreadable-html'
  | 'resolver-threw'
  | 'unresolvable-href'
  | 'unreadable-file'
  | 'over-budget';

export type CssBudgetProblem =
  | { kind: 'empty-input'; detail: string }
  | { kind: 'unreadable-html'; html: string; detail: string }
  | { kind: 'resolver-threw'; html: string; href: string; detail: string }
  | { kind: 'unresolvable-href'; html: string; href: string; detail: string }
  | { kind: 'unreadable-file'; html: string; href: string; file: string; detail: string }
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
 * Resolves one render-blocking link's href, guarding the consumer-supplied `resolveHref` callback
 * itself: a resolver that THROWS (an unguarded `statSync` inside the consumer's own code, say) is
 * a distinct failure from a resolver that returns `undefined` — the caller needs to tell "the
 * resolver crashed" apart from "the resolver looked and found nothing", so each gets its own
 * problem kind. Returns `undefined` in both failure cases; the pushed problem is what disambiguates.
 */
function resolveLink(
  html: string,
  href: string,
  resolveHref: (href: string) => string | undefined,
  problems: CssBudgetProblem[],
): string | undefined {
  let file: string | undefined;
  try {
    file = resolveHref(href);
  } catch (error) {
    problems.push({
      kind: 'resolver-threw',
      html,
      href,
      detail: `resolveHref threw while resolving "${href}": ${String(error)}`,
    });
    return undefined;
  }
  // Round 4 review finding: resolveHref can also misbehave WITHOUT throwing — returning a URL
  // object, a Proxy, or any other non-`string | undefined` value. Validated here, before `file`
  // ever reaches readFileSync, so that bug throws loudly and immediately instead of surfacing as a
  // misclassified filesystem finding two calls later.
  assertResolverReturn(file, 'resolveHref', href);
  if (file === undefined) {
    problems.push({
      kind: 'unresolvable-href',
      html,
      href,
      detail: `render-blocking stylesheet href "${href}" did not resolve to a file`,
    });
  }
  return file;
}

/**
 * Sums the resolved render-blocking stylesheets for ONE document and reports its problems.
 * Unresolvable hrefs are reported unconditionally (fail closed) and excluded from the byte sum —
 * there is nothing measurable to add — so a build that emits garbage hrefs can never coast to a
 * clean budget verdict by having nothing left to count.
 *
 * Every read is guarded (PR #4 MUST-FIX 1): a resolved path that does not actually exist on disk
 * — the resolver named a file, but it never got written — reports `unreadable-file` and is
 * excluded from the sum, rather than throwing `ENOENT` out of the whole gate.
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
    const file = resolveLink(html, link.href, resolveHref, problems);
    if (file === undefined) continue;

    try {
      bytes += measuredSize(file, measure);
    } catch (error) {
      // UNCONDITIONAL catch (round 4 review redesign): `file` reaching this point has already
      // been validated by assertResolverReturn above — it IS a real string. Whatever readFileSync
      // raises about it (ENOENT, EACCES, a NUL byte, ERR_FS_FILE_TOO_LARGE) is therefore a fact
      // about the build, not a caller bug, and belongs here. See ./errors.ts for why classifying
      // the error after the fact (what rounds 2-4a tried) cannot work.
      problems.push({
        kind: 'unreadable-file',
        html,
        href: link.href,
        file,
        detail: `could not read resolved stylesheet "${file}" for href "${link.href}": ${String(error)}`,
      });
    }
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

  // Fail closed (plan §2 constraint 4): nothing to examine must never read as a clean pass.
  if (htmlFiles.length === 0) {
    problems.push({
      kind: 'empty-input',
      detail: 'htmlFiles is empty — nothing was examined; did the build run or the glob resolve?',
    });
    return { ok: false, problems };
  }

  for (const [index, htmlFile] of htmlFiles.entries()) {
    // Same boundary-validation principle as resolveHref's return (see errors.ts): a caller
    // passing a non-string element in htmlFiles — a violation of the declared string[] type —
    // must crash loudly here rather than flow into readFileSync and surface as a misclassified
    // unreadable-html finding.
    assertStringOption(htmlFile, `htmlFiles[${index}]`);
    let html: string;
    try {
      html = readFileSync(htmlFile, 'utf8');
    } catch (error) {
      // A missing/unreadable HTML file must not abort the loop: doing so would throw away every
      // problem already collected for documents already checked (PR #4 MUST-FIX 1).
      problems.push({
        kind: 'unreadable-html',
        html: htmlFile,
        detail: `could not read "${htmlFile}": ${String(error)}`,
      });
      continue;
    }
    const links = extractStylesheetLinks(html);
    problems.push(...checkDocument(htmlFile, links, resolveHref, maxBytes, measure));
  }

  return { ok: problems.length === 0, problems };
}

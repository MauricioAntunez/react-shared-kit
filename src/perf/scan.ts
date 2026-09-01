/**
 * Shared scanning primitives for the `./perf` gates: attribute reading off raw tag source,
 * `@import`/`url()` extraction, and `@font-face` block scanning.
 *
 * INTERNAL ONLY — imported by the sibling gate modules in this directory, never re-exported from
 * `./index.ts`. Same convention as `./text.ts` and `./errors.ts`.
 *
 * WHY THIS MODULE EXISTS NOW, NOT EARLIER: `attr()` used to live only in `fontChain.ts`, with a
 * comment there arguing a second copy in `cssBudget.ts` was cheaper than a shared helper module
 * "for one function each". That judgement was correct AT THE TIME — exactly two consumers. It no
 * longer is: a `verifyFontPreload` gate and a `fontUsage` gate are landing next, both needing the
 * same tag-scanning primitives, which makes four consumers. This package's own CLAUDE.md DRY rule
 * is explicit — "3+ occurrences: MUST refactor into shared function" — so the trade-off that
 * favoured duplication at n=2 flips at n=4, and this module is that refactor. The original
 * reasoning is preserved here (not deleted) precisely so a future reader does not "fix" this split
 * back into per-file copies without knowing why it changed.
 *
 * Every function below still carries whatever doc comment it had in its previous location — the
 * comments record specific past defects (the optional-trailing-`;` minified-CSS fix, the
 * brace-matching rationale, the data-URI `;` limit, the single-vs-double-quote fix) and moving them
 * intact is the point.
 */

/**
 * Maximum length of a `url()`/`@import` specifier value this module will capture in full.
 *
 * WHY: `extractImportSpecifiers`/`urlsInSrcDeclaration` used to run an UNBOUNDED capture class
 * (`[^'")]+` / `[^'"]+`) against build-content CSS. A security pass on a sibling project MEASURED
 * this shape as quadratic on pathological input — a `url(` (or `@import`) followed by a very long
 * run of non-terminator characters and no closing delimiter:
 *
 *     1,000 repeats  ->    3.6 ms
 *     8,000 repeats  ->  193.6 ms   (4x per doubling)
 *   500,000 repeats  ->  never completes
 *
 * These gates run inside deploy chains, so a hang here is a build outage, not a slow test.
 *
 * THE VACUITY TRAP, and why this is NOT just `{1,2048}` on the old quantifier: naively bounding the
 * regex quantifier alone (`[^'")]{1,2048}`) makes an over-long value simply FAIL TO MATCH — the
 * gate then silently drops it and reports a clean pass, having verified nothing about that URL.
 * That is precisely the "gate reports OK having verified nothing" class this whole module exists
 * to prevent (see `oversized-filename`/`oversized-class-name` precedent in `./errors.ts`). So every
 * scan here runs the bounded capture AND a second, non-backtracking literal scan for the same start
 * token (`url(`, `@import "`, `@import url(`) — any start the bounded capture did not claim is
 * reported back to the caller as `oversized: true` with a capped excerpt, never silently dropped.
 * The bounded capture is what fixes the quadratic blowup (a failed match backtracks at most
 * MAX_URL_LENGTH times, never re-scanning the rest of the string); the paired literal scan is what
 * keeps that fix from becoming a silent-skip regression.
 */
export const MAX_URL_LENGTH = 2048;

/** One `url()`/`@import` value found by a bounded scan (see `MAX_URL_LENGTH`). */
export interface ScannedUrl {
  /** The captured value when `oversized` is `false`. When `oversized` is `true`, a
   * `sanitizeTagText`-capped EXCERPT of the raw text at the offending position — NOT the real,
   * complete value (that is exactly what could not be safely captured). Callers MUST branch on
   * `oversized` before using this field for anything other than a diagnostic message. */
  value: string;
  /** `true` when the content between the delimiters exceeded `MAX_URL_LENGTH`, or no closing
   * delimiter was found within a bounded scan window. Callers MUST report this explicitly (e.g. as
   * an `oversized-url` problem) — never silently skip it, and never treat `value` as the real
   * URL/specifier in that case. */
  oversized: boolean;
}

interface IndexedScannedUrl extends ScannedUrl {
  index: number;
}

/**
 * Runs a bounded "capture" regex and a matching unbounded-but-literal "start" regex over the same
 * `text`, pairing them by match start index. `capturingRe` and `startRe` MUST share the exact same
 * literal prefix (e.g. both `@import\s+url\(`) so a real occurrence produces the same `match.index`
 * in both passes — that is what lets a start NOT claimed by `capturingRe` be identified as the
 * corresponding occurrence's oversized content, rather than a false positive from an unrelated
 * later match.
 *
 * `startRe` is a fixed-literal scan (no backtracking-prone quantifier), so this second pass costs
 * O(n) regardless of how the first pass's bounded quantifier behaves — it never re-introduces the
 * quadratic cost this module exists to remove.
 */
function scanBounded(
  text: string,
  capturingRe: RegExp,
  startRe: RegExp,
  group: number,
): IndexedScannedUrl[] {
  const found: IndexedScannedUrl[] = [];
  const matchedStarts = new Set<number>();
  for (const match of text.matchAll(capturingRe)) {
    const index = match.index ?? 0;
    matchedStarts.add(index);
    const value = match[group];
    if (value !== undefined) found.push({ value, oversized: false, index });
  }
  for (const start of text.matchAll(startRe)) {
    const index = start.index ?? 0;
    if (matchedStarts.has(index)) continue;
    // No successful bounded capture claimed this start: either the content exceeds
    // MAX_URL_LENGTH, or there is no closing delimiter nearby at all. Both are reported the same
    // way — there is nothing meaningful to check either way once the value cannot be bounded, and
    // silently skipping would be the exact vacuous pass this module exists to prevent.
    const excerptEnd = Math.min(text.length, index + MAX_URL_LENGTH + 64);
    found.push({ value: sanitizeTagText(text.slice(index, excerptEnd)), oversized: true, index });
  }
  return found;
}

/** One `@import` specifier, unwrapped from `url(...)` and quotes either way it can be written,
 * bounded per `MAX_URL_LENGTH` (see that constant's doc comment for why and how). Results are
 * merged from the two mutually-exclusive forms (`@import url(...)` and `@import "..."`/
 * `@import '...'`) and re-sorted by position, so callers relying on document order among sibling
 * `@import`s (e.g. `fontChain.ts`'s BFS walk) see the same order the original single-pass regex
 * produced. */
export function extractImportSpecifiers(css: string): ScannedUrl[] {
  const urlForm = scanBounded(
    css,
    /@import\s+url\(\s*(['"]?)([^'")]{1,2048})\1\s*\)/g,
    /@import\s+url\(/g,
    2,
  );
  const quotedForm = scanBounded(css, /@import\s+(['"])([^'"]{1,2048})\1/g, /@import\s+(['"])/g, 2);
  return [...urlForm, ...quotedForm]
    .sort((a, b) => a.index - b.index)
    .map(({ value, oversized }) => ({ value, oversized }));
}

/** Every `url(...)` inside one `src:` declaration's value (the part before the trailing `;`),
 * bounded per `MAX_URL_LENGTH`. */
export function urlsInSrcDeclaration(declarationValue: string): ScannedUrl[] {
  return scanBounded(declarationValue, /url\(\s*(['"]?)([^'")]{1,2048})\1\s*\)/g, /url\(/g, 2).map(
    ({ value, oversized }) => ({ value, oversized }),
  );
}

/** Every `url(...)` inside every `src:` descriptor found in one `@font-face { ... }` block body.
 *
 * The trailing `;` is OPTIONAL (`src\s*:\s*([^;]+);?`) — CSS itself makes the semicolon after a
 * block's LAST declaration optional, and every minifier omits it, so a real production
 * stylesheet's final `src:` ends `...url(...)format("woff2")}` with no `;` before the `}`.
 * Matching only when a `;` follows used to score that shape as zero urls, silently blinding this
 * gate on minified CSS (fontchain plan `fontchain-minified-src.md`, K2). `[^;]+` still stops at
 * the next `;` when one is present, so a `src:` followed by another declaration is unaffected.
 *
 * Known limit, unchanged by the above: `url(data:font/woff2;base64,...)` has a `;` INSIDE the
 * value, so `[^;]+` truncates at it. This is benign for this gate's purpose — a data-URI face is
 * inlined in the stylesheet itself, so it is never "discovered late" and cannot be a `deep-font`.
 * Not closed here; a `url()`-aware split is a larger rewrite this fix does not authorise. */
export function urlsInFontFaceBody(body: string): ScannedUrl[] {
  const urls: ScannedUrl[] = [];
  for (const srcMatch of body.matchAll(/src\s*:\s*([^;]+);?/g)) {
    urls.push(...urlsInSrcDeclaration(srcMatch[1] ?? ''));
  }
  return urls;
}

export interface FontFaceScanResult {
  /** Every font `src` URL found in a properly closed `@font-face { ... }` block, bounded per
   * `MAX_URL_LENGTH` — see `ScannedUrl`. */
  urls: ScannedUrl[];
  /** Count of `@font-face {` starts with no matching `}` before end of file. */
  unterminatedBlocks: number;
}

/**
 * Every `url(...)` inside every `src:` descriptor of every `@font-face { ... }` block in `css`,
 * plus a count of blocks whose opening brace never closes. Brace-matched rather than
 * regex-spanned across the whole file, so a `@font-face` block does not accidentally swallow
 * unrelated rules that follow it. Shared between external-stylesheet scanning and inline
 * `<style>` scanning — the block grammar is identical either way; only how a truncated block is
 * reported differs at the call site.
 */
export function scanFontFaces(css: string): FontFaceScanResult {
  const urls: ScannedUrl[] = [];
  let unterminatedBlocks = 0;
  const blockStartRe = /@font-face\s*\{/g;
  for (const start of css.matchAll(blockStartRe)) {
    const bodyStart = (start.index ?? 0) + start[0].length;
    const end = css.indexOf('}', bodyStart);
    if (end === -1) {
      // FAIL CLOSED: a truncated block is a stronger signal something is wrong with the build
      // artifact than a reason to say nothing about it (PR #4 review finding).
      unterminatedBlocks += 1;
      continue;
    }
    urls.push(...urlsInFontFaceBody(css.slice(bodyStart, end)));
  }
  return { urls, unterminatedBlocks };
}

/** Reads one attribute's raw string value off a tag's source text.
 *
 * Matches double- OR single-quoted attribute values (IMPORTANT 5, `fontChain.ts` review) — the
 * same precedent `HTML_CLASS_ATTR` in `danglingClasses.ts` already sets. Before that fix, a
 * double-quote-only match skipped `<link rel='preload' as='font' crossorigin href='...'>` (valid
 * HTML5) entirely, producing a false `deep-font` on a page that had already applied the
 * recommended fix. Unquoted attribute values (`rel=stylesheet`) are OUT OF SCOPE: real build
 * output always quotes attribute values, and an unquoted value ends at the next whitespace, which
 * this single-tag regex has no reliable way to distinguish from the start of an unrelated
 * following attribute.
 *
 * `cssBudget.ts` previously carried its own double-quote-only copy of this function; moving it
 * here (see module doc comment) widens `cssBudget.ts`'s attribute matching to also accept
 * single-quoted values — a strict superset of its prior behaviour, so every existing double-quoted
 * fixture still matches identically. */
export function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return match?.[1] ?? match?.[2];
}

/** Maximum length of a raw tag/value excerpt reported in a problem's `tag`/`excerpt` field (round-2
 * review MEDIUM #7, `fontChain.ts`). Several of this module's own scans (`/<link\s[^>]*>/gi`'s
 * `[^>]*`, and the oversized-value excerpts in `scanBounded` above) are themselves unbounded or
 * only loosely bounded — a build artifact with a very long run makes the "one match" span
 * megabytes, and that full raw text would otherwise be placed verbatim into a problem's message for
 * a consumer to read. This is FILE CONTENT, the LESS-TRUSTED side of this package's own trust
 * boundary (see `./errors.ts`'s reasoning for why `hashPattern`/`allowlist` are trusted but build
 * content is not) — same reasoning already applied to `oversized-filename` (`headers.ts`) and
 * `oversized-class-name` (`danglingClasses.ts`). 300 is generous for any real `<link>` tag or URL
 * excerpt (attribute values and real URLs in build output are short) while still bounding a
 * pathological one. */
export const MAX_MALFORMED_TAG_LENGTH = 300;

/** Collapses ASCII control characters (including newlines/carriage returns) in `tag` to a visible
 * escape sequence, then caps the result to `MAX_MALFORMED_TAG_LENGTH` (round-2 review MEDIUM #7).
 *
 * WHY: `tag` is placed verbatim into a problem's `message` (e.g. `"<html> has a <link
 * rel="stylesheet"> with no usable href (${tag}) — ..."`), and this package's own README suggests
 * a consumer prints one problem per line. An embedded `\n` in a malformed tag would let a single
 * build-content string forge extra "lines" into that output — a log-forging surface, reproduced
 * with a tag containing an embedded newline landing byte-for-byte in a printed message. Escaping
 * every control character (not just `\n`) closes the whole class, not just the one reproduced
 * instance. Length is capped SEPARATELY, after escaping, so a very long but otherwise ordinary tag
 * still gets a bounded message rather than embedding megabytes of raw HTML in a problem object. */
export function sanitizeTagText(tag: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching control characters (including newline) to escape them — that IS the sanitization this function exists to perform.
  const escaped = tag.replace(/[\x00-\x1f\x7f]/g, (ch) => {
    if (ch === '\n') return '\\n';
    if (ch === '\r') return '\\r';
    if (ch === '\t') return '\\t';
    return `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`;
  });
  if (escaped.length <= MAX_MALFORMED_TAG_LENGTH) return escaped;
  return `${escaped.slice(0, MAX_MALFORMED_TAG_LENGTH)}… [truncated, ${escaped.length} chars]`;
}

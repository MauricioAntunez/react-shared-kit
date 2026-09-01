import { readFileSync } from 'node:fs';
import { assertResolverReturn, assertStringOption } from './errors.ts';
import { scanFontFaces } from './scan.ts';
import { stripComments } from './text.ts';

/**
 * Gate: no `@import` chain through which a FONT is reachable (T13, replaces `noCssImport.ts`,
 * ruled by the owner 2026-09-01).
 *
 * THE RULING THAT FORCES THIS SHAPE: the prior gate (`verifyNoCssImport`) flagged EVERY `@import`
 * in a stylesheet. The owner overturned that: "the @import inside css files for font files its
 * forbidden" / "import css its valid for scss and css compositions, check to not conflict with
 * that". `@import` is a legitimate composition tool (token layers, partial composition) and must
 * NOT be reported on its own. Only an `@import` through which a FONT is reached is a defect.
 *
 * MECHANISM that makes the font case a defect and the non-font case benign: a font behind an
 * `@import` is invisible to the browser's preload scanner until the importing sheet has been
 * fetched AND parsed, so the woff2 lands one full round-trip late on the critical path. A
 * stylesheet that ships no font pays no such cost — `@import "./colors.css"` composing design
 * tokens is fetched in parallel with everything else the page needs regardless of when the browser
 * discovers it.
 *
 * REAL FALSE POSITIVE this replaces: the prior gate failed boufin's
 * `src/design-system/tokens/index.css:8-11` (`@import "./colors.css" layer(bf-tokens);` and
 * siblings) — legitimate token-layer composition shipping no `@font-face`. That shape must pass
 * clean here.
 *
 * CLASSIFICATION, per live `@import` specifier found:
 *   1. Specifier matches a known font source (`fontSpecifierPatterns`) → `font-import`, no need to
 *      follow it — the specifier itself already names a font CDN/package.
 *   2. Otherwise, FOLLOW it via `resolveImport(specifier, fromFile)` and read the target. If the
 *      target (or anything IT imports, transitively) declares an `@font-face`
 *      (`scanFontFaces(...).urls.length > 0`), that is a `font-import`, reported with the full
 *      CHAIN of specifiers from the entry stylesheet to the font. Import CYCLES are guarded with a
 *      per-walk visited set — a cycle terminates silently (never hangs, never itself a problem)
 *      unless a font is reached before the cycle closes.
 *   3. Resolvable and provably font-free → NOT REPORTED. This is the composition case the owner
 *      ruled legitimate.
 *   4. Unresolvable (`resolveImport` returns `undefined`) → `unresolvable-import`. The gate never
 *      assumes an import it cannot follow is font-free — that would be a silent pass exactly where
 *      the gate is least certain. `resolveImport` is consumer-supplied (same convention as every
 *      other gate in this module); a specifier the consumer's own resolver cannot resolve (an
 *      unconfigured alias, a missing SCSS partial) is a real gap in their configuration and is
 *      worth surfacing, not swallowed.
 *
 * INCOMPLETE PATTERN LIST, BY DESIGN: `fontSpecifierPatterns`' default covers the realistic
 * regression — somebody pastes a font-CDN `@import` snippet back into the source
 * (`fonts.googleapis.com`, `fonts.gstatic.com`, `fonts.bunny.net`, `@fontsource`/
 * `@fontsource-variable`) — and is NOT exhaustive of every font host that could ever exist. Case 2
 * (follow the chain, inspect for `@font-face`) is what catches the rest: a self-hosted font behind
 * an `@import` is caught by content, not by naming a hostname the gate has never heard of.
 *
 * SCSS / SASS: `.css`, `.scss` and `.sass` are all accepted inputs. The real distinction: an
 * `@import` in SCSS is a COMPILE-TIME include — the partial's content is inlined into the emitted
 * CSS by the Sass compiler, so no runtime request chain ever exists and no discovery cost is paid.
 * A CSS `@import` in a stylesheet the browser actually fetches at runtime IS a request chain. This
 * gate scans SOURCE — before any bundler or Sass compiler has run — so it cannot always know which
 * pipeline a given file goes through (a `.scss` partial might feed a Sass compile, or might be
 * fed to a CSS-only tool that leaves `@import` as a literal runtime at-rule). Stated plainly rather
 * than pretending precision this gate does not have: the practical choice is to follow the chain
 * and report a font reached through it either way (the condition the owner banned), while never
 * reporting a font-free import in either language — the same asymmetry that makes the `@import`
 * itself not the defect, only what it reaches.
 *
 * MACHINERY CARRIED OVER FROM `noCssImport.ts` (correct there, correct here): comments are
 * stripped FIRST via `./text.ts`'s `stripComments` (a commented-out `@import` is not live); string
 * literals are masked via a local `maskStrings`/`maskStringBody` split so `content: "@import x"` is
 * never mistaken for a live at-rule while a real `@import` on an adjacent line — or even the same
 * line — still is; reported `line` is 1-indexed against the comment-stripped text; `sanitizeTagText`
 * is not needed here since a bounded regex capture (mirroring `./scan.ts`'s `MAX_URL_LENGTH`
 * convention) already caps what can be captured as a specifier; `assertStringOption` validates every
 * `cssFiles[i]`, `assertResolverReturn` validates every `resolveImport` return, per this module's
 * boundary-validation convention (see `./index.ts`'s doc comment); each file read is wrapped in its
 * OWN `try` around EXACTLY the `readFileSync` call, so one bad file never discards another file's
 * problems; an empty `cssFiles` reports `no-stylesheets-found` rather than a vacuous pass.
 */

export type NoFontImportProblemKind =
  | 'no-stylesheets-found'
  | 'unreadable-css'
  | 'resolver-threw'
  | 'unresolvable-import'
  | 'font-import';

export type NoFontImportProblem =
  | { kind: 'no-stylesheets-found'; detail: string }
  | { kind: 'unreadable-css'; file: string; detail: string }
  | { kind: 'resolver-threw'; file: string; specifier: string; detail: string }
  | { kind: 'unresolvable-import'; file: string; line: number; specifier: string; detail: string }
  | {
      kind: 'font-import';
      file: string;
      line: number;
      specifier: string;
      chain: string[];
      detail: string;
    };

export interface VerifyNoFontImportOptions {
  /** Source stylesheets to scan (`.css`, `.scss`, `.sass` — see module doc comment). */
  cssFiles: string[];
  /** Resolves an `@import` specifier found in `fromFile` to a readable file path, or `undefined`
   * if it cannot be resolved (an unconfigured alias, a missing partial, a bare bundler specifier
   * this gate has no resolver for). Never throw to signal "not found" — return `undefined`; a throw
   * is reported as `resolver-threw` instead, distinctly from a deliberate "cannot resolve". */
  resolveImport: (specifier: string, fromFile: string) => string | undefined;
  /** Specifier patterns that mark an `@import` as reaching a font WITHOUT needing to follow it.
   * Replaces (never merges with) the default list — see module doc comment for why the default is
   * deliberately incomplete. */
  fontSpecifierPatterns?: readonly RegExp[];
}

export interface VerifyNoFontImportResult {
  ok: boolean;
  problems: NoFontImportProblem[];
}

const DEFAULT_FONT_SPECIFIER_PATTERNS: readonly RegExp[] = [
  /fonts\.googleapis\.com/i,
  /fonts\.gstatic\.com/i,
  /fonts\.bunny\.net/i,
  /@fontsource(?:-variable)?\//i,
];

const IMPORT_URL_RE = /@import\s+url\(\s*(['"]?)([^'")]{1,2048})\1\s*\)/gi;
const IMPORT_QUOTED_RE = /@import\s+(['"])([^'"]{1,2048})\1/gi;

/** Masks the BODY of one quoted string starting at `start` (just past the opening quote), up to
 * and including its closing `quote` — or to end of string if unterminated. Carried over verbatim
 * from `noCssImport.ts` (see that file's history for the reasoning). */
function maskStringBody(css: string, start: number, quote: string): { text: string; next: number } {
  let out = '';
  let i = start;
  while (i < css.length) {
    const c = css.charAt(i);
    if (c === '\\') {
      const next = css.charAt(i + 1);
      out += next === '\n' ? ' \n' : '  ';
      i += 2;
      continue;
    }
    if (c === quote) {
      out += c;
      i++;
      break;
    }
    out += c === '\n' ? '\n' : ' ';
    i++;
  }
  return { text: out, next: i };
}

/** Replaces the CONTENT of every quoted string in `css` with blanks, leaving quote characters,
 * everything outside strings, and every newline untouched — so a position in the masked text lines
 * up exactly with the same position in the raw text. Carried over from `noCssImport.ts`. */
function maskStrings(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const char = css.charAt(i);
    if (char !== '"' && char !== "'") {
      out += char;
      i++;
      continue;
    }
    out += char;
    const { text, next } = maskStringBody(css, i + 1, char);
    out += text;
    i = next;
  }
  return out;
}

interface LiveImport {
  line: number;
  specifier: string;
}

/** Every LIVE (non-comment, non-string-literal) `@import` specifier in one already
 * comment-stripped stylesheet, with its 1-indexed line. Position-checks each regex match against
 * the string-masked text at the same index: a real `@import "x.css"` sits OUTSIDE any string, so
 * the masked text at that position still reads `@import` verbatim; an `@import` that is only text
 * INSIDE an unrelated string (`content: "@import fake";`) has its own letters blanked to spaces by
 * `maskStrings`, so the check fails there and it is skipped. */
/** Classifies ONE regex match as a live import (or not): `undefined` when it has no captured
 * specifier, or when the masked text at its position shows it sits inside a string literal rather
 * than as a live at-rule. Split out purely to keep `scanLiveImports`'s own branch count under the
 * lint complexity budget. */
function liveImportAt(
  stripped: string,
  masked: string,
  match: RegExpMatchArray,
): LiveImport | undefined {
  const index = match.index ?? 0;
  if (!/^@import$/i.test(masked.slice(index, index + 7))) return undefined;
  const specifier = match[2];
  if (specifier === undefined) return undefined;
  return { line: stripped.slice(0, index).split('\n').length, specifier };
}

function scanLiveImports(stripped: string): LiveImport[] {
  const masked = maskStrings(stripped);
  const results: LiveImport[] = [];
  const seenIndexes = new Set<number>();
  for (const re of [IMPORT_URL_RE, IMPORT_QUOTED_RE]) {
    for (const match of stripped.matchAll(re)) {
      const index = match.index ?? 0;
      if (seenIndexes.has(index)) continue;
      const found = liveImportAt(stripped, masked, match);
      if (found === undefined) continue;
      seenIndexes.add(index);
      results.push(found);
    }
  }
  return results.sort((a, b) => a.line - b.line);
}

function matchesFontPattern(specifier: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(specifier));
}

/** Whether an already comment-stripped stylesheet declares at least one usable `@font-face` src —
 * reuses `./scan.ts`'s brace-matched, minified-safe `scanFontFaces` rather than a second ad hoc
 * `@font-face` detector. */
function declaresFontFace(css: string): boolean {
  return scanFontFaces(css).urls.length > 0;
}

type ReachResult =
  | { kind: 'font'; chain: string[] }
  | { kind: 'clean' }
  | { kind: 'problem'; problem: NoFontImportProblem };

type ResolveOutcome =
  | { kind: 'resolved'; target: string }
  | { kind: 'unresolvable' }
  | { kind: 'threw'; detail: string };

function resolveSpecifier(
  resolveImport: VerifyNoFontImportOptions['resolveImport'],
  specifier: string,
  fromFile: string,
): ResolveOutcome {
  let resolved: string | undefined;
  try {
    resolved = resolveImport(specifier, fromFile);
  } catch (error) {
    return {
      kind: 'threw',
      detail: `resolveImport threw for "${specifier}" imported from "${fromFile}": ${String(error)}`,
    };
  }
  assertResolverReturn(resolved, 'resolveImport', specifier);
  return resolved === undefined ? { kind: 'unresolvable' } : { kind: 'resolved', target: resolved };
}

/** Classifies ONE live `@import` specifier found at `line` in `file`: a font-pattern match, a
 * follow-and-recurse into the resolved target (via `checkFontReachable`), an unresolvable/thrown
 * resolver outcome, or clean. `visited` is the CURRENT walk's cycle guard, shared across the whole
 * recursive descent from one entry-level specifier. */
function evaluateImportTarget(
  file: string,
  line: number,
  specifier: string,
  resolveImport: VerifyNoFontImportOptions['resolveImport'],
  patterns: readonly RegExp[],
  visited: Set<string>,
): ReachResult {
  if (matchesFontPattern(specifier, patterns)) return { kind: 'font', chain: [specifier] };

  const outcome = resolveSpecifier(resolveImport, specifier, file);
  if (outcome.kind === 'threw') {
    return {
      kind: 'problem',
      problem: { kind: 'resolver-threw', file, specifier, detail: outcome.detail },
    };
  }
  if (outcome.kind === 'unresolvable') {
    return {
      kind: 'problem',
      problem: {
        kind: 'unresolvable-import',
        file,
        line,
        specifier,
        detail:
          `resolveImport could not resolve "${specifier}" imported from "${file}" at line ${line} ` +
          '— an import this gate cannot follow is never assumed font-free.',
      },
    };
  }

  const sub = checkFontReachable(outcome.target, resolveImport, patterns, visited);
  if (sub.kind === 'font') return { kind: 'font', chain: [specifier, ...sub.chain] };
  return sub;
}

/** Whether `file` (or anything it transitively imports) declares a font — the recursive heart of
 * case 2. `visited` guards against import cycles: a `file` already in the set for this walk
 * terminates as `clean` immediately, never re-read and never re-followed, so `a.css` <-> `b.css`
 * cannot hang the gate. */
function checkFontReachable(
  file: string,
  resolveImport: VerifyNoFontImportOptions['resolveImport'],
  patterns: readonly RegExp[],
  visited: Set<string>,
): ReachResult {
  if (visited.has(file)) return { kind: 'clean' };
  visited.add(file);

  let css: string;
  try {
    css = readFileSync(file, 'utf8');
  } catch (error) {
    return {
      kind: 'problem',
      problem: {
        kind: 'unreadable-css',
        file,
        detail: `could not read "${file}": ${String(error)}`,
      },
    };
  }

  const stripped = stripComments(css);
  if (declaresFontFace(stripped)) return { kind: 'font', chain: [] };

  for (const { line, specifier } of scanLiveImports(stripped)) {
    const result = evaluateImportTarget(file, line, specifier, resolveImport, patterns, visited);
    if (result.kind !== 'clean') return result;
  }
  return { kind: 'clean' };
}

/** Classifies and records ONE entry-level live import into `problems`, in place. Split out purely
 * to keep `verifyNoFontImport`'s own branch count under the lint complexity budget — the
 * classification work itself lives in `evaluateImportTarget`/`checkFontReachable`. */
function reportEntryImport(
  problems: NoFontImportProblem[],
  file: string,
  line: number,
  specifier: string,
  resolveImport: VerifyNoFontImportOptions['resolveImport'],
  patterns: readonly RegExp[],
): void {
  const result = evaluateImportTarget(
    file,
    line,
    specifier,
    resolveImport,
    patterns,
    new Set([file]),
  );
  if (result.kind === 'font') {
    problems.push({
      kind: 'font-import',
      file,
      line,
      specifier,
      chain: result.chain,
      detail:
        `"${specifier}" imported from "${file}" at line ${line} reaches a font — chain: ` +
        `${result.chain.join(' -> ')}`,
    });
  } else if (result.kind === 'problem') {
    problems.push(result.problem);
  }
}

export function verifyNoFontImport(options: VerifyNoFontImportOptions): VerifyNoFontImportResult {
  const { cssFiles, resolveImport, fontSpecifierPatterns } = options;
  const patterns = fontSpecifierPatterns ?? DEFAULT_FONT_SPECIFIER_PATTERNS;
  const problems: NoFontImportProblem[] = [];

  // Fail closed (same principle as every other gate in this module): nothing to examine must
  // never read as a clean pass.
  if (cssFiles.length === 0) {
    problems.push({
      kind: 'no-stylesheets-found',
      detail: 'cssFiles is empty — nothing was examined; did the scan scope collapse?',
    });
    return { ok: false, problems };
  }

  for (const [index, file] of cssFiles.entries()) {
    assertStringOption(file, `cssFiles[${index}]`);
    let css: string;
    try {
      css = readFileSync(file, 'utf8');
    } catch (error) {
      problems.push({
        kind: 'unreadable-css',
        file,
        detail: `could not read "${file}": ${String(error)}`,
      });
      continue;
    }

    const stripped = stripComments(css);
    for (const { line, specifier } of scanLiveImports(stripped)) {
      reportEntryImport(problems, file, line, specifier, resolveImport, patterns);
    }
  }

  return { ok: problems.length === 0, problems };
}

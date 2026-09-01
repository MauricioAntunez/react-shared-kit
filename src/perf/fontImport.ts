import { readFileSync } from 'node:fs';
import { assertResolverReturn, assertStringOption } from './errors.ts';
import { extractImportSpecifiers, sanitizeTagText, scanFontFaces } from './scan.ts';
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
 *   1. Specifier exceeds `./scan.ts`'s `MAX_URL_LENGTH` (or has no closing delimiter nearby) and
 *      could not be safely captured → `oversized-import`, reported explicitly and never followed
 *      (PR #8 review FINDING 1: a bounded-only capture with no companion scan makes an over-long
 *      specifier simply FAIL TO MATCH, silently dropping a live font `@import` — real Google Fonts
 *      URLs with several families and weight lists routinely exceed 2000 chars, so this is the
 *      ordinary shape of the regression this gate exists to catch, not an edge case).
 *   2. Specifier matches a known font source (`fontSpecifierPatterns`) → `font-import`, no need to
 *      follow it — the specifier itself already names a font CDN/package.
 *   3. Otherwise, FOLLOW it via `resolveImport(specifier, fromFile)` and read the target. If the
 *      target (or anything IT imports, transitively) declares an `@font-face`
 *      (`scanFontFaces(...).urls.length > 0`), that is a `font-import`, reported with the full
 *      CHAIN of specifiers from the entry stylesheet to the font. Import CYCLES are guarded with a
 *      per-walk visited set — a cycle terminates silently (never hangs, never itself a problem)
 *      unless a font is reached before the cycle closes.
 *   4. Resolvable and provably font-free → NOT REPORTED. This is the composition case the owner
 *      ruled legitimate.
 *   5. Unresolvable (`resolveImport` returns `undefined`) → `unresolvable-import`. The gate never
 *      assumes an import it cannot follow is font-free — that would be a silent pass exactly where
 *      the gate is least certain. `resolveImport` is consumer-supplied (same convention as every
 *      other gate in this module); a specifier the consumer's own resolver cannot resolve (an
 *      unconfigured alias, a missing SCSS partial) is a real gap in their configuration and is
 *      worth surfacing, not swallowed.
 *
 * INCOMPLETE PATTERN LIST, BY DESIGN: `fontSpecifierPatterns`' default covers the realistic
 * regression — somebody pastes a font-CDN `@import` snippet back into the source
 * (`fonts.googleapis.com`, `fonts.gstatic.com`, `fonts.bunny.net`, `@fontsource`/
 * `@fontsource-variable`) — and is NOT exhaustive of every font host that could ever exist. Case 3
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
 * MACHINERY:
 *   - Comments are stripped FIRST via `./text.ts`'s `stripComments` (a commented-out `@import` is
 *     not live); string literals are masked via a local `maskStrings`/`maskStringBody` split so
 *     `content: "@import x"` is never mistaken for a live at-rule while a real `@import` on an
 *     adjacent line — or even the same line — still is.
 *   - Specifier CAPTURE (the actual value, and whether it is oversized) is delegated to
 *     `./scan.ts`'s `extractImportSpecifiers` — the same bounded-capture-plus-paired-literal-scan
 *     machinery `fontChain.ts` already uses, rather than a second, independently-bounded copy of
 *     the regexes (PR #8 review FINDING 1 fix: the removed `IMPORT_URL_RE`/`IMPORT_QUOTED_RE` were
 *     bounded with no companion scan — "the vacuity trap" `./scan.ts`'s `MAX_URL_LENGTH` doc
 *     comment names). This module still runs its own small, LITERAL (non-backtracking) start scan
 *     (`importStartIndexes`) over the same text — `extractImportSpecifiers` does not expose match
 *     position, and this module needs a position for two things it has no reason to: a 1-indexed
 *     line number, and the string-literal check above. Both scans walk the same text with the same
 *     start patterns, so their results line up 1:1 in the same order by construction.
 *   - `sanitizeTagText` (`./scan.ts`) wraps every specifier, file path, chain entry, and thrown
 *     error string interpolated into a `detail` message (PR #8 review FINDING 3: an unsanitized
 *     `specifier` echoed into `detail` let a crafted `@import` embed a `\n` and forge a fake extra
 *     line — e.g. a fabricated "PASS" line — into a consumer's printed output). The raw, unescaped
 *     values are still carried on the problem object's own fields (`specifier`, `chain`, ...) for
 *     programmatic use — only the printable `detail` string is sanitized, matching this module's
 *     `fontAssets.ts`/`fontChain.ts`/`fontPreload.ts`/`fontUsage.ts` siblings.
 *   - The import-chain walk (case 3) is an EXPLICIT STACK (`walkFontChain`), not recursion (PR #8
 *     review FINDING 2: the former mutually-recursive `checkFontReachable`/`evaluateImportTarget`
 *     pair threw an uncaught `RangeError` on a long ACYCLIC `@import` chain — reproduced reliably
 *     from N=3000 — because V8 has no TCO and the cycle guard only stops CYCLES, not chain length.
 *     A few thousand chained SCSS partials is a legitimate architecture, not only adversarial
 *     input, and a gate that crashes instead of reporting is a build outage). Mirrors
 *     `fontChain.ts`'s `walk`/`enqueueImports` precedent: an explicit stack bounds memory by the
 *     number of distinct files in the graph, not by call depth, so a chain of any length completes
 *     without a `RangeError`. It preserves the original recursive version's exact
 *     short-circuit-on-first-result DFS semantics — see `walkFontChain`'s doc comment.
 *   - Reported `line` is 1-indexed against the comment-stripped text; `assertStringOption`
 *     validates every `cssFiles[i]`, `assertResolverReturn` validates every `resolveImport`
 *     return, per this module's boundary-validation convention (see `./index.ts`'s doc comment);
 *     each file read is wrapped in its OWN `try` around EXACTLY the `readFileSync` call, so one bad
 *     file never discards another file's problems; an empty `cssFiles` reports
 *     `no-stylesheets-found` rather than a vacuous pass.
 */

export type NoFontImportProblemKind =
  | 'no-stylesheets-found'
  | 'unreadable-css'
  | 'resolver-threw'
  | 'unresolvable-import'
  | 'oversized-import'
  | 'font-import';

export type NoFontImportProblem =
  | { kind: 'no-stylesheets-found'; detail: string }
  | { kind: 'unreadable-css'; file: string; detail: string }
  | { kind: 'resolver-threw'; file: string; specifier: string; detail: string }
  | { kind: 'unresolvable-import'; file: string; line: number; specifier: string; detail: string }
  | { kind: 'oversized-import'; file: string; line: number; specifier: string; detail: string }
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

/** Literal (non-backtracking) start positions of every `@import url(...)`/`@import "..."`
 * occurrence in `text`, sorted ascending. Mirrors the two `startRe` patterns `./scan.ts`'s
 * `extractImportSpecifiers` runs internally. `extractImportSpecifiers` does not expose match
 * position; this scan exists purely so `scanLiveImports` can compute a line number and check
 * whether a match sits inside a string literal. Because both scans walk the SAME text with the SAME
 * start patterns, the two result arrays line up 1:1, in the same order — one entry per distinct
 * `@import` occurrence, whether or not `extractImportSpecifiers` could bound-capture it. */
function importStartIndexes(text: string): number[] {
  const indexes: number[] = [];
  for (const match of text.matchAll(/@import\s+url\(/g)) indexes.push(match.index ?? 0);
  for (const match of text.matchAll(/@import\s+(['"])/g)) indexes.push(match.index ?? 0);
  return indexes.sort((a, b) => a - b);
}

interface LiveImport {
  line: number;
  specifier: string;
  /** `true` when the specifier exceeded `./scan.ts`'s `MAX_URL_LENGTH` (or had no closing
   * delimiter nearby) and could not be safely captured — `specifier` is then a sanitized EXCERPT,
   * never the real value. Every `@import` this gate finds must be classified, oversized or not —
   * never silently skipped either way (PR #8 review FINDING 1). */
  oversized: boolean;
}

/** Every LIVE (non-comment, non-string-literal) `@import` specifier in one already
 * comment-stripped stylesheet, with its 1-indexed line. Specifier capture is delegated to
 * `./scan.ts`'s `extractImportSpecifiers`, run against the RAW (unmasked) text so a real
 * specifier's captured VALUE is never blanked; a result is then kept only if its start position
 * sits OUTSIDE any string literal per `maskStrings` — a real `@import "x.css"` sits outside any
 * string, so the masked text at that position still reads `@import` verbatim, while an `@import`
 * that is only text INSIDE an unrelated string (`content: "@import fake";`) has its own letters
 * blanked to spaces there, so the check fails and it is skipped. */
function scanLiveImports(stripped: string): LiveImport[] {
  const masked = maskStrings(stripped);
  const specifiers = extractImportSpecifiers(stripped);
  const starts = importStartIndexes(stripped);
  const results: LiveImport[] = [];
  for (const [i, spec] of specifiers.entries()) {
    const start = starts[i];
    if (start === undefined) continue;
    if (!/^@import$/i.test(masked.slice(start, start + 7))) continue;
    const line = stripped.slice(0, start).split('\n').length;
    results.push({ line, specifier: spec.value, oversized: spec.oversized });
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
      detail:
        `resolveImport threw for "${sanitizeTagText(specifier)}" imported from ` +
        `"${sanitizeTagText(fromFile)}": ${sanitizeTagText(String(error))}`,
    };
  }
  assertResolverReturn(resolved, 'resolveImport', specifier);
  return resolved === undefined ? { kind: 'unresolvable' } : { kind: 'resolved', target: resolved };
}

function oversizedImportProblem(
  file: string,
  line: number,
  specifier: string,
): NoFontImportProblem {
  return {
    kind: 'oversized-import',
    file,
    line,
    specifier,
    detail:
      `an @import specifier in "${sanitizeTagText(file)}" at line ${line} exceeds the bounded ` +
      'scan length, or has no closing delimiter nearby, and could not be safely captured — ' +
      `reported explicitly rather than silently dropped. Excerpt: "${sanitizeTagText(specifier)}"`,
  };
}

function unresolvableImportProblem(
  file: string,
  line: number,
  specifier: string,
): NoFontImportProblem {
  return {
    kind: 'unresolvable-import',
    file,
    line,
    specifier,
    detail:
      `resolveImport could not resolve "${sanitizeTagText(specifier)}" imported from ` +
      `"${sanitizeTagText(file)}" at line ${line} — an import this gate cannot follow is never ` +
      'assumed font-free.',
  };
}

/** Reads and comment-strips `target`, then classifies it: declares a font directly, has live
 * imports of its own to descend into, or could not be read at all. Split out of `walkFontChain`
 * purely to keep that function's branch count within this package's Biome complexity budget. */
type TargetOutcome =
  | { kind: 'font' }
  | { kind: 'problem'; problem: NoFontImportProblem }
  | { kind: 'imports'; pending: LiveImport[] };

function readAndScanTarget(target: string): TargetOutcome {
  let css: string;
  try {
    css = readFileSync(target, 'utf8');
  } catch (error) {
    return {
      kind: 'problem',
      problem: {
        kind: 'unreadable-css',
        file: target,
        detail: `could not read "${target}": ${String(error)}`,
      },
    };
  }
  const stripped = stripComments(css);
  if (declaresFontFace(stripped)) return { kind: 'font' };
  return { kind: 'imports', pending: scanLiveImports(stripped) };
}

/** One file already descended into, with its remaining (not-yet-tried) live imports and the
 * specifier chain that led to it. `pending` is consumed front-to-back via `nextPendingImport`, so
 * siblings are tried in the same document order the original recursive `for` loop used. */
interface WalkFrame {
  file: string;
  chain: string[];
  pending: LiveImport[];
}

interface Current {
  file: string;
  chain: string[];
  specifier: string;
  line: number;
  oversized: boolean;
}

/** Pops the next not-yet-tried live import off the top of `stack`, discarding exhausted frames
 * (backtracking) until one with a pending import is found, or the stack empties. This is the
 * explicit-stack equivalent of "return from an exhausted recursive call and continue the parent's
 * loop" — a frame with no `pending` left behind is simply popped, exactly like a `for` loop
 * finishing with nothing found. */
function nextPendingImport(stack: WalkFrame[]): Current | undefined {
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame === undefined) {
      stack.pop();
      continue;
    }
    const item = frame.pending.shift();
    if (item === undefined) {
      stack.pop();
      continue;
    }
    return {
      file: frame.file,
      chain: frame.chain,
      specifier: item.specifier,
      line: item.line,
      oversized: item.oversized,
    };
  }
  return undefined;
}

/**
 * Iterative (explicit-stack) DFS import-chain walk, replacing the former mutually-recursive
 * `checkFontReachable`/`evaluateImportTarget` pair (PR #8 review FINDING 2 — reproduced uncaught
 * `RangeError` at N=3000 chained, non-cyclic `@import`s; V8 has no TCO and the `visited` cycle guard
 * only stops CYCLES, not chain length). An explicit stack bounds memory by the number of distinct
 * files in the graph, not by JS call-stack depth, so a chain of any length completes without a
 * `RangeError`.
 *
 * Preserves the exact short-circuit-on-first-result semantics of the recursive version: this is a
 * DFS, and the first specifier — anywhere in the traversal, depth-first, document order among
 * siblings — that resolves to a font, or that hits a reportable problem (oversized specifier,
 * unresolvable import, a resolver that throws, an unreadable file), ends the walk immediately;
 * sibling imports and files further down the stack are never visited once a result is found. A
 * fully explored branch with nothing found backtracks to the next pending sibling (`nextPendingImport`),
 * and an empty stack with nothing found returns `clean`. `visited` is the caller-owned cycle guard
 * for this whole walk, unchanged from the recursive version: a target already in `visited` is
 * treated as `clean` and the walk backtracks, never re-read and never re-followed.
 */
type ClassifyResult = { kind: 'done'; result: ReachResult } | { kind: 'target'; target: string };

/** Classifies ONE `current` specifier without touching the filesystem: oversized, a direct
 * font-pattern match, a resolver failure, or "resolves to a target file — go read it". Split out
 * of `walkFontChain` purely to keep that function's branch count within this package's Biome
 * complexity budget; no behaviour changed by the split. */
function classifyCurrent(
  current: Current,
  resolveImport: VerifyNoFontImportOptions['resolveImport'],
  patterns: readonly RegExp[],
): ClassifyResult {
  const { file, chain, specifier, line, oversized } = current;

  if (oversized) {
    return {
      kind: 'done',
      result: { kind: 'problem', problem: oversizedImportProblem(file, line, specifier) },
    };
  }
  if (matchesFontPattern(specifier, patterns)) {
    return { kind: 'done', result: { kind: 'font', chain: [...chain, specifier] } };
  }

  const outcome = resolveSpecifier(resolveImport, specifier, file);
  if (outcome.kind === 'threw') {
    return {
      kind: 'done',
      result: {
        kind: 'problem',
        problem: { kind: 'resolver-threw', file, specifier, detail: outcome.detail },
      },
    };
  }
  if (outcome.kind === 'unresolvable') {
    return {
      kind: 'done',
      result: { kind: 'problem', problem: unresolvableImportProblem(file, line, specifier) },
    };
  }
  return { kind: 'target', target: outcome.target };
}

type AdvanceResult = { kind: 'clean' } | { kind: 'next'; current: Current };

/** Optionally pushes `push` (a newly-descended-into file's remaining imports) onto `stack`, then
 * pops the next pending import to continue the walk with — or reports `clean` once the stack is
 * exhausted. Split out of `walkFontChain` purely to keep that function's branch count within this
 * package's Biome complexity budget; shares one call site for both "backtrack past an already-
 * visited target" and "descend into a newly-read target", which differ only in whether a frame is
 * pushed first. */
function advance(stack: WalkFrame[], push?: WalkFrame): AdvanceResult {
  if (push !== undefined) stack.push(push);
  const next = nextPendingImport(stack);
  return next === undefined ? { kind: 'clean' } : { kind: 'next', current: next };
}

type StepResult = { kind: 'done'; result: ReachResult } | { kind: 'descend'; push?: WalkFrame };

/** Evaluates ONE `current` specifier all the way to either a final `ReachResult` or the next thing
 * to push onto the walk's explicit stack: `classifyCurrent`'s outcome, then (only when it resolves
 * to a target) the visited-cycle check and the target file's own content. Split out of
 * `walkFontChain` purely to keep that function's own branch count within this package's Biome
 * complexity budget — every branch here is a flat early return, not nested inside `walkFontChain`'s
 * loop, which is what actually brings the total under budget (moving branches into a same-shaped
 * nested callee does not; flattening them does). */
function evaluateCurrent(
  current: Current,
  visited: Set<string>,
  resolveImport: VerifyNoFontImportOptions['resolveImport'],
  patterns: readonly RegExp[],
): StepResult {
  const classified = classifyCurrent(current, resolveImport, patterns);
  if (classified.kind === 'done') return { kind: 'done', result: classified.result };

  const nextChain = [...current.chain, current.specifier];
  if (visited.has(classified.target)) return { kind: 'descend' };
  visited.add(classified.target);

  const target = readAndScanTarget(classified.target);
  if (target.kind === 'font') return { kind: 'done', result: { kind: 'font', chain: nextChain } };
  if (target.kind === 'problem') {
    return { kind: 'done', result: { kind: 'problem', problem: target.problem } };
  }
  return {
    kind: 'descend',
    push: { file: classified.target, chain: nextChain, pending: target.pending },
  };
}

function walkFontChain(
  entryFile: string,
  entryLine: number,
  entrySpecifier: string,
  resolveImport: VerifyNoFontImportOptions['resolveImport'],
  patterns: readonly RegExp[],
  visited: Set<string>,
): ReachResult {
  const stack: WalkFrame[] = [];
  let current: Current = {
    file: entryFile,
    chain: [],
    specifier: entrySpecifier,
    line: entryLine,
    oversized: false,
  };

  for (;;) {
    const step = evaluateCurrent(current, visited, resolveImport, patterns);
    if (step.kind === 'done') return step.result;

    const advanced = advance(stack, step.push);
    if (advanced.kind === 'clean') return advanced;
    current = advanced.current;
  }
}

/** Classifies and records ONE entry-level live import into `problems`, in place. Split out purely
 * to keep `verifyNoFontImport`'s own branch count under the lint complexity budget — the
 * classification work itself lives in `walkFontChain`. */
function reportEntryImport(
  problems: NoFontImportProblem[],
  file: string,
  entry: LiveImport,
  resolveImport: VerifyNoFontImportOptions['resolveImport'],
  patterns: readonly RegExp[],
): void {
  const { line, specifier, oversized } = entry;
  if (oversized) {
    problems.push(oversizedImportProblem(file, line, specifier));
    return;
  }

  const result = walkFontChain(file, line, specifier, resolveImport, patterns, new Set([file]));
  if (result.kind === 'font') {
    problems.push({
      kind: 'font-import',
      file,
      line,
      specifier,
      chain: result.chain,
      detail:
        `"${sanitizeTagText(specifier)}" imported from "${sanitizeTagText(file)}" at line ${line} ` +
        `reaches a font — chain: ${result.chain.map((step) => sanitizeTagText(step)).join(' -> ')}`,
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
    for (const entry of scanLiveImports(stripped)) {
      reportEntryImport(problems, file, entry, resolveImport, patterns);
    }
  }

  return { ok: problems.length === 0, problems };
}

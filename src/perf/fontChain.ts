/**
 * `verifyFontChain` — walks the `@import` graph of each render-blocking stylesheet and reports
 * every `@font-face` `src` URL that is only reachable at a nested import depth, per design §3.3.
 *
 * The defect: a font declared through `@import` inside a render-blocking stylesheet is not
 * discoverable until that stylesheet has downloaded AND PARSED. The browser's preload scanner
 * cannot see the woff2 URL until then, turning it into a critical request chain. In the
 * originating case, nine `@fontsource` `@import`s meant no font URL existed for the preload
 * scanner until the entry sheet was parsed.
 *
 * THE MESSAGE IS THE POINT (design §3.3, plan T4). `font-display: swap` does NOT resolve this
 * finding, and every problem this gate emits says so explicitly, naming both failure modes:
 *   - RENDERING — what paints while a face loads. Governed by `font-display`. `swap` handles
 *     this correctly: text paints in a fallback immediately.
 *   - DISCOVERY — when the browser first learns the font URL exists at all. Governed by where the
 *     `@font-face` sits in the CSS import graph. `swap` does nothing for this.
 * This exact conflation shipped a real defect as "already correct — NO ACTION" (boufin plan 069
 * §1.3): every clause of that reasoning was true and it answered the wrong question. The gate's
 * own wording is where that misreading gets stopped for the next reader — do not shorten it in a
 * later refactor.
 *
 * DEPTH IS MINIMUM DISCOVERY DEPTH, computed breadth-first, not "whichever path the walk found
 * first". A DFS pinned a file's depth to whatever order its imports were written in: a shared
 * stylesheet imported both directly (depth 1) and, elsewhere, through one more hop (depth 2) was
 * scored at whichever the walk reached first — reordering unrelated, unreachable-by-the-consumer
 * `@import` statements could flip a clean verdict to a false failure. BFS visits every file in
 * non-decreasing hop order, so the first time a file is reached is provably its shortest path
 * (PR #4 review finding).
 *
 * Parsing scope, deliberately hand-rolled (no CSS parser dependency, per house convention):
 *   - Recognises `@import "specifier";`, `@import 'specifier';`, and `@import url(specifier);`
 *     (quoted or unquoted url() contents). Does NOT handle `@import` with a trailing media query
 *     or supports() condition (e.g. `@import "x.css" screen;`) — such imports are still walked as
 *     plain imports; a scoping condition that would in fact exclude the import at runtime is not
 *     evaluated, so this can over-report a chain that a browser would never take.
 *   - Recognises `@font-face { ... src: url(...), url(...); ... }` blocks via brace matching that
 *     does NOT handle nested braces inside `@font-face` (there are none in real CSS) but does NOT
 *     understand `@media`/`@supports`-wrapped `@font-face` blocks — a font declared inside a
 *     conditional group rule is still found (this scanner does not track nesting depth against
 *     block boundaries), but which depth it is attributed to is always the depth of the stylesheet
 *     it textually appears in, never adjusted for the conditional wrapper.
 *   - An `@font-face {` with no matching `}` is FAIL CLOSED (`unparseable-font-face`), never
 *     silently dropped — a build artifact malformed enough to break brace matching is a stronger
 *     signal something is wrong, not a reason to say nothing (PR #4 review finding).
 *   - Does NOT resolve `url()` values that are themselves `data:` URIs into anything meaningful —
 *     they are recorded as the src, but a chain finding about a data URI is inert (nothing to
 *     fetch) and callers should not act on it. Not filtered out, because a silent drop would be a
 *     silent pass for a `@font-face` this gate could not classify.
 *   - Comments (`/* ... *\/`) are stripped before scanning so a commented-out `@import` or
 *     `@font-face` block is never treated as live.
 */
import { readFileSync } from 'node:fs';
import { isFsError } from './errors.ts';

export type FontChainProblemKind =
  | 'empty-input'
  | 'unreadable-stylesheet'
  | 'unresolvable-import'
  | 'resolver-error'
  | 'unparseable-font-face'
  | 'deep-font';

export interface FontChainProblem {
  kind: FontChainProblemKind;
  /** The entry stylesheet this problem was found while walking. Empty for `empty-input`, which
   * precedes any walk. */
  entry: string;
  /** The font `src` URL (for `deep-font`), the `@import` specifier (for `unresolvable-import` and
   * `resolver-error`), or the RESOLVED stylesheet path (for `unreadable-stylesheet` and
   * `unparseable-font-face` — never the `@import` specifier that led there, so a consumer can open
   * the exact file to fix). The literal string `'(entryStylesheets)'` for `empty-input`, which has
   * no single file to point at. */
  subject: string;
  /** Import chain from the entry sheet down to where the font/import/defect actually lives, as
   * specifiers, with the entry path as `chain[0]`. Always includes at least the entry — even an
   * `unreadable-stylesheet` finding on the entry itself ships `chain = [entry]`, never `[]`; a
   * consumer must not branch on `chain.length === 0` to detect that case. Empty only for
   * `empty-input`, which has no stylesheet to chain from. */
  chain: string[];
  message: string;
}

export interface VerifyFontChainOptions {
  /** Render-blocking CSS files, already resolved to real paths on disk. */
  entryStylesheets: string[];
  /** Resolves an `@import` specifier (as written in the CSS) to a file path. Return `undefined`
   * for "cannot resolve" — the gate treats that as a problem, never a skipped import. A throw is
   * also caught and reported (`resolver-error`), distinct from a returned `undefined`, so a
   * consumer's resolver bug is never confused with a genuinely missing file. */
  resolveImport: (specifier: string) => string | undefined;
  /** Depth at which a font URL is still considered directly reachable. 0 (default) means a font
   * must be declared in the entry sheet itself — no nested `@import` parse required. */
  maxChainDepth?: number;
}

export interface VerifyFontChainResult {
  ok: boolean;
  problems: FontChainProblem[];
}

const SWAP_DOES_NOT_FIX_THIS =
  'font-display: swap does not fix this. swap governs RENDERING (what paints while a face ' +
  'loads) and correctly shows fallback text immediately; it does nothing for DISCOVERY (when the ' +
  "browser's preload scanner first learns this font URL exists), which is governed by where the " +
  '@font-face sits in the CSS @import graph, not by font-display.';

/** Strips `/* ... *\/` comments so a commented-out `@import`/`@font-face` is never treated as live. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** One `@import` specifier, unwrapped from `url(...)` and quotes either way it can be written. */
function extractImportSpecifiers(css: string): string[] {
  const specifiers: string[] = [];
  const importRe = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)/g;
  for (const match of css.matchAll(importRe)) {
    const specifier = match[2] ?? match[4];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

/** Every `url(...)` inside one `src:` declaration's value (the part before the trailing `;`). */
function urlsInSrcDeclaration(declarationValue: string): string[] {
  const urls: string[] = [];
  for (const urlMatch of declarationValue.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
    const url = urlMatch[2];
    if (url !== undefined) urls.push(url);
  }
  return urls;
}

/** Every `url(...)` inside every `src:` descriptor found in one `@font-face { ... }` block body. */
function urlsInFontFaceBody(body: string): string[] {
  const urls: string[] = [];
  for (const srcMatch of body.matchAll(/src\s*:\s*([^;]+);/g)) {
    urls.push(...urlsInSrcDeclaration(srcMatch[1] ?? ''));
  }
  return urls;
}

interface FontFaceScanResult {
  /** Every font `src` URL found in a properly closed `@font-face { ... }` block. */
  urls: string[];
  /** Count of `@font-face {` starts with no matching `}` before end of file. */
  unterminatedBlocks: number;
}

/**
 * Every `url(...)` inside every `src:` descriptor of every `@font-face { ... }` block in `css`,
 * plus a count of blocks whose opening brace never closes. Brace-matched rather than
 * regex-spanned across the whole file, so a `@font-face` block does not accidentally swallow
 * unrelated rules that follow it.
 */
function scanFontFaces(css: string): FontFaceScanResult {
  const urls: string[] = [];
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

interface WalkState {
  problems: FontChainProblem[];
  entryLabel: string;
  maxChainDepth: number;
  resolveImport: (specifier: string) => string | undefined;
  /** Paths already enqueued (by resolved file path). BFS marks a node visited the moment it is
   * enqueued, not when it is processed — that is what guarantees the first (and only) time a node
   * is reached is via its shortest `@import` path, and what guarantees termination on a cycle. */
  visited: Set<string>;
}

/**
 * Reads and comment-strips one stylesheet, reporting `unreadable-stylesheet` and returning
 * `undefined` on failure. FAIL CLOSED — an unreadable file is never a silent pass.
 *
 * Only filesystem errors (`isFsError`) are converted into that problem. Anything else — most
 * notably a `RangeError` from a stack overflow — is RE-THROWN. PR #4 review finding: a generic
 * `catch` here previously absorbed a `RangeError: Maximum call stack size exceeded` (produced by
 * an unbounded recursive walk with its cycle guard removed) and reported it as a plausible-looking
 * `unreadable-stylesheet` problem, letting the test suite stay green while a control-flow
 * catastrophe was happening underneath it. A stack overflow must never look like a missing file.
 * See `./errors.ts` for the full classification (including why a stack overflow, a genuine 2GiB+
 * file, and a resolver contract violation all need DIFFERENT verdicts despite overlapping error
 * shapes — round 3 review finding).
 */
function readStylesheet(state: WalkState, path: string, chain: string[]): string | undefined {
  try {
    return stripComments(readFileSync(path, 'utf8'));
  } catch (error) {
    if (!isFsError(error)) throw error;
    state.problems.push({
      kind: 'unreadable-stylesheet',
      entry: state.entryLabel,
      subject: path,
      chain,
      message: `could not read stylesheet "${path}": ${String(error)}`,
    });
    return undefined;
  }
}

/** `state.resolveImport(specifier)`, with a throw converted into a `resolver-error` problem
 * distinct from the resolver returning `undefined` — a consumer's resolver bug must never be
 * confused with a genuinely-missing file (PR #4 review finding). Returns `undefined` on either
 * outcome; the caller cannot and need not tell them apart past this point, since both mean
 * "nothing to walk into" and the problem for each was already pushed here. */
function safeResolveImport(
  state: WalkState,
  specifier: string,
  nextChain: string[],
): string | undefined {
  let resolved: string | undefined;
  try {
    resolved = state.resolveImport(specifier);
  } catch (error) {
    state.problems.push({
      kind: 'resolver-error',
      entry: state.entryLabel,
      subject: specifier,
      chain: nextChain,
      message:
        `resolveImport threw while resolving @import "${specifier}" ` +
        `(chain: ${nextChain.join(' -> ')}): ${String(error)}`,
    });
    return undefined;
  }
  if (resolved === undefined) {
    state.problems.push({
      kind: 'unresolvable-import',
      entry: state.entryLabel,
      subject: specifier,
      chain: nextChain,
      message:
        `@import "${specifier}" (chain: ${nextChain.join(' -> ')}) does not resolve to a file — ` +
        'cannot verify whether it hides a font behind a nested parse.',
    });
    return undefined;
  }
  return resolved;
}

/** One stylesheet queued for BFS processing, at its (shortest-known) depth and the specifier
 * chain that reached it. */
interface QueueItem {
  path: string;
  depth: number;
  chain: string[];
}

/** Reports every `@font-face` src found in `css` at `depth`: `deep-font` when beyond
 * `maxChainDepth`, silently within budget otherwise (that is the clean case this gate exists to
 * pass). Truncated blocks are reported unconditionally, regardless of depth — that defect is
 * structural, not a discovery-latency finding.
 *
 * `path` is the RESOLVED file `css` was read from, threaded through separately from `chain`
 * (whose last element is the `@import` specifier as written, not the file it resolved to) — round
 * 2 review finding: `unparseable-font-face` previously reported `chain[chain.length - 1]`, the
 * specifier, which does not exist on disk under a resolver that renames (alias/package
 * resolution never returns the specifier verbatim). Only `path` points at a file a consumer can
 * actually open. */
function reportFontFaces(
  state: WalkState,
  css: string,
  path: string,
  depth: number,
  chain: string[],
): void {
  const { urls, unterminatedBlocks } = scanFontFaces(css);

  if (unterminatedBlocks > 0) {
    state.problems.push({
      kind: 'unparseable-font-face',
      entry: state.entryLabel,
      subject: path,
      chain,
      message:
        `${unterminatedBlocks} @font-face block(s) in "${path}" (chain: ${chain.join(' -> ')}) ` +
        'have no closing "}" and could not be parsed. A malformed build artifact is being ' +
        'reported rather than silently skipped.',
    });
  }

  if (depth <= state.maxChainDepth) return;
  for (const url of urls) {
    state.problems.push({
      kind: 'deep-font',
      entry: state.entryLabel,
      subject: url,
      chain,
      message:
        `font src "${url}" is only reachable at @import depth ${depth} ` +
        `(chain: ${chain.join(' -> ')}), beyond the allowed depth of ${state.maxChainDepth}. ` +
        'The preload scanner cannot discover this URL until every stylesheet in that chain has ' +
        `downloaded and parsed. ${SWAP_DOES_NOT_FIX_THIS}`,
    });
  }
}

/**
 * Breadth-first walk of the `@import` graph starting at `entryPath`, so every file's reported
 * depth is its MINIMUM discovery depth rather than whichever path a walk order happened to find
 * first (see module doc comment). `state.visited` marks a path the moment it is enqueued, which
 * both guarantees the BFS shortest-path property and guarantees termination on a circular
 * `@import` graph — a node already enqueued is never enqueued again, so the queue is bounded by
 * the number of distinct files in the graph.
 */
function walk(state: WalkState, entryPath: string): void {
  const queue: QueueItem[] = [{ path: entryPath, depth: 0, chain: [entryPath] }];
  state.visited.add(entryPath);

  let item = queue.shift();
  while (item !== undefined) {
    const { path, depth, chain } = item;
    const css = readStylesheet(state, path, chain);
    if (css !== undefined) {
      reportFontFaces(state, css, path, depth, chain);

      for (const specifier of extractImportSpecifiers(css)) {
        const nextChain = [...chain, specifier];
        const resolved = safeResolveImport(state, specifier, nextChain);
        if (resolved === undefined || state.visited.has(resolved)) continue;
        state.visited.add(resolved);
        queue.push({ path: resolved, depth: depth + 1, chain: nextChain });
      }
    }
    item = queue.shift();
  }
}

/**
 * See module doc comment for the defect, the required message content, the minimum-depth BFS
 * requirement, and what the hand-rolled `@import`/`@font-face` parsing does not handle.
 */
export function verifyFontChain(options: VerifyFontChainOptions): VerifyFontChainResult {
  const { entryStylesheets, resolveImport, maxChainDepth = 0 } = options;
  const problems: FontChainProblem[] = [];

  if (entryStylesheets.length === 0) {
    // Fail closed (plan §2 constraint 4): zero entry stylesheets means nothing was walked at all.
    // Reporting `ok: true` here would read as "every font is directly discoverable" when in fact
    // zero stylesheets were ever examined — the exact silent-pass-on-vacuous-input shape this gate
    // exists to rule out.
    problems.push({
      kind: 'empty-input',
      entry: '',
      subject: '(entryStylesheets)',
      chain: [],
      message:
        'entryStylesheets is empty — there is nothing to verify is font-discoverable, and that ' +
        'is being reported rather than treated as a pass. Did the render-blocking sheet list get ' +
        'built correctly?',
    });
    return { ok: false, problems };
  }

  for (const entry of entryStylesheets) {
    const state: WalkState = {
      problems,
      entryLabel: entry,
      maxChainDepth,
      resolveImport,
      visited: new Set<string>(),
    };
    walk(state, entry);
  }

  return { ok: problems.length === 0, problems };
}

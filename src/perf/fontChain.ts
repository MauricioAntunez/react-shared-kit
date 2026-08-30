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
 *   - Does NOT resolve `url()` values that are themselves `data:` URIs into anything meaningful —
 *     they are recorded as the src, but a chain finding about a data URI is inert (nothing to
 *     fetch) and callers should not act on it. Not filtered out, because a silent drop would be a
 *     silent pass for a `@font-face` this gate could not classify.
 *   - Comments (`/* ... *\/`) are stripped before scanning so a commented-out `@import` or
 *     `@font-face` block is never treated as live.
 */
import { readFileSync } from 'node:fs';

export type FontChainProblemKind = 'unreadable-stylesheet' | 'unresolvable-import' | 'deep-font';

export interface FontChainProblem {
  kind: FontChainProblemKind;
  /** The entry stylesheet this problem was found while walking. */
  entry: string;
  /** The font `src` URL (for `deep-font`), the `@import` specifier (for `unresolvable-import`),
   * or the stylesheet path (for `unreadable-stylesheet`) that this problem is about. */
  subject: string;
  /** Import chain from the entry sheet down to where the font/import actually lives, as
   * specifiers (or file paths for the entry). Empty for `unreadable-stylesheet`. */
  chain: string[];
  message: string;
}

export interface VerifyFontChainOptions {
  /** Render-blocking CSS files, already resolved to real paths on disk. */
  entryStylesheets: string[];
  /** Resolves an `@import` specifier (as written in the CSS) to a file path. Return `undefined`
   * for "cannot resolve" — the gate treats that as a problem, never a skipped import. */
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

/** Every `url(...)` inside every `src:` descriptor of every `@font-face { ... }` block in `css`.
 * Brace-matched rather than regex-spanned across the whole file, so a `@font-face` block does not
 * accidentally swallow unrelated rules that follow it. */
function extractFontFaceSrcUrls(css: string): string[] {
  const urls: string[] = [];
  const blockStartRe = /@font-face\s*\{/g;
  for (const start of css.matchAll(blockStartRe)) {
    const bodyStart = (start.index ?? 0) + start[0].length;
    const end = css.indexOf('}', bodyStart);
    if (end === -1) continue; // unterminated block — nothing to extract, not this gate's job to flag
    urls.push(...urlsInFontFaceBody(css.slice(bodyStart, end)));
  }
  return urls;
}

interface WalkState {
  problems: FontChainProblem[];
  entryLabel: string;
  maxChainDepth: number;
  resolveImport: (specifier: string) => string | undefined;
  visited: Set<string>;
}

/** Reads and comment-strips one stylesheet, reporting `unreadable-stylesheet` and returning
 * `undefined` on failure. FAIL CLOSED — an unreadable file is never a silent pass. */
function readStylesheet(state: WalkState, path: string, chain: string[]): string | undefined {
  try {
    return stripComments(readFileSync(path, 'utf8'));
  } catch (error) {
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

/**
 * Depth-first walk of the `@import` graph starting at `path`, reporting every `@font-face` src
 * found deeper than `maxChainDepth` and every `@import` specifier that does not resolve.
 * `depth` is the number of `@import` hops already taken to reach `path` (0 for the entry sheet
 * itself). `chain` is the specifier trail (or the entry path, for depth 0).
 *
 * Circular `@import` graphs are guarded via `state.visited` (by resolved path) — a cycle simply
 * stops walking rather than recursing forever.
 */
function walk(state: WalkState, path: string, depth: number, chain: string[]): void {
  if (state.visited.has(path)) return;
  state.visited.add(path);

  const css = readStylesheet(state, path, chain);
  if (css === undefined) return;

  if (depth > state.maxChainDepth) {
    for (const url of extractFontFaceSrcUrls(css)) {
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
  // Fonts within the allowed depth are not reported here — a directly-declared @font-face at
  // depth <= maxChainDepth is the clean case this gate is meant to pass.

  for (const specifier of extractImportSpecifiers(css)) {
    const resolved = state.resolveImport(specifier);
    const nextChain = [...chain, specifier];
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
      continue;
    }
    walk(state, resolved, depth + 1, nextChain);
  }
}

/**
 * See module doc comment for the defect, the required message content, and what the hand-rolled
 * `@import`/`@font-face` parsing does not handle.
 */
export function verifyFontChain(options: VerifyFontChainOptions): VerifyFontChainResult {
  const { entryStylesheets, resolveImport, maxChainDepth = 0 } = options;
  const problems: FontChainProblem[] = [];

  for (const entry of entryStylesheets) {
    const state: WalkState = {
      problems,
      entryLabel: entry,
      maxChainDepth,
      resolveImport,
      visited: new Set<string>(),
    };
    walk(state, entry, 0, [entry]);
  }

  return { ok: problems.length === 0, problems };
}

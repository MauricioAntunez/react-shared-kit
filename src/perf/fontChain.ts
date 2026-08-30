/**
 * `verifyFontChain` — enforces a hard rule: **a font file must never be imported via CSS.** Every
 * `@font-face` reachable only through an external stylesheet — whether declared directly in a
 * render-blocking sheet or behind a nested `@import` — is a defect, full stop, regardless of how
 * many hops away it is. There is no acceptable depth other than zero.
 *
 * ROOT CAUSE OF A SHIPPED MISS (this file's prior version): depth was measured WITHIN the CSS
 * graph, starting from the entry stylesheet — so a font declared directly in the entry sheet
 * scored depth 0 and PASSED, six review rounds never questioning the quantity. That is the wrong
 * frame of reference. The browser's preload scanner reads the DOCUMENT, not any CSS file: a font
 * whose only declaration lives in a stylesheet is undiscoverable until that stylesheet has been
 * fetched AND parsed, whether or not any `@import` is involved. Measured on the originating
 * consumer: zero `@import`s, `@font-face` in the entry sheet, no preload — this gate used to
 * report "no font declared behind a nested @import chain" and pass, while the real critical-path
 * chain (`document -> root.css -> woff2`) cost ~100ms of pure discovery latency that a green gate
 * said did not exist.
 *
 * THE FIX: depth is now measured FROM THE DOCUMENT. A font is depth 0 — clean — in exactly two
 * shapes, and no other:
 *   1. a `<link rel="preload" as="font" crossorigin>` in `htmlFiles` names that URL, or
 *   2. the `@font-face` sits inside an inline `<style>` in `htmlFiles` itself.
 * Anything else is `deep-font`, whether it took one hop (the render-blocking entry sheet itself)
 * or several (one or more nested `@import`s on top of that hop). There is no `maxChainDepth`
 * option here on purpose (see below) — this module previously exposed one, and a tunable
 * threshold is exactly the shape of knob that lets a consumer accept the hard rule's violation.
 * The BFS `@import` walk below still computes and reports the actual hop count, because it is
 * useful diagnostic detail in the problem message, but it never gates pass/fail — every depth
 * greater than 0 fails, uniformly.
 *
 * THE MESSAGE IS THE POINT (design §3.3, plan T4, and re-affirmed on this fix): `font-display:
 * swap` does NOT resolve this finding, and every problem this gate emits says so explicitly,
 * naming both failure modes:
 *   - RENDERING — what paints while a face loads. Governed by `font-display`. `swap` handles
 *     this correctly: text paints in a fallback immediately.
 *   - DISCOVERY — when the browser first learns the font URL exists at all. Governed by whether
 *     the document itself reveals it. `swap` does nothing for this.
 * This exact conflation shipped a real defect as "already correct — NO ACTION" (boufin plan 069
 * §1.3) TWICE — first for the discovery/rendering conflation itself, then again when this gate's
 * own depth-from-the-wrong-root bug let the same underlying defect slip past a "fixed" check. The
 * gate's own wording is where the first misreading gets stopped for the next reader; do not
 * shorten it in a later refactor.
 *
 * THE REMEDY IS NOT "PRELOAD EVERY FACE." The gate cannot know which face the largest
 * above-the-fold text actually uses, so every `deep-font` message states both legitimate remedies
 * and says which is usually better: inlining the `@font-face` declaration in the document HEAD
 * discovers the font at HTML parse time AND still lets the browser download the face lazily, only
 * once a glyph actually needs it — a `<link rel="preload">`, by contrast, forces an unconditional
 * download the moment the browser sees the tag. A project with nine faces and six of them on the
 * critical path would trade ~100ms of discovery latency for ~100KB of critical-path bytes by
 * preloading all of them — a worse outcome than the defect being fixed.
 *
 * DEPTH IS MINIMUM DISCOVERY DEPTH WITHIN THE CSS GRAPH, computed breadth-first, not "whichever
 * path the walk found first" — this part of the design is unchanged by the fix above. A DFS
 * pinned a file's depth to whatever order its imports were written in: a shared stylesheet
 * imported both directly and, elsewhere, through one more hop was scored at whichever the walk
 * reached first — reordering unrelated, unreachable-by-the-consumer `@import` statements could
 * change the reported (though never the pass/fail) depth. BFS visits every file in non-decreasing
 * hop order, so the first time a file is reached is provably its shortest path (PR #4 review
 * finding). The walk now starts at depth 1, not 0: reaching the render-blocking entry sheet is
 * itself one hop from the document, before any `@import` is walked.
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
 *     it textually appears in, never adjusted for the conditional wrapper. The same hand-rolled
 *     brace-matching approach is reused, unexported, for `@font-face` blocks inside an inline
 *     `<style>` — a document-level truncated block is not reported as a separate problem kind
 *     (unlike the external-stylesheet case below): it simply cannot exempt anything, and its font
 *     URL is not being walked for elsewhere, so there is nothing else meaningful to say about it.
 *   - An `@font-face {` with no matching `}` INSIDE AN EXTERNAL STYLESHEET is FAIL CLOSED
 *     (`unparseable-font-face`), never silently dropped — a build artifact malformed enough to
 *     break brace matching is a stronger signal something is wrong, not a reason to say nothing
 *     (PR #4 review finding).
 *   - Does NOT resolve `url()` values that are themselves `data:` URIs into anything meaningful —
 *     they are recorded as the src, but a chain finding about a data URI is inert (nothing to
 *     fetch) and callers should not act on it. Not filtered out, because a silent drop would be a
 *     silent pass for a `@font-face` this gate could not classify.
 *   - Comments (`/* ... *\/`) are stripped before scanning so a commented-out `@import` or
 *     `@font-face` block is never treated as live. Same treatment for inline `<style>` bodies.
 *   - The two exemption checks (preload URL, inline `@font-face` URL) are plain string equality
 *     against the `url()` value as written in each source — no URL normalisation (relative vs.
 *     absolute, trailing query strings). A consumer whose preload `href` and stylesheet `url()`
 *     disagree in form will see a false `deep-font`; this mirrors the same documented limitation
 *     already accepted for `data:` URIs above and for `resolveHref`/`resolveImport` elsewhere in
 *     this module — the gate reasons about strings as written, not resolved URL identity.
 */
import { readFileSync } from 'node:fs';
import { assertResolverReturn, assertStringOption } from './errors.ts';

export type FontChainProblemKind =
  | 'empty-input'
  | 'unreadable-html'
  | 'unreadable-stylesheet'
  | 'unresolvable-import'
  | 'resolver-error'
  | 'unparseable-font-face'
  | 'deep-font';

export interface FontChainProblem {
  kind: FontChainProblemKind;
  /** The entry stylesheet this problem was found while walking. Empty for `empty-input` and
   * `unreadable-html`, neither of which is scoped to one entry sheet. */
  entry: string;
  /** The font `src` URL (for `deep-font`), the `@import` specifier (for `unresolvable-import` and
   * `resolver-error`), or the RESOLVED stylesheet path (for `unreadable-stylesheet` and
   * `unparseable-font-face` — never the `@import` specifier that led there, so a consumer can open
   * the exact file to fix). The unreadable HTML file's own path for `unreadable-html`. The literal
   * string `'(htmlFiles)'` or `'(entryStylesheets)'` for `empty-input`, naming which input was
   * empty — neither has a single file to point at. */
  subject: string;
  /** Import chain from the entry sheet down to where the font/import/defect actually lives, as
   * specifiers, with the entry path as `chain[0]`. Always includes at least the entry — even an
   * `unreadable-stylesheet` finding on the entry itself ships `chain = [entry]`, never `[]`; a
   * consumer must not branch on `chain.length === 0` to detect that case. Empty for `empty-input`
   * and `unreadable-html`, neither of which has a stylesheet to chain from. */
  chain: string[];
  message: string;
}

export interface VerifyFontChainOptions {
  /** Built HTML documents to scan for the two shapes that exempt a font from `deep-font`: a
   * `<link rel="preload" as="font" crossorigin>` naming its URL, or an inline `<style>` in the
   * document containing its `@font-face` block. Scanned globally across every file — a preload
   * or inline declaration anywhere in `htmlFiles` exempts that URL everywhere it is found in the
   * CSS graph, since the point being verified is "does at least one document reveal this font,"
   * not "does every page." */
  htmlFiles: string[];
  /** Render-blocking CSS files, already resolved to real paths on disk. */
  entryStylesheets: string[];
  /** Resolves an `@import` specifier (as written in the CSS) to a file path. Return `undefined`
   * for "cannot resolve" — the gate treats that as a problem, never a skipped import. A throw is
   * also caught and reported (`resolver-error`), distinct from a returned `undefined`, so a
   * consumer's resolver bug is never confused with a genuinely missing file. */
  resolveImport: (specifier: string) => string | undefined;
}

export interface VerifyFontChainResult {
  ok: boolean;
  problems: FontChainProblem[];
}

const SWAP_DOES_NOT_FIX_THIS =
  'font-display: swap does not fix this. swap governs RENDERING (what paints while a face ' +
  'loads) and correctly shows fallback text immediately; it does nothing for DISCOVERY (when the ' +
  "browser's preload scanner first learns this font URL exists), which is governed by whether " +
  'the DOCUMENT itself reveals the URL, not by font-display.';

const REMEDY =
  'A font file must never be imported via CSS — this URL is reachable only through an external ' +
  'stylesheet, which the browser cannot see until that stylesheet is fetched and parsed. Fix it ' +
  'one of two ways: (a) inline this @font-face block inside a <style> in the document head — ' +
  'usually the better choice, since discovery happens at HTML parse time AND the browser still ' +
  'only downloads the face once a glyph needs it; or (b) add a ' +
  '<link rel="preload" as="font" crossorigin> for this exact URL in the document, which forces ' +
  'an unconditional download the moment the browser sees the tag. Do NOT preload every face as a ' +
  'blanket fix — on a page with several faces on the critical path, that trades a discovery delay ' +
  'for a bandwidth cost on the SAME critical path, which is worse.';

/** Strips `/* ... *\/` comments so a commented-out `@import`/`@font-face` is never treated as live. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Test-only indirection point (module export, NOT re-exported from `./index.ts`'s barrel — same
 * pattern as `./errors.ts`'s helpers). `stripComments` is a pure regex transform with no external
 * module boundary to intercept, unlike `brotliCompressSync` in `cssBudget.ts`, so this object
 * exists purely so a test can substitute a throwing implementation and prove the round 5 fix: a
 * `stripComments` failure propagates uncaught rather than being reported as `unreadable-stylesheet`
 * about a file that WAS read successfully. Never mutated outside a test.
 */
export const internal = { stripComments };

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
 * unrelated rules that follow it. Shared between external-stylesheet scanning and inline
 * `<style>` scanning (see `extractInlineFontFaceUrls`) — the block grammar is identical either
 * way; only how a truncated block is reported differs at the call site.
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

/** Reads one attribute's raw string value off a tag's source text. Duplicated minimally from
 * `cssBudget.ts`'s identical helper (that module is out of scope for this fix, and the shared
 * shape is small enough that a second copy is cheaper than a cross-cutting helper module for one
 * function each — same reasoning `cssBudget.ts` already gives for its own copy). */
function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
  return match?.[1];
}

/** `<link rel="preload" as="font" crossorigin href="...">` URLs in `html`. All three of `rel`,
 * `as` and `crossorigin` are required.
 *
 * A preload missing `crossorigin` makes the browser fetch the font TWICE, so it is NOT treated as
 * satisfying the exemption — it is not a fix, it is a second download. MEASURED, not assumed:
 * two identical same-origin pages, each with one `@font-face` and one preload for the same woff2,
 * differing only in the attribute, counting `performance.getEntriesByType('resource')`:
 *
 *   without crossorigin -> 2 requests   (initiatorType 'link' AND 'css')
 *   with    crossorigin -> 1 request    (initiatorType 'css', served from the preload)
 *
 * The mechanism is that a font is always fetched in CORS mode, so a no-cors preload lands in a
 * different cache partition than the font-relation request that follows and cannot satisfy it.
 * That mechanism is the standard explanation and it matches the observation, but note the
 * OBSERVATION is the evidence here: a fanout across the project's KBs (MDN, chrome-developer,
 * web.dev, the WHATWG HTML spec) returned nothing stating it, so it was settled by reproduction
 * rather than by citation. Re-run the two-page probe before changing this behaviour.
 *
 * `crossorigin` is boolean-ish — bare or `crossorigin="anonymous"` both count — unlike `rel`/`as`,
 * which carry meaningful values. */
function extractPreloadFontUrls(html: string): Set<string> {
  const urls = new Set<string>();
  for (const match of html.matchAll(/<link\s[^>]*>/gi)) {
    const tag = match[0];
    const rel = attr(tag, 'rel');
    if (rel === undefined || !/\bpreload\b/i.test(rel)) continue;
    const as = attr(tag, 'as');
    if (as === undefined || !/^font$/i.test(as)) continue;
    if (!/(^|\s)crossorigin(\s|=|\/?>|$)/i.test(tag)) continue;
    const href = attr(tag, 'href');
    if (href !== undefined) urls.add(href);
  }
  return urls;
}

/** Font `src` URLs declared inside any inline `<style>` block in `html` — the second of the two
 * shapes that exempt a font from `deep-font` (see module doc comment). A truncated `@font-face`
 * inside an inline block is not separately reported: this function only feeds the exemption set,
 * so a malformed inline block simply fails to exempt anything, which is already the fail-closed
 * outcome (see module doc comment). */
function extractInlineFontFaceUrls(html: string): Set<string> {
  const urls = new Set<string>();
  for (const styleMatch of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    const { urls: fontUrls } = scanFontFaces(stripComments(styleMatch[1] ?? ''));
    for (const url of fontUrls) urls.add(url);
  }
  return urls;
}

interface WalkState {
  problems: FontChainProblem[];
  entryLabel: string;
  resolveImport: (specifier: string) => string | undefined;
  /** URLs exempt from `deep-font`: either preloaded (with `crossorigin`) or declared inline in
   * the document. The union of `extractPreloadFontUrls` and `extractInlineFontFaceUrls` across
   * every file in `htmlFiles`. */
  exemptUrls: Set<string>;
  /** Paths already enqueued (by resolved file path). BFS marks a node visited the moment it is
   * enqueued, not when it is processed — that is what guarantees the first (and only) time a node
   * is reached is via its shortest `@import` path, and what guarantees termination on a cycle. */
  visited: Set<string>;
}

/**
 * Reads and comment-strips one stylesheet, reporting `unreadable-stylesheet` and returning
 * `undefined` on failure. FAIL CLOSED — an unreadable file is never a silent pass.
 *
 * UNCONDITIONAL catch, NARROWED to exactly the `readFileSync` call (round 4 then round 5 review
 * redesign): every caller of this function only ever passes a value already proven to be a real
 * string — the entry path (validated in `verifyFontChain`) or a resolved path (validated by
 * `assertResolverReturn` in `safeResolveImport` before it is ever queued). Given a real string,
 * whatever `readFileSync` raises about it — ENOENT, EACCES, EISDIR, `ERR_FS_FILE_TOO_LARGE`, a
 * NUL byte — IS a fact about the build and belongs in `problems`. See `./errors.ts` for why
 * classifying the error after the fact (what rounds 2-4 tried) cannot work, and why validating the
 * input at the boundary instead makes this catch simple again.
 *
 * `stripComments` runs OUTSIDE the try, deliberately (round 5 review finding): it is a pure
 * regex transform of bytes ALREADY read from disk, not an fs fact. Lumping it into the same catch
 * as `readFileSync` was the same bug already fixed for the resolver boundary in round 4 — one
 * catch spanning two unrelated operations reports a bug in the second operation as if it were a
 * fact about the first. A `stripComments` failure is a bug in this module, not a build defect,
 * and propagates like any other internal bug rather than becoming a misleading "could not read"
 * finding about a file that WAS read successfully.
 *
 * The walk is also iterative (BFS, not recursive — see `walk`), so the stack-overflow scenario
 * that once made this catch's classification matter no longer arises here at all.
 */
function readStylesheet(state: WalkState, path: string, chain: string[]): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
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
  return internal.stripComments(raw);
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
  // Round 4 review finding: resolveImport can also misbehave WITHOUT throwing — returning a URL
  // object, a Proxy, or any other non-`string | undefined` value. Validated here, before `resolved`
  // ever reaches readFileSync, so that bug throws loudly and immediately instead of surfacing as a
  // misclassified filesystem finding two calls later.
  assertResolverReturn(resolved, 'resolveImport', specifier);
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
 * chain that reached it. Depth starts at 1 (see `walk`): reaching the render-blocking entry sheet
 * is itself one hop from the document. */
interface QueueItem {
  path: string;
  depth: number;
  chain: string[];
}

/** Reports every `@font-face` src found in `css` at `depth`, UNLESS it is in `state.exemptUrls`
 * (preloaded with `crossorigin`, or declared inline in the document — see module doc comment).
 * There is no depth threshold: every CSS-graph depth is >= 1 (a document hop, at minimum), and
 * the hard rule is "a font file must never be imported via CSS" at ANY depth — so every
 * non-exempt URL found here is reported, uniformly. `depth` still appears in the message purely as
 * diagnostic detail (how far the defect is), never as a pass/fail threshold.
 *
 * Truncated blocks are reported unconditionally, regardless of depth or exemption — that defect
 * is structural, not a discovery-latency finding, and a font inside a block this scanner could
 * not parse cannot be checked against `exemptUrls` in the first place.
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

  for (const url of urls) {
    if (state.exemptUrls.has(url)) continue;
    state.problems.push({
      kind: 'deep-font',
      entry: state.entryLabel,
      subject: url,
      chain,
      message:
        `${REMEDY} This URL is reachable only after ${depth} stylesheet hop(s) from the ` +
        `document (chain: ${chain.join(' -> ')}). ${SWAP_DOES_NOT_FIX_THIS}`,
    });
  }
}

/**
 * Breadth-first walk of the `@import` graph starting at `entryPath`, so every file's reported
 * depth is its MINIMUM discovery depth rather than whichever path a walk order happened to find
 * first (see module doc comment). Depth starts at 1, not 0: `entryPath` is already one hop away
 * from the document that links it. `state.visited` marks a path the moment it is enqueued, which
 * both guarantees the BFS shortest-path property and guarantees termination on a circular
 * `@import` graph — a node already enqueued is never enqueued again, so the queue is bounded by
 * the number of distinct files in the graph.
 */
function walk(state: WalkState, entryPath: string): void {
  const queue: QueueItem[] = [{ path: entryPath, depth: 1, chain: [entryPath] }];
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

/** Reads every file in `htmlFiles` once and accumulates the union of both exemption shapes across
 * all of them (see `VerifyFontChainOptions.htmlFiles`). An unreadable file is reported
 * (`unreadable-html`) and skipped — never abandons signals already collected from files already
 * read, the same fail-closed-but-not-fail-stop shape as the rest of this module's per-file loops. */
function collectDocumentSignals(htmlFiles: string[]): {
  exemptUrls: Set<string>;
  problems: FontChainProblem[];
} {
  const exemptUrls = new Set<string>();
  const problems: FontChainProblem[] = [];
  for (const htmlFile of htmlFiles) {
    let html: string;
    try {
      // UNCONDITIONAL catch, NARROWED to exactly this call: htmlFile is already validated to be a
      // real string (assertStringOption, in verifyFontChain) before it ever reaches this line.
      html = readFileSync(htmlFile, 'utf8');
    } catch (error) {
      problems.push({
        kind: 'unreadable-html',
        entry: '',
        subject: htmlFile,
        chain: [],
        message: `could not read "${htmlFile}": ${String(error)}`,
      });
      continue;
    }
    for (const url of extractPreloadFontUrls(html)) exemptUrls.add(url);
    for (const url of extractInlineFontFaceUrls(html)) exemptUrls.add(url);
  }
  return { exemptUrls, problems };
}

/**
 * See module doc comment for the defect, the hard no-non-zero-depth rule, the required message
 * content, the minimum-depth BFS diagnostic, and what the hand-rolled `@import`/`@font-face`
 * parsing does not handle.
 */
export function verifyFontChain(options: VerifyFontChainOptions): VerifyFontChainResult {
  const { htmlFiles, entryStylesheets, resolveImport } = options;

  // Boundary validation (see ./errors.ts): a caller passing a non-string element in either array
  // is a contract violation and must crash loudly here, naming the index, rather than flow into
  // readFileSync and surface as a misclassified unreadable-html/unreadable-stylesheet finding.
  for (const [index, file] of htmlFiles.entries()) assertStringOption(file, `htmlFiles[${index}]`);
  for (const [index, entry] of entryStylesheets.entries()) {
    assertStringOption(entry, `entryStylesheets[${index}]`);
  }

  // Fail closed (plan §2 constraint 4): nothing to examine must never read as a clean pass. Both
  // are checked (not short-circuited) so a caller misconfiguring both sees both problems, but
  // processing stops here — walking the CSS graph with zero known documents would report every
  // font as un-exemptable, burying the real empty-input signal in a flood of findings that looks
  // like the check ran when it did not.
  const emptyProblems: FontChainProblem[] = [];
  if (htmlFiles.length === 0) {
    emptyProblems.push({
      kind: 'empty-input',
      entry: '',
      subject: '(htmlFiles)',
      chain: [],
      message:
        'htmlFiles is empty — there is nothing to check for a preload or inline <style> that ' +
        'would exempt a font, and that is being reported rather than treated as a pass. Did the ' +
        'built HTML output get listed correctly?',
    });
  }
  if (entryStylesheets.length === 0) {
    emptyProblems.push({
      kind: 'empty-input',
      entry: '',
      subject: '(entryStylesheets)',
      chain: [],
      message:
        'entryStylesheets is empty — there is nothing to verify is font-discoverable, and that ' +
        'is being reported rather than treated as a pass. Did the render-blocking sheet list get ' +
        'built correctly?',
    });
  }
  if (emptyProblems.length > 0) return { ok: false, problems: emptyProblems };

  const { exemptUrls, problems } = collectDocumentSignals(htmlFiles);

  for (const entry of entryStylesheets) {
    const state: WalkState = {
      problems,
      entryLabel: entry,
      resolveImport,
      exemptUrls,
      visited: new Set<string>(),
    };
    walk(state, entry);
  }

  return { ok: problems.length === 0, problems };
}

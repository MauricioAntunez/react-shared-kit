import { readFileSync } from 'node:fs';
import { assertResolverReturn, assertStringOption } from './errors.ts';
import { attr, MAX_URL_LENGTH, sanitizeTagText, scanFontFaces } from './scan.ts';
import { stripComments, stripHtmlComments } from './text.ts';

/**
 * `verifyFontPreload` — every `@font-face` a build declares must be preloaded from every document
 * that needs it, and every font preload must actually be usable by a browser and actually name a
 * real face. Owner ruling 2026-08-31: fonts are loaded FROM THE HTML with
 * `<link rel="preload" as="font">`, never discovered through a stylesheet — this gate is the
 * enforcement of that ruling, not the ruling itself (see `verifyFontChain` in `./fontChain.ts` for
 * the discoverability rule this one composes with).
 *
 * PROVENANCE: ported and hardened from two sibling-project gates that hit these defects for real,
 * not hypothetically — boufin's `scripts/verify-font-preload.ts` (a build-time gate over a single
 * bundled architecture) and web-chile's `scripts/verify-font-chain.mjs` (the preload-pairing block
 * appended after that project's own `verifyFontChain` call, over an inline-per-document
 * architecture). Both are in active use; this module exists because a kit gate serving only one
 * shape is useless to the other, so it reads faces from BOTH `cssFiles` (bundled) AND every
 * document's own inline `<style>` blocks (inline) unconditionally.
 *
 * WHY `expectedFacesPerDocument` IS REQUIRED, NOT OPTIONAL: web-chile's round-2 review reproduced,
 * against the real 145-document build, a check that unions font URLs across every document and
 * asserts the union non-empty — passing while exactly ONE document had its entire inline `<style>`
 * block stripped. The union stayed non-empty (fewer referencing documents, same distinct URLs), so
 * a global floor of any size could not have caught it: only a PER-DOCUMENT assertion can see one
 * document losing everything while the rest keep theirs. An optional floor recreates the same
 * vacuous-pass hole for any consumer who omits it, so it is mandatory here. It is a FLOOR, not a
 * tolerance: raising it can only make the gate stricter, and it runs BEFORE any cross-document
 * aggregation is used for anything else, so `under-declared-faces` never depends on what other
 * documents declare.
 *
 * PER-DOCUMENT ATTRIBUTION OF `cssFiles` FACES (PR #8 FULL-review finding, 2026-09-01): the fix
 * above closed the hole for INLINE faces, but a second, distinct hole survived in the `cssFiles`
 * path — reproduced against this exact module. `cssFaceUrls` used to be a single build-wide union
 * over every `cssFiles` entry, merged into EVERY document's face set with no check that the
 * document actually links that stylesheet. Two documents sharing one bundled chunk, one of them
 * losing its OWN signal (its `<link rel="stylesheet">` for that chunk, its inline `<style>`, or
 * both) while carrying copy-pasted preload boilerplate for the chunk's faces regardless: the union
 * still satisfied the per-document floor for the broken document, because the floor was being fed
 * faces the document never actually declared. The floor is only as correct as the attribution
 * feeding it — a per-document ASSERTION over a build-wide UNION is not a per-document guarantee.
 *
 * Fixed the same way `verifyFontChain` already does it (see that module's `resolveStylesheet` /
 * `extractStylesheetHrefs` precedent): a `cssFiles` entry's faces are attributed to a document ONLY
 * when that document carries a `<link rel="stylesheet">` whose `href`, resolved through the same
 * `resolveHref` this module already requires, names that exact `cssFiles` entry. A document's face
 * set is now `inline @font-face faces ∪ faces of cssFiles entries it actually links` — never a
 * global union. Three edge cases this creates, decided and tested here (`fontPreload.test.ts`):
 *   - An entry in `cssFiles` no document links (a dead/orphan chunk) produces NO problem of its
 *     own. Its faces still go through `resolveDistinctFaceUrls` (so `unresolvable-font-file` /
 *     `face-without-woff2` still fire if it is malformed), but preload PAIRING never runs for its
 *     URLs, because no document's attributed face set ever includes them. This is a deliberate
 *     scope limit, not an oversight: "is every built CSS chunk referenced by some document" is a
 *     bundler/dead-code question, not a per-document preload-correctness question, which is what
 *     this gate exists to answer.
 *   - A document linking a stylesheet whose resolved path is NOT among `cssFiles` produces
 *     `unscanned-stylesheet`, visibly — it does NOT silently contribute zero faces as if the link
 *     were absent. This gate cannot verify faces it was never given the file to scan; `cssFiles` is
 *     expected to enumerate the CSS this gate should treat as authoritative for `@font-face`, and a
 *     linked stylesheet missing from that list is either an incomplete `cssFiles` argument or a
 *     stylesheet this gate has no way to vouch for. Either way the consumer is told, not left to
 *     assume a clean pass. (A stylesheet `href` that does not RESOLVE at all — `resolveHref` throws
 *     or returns `undefined` — is reported as `resolver-threw` or silently excluded respectively;
 *     an unresolvable stylesheet reference is `verifyFontChain`'s `unresolvable-stylesheet` to
 *     catch, not duplicated here, to avoid two gates disagreeing about the same broken `href`.)
 *
 *   `expectedFacesPerDocument` IS A COUNT FLOOR, NOT A CONTENT ASSERTION — the one thing it cannot
 *   see, stated here so a green result is not read as more than it is. It answers "does this
 *   document declare at least N distinct faces", never "are they the RIGHT N". Verified against
 *   this module: two documents both linking a two-face chunk, one of them additionally declaring a
 *   third face inline — pin the floor at 2 and the loss of that third face is INVISIBLE, because
 *   the survivors still clear 2; pin it at 3, the number that document genuinely expects, and the
 *   same loss is reported. So pin it to what the RICHEST document declares, not to the smallest
 *   number every document happens to satisfy. Equally, a document swapping one face for a duplicate
 *   of another keeps its count and passes; catching that needs a per-document expected SET, which
 *   this gate deliberately does not take — the expected set differs per route in every consumer
 *   architecture examined, and a per-document set argument nobody maintains decays into a rubber
 *   stamp faster than a count nobody has to. A template regression removing the SAME face from
 *   EVERY document is outside this floor's reach for the same reason: every document falls
 *   together, so none is anomalous relative to the pinned number. `verifyFontChain` and a browser
 *   sweep cover that case; this gate is necessary, not sufficient.
 *   - `cssFiles: []` with every face declared inline is unaffected by any of the above: with no
 *     `cssFiles` entries there is nothing to attribute and nothing to mismatch against, so a
 *     document's face set is exactly its inline faces, exactly as before this fix.
 * Residual limit, stated plainly rather than overclaimed: this still trusts `resolveHref` to
 * resolve a stylesheet `href` to the SAME path string used as a `cssFiles` entry. A resolver that
 * returns two different-but-equivalent paths for what is really the same file (say, a symlink and
 * its target) defeats the string-equality match and reads as `unscanned-stylesheet`. That is a
 * resolver-consistency requirement this module cannot itself verify — same trust boundary the
 * module already places on every other `resolveHref` call.
 *
 * TWO VIEWS OF THE SAME HTML DOCUMENT, deliberately different:
 *   - Hunting `<link>` TAGS (this gate never reads inline CSS as markup) uses
 *     `stripHtmlComments(html, { blankStyleBodies: true })` — a `<link rel="preload" as="font"
 *     href="...">`-SHAPED STRING sitting inside a `<style>` body (e.g. a CSS `content:` value) must
 *     not survive into the stripped output and be misread by the tag scan as a real preload.
 *   - Scanning a document's inline `<style>` blocks for `@font-face` uses the DEFAULT
 *     `stripHtmlComments(html)` (unblanked) — blanking would destroy the very content that scan
 *     exists to read. Getting this backwards is the exact defect that broke an earlier task: using
 *     the blanked view for `@font-face` scanning silently loses every inline face, and using the
 *     unblanked view for tag scanning lets a decoy string in a `<style>` body register as a live
 *     preload.
 *
 * OTHER PROBLEM CLASSES, each traced to a concrete failure a plainer check missed:
 *   - `face-without-woff2` is REPORTED, never skipped — a face with no woff2 src cannot be
 *     preloaded in this form, so silently dropping it would recreate late discovery while the gate
 *     said PASS.
 *   - `font-preload-wrong-crossorigin` checks the attribute's VALUE, not merely its presence: a
 *     bare `crossorigin` is legal HTML meaning anonymous and is NOT reported, but
 *     `crossorigin="use-credentials"` is a DIFFERENT fetch cache key than the `@font-face`
 *     request, so the face downloads twice — the identical cost to omitting the attribute
 *     entirely, which a boolean presence test cannot distinguish.
 *   - `font-preload-wrong-type` — browsers treat `type` as a capability hint and may skip the
 *     preload outright, restoring late discovery with the gate green.
 *   - Preload tags are keyed to an ARRAY per href, never last-write-wins: a broken duplicate (no
 *     crossorigin) placed BEFORE a well-formed one for the same href was silently overwritten in
 *     an earlier version, so catching the defect depended on tag scan order — luck, not a gate.
 *   - `font-preload-unpaired` is AGGREGATED per href with a `count`, not emitted once per tag: 50
 *     copies of one stray href produced 50 near-identical problems in a reproduction, and a gate
 *     that floods 50 lines for one defect gets skimmed, then ignored.
 *   - Attribute reads go through `./scan.ts`'s `attr()` (quote- and case-insensitive): a
 *     double-quote-only, case-sensitive match silently drops a valid tag, which reads as "no
 *     preload for this href" — a FALSE POSITIVE that reds a build on ordinary, browser-parseable
 *     HTML. That is the failure mode that gets a gate disabled by whoever hits it.
 *   - Every problem detail runs through `sanitizeTagText` — file content is the less-trusted side
 *     of this boundary and is printed to CI logs; an embedded newline lets crafted CSS forge a
 *     line reading like the gate's own PASS output, reproduced (not hypothesised) on a sibling gate.
 *
 * Pure, fail-closed, never throws except at the input-contract boundary (`assertResolverReturn`,
 * `assertStringOption`) — same conventions as every other gate in this module; see `./errors.ts`
 * and `./cssBudget.ts`'s doc comment for the full reasoning this module inherits verbatim.
 */

export type FontPreloadProblemKind =
  | 'empty-input'
  | 'no-faces'
  | 'unreadable-html'
  | 'unreadable-css'
  | 'resolver-threw'
  | 'unresolvable-font-file'
  | 'face-without-woff2'
  | 'under-declared-faces'
  | 'font-preload-missing'
  | 'font-preload-wrong-crossorigin'
  | 'font-preload-wrong-type'
  | 'font-preload-unpaired'
  | 'font-preload-duplicate'
  | 'oversized-url'
  | 'unterminated-html-comment'
  | 'unscanned-stylesheet';

export type FontPreloadProblem =
  | { kind: 'empty-input'; detail: string }
  | { kind: 'no-faces'; detail: string }
  | { kind: 'unreadable-html'; html: string; detail: string }
  | { kind: 'unreadable-css'; css: string; detail: string }
  | { kind: 'resolver-threw'; source: string; href: string; detail: string }
  | { kind: 'unresolvable-font-file'; source: string; href: string; detail: string }
  | { kind: 'face-without-woff2'; source: string; detail: string }
  | { kind: 'under-declared-faces'; html: string; count: number; expected: number; detail: string }
  | { kind: 'font-preload-missing'; html: string; href: string; detail: string }
  | {
      kind: 'font-preload-wrong-crossorigin';
      html: string;
      href: string;
      crossorigin: string | undefined;
      detail: string;
    }
  | {
      kind: 'font-preload-wrong-type';
      html: string;
      href: string;
      type: string | undefined;
      detail: string;
    }
  | { kind: 'font-preload-unpaired'; html: string; href: string; count: number; detail: string }
  | { kind: 'font-preload-duplicate'; html: string; href: string; count: number; detail: string }
  | { kind: 'oversized-url'; source: string; excerpt: string; detail: string }
  | { kind: 'unterminated-html-comment'; html: string; detail: string }
  | { kind: 'unscanned-stylesheet'; html: string; href: string; detail: string };

export interface VerifyFontPreloadOptions {
  /** Built HTML files to check for preload tags and inline `@font-face`. */
  htmlFiles: string[];
  /** Built CSS files (bundled chunks) to scan for `@font-face`. May be empty when every face is
   * declared inline, per document — this gate does not require the bundled architecture. */
  cssFiles: string[];
  /** Face URL -> file path, consumer-supplied. Return `undefined` for anything that does not
   * resolve — that is a problem, not a skip. */
  resolveHref: (href: string) => string | undefined;
  /** Floor on DISTINCT face URLs a single document must declare (via its own inline `@font-face`
   * plus every `cssFiles`-declared face) before it is considered to have its own faces at all.
   * Required — see module doc comment for why an optional floor recreates a vacuous "0 of 0"
   * pass. */
  expectedFacesPerDocument: number;
}

export interface VerifyFontPreloadResult {
  ok: boolean;
  problems: FontPreloadProblem[];
}

/** One `@font-face`'s woff2 URL and where it was declared, or `undefined` when that face has no
 * woff2 src at all (already reported as `face-without-woff2` by the time this is produced). */
interface DeclaredFace {
  woff2: string | undefined;
  source: string;
}

/** One `<link rel="preload" as="font">` tag, reduced to what usability checks need. */
interface FontPreloadTag {
  href: string;
  crossorigin: string | undefined;
  type: string | undefined;
}

/** One successfully read HTML document, in both views the checks below need (see module doc
 * comment for why they must differ). */
interface HtmlDoc {
  file: string;
  /** Comment-stripped, `<style>` bodies intact — for reading inline `@font-face`. */
  unblanked: string;
  /** Comment-stripped, `<style>` bodies blanked — for hunting `<link>` tags. */
  blanked: string;
  unterminated: boolean;
}

/** Extracts declared faces from one already comment-stripped CSS source (a whole file, or one
 * inline `<style>` body), reporting `face-without-woff2` and `oversized-url`. */
function facesFromCss(css: string, source: string, problems: FontPreloadProblem[]): DeclaredFace[] {
  const { urls, unterminatedBlocks } = scanFontFaces(css);
  if (unterminatedBlocks > 0) {
    problems.push({
      kind: 'unreadable-css',
      css: source,
      detail: `${unterminatedBlocks} @font-face block(s) in "${source}" never close`,
    });
  }

  const woff2Urls: string[] = [];
  for (const scanned of urls) {
    if (scanned.oversized) {
      problems.push({
        kind: 'oversized-url',
        source,
        excerpt: sanitizeTagText(scanned.value),
        detail: `a url() in "${source}" exceeds ${MAX_URL_LENGTH} characters and was not safely captured`,
      });
      continue;
    }
    if (scanned.value.endsWith('.woff2')) woff2Urls.push(scanned.value);
  }

  if (woff2Urls.length === 0) {
    if (urls.length > 0) {
      problems.push({
        kind: 'face-without-woff2',
        source,
        detail: `an @font-face in "${source}" declares no .woff2 src, so it cannot be preloaded`,
      });
    }
    return [];
  }
  return woff2Urls.map((woff2) => ({ woff2, source }));
}

/** Every declared face across every inline `<style>` block in one UNBLANKED document view. */
function facesFromInlineStyles(
  unblanked: string,
  source: string,
  problems: FontPreloadProblem[],
): DeclaredFace[] {
  const faces: DeclaredFace[] = [];
  for (const match of unblanked.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    faces.push(...facesFromCss(stripComments(match[1] ?? ''), source, problems));
  }
  return faces;
}

/** Reads every HTML file once into both views, reporting `unreadable-html` /
 * `unterminated-html-comment`. A file that fails to read is simply absent from the returned list
 * — its own problem was already pushed. */
function readHtmlDocs(htmlFiles: string[], problems: FontPreloadProblem[]): HtmlDoc[] {
  const docs: HtmlDoc[] = [];
  for (const [index, file] of htmlFiles.entries()) {
    assertStringOption(file, `htmlFiles[${index}]`);
    let html: string;
    try {
      html = readFileSync(file, 'utf8');
    } catch (error) {
      problems.push({
        kind: 'unreadable-html',
        html: file,
        detail: `could not read "${file}": ${String(error)}`,
      });
      continue;
    }
    const { text: unblanked } = stripHtmlComments(html);
    const { text: blanked, unterminated } = stripHtmlComments(html, { blankStyleBodies: true });
    if (unterminated) {
      problems.push({
        kind: 'unterminated-html-comment',
        html: file,
        detail: `"${file}" contains an unterminated HTML comment`,
      });
    }
    docs.push({ file, unblanked, blanked, unterminated });
  }
  return docs;
}

/** Reads every CSS file once, reporting `unreadable-css` and returning its declared faces. */
function readCssFaces(cssFiles: string[], problems: FontPreloadProblem[]): DeclaredFace[] {
  const faces: DeclaredFace[] = [];
  for (const [index, file] of cssFiles.entries()) {
    assertStringOption(file, `cssFiles[${index}]`);
    let css: string;
    try {
      css = readFileSync(file, 'utf8');
    } catch (error) {
      problems.push({
        kind: 'unreadable-css',
        css: file,
        detail: `could not read "${file}": ${String(error)}`,
      });
      continue;
    }
    faces.push(...facesFromCss(stripComments(css), file, problems));
  }
  return faces;
}

/** Groups already-collected `DeclaredFace`s by their `source` (a `cssFiles` entry's own path) —
 * how `attributeLinkedCssFaces` looks up "faces belonging to THIS resolved stylesheet path". */
function groupFacesBySource(faces: readonly DeclaredFace[]): Map<string, DeclaredFace[]> {
  const bySource = new Map<string, DeclaredFace[]>();
  for (const face of faces) {
    const existing = bySource.get(face.source);
    if (existing === undefined) bySource.set(face.source, [face]);
    else existing.push(face);
  }
  return bySource;
}

/** `href` values off every well-formed `<link rel="stylesheet" href="...">` in the BLANKED
 * document view (see module doc comment for why the blanked view is used for tag hunting). Mirrors
 * `fontChain.ts`'s `extractStylesheetHrefs`, narrowed to just the hrefs — a malformed
 * `rel="stylesheet"` tag with no usable `href` is that module's problem to report, not this one's;
 * duplicating it here would have two gates disagreeing about the same defect. */
function stylesheetHrefs(blankedHtml: string): string[] {
  const hrefs: string[] = [];
  for (const match of blankedHtml.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = attr(tag, 'rel');
    if (rel === undefined || !/\bstylesheet\b/i.test(rel)) continue;
    const href = attr(tag, 'href');
    if (href !== undefined) hrefs.push(href);
  }
  return hrefs;
}

/** Resolves one stylesheet `href` via the shared `resolveHref`, reporting `resolver-threw` on a
 * throw. Returns `undefined` both when the resolver throws (already reported) and when it
 * legitimately returns `undefined` (an unresolvable stylesheet reference — `verifyFontChain`'s
 * `unresolvable-stylesheet` is the gate that reports that; see module doc comment) — the caller
 * cannot attribute any faces either way and does not need to tell the two apart further. */
function resolveStylesheetHref(
  doc: HtmlDoc,
  href: string,
  resolveHref: (href: string) => string | undefined,
  problems: FontPreloadProblem[],
): string | undefined {
  let target: string | undefined;
  try {
    target = resolveHref(href);
  } catch (error) {
    problems.push({
      kind: 'resolver-threw',
      source: doc.file,
      href,
      detail: `resolveHref threw while resolving stylesheet "${sanitizeTagText(href)}" linked from "${doc.file}": ${String(error)}`,
    });
    return undefined;
  }
  assertResolverReturn(target, 'resolveHref', href);
  return target;
}

/** A document's face set from `cssFiles`: ONLY the faces of stylesheets this document actually
 * links via `<link rel="stylesheet">` — never every `cssFiles` entry unconditionally (that was the
 * PR #8 CRITICAL finding; see module doc comment). A linked stylesheet that resolves to a path NOT
 * present in `cssFiles` is reported as `unscanned-stylesheet`, visibly, rather than silently
 * contributing zero faces. */
function attributeLinkedCssFaces(
  doc: HtmlDoc,
  cssFacesBySource: ReadonlyMap<string, DeclaredFace[]>,
  resolveHref: (href: string) => string | undefined,
  problems: FontPreloadProblem[],
): Set<string> {
  const attributed = new Set<string>();
  for (const href of stylesheetHrefs(doc.blanked)) {
    const target = resolveStylesheetHref(doc, href, resolveHref, problems);
    if (target === undefined) continue;
    const faces = cssFacesBySource.get(target);
    if (faces === undefined) {
      problems.push({
        kind: 'unscanned-stylesheet',
        html: doc.file,
        href,
        detail:
          `"${doc.file}" links stylesheet "${sanitizeTagText(href)}", resolved to a file not ` +
          'present in cssFiles — this gate cannot verify faces it may declare; add it to ' +
          'cssFiles, or confirm it declares no @font-face',
      });
      continue;
    }
    for (const face of faces) {
      if (face.woff2 !== undefined) attributed.add(face.woff2);
    }
  }
  return attributed;
}

/** Resolves every DISTINCT woff2 URL exactly once (a face may be redeclared verbatim across
 * documents/chunks), reporting `resolver-threw` / `unresolvable-font-file` against the first
 * source that declared it. Returns the set of URLs that resolved. */
function resolveDistinctFaceUrls(
  faces: DeclaredFace[],
  resolveHref: (href: string) => string | undefined,
  problems: FontPreloadProblem[],
): Set<string> {
  const firstSourceByUrl = new Map<string, string>();
  for (const face of faces) {
    if (face.woff2 !== undefined && !firstSourceByUrl.has(face.woff2)) {
      firstSourceByUrl.set(face.woff2, face.source);
    }
  }

  const resolved = new Set<string>();
  for (const [href, source] of firstSourceByUrl) {
    let target: string | undefined;
    try {
      target = resolveHref(href);
    } catch (error) {
      problems.push({
        kind: 'resolver-threw',
        source,
        href,
        detail: `resolveHref threw while resolving "${sanitizeTagText(href)}": ${String(error)}`,
      });
      continue;
    }
    assertResolverReturn(target, 'resolveHref', href);
    if (target === undefined) {
      problems.push({
        kind: 'unresolvable-font-file',
        source,
        href,
        detail: `font face url "${sanitizeTagText(href)}" declared in "${source}" did not resolve to a file`,
      });
      continue;
    }
    resolved.add(href);
  }
  return resolved;
}

/** `true` when `tag`'s `rel` contains `preload` and `as` equals `font`, case-insensitively. */
function isFontPreloadTag(tag: string): boolean {
  const rel = attr(tag, 'rel');
  const as = attr(tag, 'as');
  return rel !== undefined && /\bpreload\b/i.test(rel) && as !== undefined && /^font$/i.test(as);
}

/** A bare `crossorigin` (no `=`) is legal HTML meaning anonymous. `attr()` only reads a
 * value-bearing attribute, so a presence-only check is needed to distinguish "bare" from
 * "genuinely absent". */
function hasBareCrossorigin(tag: string): boolean {
  return /(^|\s)crossorigin(\s|=|\/?>|$)/i.test(tag) && attr(tag, 'crossorigin') === undefined;
}

/** Reads every `<link rel="preload" as="font">` tag out of the BLANKED document view (see module
 * doc comment for why). */
function fontPreloadTags(blankedHtml: string): FontPreloadTag[] {
  const found: FontPreloadTag[] = [];
  for (const match of blankedHtml.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    if (!isFontPreloadTag(tag)) continue;
    const href = attr(tag, 'href');
    if (href === undefined) continue;
    const rawCrossorigin = attr(tag, 'crossorigin');
    const crossorigin =
      rawCrossorigin !== undefined
        ? rawCrossorigin
        : hasBareCrossorigin(tag)
          ? 'anonymous'
          : undefined;
    found.push({ href, crossorigin, type: attr(tag, 'type') });
  }
  return found;
}

/** Groups preload tags by href — an ARRAY per href, never last-write-wins (see module doc
 * comment). */
function groupPreloadsByHref(tags: FontPreloadTag[]): Map<string, FontPreloadTag[]> {
  const byHref = new Map<string, FontPreloadTag[]>();
  for (const tag of tags) {
    const existing = byHref.get(tag.href);
    if (existing === undefined) byHref.set(tag.href, [tag]);
    else existing.push(tag);
  }
  return byHref;
}

function reportUnusablePreload(
  htmlFile: string,
  tag: FontPreloadTag,
  problems: FontPreloadProblem[],
): void {
  if (tag.crossorigin !== 'anonymous') {
    problems.push({
      kind: 'font-preload-wrong-crossorigin',
      html: htmlFile,
      href: tag.href,
      crossorigin: tag.crossorigin,
      detail: `"${htmlFile}" preloads "${sanitizeTagText(tag.href)}" with crossorigin ${
        tag.crossorigin === undefined ? '(absent)' : sanitizeTagText(tag.crossorigin)
      }, not anonymous — a different fetch cache key than the @font-face request, so the file downloads twice`,
    });
  }
  if (tag.type !== 'font/woff2') {
    problems.push({
      kind: 'font-preload-wrong-type',
      html: htmlFile,
      href: tag.href,
      type: tag.type,
      detail: `"${htmlFile}" preloads "${sanitizeTagText(tag.href)}" with type ${
        tag.type === undefined ? '(absent)' : sanitizeTagText(tag.type)
      }, not font/woff2 — the browser may skip the preload`,
    });
  }
}

/** Every declared face has a usable preload, every preload names a declared face, and no href
 * repeats. */
function checkPreloadPairing(
  htmlFile: string,
  blankedHtml: string,
  faceUrls: ReadonlySet<string>,
  problems: FontPreloadProblem[],
): void {
  const byHref = groupPreloadsByHref(fontPreloadTags(blankedHtml));

  for (const href of faceUrls) {
    const matches = byHref.get(href) ?? [];
    if (matches.length === 0) {
      problems.push({
        kind: 'font-preload-missing',
        html: htmlFile,
        href,
        detail: `"${htmlFile}" declares @font-face src "${sanitizeTagText(href)}" with no matching preload`,
      });
      continue;
    }
    for (const tag of matches) reportUnusablePreload(htmlFile, tag, problems);
  }

  for (const [href, matches] of byHref) {
    if (!faceUrls.has(href)) {
      problems.push({
        kind: 'font-preload-unpaired',
        html: htmlFile,
        href,
        count: matches.length,
        detail: `"${htmlFile}" preloads "${sanitizeTagText(href)}", which no @font-face declares (${matches.length} tag(s))`,
      });
    }
    if (matches.length > 1) {
      problems.push({
        kind: 'font-preload-duplicate',
        html: htmlFile,
        href,
        count: matches.length,
        detail: `"${htmlFile}" has ${matches.length} preload tags for the same href "${sanitizeTagText(href)}"`,
      });
    }
  }
}

/** The per-document floor, then preload pairing. Runs the floor BEFORE anything else uses
 * `documentFaceUrls`, per the module doc comment. */
function checkDocument(
  doc: HtmlDoc,
  inlineFaces: DeclaredFace[],
  linkedCssFaceUrls: ReadonlySet<string>,
  resolvedUrls: ReadonlySet<string>,
  expectedFacesPerDocument: number,
  problems: FontPreloadProblem[],
): void {
  const documentFaceUrls = new Set<string>();
  for (const url of linkedCssFaceUrls) {
    if (resolvedUrls.has(url)) documentFaceUrls.add(url);
  }
  for (const face of inlineFaces) {
    if (face.woff2 !== undefined && resolvedUrls.has(face.woff2)) documentFaceUrls.add(face.woff2);
  }

  if (documentFaceUrls.size < expectedFacesPerDocument) {
    problems.push({
      kind: 'under-declared-faces',
      html: doc.file,
      count: documentFaceUrls.size,
      expected: expectedFacesPerDocument,
      detail: `"${doc.file}" declares ${documentFaceUrls.size} distinct font face url(s), expected at least ${expectedFacesPerDocument}`,
    });
  }

  checkPreloadPairing(doc.file, doc.blanked, documentFaceUrls, problems);
}

export function verifyFontPreload(options: VerifyFontPreloadOptions): VerifyFontPreloadResult {
  const { htmlFiles, cssFiles, resolveHref, expectedFacesPerDocument } = options;
  const problems: FontPreloadProblem[] = [];

  if (htmlFiles.length === 0) {
    problems.push({
      kind: 'empty-input',
      detail: 'htmlFiles is empty — nothing was examined; did the build run or the glob resolve?',
    });
    return { ok: false, problems };
  }

  const docs = readHtmlDocs(htmlFiles, problems);
  const cssFaces = readCssFaces(cssFiles, problems);
  const inlineFacesByDoc = new Map<string, DeclaredFace[]>();
  for (const doc of docs) {
    inlineFacesByDoc.set(doc.file, facesFromInlineStyles(doc.unblanked, doc.file, problems));
  }

  const allFaces = [...cssFaces, ...[...inlineFacesByDoc.values()].flat()];
  if (allFaces.length === 0) {
    problems.push({
      kind: 'no-faces',
      detail: 'no @font-face declared in any cssFiles entry or any document inline <style> block',
    });
    return { ok: false, problems };
  }

  const resolvedUrls = resolveDistinctFaceUrls(allFaces, resolveHref, problems);
  const cssFacesBySource = groupFacesBySource(cssFaces);

  for (const doc of docs) {
    const linkedCssFaceUrls = attributeLinkedCssFaces(doc, cssFacesBySource, resolveHref, problems);
    checkDocument(
      doc,
      inlineFacesByDoc.get(doc.file) ?? [],
      linkedCssFaceUrls,
      resolvedUrls,
      expectedFacesPerDocument,
      problems,
    );
  }

  return { ok: problems.length === 0, problems };
}

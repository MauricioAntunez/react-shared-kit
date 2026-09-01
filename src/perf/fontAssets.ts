/**
 * Gate: fonts are self-hosted, present, and real (T4, deploy-perf-gates).
 *
 * Ported from web-usa's `scripts/verify-fonts.mjs` (this kit's reference implementation for the
 * check shapes and the reproductions that motivated each one), generalised the same way
 * `cssBudget.ts`/`headers.ts` generalise their own sibling scripts: hardcoded paths become
 * options, a resolver replaces a hand-rolled `join`, and every I/O boundary fails closed per item
 * rather than aborting the whole run.
 *
 * Both failure modes this catches are SILENT. Nothing throws, the build stays green, and the page
 * still renders — in the fallback face — so the only signal is a human noticing the typography
 * changed.
 *
 *   1. A remote font origin creeps back in. The `@import` of a third-party font stylesheet that
 *      self-hosting replaced cost a measured 1,540 ms of render-blocking time and a four-level
 *      critical chain on web-usa. One well-meaning "quick fix" re-adds it and nothing objects.
 *   2. A font file goes missing, is truncated, or is silently re-encoded. A static-host build
 *      copies a public directory verbatim with no manifest and no existence check.
 *
 * CHECK 1 — forbidden origin, bare substring, deliberately NOT scoped to `url()`/`@import`/`href=`:
 * three shapes defeated the narrower version, each found by reproduction on web-usa: an origin
 * inside a CSS comment (`@import/*c*\/"https://…"` — a CSS comment is whitespace-equivalent, so
 * `@import\s+` never matches while the browser still fetches), uppercase `URL(`, and a `)` inside a
 * query string ending a bracketed match early. Enumerating fetching syntax is a losing game; the
 * hostname appearing at all in non-comment source is the honest signal. Comments are stripped first
 * (`stripComments` for `.css`, `stripHtmlComments` for `.html`, both from `./text.ts`) — that is
 * exactly what lets a repo's own comments NAME these origins while explaining why they were
 * removed, without tripping the gate.
 * LIMIT, stated rather than papered over: this cannot catch a fetch reaching those origins without
 * naming them in source — a redirect, a hostname assembled at runtime. No static text check can.
 * It catches the realistic regression: somebody pastes a font-CDN snippet back in.
 *
 * CHECK 2 — containment: every resolved font path must sit under `fontRoot`. `path.resolve` does
 * not sandbox — a reference like `/fonts/../../../etc/passwd.woff2` collapses to a path outside
 * `fontRoot`. The prefix test is boundary-guarded (`fontRoot + sep`) so `/fonts` does not also
 * admit `/fontsX`. A rejected reference is DROPPED from the working set, not just flagged, so no
 * later pass (existence, checksum) ever reads a path this guard already rejected.
 * KNOWN RESIDUAL, stated honestly: the guard is lexical, not symlink-aware — a committed symlink
 * under `fontRoot` pointing outside it passes. Low real risk (the source is repo-controlled, the
 * same trust level needed to edit this gate itself), and no file CONTENT is ever printed by any
 * check here, only a sha256 prefix and booleans.
 *
 * CHECK 3 — existence / non-empty / real woff2: the file resolves, has size > 0, and begins with
 * the ASCII signature `wOF2`. Only the 4 signature bytes are read — loading a whole file to compare
 * four bytes is wasteful on principle, and would matter if the containment guard above ever failed.
 * A truncated or wrong-format file still "exists" on disk; the browser just ignores it.
 *
 * CHECK 4 — checksums (only when `checksums` is supplied): sha256 of the bytes must match the
 * pinned value; a referenced file with no pinned entry is a problem, not a pass. Trust boundary,
 * stated precisely: this guards drift AFTER commit — a corrupted, swapped, or silently re-encoded
 * binary. It does NOT establish provenance — the checksum map and the binaries share identical
 * trust (git commit authorship), so a match proves co-change, not authenticity. Only a sha256
 * PREFIX ever appears in a problem's `detail`, never full file content.
 *
 * CHECK 5 — anti-vacuity: an empty `sourceFiles` or an empty `fontReferences` is `empty-input`. A
 * gate that checked nothing and reported `ok: true` is the exact blind spot this module exists to
 * prevent.
 *
 * WARNINGS, deliberately separate from `problems` — `ok` is `problems.length === 0` and is NOT
 * affected by anything in `warnings`. This mirrors web-usa's own severity call: a font file under
 * `fontRoot` that nothing references (`orphan-font-file`) wastes repo space but breaks nothing at
 * runtime, unlike every `problems` kind above, each of which is a real user-visible or
 * build-integrity defect.
 *
 * Every `try` below wraps exactly one fs call, per this module family's convention (see
 * `./errors.ts`): a resolver's return and every array element are boundary-validated
 * (`assertResolverReturn`/`assertStringOption`) BEFORE any fs call, so once a value reaches a
 * `readFileSync`/`statSync`/`openSync` call, whatever it raises (ENOENT, EACCES, EISDIR, a NUL
 * byte) is unconditionally a fact about the build, reported and never re-thrown — and a bug in a
 * later processing step (hashing, magic-byte comparison) propagates uncaught instead of being
 * misreported as a filesystem fact.
 *
 * ARCHITECTURE THIS GATE FITS, AND THE ONE IT DOES NOT — read before wiring it up or reading a
 * green result as coverage. `verifyFontAssets` targets the SELF-HOSTED STATIC font architecture:
 * font files living in a dedicated directory (`fontRoot`), referenced by stable literal URL
 * strings in source, optionally checksum-pinned. That is the shape two real integration probes
 * verified it against (web-chile, web-usa).
 *
 * It does NOT fit the BUNDLED architecture, where fonts are imported as npm packages (e.g.
 * `@fontsource/*`) and content-hashed by the bundler into a shared `assets/` directory alongside
 * every other build output (verified against boufin). There, `fontRoot` containment is nearly
 * vacuous — there is no dedicated font subdirectory to scope against, everything shares one
 * assets dir — and there is no stable literal URL set to hand as `fontReferences`, because the
 * hash changes per build. `verifyFontPreload` is the gate that covers that architecture instead,
 * and was verified to work there. A consumer on the bundled model must NOT read a green
 * `verifyFontAssets` result as meaningful coverage — a gate that is green only because it had
 * nothing real to check against is exactly the silent-pass failure class this whole module exists
 * to prevent (see CHECK 5, anti-vacuity, above). Pick the gate that matches the architecture; do
 * not run this one on a bundled build and call it done.
 */
import { createHash } from 'node:crypto';
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { assertResolverReturn, assertStringOption } from './errors.ts';
import { sanitizeTagText, scanFontFaces } from './scan.ts';
import { stripComments, stripHtmlComments } from './text.ts';

const WOFF2_MAGIC = Buffer.from('wOF2');
const CHECKSUM_PREFIX_LENGTH = 12;

export type FontAssetsProblemKind =
  | 'empty-input'
  | 'unreadable-source'
  | 'forbidden-origin'
  | 'outside-font-root'
  | 'resolver-threw'
  | 'unresolvable-font'
  | 'unreadable-font'
  | 'empty-font-file'
  | 'not-woff2'
  | 'missing-checksum'
  | 'checksum-mismatch';

export type FontAssetsProblem =
  | { kind: 'empty-input'; detail: string }
  | { kind: 'unreadable-source'; source: string; detail: string }
  | { kind: 'forbidden-origin'; source: string; origin: string; detail: string }
  | { kind: 'outside-font-root'; reference: string; detail: string }
  | { kind: 'resolver-threw'; reference: string; detail: string }
  | { kind: 'unresolvable-font'; reference: string; detail: string }
  | { kind: 'unreadable-font'; reference: string; file: string; detail: string }
  | { kind: 'empty-font-file'; reference: string; file: string; detail: string }
  | { kind: 'not-woff2'; reference: string; file: string; detail: string }
  | { kind: 'missing-checksum'; reference: string; file: string; detail: string }
  | { kind: 'checksum-mismatch'; reference: string; file: string; detail: string };

export type FontAssetsWarningKind = 'orphan-font-file';

export interface FontAssetsWarning {
  kind: FontAssetsWarningKind;
  file: string;
  detail: string;
}

export interface VerifyFontAssetsOptions {
  /** HTML and CSS source files scanned for forbidden font-CDN origins. */
  sourceFiles: string[];
  /** woff2 URLs as written in source (e.g. `/fonts/inter-latin-400.woff2`). */
  fontReferences: string[];
  /** reference -> file path on disk. Return `undefined` for anything that does not resolve. */
  resolveHref: (href: string) => string | undefined;
  /** Hostnames that must never appear in comment-stripped `sourceFiles` content. */
  forbiddenOrigins: readonly string[];
  /** Containment boundary: every resolved font path must sit under this directory. */
  fontRoot: string;
  /** basename -> pinned sha256 hex. Omit to skip the checksum check entirely. */
  checksums?: Readonly<Record<string, string>>;
}

export interface VerifyFontAssetsResult {
  ok: boolean;
  problems: FontAssetsProblem[];
  warnings: FontAssetsWarning[];
}

/** Strips comments per file extension so a comment naming a forbidden origin (to explain its
 * removal) is never mistaken for a live reference. Anything not recognised as CSS or HTML is
 * scanned as-is — this gate has no third source type today, and a stricter default would only
 * risk silently skipping a file whose extension does not match either case. */
function stripSourceComments(source: string, text: string): string {
  const ext = extname(source).toLowerCase();
  if (ext === '.css' || ext === '.scss' || ext === '.sass') return stripComments(text);
  if (ext === '.html' || ext === '.htm') return stripHtmlComments(text).text;
  return text;
}

function checkForbiddenOrigins(
  sourceFiles: string[],
  forbiddenOrigins: readonly string[],
  problems: FontAssetsProblem[],
): void {
  for (const [index, source] of sourceFiles.entries()) {
    assertStringOption(source, `sourceFiles[${index}]`);
    let text: string;
    try {
      text = readFileSync(source, 'utf8');
    } catch (error) {
      problems.push({
        kind: 'unreadable-source',
        source,
        detail: `could not read "${sanitizeTagText(source)}": ${sanitizeTagText(String(error))}`,
      });
      continue;
    }
    const stripped = stripSourceComments(source, text);
    for (const origin of forbiddenOrigins) {
      if (stripped.includes(origin)) {
        problems.push({
          kind: 'forbidden-origin',
          source,
          origin,
          detail:
            `"${sanitizeTagText(source)}" references "${sanitizeTagText(origin)}" — fonts must ` +
            'be served from this origin',
        });
      }
    }
  }
}

/** Resolves one font reference against `fontRoot`, guarding the consumer-supplied `resolveHref`
 * callback itself (same split as `cssBudget.ts`'s `resolveLink`): a resolver that THROWS is a
 * distinct failure from one that returns `undefined`. Containment is checked immediately after a
 * successful resolve — a violation is reported AND the reference is dropped from the returned set
 * so no later pass ever reads a path this guard rejected. */
function resolveAndContain(
  reference: string,
  resolveHref: (href: string) => string | undefined,
  fontRoot: string,
  fontRootResolved: string,
  problems: FontAssetsProblem[],
): string | undefined {
  let file: string | undefined;
  try {
    file = resolveHref(reference);
  } catch (error) {
    problems.push({
      kind: 'resolver-threw',
      reference,
      detail:
        `resolveHref threw while resolving "${sanitizeTagText(reference)}": ` +
        sanitizeTagText(String(error)),
    });
    return undefined;
  }
  assertResolverReturn(file, 'resolveHref', reference);
  if (file === undefined) {
    problems.push({
      kind: 'unresolvable-font',
      reference,
      detail: `font reference "${sanitizeTagText(reference)}" did not resolve to a file`,
    });
    return undefined;
  }
  const resolved = resolve(file);
  if (resolved !== fontRootResolved && !resolved.startsWith(fontRootResolved + sep)) {
    problems.push({
      kind: 'outside-font-root',
      reference,
      detail:
        `"${sanitizeTagText(reference)}" resolves to "${sanitizeTagText(resolved)}", outside ` +
        `fontRoot "${sanitizeTagText(fontRoot)}"`,
    });
    return undefined;
  }
  return file;
}

/** Reads exactly the first 4 bytes of `file` — never the whole file — to compare against the
 * WOFF2 magic signature. One fs-call unit (open, read, close for one already-`statSync`-confirmed
 * file); its own failure is reported by the caller as `unreadable-font`, matching `statSync`'s
 * treatment of the same file. */
function readMagicBytes(file: string): Buffer {
  const fd = openSync(file, 'r');
  try {
    const header = Buffer.alloc(4);
    readSync(fd, header, 0, 4, 0);
    return header;
  } finally {
    closeSync(fd);
  }
}

function checkChecksum(
  reference: string,
  file: string,
  checksums: Readonly<Record<string, string>>,
  problems: FontAssetsProblem[],
): void {
  const basename = file.split('/').pop() ?? file;
  const expected = checksums[basename];
  if (expected === undefined) {
    problems.push({
      kind: 'missing-checksum',
      reference,
      file,
      detail: `"${sanitizeTagText(basename)}" has no pinned checksum in the supplied checksums map`,
    });
    return;
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    problems.push({
      kind: 'unreadable-font',
      reference,
      file,
      detail:
        `"${sanitizeTagText(file)}" could not be read for checksum verification: ` +
        sanitizeTagText(String(error)),
    });
    return;
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) {
    problems.push({
      kind: 'checksum-mismatch',
      reference,
      file,
      detail:
        `"${sanitizeTagText(basename)}" does not match its pinned checksum (expected ` +
        `${expected.slice(0, CHECKSUM_PREFIX_LENGTH)}…, got ${actual.slice(0, CHECKSUM_PREFIX_LENGTH)}…)`,
    });
  }
}

function checkFontFile(
  reference: string,
  file: string,
  checksums: Readonly<Record<string, string>> | undefined,
  problems: FontAssetsProblem[],
): void {
  let size: number;
  try {
    size = statSync(file).size;
  } catch (error) {
    problems.push({
      kind: 'unreadable-font',
      reference,
      file,
      detail: `"${sanitizeTagText(file)}" is referenced but could not be read: ${sanitizeTagText(String(error))}`,
    });
    return;
  }
  if (size === 0) {
    problems.push({
      kind: 'empty-font-file',
      reference,
      file,
      detail: `"${sanitizeTagText(file)}" is zero bytes`,
    });
    return;
  }

  let magic: Buffer;
  try {
    magic = readMagicBytes(file);
  } catch (error) {
    problems.push({
      kind: 'unreadable-font',
      reference,
      file,
      detail: `"${sanitizeTagText(file)}" is referenced but could not be read: ${sanitizeTagText(String(error))}`,
    });
    return;
  }
  if (!magic.equals(WOFF2_MAGIC)) {
    problems.push({
      kind: 'not-woff2',
      reference,
      file,
      detail: `"${sanitizeTagText(file)}" is not a WOFF2 file (bad magic bytes)`,
    });
    return;
  }

  if (checksums !== undefined) checkChecksum(reference, file, checksums, problems);
}

/** Warns (never fails) about a `.woff2` file under `fontRoot` that no resolved reference points
 * at — an orphan wastes repo space but breaks nothing, the same severity call web-usa's own
 * script makes. `resolvedFiles` holds every SUCCESSFULLY resolved-and-contained font path, so a
 * reference dropped by an earlier check (outside-font-root, unresolvable) does not spuriously
 * exempt a real file from this warning. */
function checkOrphans(
  fontRoot: string,
  resolvedFiles: ReadonlySet<string>,
  warnings: FontAssetsWarning[],
): void {
  let entries: string[];
  try {
    entries = readdirSync(fontRoot);
  } catch {
    // A missing fontRoot is not this check's concern — every referenced font already failed its
    // own existence check above if the directory is absent.
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.woff2')) continue;
    const full = resolve(fontRoot, entry);
    if (!resolvedFiles.has(full)) {
      warnings.push({
        kind: 'orphan-font-file',
        file: full,
        detail: `"${sanitizeTagText(full)}" is not referenced by any font reference — unreferenced, wastes repo space`,
      });
    }
  }
}

export function verifyFontAssets(options: VerifyFontAssetsOptions): VerifyFontAssetsResult {
  const { sourceFiles, fontReferences, resolveHref, forbiddenOrigins, fontRoot, checksums } =
    options;
  assertStringOption(fontRoot, 'fontRoot');
  const problems: FontAssetsProblem[] = [];
  const warnings: FontAssetsWarning[] = [];

  // Fail closed (anti-vacuity, per module doc comment): nothing to examine must never read as a
  // clean pass.
  if (sourceFiles.length === 0 || fontReferences.length === 0) {
    problems.push({
      kind: 'empty-input',
      detail:
        'sourceFiles or fontReferences is empty — nothing was examined; did the build run or ' +
        'the font wiring get removed?',
    });
    return { ok: false, problems, warnings };
  }

  checkForbiddenOrigins(sourceFiles, forbiddenOrigins, problems);

  const fontRootResolved = resolve(fontRoot);
  const resolvedFiles = new Set<string>();
  for (const [index, reference] of fontReferences.entries()) {
    assertStringOption(reference, `fontReferences[${index}]`);
    const file = resolveAndContain(reference, resolveHref, fontRoot, fontRootResolved, problems);
    if (file === undefined) continue;
    resolvedFiles.add(resolve(file));
    checkFontFile(reference, file, checksums, problems);
  }

  checkOrphans(fontRoot, resolvedFiles, warnings);

  return { ok: problems.length === 0, problems, warnings };
}

/**
 * Extracts every `@font-face` `src:` URL from `css`, for building a `fontReferences` array to
 * hand to `verifyFontAssets`. Comments are stripped first (`stripComments` from `./text.ts`, the
 * same helper `verifyFontAssets`/`verifyFontChain` use) so a commented-out `@font-face` — kept
 * around to explain why a face was removed — is never mistaken for a live one; `scanFontFaces`
 * itself does not strip comments, it only brace-matches. The brace-matched, minified-CSS-safe
 * scan (`scanFontFaces`, `./scan.ts`) is the same scanner `verifyFontChain`/
 * `findUnshippedFontUsage` already rely on, not a second hand-rolled regex. Two independent
 * integration probes (boufin,
 * web-chile) hand-rolled their own extraction regex for exactly this purpose because the kit
 * exported nothing that did it; this function is that missing piece.
 *
 * THIS IS A CONVENIENCE EXTRACTOR, NOT A GATE. It reports nothing and has no `ok`/`problems`
 * shape — it returns URLs, or it doesn't. Two decisions follow from that, both deliberate:
 *
 * 1. OVERSIZED URLS ARE EXCLUDED. `scanFontFaces` marks a URL `oversized: true` when it could not
 *    be safely captured in full (see `ScannedUrl` in `./scan.ts`) — in that case `.value` is a
 *    diagnostic excerpt, NOT a usable URL, so including it here would hand `verifyFontAssets` a
 *    reference that can never resolve to a real file. This function silently drops it rather than
 *    returning garbage. That silence is intentional ONLY because it is not this function's job to
 *    flag it: `verifyFontChain` is the gate that REPORTS an oversized URL as a problem. Do not
 *    treat a short list from this function as proof every face was captured — run the gate for
 *    that signal, not this helper.
 *
 * 2. NO EXTENSION FILTERING. Every URL is returned, in declaration order, deduplicated — `.woff2`,
 *    `.woff`, anything else — not just `.woff2`. A caller building `fontReferences` for
 *    `verifyFontAssets` (which only checks `.woff2` files) is expected to filter for that
 *    extension itself. Filtering silently inside this helper was considered and rejected: a
 *    `.woff` sibling face silently dropped here would be invisible to a caller who assumed this
 *    function returned "everything", which is exactly the kind of silent information loss this
 *    module's own design (CHECK 5, anti-vacuity) exists to avoid elsewhere. Returning everything
 *    and letting the caller filter keeps that decision visible at the call site.
 */
export function fontUrlsFromCss(css: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const { value, oversized } of scanFontFaces(stripComments(css)).urls) {
    if (oversized) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    urls.push(value);
  }
  return urls;
}

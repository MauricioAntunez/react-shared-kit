/**
 * Deploy-performance gates: static analysis over BUILT output.
 *
 * Sibling of `./check`, not part of it. `./check` lives under `src/image/` and is image-scoped by
 * path and by its own header comment; header, CSS and font gates do not belong there. This module
 * is purely additive — nothing here is imported by `./check`, `./images` or the root export, so no
 * existing consumer can break from its presence.
 *
 * It inherits `./check`'s hard constraints verbatim, because it runs in the same place — a deploy
 * chain:
 *   - NEVER import sharp or imagetools-core (ruling 6.3: no native binaries in the deploy chain).
 *   - Node-only. No React, no DOM.
 *   - Pure functions returning a result object. Never console.log, never process.exit — Biome's
 *     noConsole is on, and the consuming wrapper owns presentation and exit codes.
 *   - Fail closed. An unreadable file, an unparseable rule or an unrecognised shape is a problem,
 *     never a silent pass.
 *
 * ONE QUALIFICATION to "returns a result object", and it is narrower than it first reads. These
 * gates return problems for every condition they are built to detect — missing files, unreadable
 * input, malformed rules, vacuous input, a resolver that declines to resolve. What they do NOT do
 * is dress a *programming* error up as one of those findings. Every gate in this module VALIDATES
 * its string inputs at the boundary, rather than trying to classify an error after the fact: a
 * resolver callback's return value (`resolveHref` in `verifyCssBudget`; `resolveImport` and
 * `resolveStylesheet` in `verifyFontChain`), `verifyHeaders`'s `headersFile`/`assetsDir` options,
 * and every `htmlFiles`/`cssFiles` array ELEMENT, are checked against their declared type
 * (`string | undefined` for a resolver, `string` for an option or element) the moment they are
 * produced — before they ever reach an fs call. A violation throws immediately, naming the
 * resolver/option and what it actually returned, so a consumer whose resolver returns a `URL`
 * object, a `Proxy`, or any other non-string gets a loud crash naming their bug, not a
 * plausible-looking "unreadable stylesheet" pointing at a file that is fine.
 *
 * Four rounds tried the opposite approach — classifying the error AFTER `readFileSync`/
 * `readdirSync` had already thrown — by `.code` presence, then an `ERR_` prefix exclusion, then a
 * narrow two-code allowlist, and each failed a new way, because Node's error codes do not
 * partition into "caller bug" vs. "fs condition": `ERR_INVALID_ARG_VALUE` is raised both for a
 * caller-bug `URL` object AND for a syntactically valid string path containing a NUL byte, which
 * IS a fact about the build. Validating the resolver's own declared contract at the boundary
 * sidesteps the classification problem entirely: once a value is known to be a real string,
 * everything the `readFileSync`/`readdirSync` CALL ITSELF subsequently raises about it — ENOENT,
 * EACCES, EISDIR, a NUL byte, `ERR_FS_FILE_TOO_LARGE` — is unconditionally a fact about the
 * build, and is reported, never re-thrown.
 *
 * That claim only holds if the `try` scopes EXACTLY the fs call — a fifth defect (round 5) had
 * each catch's `try` also wrapping a second, unrelated operation on the bytes the fs call already
 * returned (`brotliCompressSync` in `cssBudget`, the comment-stripping transform in
 * `fontChain`), so a bug in THAT step was still misreported as a filesystem fact about a file
 * that had, in fact, been read successfully. Every `try` here now wraps only the fs call itself;
 * a failure in a subsequent processing step propagates like any other internal bug. See
 * `./errors.ts` for the full reasoning.
 *
 * Fail closed means no silent pass. It does not mean pretending a defect is a finding — nor
 * pretending a finding is a defect.
 *
 * SCOPE BOUNDARY, ruled by the user 2026-08-30: this module ships gates, never styles. No CSS, no
 * @font-face, no design tokens, no font files. The kit measures; the consuming project fixes. That
 * is what keeps a sixth module compatible with this package's charter ("no CSS, no design tokens")
 * rather than a loosening of it.
 *
 * LIMIT — READ BEFORE TRUSTING A GREEN RESULT. Everything here is static analysis of built files.
 * It can see bytes, hrefs, the @import graph and header rules. It CANNOT see what a browser
 * actually computed, which stylesheet the browser really blocked on, or what a rendered box became.
 * A real-browser oracle cannot live in this package: the Vitest environment is deliberately `node`
 * with no DOM, and pulling a browser into a package whose gates run inside deploy chains would drag
 * a heavyweight dependency into exactly the place ruling 6.3 keeps native binaries out of.
 *
 * So these gates are NECESSARY AND NOT SUFFICIENT. Pair each with a browser check in the consuming
 * project — the same two-gate split that already exists for images, where `verifyHtmlImages`
 * (attributes, here) and a browser-driven layout sweep (rendered box, there) both run because
 * neither subsumes the other. A consumer running only these gates has weaker coverage than that.
 *
 * `findDanglingClasses` is the fourth gate: a CSS-Modules selector joining a class from one
 * built file to a hashed name from another compiles cleanly but matches no element, because CSS
 * Modules hashes class names per source file. That is dead weight in a render-blocking
 * stylesheet — parsed and evaluated on every route for zero effect — and simultaneously means the
 * rule's own intent is silently not applying. See `./danglingClasses.ts` for the mechanism, the
 * `allowlist` for runtime-conditional variants (a bare `RegExp` or a file-scoped
 * `ScopedAllowlistEntry`), and the fail-closed rules it inherits from here.
 *
 * COMMENT STRIPPING IS CENTRALISED, not reimplemented per gate: `./text.ts`'s `stripComments`
 * (CSS `/* ... *\/`) and `stripHtmlComments` (`<!-- ... -->`) are the only implementations, so a
 * commented-out `@import`/`@font-face`/`<link>`/`class="..."`/CSS-Modules selector is never
 * mistaken for live in `verifyFontChain` or `findDanglingClasses`. `./text.ts` is INTERNAL — not
 * re-exported here — because no consumer needs it; `verifyCssBudget` and `verifyHeaders` have no
 * comment-stripping step of their own to share.
 *
 * TWO FONT-DELIVERY ARCHITECTURES EXIST, and `verifyFontAssets`/`verifyFontPreload` cover them
 * separately, not interchangeably. `verifyFontAssets` targets self-hosted static fonts (a
 * dedicated font directory, stable literal URLs); `verifyFontPreload` targets bundler-hashed
 * fonts (npm font packages content-hashed into a shared assets dir, no stable URL to pin). See
 * `fontAssets.ts`'s module doc comment for the full reasoning and the failure mode of running the
 * wrong one.
 *
 * `verifyFontChain` measures font discovery PER DOCUMENT, not from a build-wide union: each
 * `htmlFiles` entry's own `<link rel="stylesheet">` tags (resolved via `resolveStylesheet`) name
 * the CSS graph walked for THAT document, and only that document's own preload/inline-`@font-face`
 * signals exempt a font from it — so a preload added to one page can never silence a genuinely
 * late font on a different page that shares the same stylesheet.
 *
 * A consumer-supplied `hashPattern` (`findDanglingClasses`, `verifyHeaders`) is matched only after
 * the candidate token is bounded to `MAX_HASH_PATTERN_TOKEN_LENGTH` — never handed to an arbitrary,
 * consumer-supplied regex while still unbounded in length. CORRECTED WORDING (round-2 review
 * MEDIUM #6 — an earlier version of this paragraph called the cap a ReDoS mitigation, which
 * `./errors.ts` itself disproves): a 32-character token already takes 19.3 SECONDS against a
 * catastrophically backtracking pattern, so a 128-char-bounded string is EXACTLY as much a ReDoS
 * surface as an unbounded one — no length cap can bound regex execution TIME. The cap is a length
 * sanity bound only; an over-cap token is reported as its own explicit problem
 * (`oversized-class-name`/`oversized-filename`) rather than silently skipped or falsely matched.
 * See `./errors.ts` for the cap, the measured backtracking curve, and why `hashPattern`/
 * `allowlist` regexes are trusted (same author as the build script), unlike build content.
 */

export type {
  CssBudgetProblem,
  CssBudgetProblemKind,
  VerifyCssBudgetOptions,
  VerifyCssBudgetResult,
} from './cssBudget.ts';
export { verifyCssBudget } from './cssBudget.ts';
export type {
  AllowlistEntry,
  DanglingClassProblem,
  DanglingClassProblemKind,
  FindDanglingClassesOptions,
  FindDanglingClassesResult,
  ScopedAllowlistEntry,
} from './danglingClasses.ts';
export { findDanglingClasses } from './danglingClasses.ts';
export type {
  FontAssetsProblem,
  FontAssetsProblemKind,
  FontAssetsWarning,
  FontAssetsWarningKind,
  VerifyFontAssetsOptions,
  VerifyFontAssetsResult,
} from './fontAssets.ts';
export { fontUrlsFromCss, verifyFontAssets } from './fontAssets.ts';
export type {
  FontChainProblem,
  FontChainProblemKind,
  VerifyFontChainOptions,
  VerifyFontChainResult,
} from './fontChain.ts';
export { verifyFontChain } from './fontChain.ts';
export type {
  NoFontImportProblem,
  NoFontImportProblemKind,
  VerifyNoFontImportOptions,
  VerifyNoFontImportResult,
} from './fontImport.ts';
export { verifyNoFontImport } from './fontImport.ts';
export type {
  FontPreloadProblem,
  FontPreloadProblemKind,
  VerifyFontPreloadOptions,
  VerifyFontPreloadResult,
} from './fontPreload.ts';
export { verifyFontPreload } from './fontPreload.ts';
export type { FontUsageViolation, ObservedElement, ShippedFace } from './fontUsage.ts';
export {
  findUnshippedFontUsage,
  normalizeFamily,
  parseFontFaces,
  shipsFamily,
  shipsWeight,
} from './fontUsage.ts';
export type {
  HeadersProblem,
  HeadersProblemKind,
  VerifyHeadersOptions,
  VerifyHeadersResult,
} from './headers.ts';
export { verifyHeaders } from './headers.ts';

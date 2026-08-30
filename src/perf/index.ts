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
 * is dress a *programming* error up as one of those findings. All three VALIDATE their string
 * inputs at the boundary, rather than trying to classify an error after the fact: a
 * `resolveHref`/`resolveImport` callback's return value, and `headers`'s `headersFile`/
 * `assetsDir` options, are checked against their declared type (`string | undefined` for a
 * resolver, `string` for an option) the moment they are produced — before they ever reach an fs
 * call. A violation throws immediately, naming the resolver/option and what it actually returned,
 * so a consumer whose `resolveHref`/`resolveImport` returns a `URL` object, a `Proxy`, or any
 * other non-string gets a loud crash naming their bug, not a plausible-looking "unreadable
 * stylesheet" pointing at a file that is fine.
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
 */

export type {
  CssBudgetProblem,
  CssBudgetProblemKind,
  VerifyCssBudgetOptions,
  VerifyCssBudgetResult,
} from './cssBudget.ts';
export { verifyCssBudget } from './cssBudget.ts';
export type {
  FontChainProblem,
  FontChainProblemKind,
  VerifyFontChainOptions,
  VerifyFontChainResult,
} from './fontChain.ts';
export { verifyFontChain } from './fontChain.ts';
export type {
  HeadersProblem,
  HeadersProblemKind,
  VerifyHeadersOptions,
  VerifyHeadersResult,
} from './headers.ts';
export { verifyHeaders } from './headers.ts';

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
 * ONE QUALIFICATION to "returns a result object", added after review: these gates return problems
 * for every condition they are built to detect — missing files, unreadable input, malformed rules,
 * vacuous input, a resolver that declines to resolve. They do NOT swallow a *programming* error.
 * `verifyFontChain` deliberately re-throws anything that is not a filesystem failure, because the
 * alternative is worse: a catch broad enough to absorb, say, a stack overflow would report it as
 * "unreadable stylesheet", and a consumer would go looking for a missing file that exists. A bug in
 * the kit or in a consumer's callback should surface as the loud crash it is. Fail closed means no
 * silent pass; it does not mean pretend a defect is a finding.
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

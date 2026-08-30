/**
 * Shared error classification for every `./perf` gate that guards a filesystem read (or a
 * consumer-supplied callback standing in for one) against becoming an uncaught crash.
 *
 * INTERNAL ONLY — imported by the sibling gate modules in this directory, never re-exported from
 * `./index.ts`. Not part of the package's public surface.
 *
 * The problem this solves, twice over (round 2 and round 3 review findings on `fontChain.ts`,
 * then found to be missing entirely from `cssBudget.ts` and `headers.ts`):
 *
 *   1. A gate's read of a file it does not control (a resolved path, a consumer-named directory)
 *      can fail for a real, reportable reason — ENOENT, EACCES, EISDIR, ENAMETOOLONG, ELOOP, or
 *      Node's own `ERR_FS_FILE_TOO_LARGE` (>2GiB) / `ERR_FS_EISDIR`. Every one of those is a FACT
 *      ABOUT THE BUILD and belongs in the gate's `problems` list.
 *   2. The exact same `catch` can also see something that is not about the build at all: a
 *      `RangeError: Maximum call stack size exceeded` from a runaway walk, or a
 *      `TypeError [ERR_INVALID_ARG_TYPE]` because a consumer-supplied `resolveHref`/`resolveImport`
 *      returned something other than the `string | undefined` it promised (`readFileSync` throws
 *      that the moment it is handed a non-string). Reporting either of those as "your CSS file is
 *      unreadable" hides a control-flow catastrophe or a caller bug behind a plausible-looking,
 *      wrong finding.
 *
 * A bare `.code` allowlist is not enough: round 2 tried `typeof code === 'string'`, which
 * misclassified `ERR_INVALID_ARG_TYPE` as an fs error (case 2). Round 3 then over-corrected to
 * "any `ERR_`-prefixed code is not an fs error", which misclassifies `ERR_FS_FILE_TOO_LARGE` and
 * `ERR_FS_EISDIR` — genuine Node fs-layer conditions that also happen to start with `ERR_` — as
 * caller bugs (case 1). Neither a bare presence-of-`.code` check nor a bare prefix check
 * separates the two cases; the actual boundary is which SPECIFIC codes mean "the caller violated
 * an argument contract" vs. everything else, which does mean a real filesystem condition.
 *
 * Class alone does not resolve it either: `ERR_INVALID_ARG_TYPE` is a `TypeError`, but so is a
 * plain caller bug that just constructs one, and `ERR_FS_FILE_TOO_LARGE` and a stack-overflow
 * `RangeError` are BOTH `RangeError`s — same class, opposite verdict (one is a build fact, the
 * other is not). So this uses a narrow, explicit code allowlist of Node's own argument-validation
 * errors — `ERR_INVALID_ARG_TYPE` and `ERR_INVALID_ARG_VALUE`, both raised by Node's internal
 * `validate*` helpers when a caller hands a value of the wrong shape, never by the fs layer for a
 * condition about a file on disk. A stack overflow needs no entry here: it carries no `.code` at
 * all, so it is excluded by the base "has a string code" check before the allowlist is ever
 * consulted.
 */

/** Codes Node's own argument validators raise when a caller passes a value of the wrong shape —
 * a contract violation, never a fact about a file on disk. See module doc comment for why a
 * broader `ERR_` prefix match is wrong (it also catches genuine fs-layer codes like
 * `ERR_FS_FILE_TOO_LARGE`). */
const ARGUMENT_CONTRACT_VIOLATION_CODES: ReadonlySet<string> = new Set([
  'ERR_INVALID_ARG_TYPE',
  'ERR_INVALID_ARG_VALUE',
]);

/**
 * Is `error` a filesystem condition safe to convert into a `problems` entry, as opposed to a
 * control-flow catastrophe (no `.code` at all — e.g. a stack-overflow `RangeError`) or a
 * consumer callback's contract violation (`ERR_INVALID_ARG_TYPE`/`ERR_INVALID_ARG_VALUE`) that
 * must propagate instead of being reported as if it were about the build?
 */
export function isFsError(error: unknown): error is NodeJS.ErrnoException {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code !== 'string') return false;
  return !ARGUMENT_CONTRACT_VIOLATION_CODES.has(code);
}

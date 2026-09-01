/**
 * Shared input validation for every `./perf` gate that hands a consumer-supplied value (a
 * resolver's return, a string option) to a filesystem call.
 *
 * INTERNAL ONLY — imported by the sibling gate modules in this directory, never re-exported from
 * `./index.ts`. Not part of the package's public surface.
 *
 * ROUND 4 REDESIGN — validate the input, do not classify the error. Four consecutive review
 * rounds tried to guess, AFTER `readFileSync`/`readdirSync` had already thrown, whether the error
 * meant "this is a fact about the file" or "the caller broke a contract":
 *   - round 2: any error carrying a `.code` was an fs fact. Wrong — `ERR_INVALID_ARG_TYPE` (a
 *     resolver returning the wrong shape) also carries one.
 *   - round 3: exclude any `ERR_`-prefixed code as a caller bug. Wrong — `ERR_FS_FILE_TOO_LARGE`
 *     and `ERR_FS_EISDIR` are genuine fs conditions that also start with `ERR_`.
 *   - round 4a: narrow the exclusion to exactly `ERR_INVALID_ARG_TYPE`/`ERR_INVALID_ARG_VALUE`.
 *     Wrong in BOTH directions at once: `ERR_INVALID_ARG_VALUE` is also what `readFileSync` throws
 *     for a syntactically valid string containing a NUL byte — a real fs-worthy fact, not a caller
 *     bug — so excluding it crashed the gate on a single stray byte in a committed file; and a
 *     resolver returning a `URL` object raises `ERR_INVALID_URL_SCHEME`, uncovered by the
 *     allowlist, so THAT caller bug slipped through and got reported as "unreadable file".
 * Node's error codes simply do not partition into "caller bug" vs. "fs condition" — the same code
 * can be either, depending on what produced it, and any finite code allowlist misses whatever
 * exotic value a resolver returns next (a `Proxy`, a `Buffer`, a number, `null`).
 *
 * So this stops trying to read the error and instead enforces the one thing that IS stable: the
 * resolver's own declared contract (`(input) => string | undefined`) and an option's declared type
 * (`string`). Checked the moment the value is produced, before it ever reaches an fs call. Once
 * that passes, every gate's `readFileSync`/`readdirSync` CALL reports UNCONDITIONALLY — no
 * further classification, because a value that is provably a string can only fail there for a real
 * reason about the thing it names (missing, a directory, too large, a NUL byte, no permission).
 *
 * That guarantee is scoped to the fs call ITSELF, not to whatever `try` block happens to contain
 * it (round 5 review finding): each gate's `try` must wrap ONLY `readFileSync`/`readdirSync`, not
 * a second processing step performed on the bytes it returns (`brotliCompressSync` in
 * `cssBudget.ts`, comment-stripping in `fontChain.ts` were both found wrapping one extra step in
 * the same catch). A bug in that second step is not a fact about the file — the file was read
 * successfully — and must propagate rather than being reported under a filesystem-problem kind.
 * This module only validates the INPUT; keeping each `try` narrow is the caller's responsibility.
 */

/** A short, readable description of an unexpected value for an error message — never assumes it
 * is an object with a sensible `.constructor`, since the whole point is that its shape is
 * unpredictable (a `Proxy`, a primitive, `null`, an array). */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (value instanceof URL) return 'a URL object (did you mean its .pathname or .href?)';
  if (typeof value === 'object') {
    const name = (value as { constructor?: { name?: string } }).constructor?.name;
    return `an instance of ${name ?? 'Object'}`;
  }
  return `a ${typeof value} (${String(value)})`;
}

/**
 * Enforces a resolver callback's declared `(input) => string | undefined` contract on its return
 * value, throwing immediately if it is neither. This is the boundary check that replaces
 * after-the-fact error classification (see module doc comment): a resolver returning a `URL`, a
 * `Proxy`, a number, or anything else non-string is a caller bug and must crash loudly, naming the
 * resolver and the input it was given, rather than flow into `readFileSync` and surface as an
 * oblique, misclassified fs error two calls later.
 */
export function assertResolverReturn(
  value: unknown,
  resolverLabel: string,
  input: string,
): asserts value is string | undefined {
  if (value === undefined || typeof value === 'string') return;
  throw new TypeError(
    `${resolverLabel}(${JSON.stringify(input)}) must return a string or undefined per its ` +
      `declared contract, but returned ${describeValue(value)}.`,
  );
}

/**
 * Enforces a required string option's declared type, throwing immediately if it is not a string.
 * Same reasoning as `assertResolverReturn`, for options like `headersFile`/`assetsDir` that (unlike
 * a resolver's return) have no legitimate `undefined` case.
 */
export function assertStringOption(value: unknown, optionName: string): asserts value is string {
  if (typeof value === 'string') return;
  throw new TypeError(`${optionName} must be a string, but received ${describeValue(value)}.`);
}

/**
 * Enforces a required ANTI-VACUITY FLOOR option: an integer strictly greater than zero.
 *
 * WHY A RUNTIME CHECK AND NOT JUST `number`. `verifyFontChain` and `verifyFontPreload` both take an
 * `expectedFacesPerDocument` floor, made REQUIRED so a consumer cannot omit it and silently get a
 * gate that passes having examined nothing. TypeScript proves a number was passed; it cannot prove
 * the number is a real floor. Three review lenses independently reproduced the gap that leaves:
 *
 *   floor = 0 or negative  ->  `size >= floor` is always true  ->  the floor NEVER fires, for any
 *                              document, restoring the exact vacuous pass the option exists to
 *                              close — and `ok: true` with zero faces examined is what shipped in
 *                              2026.831.3 and prompted the option in the first place.
 *   floor = NaN | Infinity ->  `size >= floor` is always false ->  the floor fires on EVERY
 *                              document, including correct ones, breaking a healthy build (and
 *                              `NaN` serialises to `null` in the problem's `expected` field, so the
 *                              message cannot even be read).
 *   floor = 2.5            ->  behaves as a ceiling of 3 while reporting "expected at least 2.5".
 *
 * `0` is not hypothetical: it is what a migration reaches for first. This package's own test suite
 * pinned it at 70 call sites while adapting to the breaking change, and a consumer computing
 * `Math.min(...perRouteCounts)` or `Number(process.env.MIN_FACES ?? '0')` lands on it by accident.
 *
 * `0` is DELIBERATELY NOT accepted as "floor disabled". An opt-out spelling would relocate the same
 * silent reopening one level up into a documented default, which is how the original defect got in.
 * A build that genuinely ships no webfonts has no reason to run a font-floor gate over it.
 */
export function assertPositiveIntegerOption(
  value: unknown,
  optionName: string,
): asserts value is number {
  if (Number.isInteger(value) && (value as number) > 0) return;
  throw new TypeError(
    `${optionName} must be an integer greater than 0 — it is an anti-vacuity floor, and a value ` +
      `of 0 or less disables it silently while the gate still reports ok. Received ` +
      `${describeValue(value)}.`,
  );
}

/**
 * Maximum length of a token handed to a CONSUMER-SUPPLIED `hashPattern` (`headers.ts`'s
 * `checkAssetsHashed`, `danglingClasses.ts`'s `extractHashedClasses`/`logicalName`) before it is
 * matched.
 *
 * WHAT THIS CAP IS: a sanity bound on token LENGTH, nothing more. `hashPattern` is an arbitrary
 * regex the consumer provides, tested against build-content-derived strings (filenames, CSS class
 * selector tokens) with no length cap upstream — those strings can be as long as whatever produced
 * them. A real hashed filename (`<name>-<8-char hash>.<ext>`) or CSS-Modules class name
 * (`_<logicalName>_<hash>_<line>`) is essentially always well under 128 characters — nothing in
 * this package's own fixtures or any real Vite/CSS-Modules output approaches it — so this cap can
 * only ever reject pathological-LENGTH input, never a legitimate hashed name. Do NOT lower this
 * "to be safer": the goal is a length sanity check, not tuning a defense against a specific attack
 * pattern, and a smaller cap risks clipping a real name with an unusually long logical part.
 *
 * WHAT THIS CAP IS NOT, AND CANNOT BE (HIGH review finding, 2026-08-30 — corrects an earlier
 * version of this comment that claimed the cap bounded execution time): no LENGTH cap can bound
 * regex execution TIME. Measured on `/^(a+)+$/` (classic catastrophic backtracking) against a
 * failing match:
 *
 *     20 chars →     23 ms        30 chars →   4,659 ms
 *     25 chars →    145 ms        32 chars →  19,275 ms
 *     28 chars →  1,158 ms        36 chars →  51,900 ms
 *
 * This cap is 128 — 3.5x LONGER than the 36-character token that took 51.9 SECONDS above — and no
 * smaller cap fixes it either: legitimate CSS-Modules class names and hashed filenames reach ~40
 * characters, while the blowup is already at 19 seconds by 32 characters. There is no length value
 * that admits real input and excludes a pathological pattern; catastrophic backtracking is
 * exponential in input length, so shrinking the cap barely moves the worst case while cutting into
 * legitimate names.
 *
 * A consumer-supplied pathological `hashPattern`/`allowlist` regex CAN still hang the build. This
 * cap does not defend against that, and nothing in this module does. The pattern DEFAULTS shipped
 * by `headers.ts` and `danglingClasses.ts` are linear and safe. `hashPattern`/`allowlist` patterns
 * come from the same trust domain as the build script that invokes this gate — the person who
 * writes one also writes the other — so a pathological pattern is a bug the author hits on their
 * own first run against real content, not a vulnerability an external or adversarial party can
 * trigger.
 */
export const MAX_HASH_PATTERN_TOKEN_LENGTH = 128;

/**
 * `hashPattern.test(token)`, bounded by `MAX_HASH_PATTERN_TOKEN_LENGTH`. Returns `'oversized'`
 * WITHOUT ever invoking `pattern` when `token` exceeds the cap — the point is to never hand a
 * consumer-supplied regex an unbounded string, not to time-box the regex engine after the fact
 * (not possible for a synchronous, single-threaded `RegExp.test()` call; nothing can interrupt it
 * once started). Callers MUST branch on `'oversized'` and report it as its own explicit finding —
 * never fold it into `'no-match'` (that makes the token silently vanish from the check, since no
 * matching hashed name is ever recorded for it) and never treat it as `'match'` (that would accept
 * a token that was never actually verified against `hashPattern`). See `headers.ts`'s
 * `oversized-filename` and `danglingClasses.ts`'s `oversized-class-name` problem kinds.
 */
export function testHashPatternBounded(
  pattern: RegExp,
  token: string,
): 'match' | 'no-match' | 'oversized' {
  if (token.length > MAX_HASH_PATTERN_TOKEN_LENGTH) return 'oversized';
  return pattern.test(token) ? 'match' : 'no-match';
}

/**
 * `hashPattern.exec(token)`, bounded the same way as `testHashPatternBounded`. Used by
 * `danglingClasses.ts`'s `logicalName`, whose only current caller already passes a cap-checked
 * class name (`extractHashedClasses` never adds an oversized name to the set it returns) — this
 * guard exists so `logicalName` cannot become a second, unguarded path to the same regex if it is
 * ever called with unchecked input later.
 */
export function execHashPatternBounded(
  pattern: RegExp,
  token: string,
): RegExpExecArray | null | 'oversized' {
  if (token.length > MAX_HASH_PATTERN_TOKEN_LENGTH) return 'oversized';
  return pattern.exec(token);
}

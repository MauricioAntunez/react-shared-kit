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
 * that passes, every gate's `readFileSync`/`readdirSync` catch reports UNCONDITIONALLY — no
 * further classification, because a value that is provably a string can only fail there for a real
 * reason about the thing it names (missing, a directory, too large, a NUL byte, no permission).
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

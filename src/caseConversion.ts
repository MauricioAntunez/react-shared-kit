/**
 * Case conversion for strings and for object keys.
 *
 * The key transformers are for crossing an API boundary — snake_case on the
 * wire, camelCase in the app — so they are recursive and never mutate their
 * input.
 */

const SNAKE_BOUNDARY = /_([a-z])/g;
const CAMEL_BOUNDARY = /([A-Z])/g;
const LEADING_UNDERSCORE = /^_/;

/**
 * Converts a snake_case string to camelCase.
 *
 * Only `_` followed by a lowercase letter is a boundary, so `user_ID` and
 * `field_2` are returned unchanged — the underscore survives. Round-tripping
 * with {@link toSnakeCase} is lossless for ordinary identifiers but not for
 * these.
 */
export function toCamelCase(str: string): string {
  return str.replace(SNAKE_BOUNDARY, (_, letter: string) => letter.toUpperCase());
}

/**
 * Converts a camelCase string to snake_case.
 *
 * Every uppercase letter is treated as a word boundary, so acronyms split:
 * `parseURL` becomes `parse_u_r_l`. That round-trips back through
 * {@link toCamelCase} intact, but it is not the spelling a human would choose.
 */
export function toSnakeCase(str: string): string {
  return str.replace(CAMEL_BOUNDARY, '_$1').toLowerCase().replace(LEADING_UNDERSCORE, '');
}

/**
 * Uppercases the first character, leaving the rest of the string untouched.
 *
 * `capitalize('hELLO')` is `'HELLO'`, not `'Hello'`.
 */
export function capitalize(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/** Anything the key transformers accept. `Date` is included because payloads carry them. */
type TransformableValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Date
  | TransformableValue[]
  | { [key: string]: TransformableValue };

/**
 * True only for `{}`-style objects.
 *
 * Anything with a different prototype — `Date`, `Map`, `Set`, `RegExp`, a class
 * instance — is passed through untouched rather than being flattened into a
 * plain object with renamed keys, which would silently destroy it.
 */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function transformKeys(
  value: TransformableValue,
  transform: (key: string) => string,
): TransformableValue {
  if (Array.isArray(value)) {
    return value.map((item) => transformKeys(item, transform));
  }

  if (value === null || typeof value !== 'object' || !isPlainObject(value)) {
    return value;
  }

  const result: { [key: string]: TransformableValue } = {};

  for (const [key, item] of Object.entries(value)) {
    // Plain assignment to a `__proto__` key would reassign the prototype instead
    // of adding a property; defineProperty always creates an own property. Keys
    // come from untrusted payloads, so this is not hypothetical.
    Object.defineProperty(result, transform(key), {
      value: transformKeys(item, transform),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  return result;
}

/**
 * Recursively renames object keys from snake_case to camelCase.
 *
 * The input is not mutated. Non-plain objects (`Date`, `Map`, class instances)
 * pass through by reference. The returned type is the input type: keys are
 * renamed at runtime but not in the type system, so cast at the boundary if the
 * distinction matters.
 */
export function camelCaseKeys<T>(value: T): T {
  return transformKeys(value as TransformableValue, toCamelCase) as T;
}

/**
 * Recursively renames object keys from camelCase to snake_case.
 *
 * Same guarantees as {@link camelCaseKeys}.
 */
export function snakeCaseKeys<T>(value: T): T {
  return transformKeys(value as TransformableValue, toSnakeCase) as T;
}

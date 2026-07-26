/**
 * Stable React keys for lists whose items carry no id.
 *
 * Why this exists: an array index is not an identity. When a list is reordered,
 * filtered or prepended to, index keys make React reuse the wrong DOM node — a
 * checked checkbox stays checked on a different row, a focused input keeps focus
 * while its value changes underneath.
 *
 * What can and cannot be done:
 * - Object items HAVE a stable identity: the reference itself. A WeakMap assigns
 *   each object a key on first sight and returns the same key forever after, with
 *   no retention (entries are collected with the object).
 * - Primitive items (strings, numbers) have no identity beyond their value. Distinct
 *   values are used directly. DUPLICATE primitives are genuinely ambiguous — nothing
 *   can tell the second "Santiago" in a list from the third — so they fall back to a
 *   value+occurrence key, which is order-dependent by necessity. Prefer giving such
 *   lists real ids.
 */

const objectKeys = new WeakMap<object, string>();
let counter = 0;

/** Returns a key that is stable for the lifetime of an object item. */
export function stableKey(item: unknown): string {
  if (item !== null && (typeof item === 'object' || typeof item === 'function')) {
    const existing = objectKeys.get(item as object);
    if (existing !== undefined) return existing;

    counter += 1;
    const key = `key-${counter}`;
    objectKeys.set(item as object, key);
    return key;
  }

  return String(item);
}

/** Shape of an item that already carries its own identity. */
type Identifiable = { id?: string | number; key?: string | number };

/**
 * Resolves the best available key for a list item, in order of trustworthiness:
 * an explicit `id`/`key` field, then object identity, then the primitive value.
 *
 * Duplicate primitives are disambiguated by occurrence, which is why `seen` is
 * threaded through — call it once per list, not per item in isolation.
 */
export function resolveKeys<T>(
  items: readonly T[],
  getId?: (item: T) => string | number,
): string[] {
  const seen = new Map<string, number>();

  return items.map((item) => {
    let base: string;

    if (getId) {
      base = String(getId(item));
    } else if (item !== null && typeof item === 'object') {
      const candidate = (item as Identifiable).id ?? (item as Identifiable).key;
      base = candidate === undefined ? stableKey(item) : String(candidate);
    } else {
      base = String(item);
    }

    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);

    // First occurrence keeps the clean key so stable lists produce stable keys.
    return count === 0 ? base : `${base}#${count}`;
  });
}

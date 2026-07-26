# react-shared-kit

A small library of app-agnostic React utilities, shared across projects. Not a framework and not a
design system — no components, no CSS, no design tokens. Those belong to the app that owns them.
ESM only, zero runtime dependencies.

```bash
npm install react-shared-kit
```

## `resolveKeys(items, getId?)`

Stable React list keys for items that carry no domain id.

An array index is not an identity. When a list is reordered, filtered, or prepended to, index keys
make React reuse the wrong DOM node — a checked checkbox stays checked on a different row, a focused
input keeps focus while its value changes underneath.

```ts
import { resolveKeys } from 'react-shared-kit';

function Rows({ rows }: { rows: Row[] }) {
  const keys = resolveKeys(rows);
  return rows.map((row, i) => <Row key={keys[i]} {...row} />);
}
```

Keys are resolved in order of trustworthiness:

1. an explicit `id` / `key` field on the item (or whatever `getId` returns),
2. object identity, for objects with no id,
3. the primitive value itself.

Duplicate keys are disambiguated by occurrence — the first `x` stays `x`, the second becomes `x#1`
— so a list that does not change produces keys that do not change.

```ts
resolveKeys([{ id: 'a' }, { id: 'b' }]);        // ['a', 'b']
resolveKeys(['x', 'x', 'y']);                   // ['x', 'x#1', 'y']
resolveKeys(items, (item) => item.slug);        // custom accessor
```

## `stableKey(item)`

The single-item primitive behind `resolveKeys`. Objects get a key assigned on first sight via a
`WeakMap` and keep it for their lifetime, with no retention — the entry is collected with the
object. Primitives return their own value.

```ts
const a = { name: 'x' };
stableKey(a) === stableKey(a); // true
stableKey({ name: 'x' }) === stableKey({ name: 'x' }); // false — distinct objects
```

## Limitations worth knowing

- **Keys are process-local.** They come from an in-memory counter, so they are not stable across
  reloads, workers, or servers. Never persist them or send them over the wire.
- **Duplicate primitives are genuinely ambiguous.** Nothing can tell the second `'Santiago'` in a
  list from the third, so their keys are order-dependent by necessity. Give such lists real ids.

## License

MIT

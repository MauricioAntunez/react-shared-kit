# @uxr/react-shared-kit

A small library of app-agnostic utilities, shared across projects. Not a framework and not a design
system — no components, no CSS, no design tokens. Those belong to the app that owns them. ESM only,
zero runtime dependencies, Node 22+.

```bash
npm install @uxr/react-shared-kit
```

Published with [provenance](https://docs.npmjs.com/generating-provenance-statements) from GitHub
Actions, so every release is traceable to the commit and workflow that built it.

---

## List keys

### `resolveKeys(items, getId?)`

Stable React list keys for items that carry no domain id.

An array index is not an identity. When a list is reordered, filtered, or prepended to, index keys
make React reuse the wrong DOM node — a checked checkbox stays checked on a different row, a focused
input keeps focus while its value changes underneath.

```tsx
import { resolveKeys } from '@uxr/react-shared-kit';

function Rows({ rows }: { rows: Row[] }) {
  const keys = resolveKeys(rows);
  return rows.map((row, i) => <Row key={keys[i]} {...row} />);
}
```

Keys are resolved in order of trustworthiness:

1. an explicit `id` / `key` field on the item (or whatever `getId` returns),
2. object identity, for objects with no id,
3. the primitive value itself.

Duplicate keys are disambiguated by occurrence — the first `x` stays `x`, the second becomes `x#1` —
so a list that does not change produces keys that do not change.

```ts
resolveKeys([{ id: 'a' }, { id: 'b' }]); // ['a', 'b']
resolveKeys(['x', 'x', 'y']);            // ['x', 'x#1', 'y']
resolveKeys(items, (item) => item.slug); // custom accessor
```

### `stableKey(item)`

The single-item primitive behind `resolveKeys`. Objects get a key assigned on first sight via a
`WeakMap` and keep it for their lifetime, with no retention — the entry is collected with the
object. Primitives return their own value.

```ts
const a = { name: 'x' };
stableKey(a) === stableKey(a);                          // true
stableKey({ name: 'x' }) === stableKey({ name: 'x' });  // false — distinct objects
```

**Keys are process-local.** They come from an in-memory counter, so they are not stable across
reloads, workers, or servers. Never persist them or send them over the wire. And duplicate
primitives are genuinely ambiguous — nothing can tell the second `'Santiago'` in a list from the
third, so those keys are order-dependent by necessity. Give such lists real ids.

---

## Case conversion

For crossing an API boundary: `snake_case` on the wire, `camelCase` in the app.

```ts
import { camelCaseKeys, snakeCaseKeys, toCamelCase, toSnakeCase, capitalize } from '@uxr/react-shared-kit';

toCamelCase('user_name');  // 'userName'
toSnakeCase('userName');   // 'user_name'
capitalize('hello');       // 'Hello'

camelCaseKeys({ user_name: 'a', nested: { inner_key: [{ deep_key: 1 }] } });
// { userName: 'a', nested: { innerKey: [{ deepKey: 1 }] } }
```

`camelCaseKeys` / `snakeCaseKeys` recurse through objects and arrays, never mutate their input, and
pass **non-plain objects through by reference** — `Date`, `Map`, `Set`, `RegExp` and class instances
survive intact rather than being flattened into plain objects with renamed keys. Keys are assigned
with `defineProperty`, so a `__proto__` key in an untrusted payload cannot reassign the prototype.

Two behaviours worth knowing before you rely on them:

- **Only `_` followed by a lowercase letter is a boundary.** `user_ID` and `field_2` come back
  unchanged.
- **Every uppercase letter is a boundary going the other way**, so acronyms split:
  `parseURL` → `parse_u_r_l`. That round-trips back intact, but it is not the spelling a human would
  pick.

The return type is the input type. Keys are renamed at runtime but not in the type system, so cast
at the boundary if the distinction matters to you.

---

## Date ranges

Preset ranges for period pickers, in the local timezone or UTC.

```ts
import { periodToRange, resolvePeriodRange, toYmd, PERIODS } from '@uxr/react-shared-kit';

// Ranges run Monday -> today. Below, "now" is 02:30 UTC on Sunday 2026-07-26,
// which is still Saturday the 25th in Santiago — hence the different `to`.
periodToRange('week');                 // { from: '2026-07-20', to: '2026-07-25' }  local
periodToRange('week', { utc: true });  // { from: '2026-07-20', to: '2026-07-26' }  UTC

// Handles the whole picker, including the user-supplied case:
resolvePeriodRange(period, customFrom, customTo);
```

Every function here answers a calendar question, and the answer depends on the timezone: at 21:00 in
Santiago it is already tomorrow in UTC. Pass `{ utc: true }` when a UTC-based API consumes the range;
leave it off when a person reads it. Dates are emitted as `YYYY-MM-DD` strings, never `Date` objects
— a calendar date has no time and no offset, and attaching one invites exactly the confusion this
module exists to avoid.

`PERIODS` is a `const` array you can iterate to build the picker; `Period` is the union derived from
it. `periodToRange` accepts only *preset* periods — `'custom'` is a compile error there, because it
has no computable range. Use `resolvePeriodRange`, which takes the user's dates alongside the period.

Pass `{ now }` to pin "today" — the option exists so week and month boundaries are testable, which is
precisely where date bugs live.

```ts
todayYmd({ utc: true });         // '2026-07-26'
monthStartYmd();                 // '2026-07-01'
toYmd(new Date(), { utc: true });
```

`normalizeYmd` extracts the `YYYY-MM-DD` prefix of a date string, accepting the dashed form (with or
without a time suffix) or compact `YYYYMMDD`, and returns `''` when it matches neither:

```ts
normalizeYmd('2026-07-26T02:00:00Z'); // '2026-07-26'
normalizeYmd('20260726');             // '2026-07-26'
normalizeYmd('not a date');           // ''
```

It is **string surgery, not a timezone conversion** — the result is the date as written, wherever you
run it. To convert an instant to a calendar date in a given zone, use `toYmd(new Date(iso), { utc })`
instead. The two disagree by a day near midnight, which is the bug this note exists to prevent.

---

## Chilean RUT

```ts
import { isValidRut, formatRut } from '@uxr/react-shared-kit';

isValidRut('12.345.678-5'); // true
isValidRut('12345678-5');   // true — dots, hyphens and spaces are ignored
isValidRut('12.345.670-k'); // true — K accepted in either case
formatRut('123456785');     // '12.345.678-5'
```

Validation is the mod-11 check-digit algorithm: it proves the digits are internally consistent, **not
that the RUT was ever issued to anyone**. Treat `true` as "well-formed", never as "this person
exists".

`formatRut` returns the cleaned input unchanged when the RUT is invalid — it never throws and never
reports failure, so call `isValidRut` first if you need to tell "formatted" from "gave up".

---

## Image optimization

Generation, delivery and verification for responsive images, split across three subpaths so a
browser bundle never pulls in Node/`sharp` code:

- `@uxr/react-shared-kit` (root) — `Picture`, `buildSizes`, and the manifest types. Browser-safe.
- `@uxr/react-shared-kit/images` — `defineImageClasses`, `buildSizes`, and the types, with no
  React import. For build scripts that need the class table but not the component.
- `@uxr/react-shared-kit/node` — `optimizeImages`, `verifyImages`, and the ledger primitives.
  Node-only; requires the peer deps below.

`react` is a peer dependency for the root subpath. `sharp` and `imagetools-core` are peer
dependencies too, but **optional** — install them only if you use `@uxr/react-shared-kit/node`; the
root and `/images` subpaths never import them.

```bash
npm install @uxr/react-shared-kit sharp imagetools-core
```

Define the class ladder once, generate derivatives with a build script, then render with
`<Picture>`:

```ts
// build-images.mjs — run over your app's existing public/** tree
import { defineImageClasses } from '@uxr/react-shared-kit/images';
import { optimizeImages } from '@uxr/react-shared-kit/node';

const { classes, classForPath } = defineImageClasses(
  { hero: { widths: [480, 768, 1280], masterMin: 1280 } },
  { hero: 'hero' }, // any path under a "hero" directory uses the "hero" class
);

await optimizeImages({
  sourceDir: 'public/images',
  classes,
  classForPath,
  manifestPath: 'public/images/manifest.json',
  ledgerPath: '.image-ledger.json',
});
```

```tsx
// any component
import { Picture } from '@uxr/react-shared-kit';
import manifest from '../public/images/manifest.json';

function Hero() {
  return (
    <Picture
      manifest={manifest}
      src="/images/hero/banner.jpg"
      alt="Product banner"
      sizes="100vw"
      priority
    />
  );
}
```

Four rules the module never bends:

- **No upscaling.** A class's width ladder is truncated per image to `w <= master intrinsic
  width`; srcset descriptors come from the *measured* output, never the requested width.
- **AVIF-first, unconditionally.** `<Picture>` always lists AVIF before WebP in the `<picture>`
  source order. A larger AVIF than its WebP sibling is reported by `optimizeImages`, never dropped.
- **The ledger is content-addressed.** Re-encode decisions key on `sha256(bytes) + params`, never
  on file mtime — touching a file without changing its bytes costs zero re-encodes.
- **Mobile-first.** Ladders ascend from the smallest rung, the plain `<img src>` fallback is the
  smallest JPEG rung, and images are `loading="lazy"` unless `priority` is set.

`verifyImages` re-checks an existing manifest against the source tree (stale entries, missing
files, ladder violations, derivatives whose aspect ratio proves they came from a different master)
without re-encoding anything — run it in CI to catch a manifest that drifted from its images.

**`ok` reflects `issues` only.** The result also carries `ignored`: image files that exist in the
tree but were never treated as masters — an AVIF used as a source, an animated GIF, an orphaned
derivative left behind by a rename. Those are facts about the tree rather than proof the build is
wrong, so they deliberately do **not** set `ok: false`; failing on them would push you to disable
the gate wholesale. A CI script that stops at `if (!result.ok)` will never see them, so check both:

```ts
const result = await verifyImages({ manifest, classes, sourceDir: 'public' });
if (!result.ok) {
  for (const issue of result.issues) console.error(`${issue.kind}: ${issue.path} — ${issue.detail}`);
  process.exit(1);
}
for (const file of result.ignored) console.warn(`not optimized (${file.reason}): ${file.publicPath}`);
```

`optimizeImages` reports the same set on its own `ignored`, plus `sourceDirMissing` and
`sourceDirEmpty` — both leave any existing manifest untouched, so the flags are the only way to
tell a misconfigured path from a genuinely empty one.

---

## Consuming the TypeScript source

The default entry point is compiled JavaScript plus declarations, which works in any bundler and any
Node. A `source` export condition additionally points at the raw `.ts`, for tools that prefer to
transpile it themselves:

```json
"exports": { ".": { "source": "./src/index.ts", "types": "./dist/index.d.ts", "import": "./dist/index.js" } }
```

## License

MIT

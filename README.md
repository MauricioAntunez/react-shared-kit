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

Generation, delivery and verification for responsive images, split across four subpaths so a
browser bundle never pulls in Node/`sharp` code:

- `@uxr/react-shared-kit` (root) — `Picture`, `buildSizes`, and the manifest types. Browser-safe.
- `@uxr/react-shared-kit/images` — `defineImageClasses`, `buildSizes`, and the types, with no
  React import. For build scripts that need the class table but not the component.
- `@uxr/react-shared-kit/node` — `optimizeImages`, `verifyImages`, and the ledger primitives.
  Node-only; requires the peer deps below.
- `@uxr/react-shared-kit/check` — build/deploy-chain gates: `intrinsicSize`/`sameAspect` and the
  `object-fit` source of truth (`isDistortingFit`), `verifyHtmlImages` (built `<img>` tags carry
  width/height and an honest ratio or a non-distorting `object-fit`), `verifyImageTree`
  (structural manifest-vs-disk verify — paths, ladders, orphans, master hashes), `scanMetadataLeaks`
  (EXIF/XMP/IPTC presence, without decoding), and `isSameEntryModule`/`makeEntryPointCheck` (a
  symlink-safe `require.main === module` guard for script entry points). Sharp-free by
  construction — never imports sharp or imagetools-core — so these gates run with zero native
  binaries on the deploy chain. A gate script:

  ```ts
  import { verifyImageTree, makeEntryPointCheck } from '@uxr/react-shared-kit/check';

  const isEntryPoint = makeEntryPointCheck('verify-images');
  if (isEntryPoint(process.argv[1], import.meta.url)) {
    const result = verifyImageTree({ manifest, outputDir: 'public', mastersDir: 'assets' });
    if (!result.ok) {
      console.error(result.issues);
      process.exit(1);
    }
  }
  ```
- `@uxr/react-shared-kit/perf` — deploy-performance gates over built output (headers, CSS budget,
  font-discovery chains, dangling CSS-Modules selectors). See **Deploy-performance gates** below.

`react` is a peer dependency for the root subpath. `sharp` and `imagetools-core` are peer
dependencies too, but **optional** — install them only if you use `@uxr/react-shared-kit/node`; the
root, `/images`, and `/check` subpaths never import them.

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

## Deploy-performance gates

`@uxr/react-shared-kit/perf` — four static-analysis gates over **built** output, for projects on a
Vite-style content-hashing bundler behind a static host. Sibling of `/check`, not part of it: those
are image gates and live under `src/image/`.

```ts
import {
  verifyHeaders,
  verifyCssBudget,
  verifyFontChain,
  findDanglingClasses,
} from '@uxr/react-shared-kit/perf';
```

| Gate | Catches |
|---|---|
| `verifyHeaders` | Content-hashed assets served `max-age=0, must-revalidate`, so every repeat visit pays a revalidation round-trip. Also refuses `immutable` on any **unhashed** path — that is cache poisoning: the file changes, the URL does not, clients hold a stale copy for a year. |
| `verifyCssBudget` | Render-blocking CSS over a per-document byte budget — and any stylesheet `href` that resolves to no file at all. |
| `verifyFontChain` | **A font file imported via CSS at all** — a hard rule, not a budget: a face is clean only if the HTML itself reveals it (a `<link rel="preload" as="font" crossorigin>`, or the `@font-face` inlined in a `<style>` in the document). A face declared only in an external stylesheet fails, whether that's the render-blocking sheet itself or a nested `@import` — depth still appears in the message as diagnostic detail, but there is no depth that passes without one of those two shapes. |
| `findDanglingClasses` | A CSS-Modules selector joining a class from one built file to a hashed name from another — compiles cleanly, matches no element anywhere. Dead bytes shipped and evaluated on every route that loads the chunk, **and** the rule's own intent silently isn't applying (one such rule cost a production element 465px of width). |

Each returns `{ ok, problems }`. They never log and never call `process.exit` — your wrapper owns
presentation and exit codes, the same contract as `/check`.

**A `problems` entry is not the only way these gates can end a run.** Each validates its
consumer-supplied inputs — a `resolveHref`/`resolveImport` callback's return value, a required
string option, an element of a `htmlFiles`/`cssFiles` array — against its declared type the moment
it is produced, and **throws immediately** if it is violated: a resolver returning a `URL` object
instead of its `.pathname`, say. That is a caller bug, not a build fact, so it is not folded into
`problems` disguised as an "unreadable file" pointing at something that is actually fine. Reserve
`problems` for facts about the build itself — missing/unreadable files, malformed rules, vacuous
input, a resolver that declines to resolve by returning `undefined`. A crash on startup means fix
the call site, not the build.

### These gates are necessary, not sufficient

**Do not read a green result as "the problem is closed."** Everything here is static analysis. It
sees bytes, hrefs, the `@import` graph and header rules. It **cannot** see what the browser actually
computed, which stylesheet it really blocked on, or what a rendered box became.

A real-browser oracle cannot live in this package: the Vitest environment is deliberately `node`
with no DOM, and pulling a browser into a package whose gates run inside deploy chains would drag a
heavyweight dependency into exactly the place ruling 6.3 keeps native binaries out of.

So pair each gate with a browser check in your own project — the same two-gate split that already
exists for images, where `verifyHtmlImages` (attributes, here) and a browser-driven layout sweep
(rendered box, there) both run because neither subsumes the other. **A project running only these
gates has weaker coverage than one running both.**

### `verifyFontChain` measures from the DOCUMENT, not the entry stylesheet

An earlier version of this gate measured `@import` depth starting from the render-blocking entry
stylesheet, so a font declared directly in that sheet — zero `@import`s at all — scored depth 0 and
passed. That is the wrong frame of reference: the browser's preload scanner reads the **document**,
not any CSS file, so a font whose only declaration lives in a stylesheet is undiscoverable until
that stylesheet is fetched *and* parsed, `@import` or not. `verifyFontChain` now needs `htmlFiles`
so it can check the two shapes that actually make a font document-discoverable — a font-preload
link or an inlined `@font-face` — and treats everything else as a defect, at any depth. There is no
`maxChainDepth` option to raise instead: **a font file must never be imported via CSS** is a hard
rule, not a threshold a consumer can tune past.

When a `deep-font` finding fires, prefer **inlining** the `@font-face` block in the document head
over adding a preload: inlining gets the browser discovering the font at HTML parse time *and*
still only downloads the face lazily, once a glyph actually needs it, while a preload forces an
unconditional download the moment the tag is seen. **Do not preload every face as a blanket fix** —
a page with several faces on the critical path would trade a discovery delay for a bandwidth cost
on that same critical path, which is worse than the defect being fixed. The gate cannot know which
face your largest above-the-fold text actually uses, so it reports what it found and leaves that
choice to you.

### `font-display: swap` does not answer `verifyFontChain`

Worth stating because an expert got it wrong and shipped the defect — twice, the second time via
this very gate's own depth-from-the-wrong-root bug above. There are two distinct failure modes and
one does not answer the other:

- **Rendering** — what the user sees while a face loads. Governed by `font-display`. `swap` handles
  this correctly.
- **Discovery** — when the browser first learns the font URL exists. Governed by whether the
  document itself reveals it. `swap` does nothing for it.

A project whose fonts all declare `swap` can still be several hundred milliseconds late to request
them. `verifyFontChain` measures the second thing, and says so in its own problem messages.

### Vacuity

An empty `assetsDir`, a `_headers` that parses to zero rules, an empty `htmlFiles`, or an empty
`entryStylesheets`/`cssFiles` is reported as a problem — not passed. A gate that reports success
when the build produced nothing to verify is worse than no gate.

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

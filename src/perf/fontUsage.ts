import { sanitizeTagText } from './scan.ts';
import { stripComments } from './text.ts';

/**
 * Font-coverage analysis: does every element that renders text use a `font-family` +
 * `font-weight` pair the build actually SHIPS? (T6, ported from boufin's
 * `scripts/verify-font-faces.ts`.)
 *
 * WHY THIS GATE EXISTS. A stylesheet declaring nine faces got trimmed to three on the strength of
 * a comment claiming one dropped face was "never paired with the body family anywhere". That was
 * false: a footer heading declared `font-weight: 700` with NO `font-family` — it INHERITS the
 * body family — and a UA-default rule for `strong`/`b` did the same. Both are invisible to a
 * check that reads CSS BLOCKS pairing a weight token with a family token in the SAME declaration,
 * because neither an inherited family nor a UA default lives in that block. The browser silently
 * synthesises or substitutes a fallback weight — no error, no visual glitch obvious enough to
 * notice — so this defect ships silently until someone looks at computed style.
 *
 * THE SPLIT — READ BEFORE TRUSTING A CONSUMER USING ONLY THIS MODULE. Only a real browser running
 * `getComputedStyle` can observe the RESOLVED `font-family`/`font-weight` pair an element actually
 * renders with — inheritance, cascade and UA defaults all happen there, not in any static
 * analysis of source files. This package cannot take that dependency: the Vitest environment here
 * is deliberately `node` with no DOM, and these gates run inside deploy chains where a
 * heavyweight/native dependency is exactly what the module's charter (see `./index.ts`) keeps
 * out. So the work is split in two:
 *
 *   - the CONSUMER drives a browser (Playwright, Puppeteer, whatever it already uses) over the
 *     built site, computes each rendered element's resolved family/weight, and produces
 *     `ObservedElement[]` per route — that half does not and cannot live here;
 *   - this module is the PURE half: it parses the shipped `@font-face` set out of built CSS and
 *     decides which observations violate it, given both halves as plain data.
 *
 * A consumer that only runs this module's functions — without ever collecting real
 * `ObservedElement`s from a browser sweep — has verified NOTHING about what actually renders. It
 * has a parser for the shipped set and nothing to compare it against. Coverage requires both
 * halves; this module alone is necessary and not sufficient, the same relationship this
 * directory's other gates have to a browser check (see `./index.ts`'s LIMIT paragraph).
 *
 * SEMANTICS, each rule kept from the boufin original for the reason it was added there:
 *
 * - `normalizeFamily` implements CSS Fonts §2.1 family-name comparison: trim, strip one layer of
 *   surrounding quotes, trim again, ASCII-lowercase. Both sides of every comparison — the shipped
 *   set built from CSS and the observed value handed in by the consumer's browser sweep — MUST
 *   run through this SAME function, or a same-family match silently fails (a shipped `"Space
 *   Grotesk"` never matching an observed `space grotesk` because only one side was normalised).
 * - `parseFontFaces` reads `font-family` and `font-weight` DESCRIPTORS out of each `@font-face`
 *   block body. `./scan.ts`'s `scanFontFaces`/`urlsInFontFaceBody` walk the same block grammar but
 *   extract `src: url(...)` values for a different gate (`fontChain.ts`'s deep-font check) — they
 *   do not parse these two descriptors, so this module reads the block bodies itself rather than
 *   reusing that extraction.
 *   - `font-weight` may be a single value (`700`) or a variable-font RANGE (`100 900`) — real
 *     production CSS ships both shapes, and a parser that only understood the single-value form
 *     would silently mis-cover every variable-font face the day one ships.
 *   - Only the FIRST family token before a comma is taken from `font-family` — a face descriptor
 *     lists its own name first, any further tokens are unrelated fallback names, not additional
 *     things this face ships.
 *   - A block with no parsable `font-family` or `font-weight` is SKIPPED, never defaulted to some
 *     assumed value — defaulting would let a malformed `@font-face` pass as covering a pair the
 *     build never actually shipped, which is the exact silent-pass failure mode this gate exists
 *     to close.
 *   - Comments are stripped first (`./text.ts`'s `stripComments`) so a commented-out `@font-face`
 *     is never read as shipped.
 * - `shipsFamily` / `shipsWeight` are the two halves of "is this pair covered": is the
 *   (already-normalised) family one we ship ANY face for, and if so does some shipped face for it
 *   cover `weight` within `[weightMin, weightMax]` inclusive at both ends.
 * - `findUnshippedFontUsage`: an element whose family we ship NOTHING for is never a violation —
 *   that family is not ours to ship (a UA/system fallback, or a third-party family the page
 *   intentionally uses outside this build's control). Only a SHIPPED family at an UNSHIPPED
 *   weight is a violation. `shipsFamily` is re-checked here even though a well-behaved consumer's
 *   browser collector is expected to have already filtered to shipped families before calling
 *   this function — so this pure function stays correct for ANY caller, not only a
 *   well-behaved one.
 * - An empty `faces` array makes `findUnshippedFontUsage` report NO violations for any input,
 *   INTENTIONALLY, not as a vacuous pass this module is silently guilty of: with nothing shipped,
 *   `shipsFamily` is false for every element, so nothing is "ours" to have gotten wrong. Failing
 *   an empty shipped set closed (e.g. "the build shipped zero `@font-face` blocks — something is
 *   badly wrong") is the CONSUMER's responsibility, exactly as boufin's `collectShippedFaces` does
 *   before ever calling `findViolations` — this pure function does not have enough context (was
 *   the build supposed to ship fonts at all?) to make that call itself.
 * - `detail` on each violation runs `route`, `tag`, `className` and `family` through
 *   `sanitizeTagText` (`./scan.ts`) — all four are built-page content (a route path from the built
 *   site, an observed element's tag/class/family from a live DOM), the LESS-TRUSTED side of this
 *   package's trust boundary, and a crafted class name or family string must not be able to forge
 *   an extra line into a CI log that reads like this gate's own output.
 *
 * These functions are PURE and return plain values, not `{ ok, problems }` wrapper objects like
 * the `verify*` gates elsewhere in this directory — deliberately, and not an oversight: this
 * module has no filesystem or html-tree input of its own to fail closed over (no `htmlFiles`, no
 * `resolveHref`), only strings and arrays a caller already owns. `findUnshippedFontUsage` returns
 * a violation array directly; an empty array IS the pass. The `ok`/`problems` shape earns its
 * keep where a gate reports multiple KINDS of failure (unreadable file, malformed input, over
 * budget) that a caller must distinguish — that does not apply here.
 */

/** A family name that has been run through `normalizeFamily` — trimmed, unquoted, lowercased.
 * Constructed ONLY by `normalizeFamily`; there is no other way to produce one. Exists so
 * `ShippedFace.family` and the `family` parameters of `shipsFamily`/`shipsWeight` cannot silently
 * accept a raw, un-normalised string (see the module doc comment's normalisation-mismatch
 * warning) — the compiler now enforces what used to be prose only. `ObservedElement.family` is
 * deliberately NOT this type: it is raw browser output and must be normalised before comparison,
 * never assumed pre-normalised. */
export type NormalizedFamily = string & { readonly __brand: 'NormalizedFamily' };

/** One `@font-face` this build ships, reduced to what coverage needs: the normalised family name
 * (see `normalizeFamily`) and the weight range it covers (`weightMin === weightMax` for a
 * single-value `font-weight`). INVARIANT: `weightMin <= weightMax`. `parseFontFaces` always
 * upholds it (it derives both from `Math.min`/`Math.max` over the same non-empty number list), but
 * this interface is public and the module doc comment explicitly invites hand-constructed faces —
 * `shipsWeight` guards against a caller violating it (see its own doc comment). */
export interface ShippedFace {
  family: NormalizedFamily;
  weightMin: number;
  weightMax: number;
}

/** One element a consumer's browser sweep observed on a built page, reduced to the resolved
 * `font-family`/`font-weight` pair `getComputedStyle` reported for it. `family` is NOT assumed to
 * be pre-normalised — run it through `normalizeFamily` before comparing. */
export interface ObservedElement {
  tag: string;
  className: string;
  family: string;
  weight: number;
}

/** One element whose resolved family IS shipped by this build, but at a weight no shipped face
 * for that family covers. */
export interface FontUsageViolation {
  route: string;
  tag: string;
  className: string;
  family: string;
  weight: number;
  detail: string;
}

/** Family-name comparison per CSS Fonts §2.1: trim, strip one layer of surrounding quotes, trim
 * again, ASCII-lowercase. Both the shipped set and every observed value MUST be run through this
 * SAME function — see the module doc comment for why a mismatch silently defeats a same-family
 * match. */
export function normalizeFamily(family: string): NormalizedFamily {
  return family
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .trim()
    .toLowerCase() as NormalizedFamily;
}

/** One `@font-face` block body's parsed `family`/`weightMin`/`weightMax`, or `undefined` when the
 * block has no parsable `font-family` or `font-weight` — the caller SKIPS an `undefined` result
 * rather than defaulting it (see module doc comment). */
function parseFontFaceBody(body: string): ShippedFace | undefined {
  const familyRaw = /font-family\s*:\s*([^;]+);?/.exec(body)?.[1];
  const weightRaw = /font-weight\s*:\s*([^;]+);?/.exec(body)?.[1];
  if (familyRaw === undefined || weightRaw === undefined) return undefined;

  const family = normalizeFamily(familyRaw.split(',')[0] ?? '');
  if (family === '') return undefined;

  const numbers = weightRaw
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  if (numbers.length === 0) return undefined;

  return { family, weightMin: Math.min(...numbers), weightMax: Math.max(...numbers) };
}

/** Every `@font-face` declared in `css`, as `{family, weightMin, weightMax}` — see the module doc
 * comment's SEMANTICS section for the parsing rules (variable-weight ranges, first-family-only,
 * skip-don't-default, comment stripping). */
export function parseFontFaces(css: string): ShippedFace[] {
  const stripped = stripComments(css);
  const faces: ShippedFace[] = [];
  for (const block of stripped.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const face = parseFontFaceBody(block[1] ?? '');
    if (face !== undefined) faces.push(face);
  }
  return faces;
}

/** Is `family` (already normalised) one this build ships ANY face for? A family we ship nothing
 * for is never a violation, regardless of weight — it is not ours to ship. */
export function shipsFamily(family: NormalizedFamily, faces: readonly ShippedFace[]): boolean {
  return faces.some((f) => f.family === family);
}

/** Does some shipped face for `family` (already normalised) cover `weight`, inclusive at both
 * `weightMin` and `weightMax`? Guards `f.weightMin <= f.weightMax` before testing the range: a
 * hand-constructed `ShippedFace` (the module doc comment explicitly invites those) with an
 * inverted range describes an empty interval, so it covers nothing — that is the documented,
 * intentional result of the guard, not a bug to fix by throwing (a pure predicate should not
 * throw) or by adding a second branded type (rejected: disproportionate for a range only
 * hand-built input can invert). */
export function shipsWeight(
  family: NormalizedFamily,
  weight: number,
  faces: readonly ShippedFace[],
): boolean {
  return faces.some(
    (f) =>
      f.family === family &&
      f.weightMin <= f.weightMax &&
      weight >= f.weightMin &&
      weight <= f.weightMax,
  );
}

/** One violation, formatted for CI output — every built-page-derived field sanitised
 * (`sanitizeTagText`, `./scan.ts`) so a crafted class name or family string cannot forge a line
 * that reads like this gate's own output. */
function formatDetail(
  route: string,
  tag: string,
  className: string,
  family: string,
  weight: number,
): string {
  const safeRoute = sanitizeTagText(route);
  const safeTag = sanitizeTagText(tag);
  const safeFamily = sanitizeTagText(family);
  const cls = className.trim() === '' ? '' : `.${sanitizeTagText(className).replace(/\s+/g, '.')}`;
  return `${safeRoute}: <${safeTag}${cls}> renders ${safeFamily} | ${weight} — no shipped @font-face covers that pair`;
}

/**
 * For each observed element on `route`: normalise its family; if this build ships nothing for
 * that family, it is not a violation (skip); if it ships the family but no shipped face covers
 * `weight`, it IS a violation. `shipsFamily` is re-checked here defensively — see the module doc
 * comment — so this function is correct for any caller, not only one whose collector already
 * pre-filtered to shipped families.
 */
export function findUnshippedFontUsage(
  route: string,
  elements: readonly ObservedElement[],
  faces: readonly ShippedFace[],
): FontUsageViolation[] {
  const violations: FontUsageViolation[] = [];
  for (const el of elements) {
    const family = normalizeFamily(el.family);
    if (!shipsFamily(family, faces)) continue;
    if (shipsWeight(family, el.weight, faces)) continue;
    violations.push({
      route,
      tag: el.tag,
      className: el.className,
      family: el.family,
      weight: el.weight,
      detail: formatDetail(route, el.tag, el.className, el.family, el.weight),
    });
  }
  return violations;
}

/**
 * The single source of truth for which `object-fit` values reshape an image without distortion.
 *
 * This exists because the same fact is easy to encode in several separate shapes: an inclusion
 * list in one gate, an inequality against `'fill'` in another, a hardcoded array in a test,
 * with nothing tying them together. They agree only because CSS happens to define exactly five
 * keywords, so "not fill" and "the other four" are accidentally equivalent. Edit any one of
 * them and two gates silently disagree about which images are deliberately cropped, with no
 * mechanism to notice. One list, one predicate, nothing else.
 */

/** Every value `object-fit` can compute to. Browsers normalise to exactly these five. */
export type ObjectFit = 'fill' | 'contain' | 'cover' | 'none' | 'scale-down';

/**
 * The fits that make a box of a different shape intentional.
 *
 * `fill` is absent deliberately: it is the one value that scales the axes independently, and
 * it is also the CSS initial value — which is why distortion is the DEFAULT here and has to
 * be designed away rather than introduced by mistake. Declaring `object-fit: fill` on a
 * mismatched box does not make the squash intentional, it only spells it out.
 *
 * Deliberately no companion constant (`DISTORTING_FIT = 'fill'`) beside this list: it would
 * be a second "source of truth" inside the very module written to stop facts being stated in
 * more than one place. One list, one predicate, nothing else.
 */
export const NON_DISTORTING_FITS: readonly ObjectFit[] = ['contain', 'cover', 'none', 'scale-down'];

/**
 * Would this computed `object-fit` distort a picture placed in a box of the wrong shape?
 *
 * Takes a `string` rather than an `ObjectFit` on purpose: every caller gets its value from
 * outside the type system — `getComputedStyle` in a browser, or a regex over built CSS — so
 * an unknown value is representable in practice. An unrecognised value is treated as
 * DISTORTING, which fails closed: a fit this module has not learned about must never
 * silently excuse a stretched image.
 */
export function isDistortingFit(value: string): boolean {
  return !NON_DISTORTING_FITS.includes(value as ObjectFit);
}

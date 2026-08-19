import type { SizeEntry } from './types.ts';

const ROOT_FONT_PX = 16;

/** px, em and rem only. Anything else has no fixed order against the others, so it is rejected. */
function toPx(minWidth: string): number {
  const match = /^([\d.]+)(px|em|rem)$/.exec(minWidth.trim());
  if (!match) throw new Error(`buildSizes: unsupported unit in "${minWidth}" (use px, em or rem)`);
  const value = Number(match[1]);
  return match[2] === 'px' ? value : value * ROOT_FONT_PX;
}

/**
 * Build a `sizes` attribute, mobile-first (D7).
 *
 * `sizes` is evaluated left to right and the FIRST matching condition wins, so the conditions must
 * descend and the unconditional mobile value must come last. Getting that order wrong does not
 * error in a browser — it silently selects the wrong `srcset` candidate — which is exactly why it
 * is enforced here instead of documented in a comment.
 */
export function buildSizes(entries: readonly SizeEntry[]): string {
  if (entries.length === 0) throw new Error('buildSizes: entry list is empty');

  const last = entries[entries.length - 1];
  if (last === undefined || last.minWidth !== undefined) {
    throw new Error('buildSizes: the final entry must be unconditional (no minWidth)');
  }

  let previous = Number.POSITIVE_INFINITY;
  for (let i = 0; i < entries.length - 1; i++) {
    const entry = entries[i];
    if (entry === undefined) continue;
    if (entry.minWidth === undefined) {
      throw new Error(`buildSizes: only the final entry may be unconditional (index ${i})`);
    }
    const px = toPx(entry.minWidth);
    if (px >= previous) {
      throw new Error(
        `buildSizes: min-widths must be strictly descending; "${entry.minWidth}" follows a smaller one`,
      );
    }
    previous = px;
  }

  return entries
    .map((e) => (e.minWidth === undefined ? e.value : `(min-width: ${e.minWidth}) ${e.value}`))
    .join(', ');
}

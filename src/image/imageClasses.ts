import type { ImageClasses } from './types.ts';

function validateClassDef<K extends string>(name: K, def: ImageClasses<K>[K]): void {
  if (def.widths.length === 0) {
    throw new Error(`Image class "${name}" has an empty width ladder`);
  }
  for (let i = 1; i < def.widths.length; i++) {
    const prev = def.widths[i - 1];
    const cur = def.widths[i];
    if (prev === undefined || cur === undefined || cur <= prev) {
      throw new Error(`Image class "${name}" ladder must be strictly ascending`);
    }
  }
  const largest = def.widths[def.widths.length - 1];
  if (largest !== def.masterMin) {
    throw new Error(
      `Image class "${name}": largest rung ${largest} must equal masterMin ${def.masterMin}`,
    );
  }
}

function validateDirToClass<K extends string>(
  dirToClass: Record<string, K>,
  classes: ImageClasses<K>,
): void {
  for (const [dir, cls] of Object.entries(dirToClass) as Array<[string, K]>) {
    if (!(cls in classes)) {
      throw new Error(`Directory "${dir}" maps to unknown class "${cls}"`);
    }
  }
}

/**
 * Validate a class table and pair it with a path→class resolver.
 *
 * The ladder is a hard cap (D4): `max(widths)` must equal `masterMin`, so a class can never
 * request a rung its master is not required to satisfy. Validation happens here, at definition
 * time, because a bad table is a programming error and should not wait for an encode to surface.
 */
export function defineImageClasses<K extends string>(
  classes: ImageClasses<K>,
  dirToClass: Record<string, K>,
): { classes: ImageClasses<K>; classForPath: (path: string) => K } {
  for (const [name, def] of Object.entries(classes) as Array<[K, ImageClasses<K>[K]]>) {
    validateClassDef(name, def);
  }
  validateDirToClass(dirToClass, classes);

  /**
   * Scans directory segments from the LAST to the first, so a nested tree
   * (`/static/image/webp/blog/deep/foo.jpg`) resolves on `blog` rather than on
   * whatever happens to sit at a fixed index. Throws on a miss: silently defaulting an
   * unmapped directory is how an avatar acquires a hero ladder.
   */
  function classForPath(path: string): K {
    const segments = path.split('/').filter(Boolean);
    const dirs = segments.slice(0, -1);
    for (let i = dirs.length - 1; i >= 0; i--) {
      const seg = dirs[i];
      if (seg !== undefined && seg in dirToClass) {
        const cls = dirToClass[seg];
        if (cls !== undefined) return cls;
      }
    }
    throw new Error(`No image class for path: ${path}`);
  }

  return { classes, classForPath };
}

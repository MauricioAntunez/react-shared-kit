import type { ImageManifest, Rung } from './types.ts';

/** Vector sources pass through untouched: SVG scales from one file, so it is never rasterised. */
const VECTOR_RE = /\.svgz?(\?|#|$)/i;

/**
 * Two failure modes to avoid at once, and the obvious guard hits the second one.
 *
 * A bare `process.env.NODE_ENV` throws a ReferenceError wherever `process` is undefined, and it
 * sits on the MISSING-ENTRY branch — so the benign degrade this component promises ("never blank a
 * page") becomes a hard render failure. But guarding with `typeof process !== 'undefined'` is
 * WORSE: bundlers substitute the `process.env.NODE_ENV` define, yet cannot fold `typeof process`,
 * so in a browser the guard is false at runtime, `isProduction()` returns false in production, and
 * the warning ships to every end user forever. Measured against a real Vite 8 production build.
 *
 * The member access must therefore stay bare, so `define` substitution still applies, with the
 * ReferenceError caught. It fails to `true` — silence — because a library that cannot tell which
 * environment it is in should not shout at end users.
 */
function isProduction(): boolean {
  try {
    return process.env.NODE_ENV === 'production';
  } catch {
    return true;
  }
}

export interface PictureProps {
  /** The manifest emitted by `optimizeImages`. */
  manifest: ImageManifest;
  /** Public-style path of the MASTER, e.g. `/images/blog/foo.jpg`. */
  src: string;
  alt: string;
  /**
   * REQUIRED. An omitted `sizes` lets the browser assume 100vw and fetch the largest candidate for
   * a box of unknown width — the exact regression this module exists to prevent.
   */
  sizes: string;
  /**
   * `true` for the LCP image. Flips to `loading="eager"` + `fetchpriority="high"`; lazy-loading a
   * hero delays its request until layout, which is the wrong trade on a phone.
   */
  priority?: boolean | undefined;
  className?: string | undefined;
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx + 1);
}

function srcsetFor(dir: string, rungs: readonly Rung[], format: keyof Rung['files']): string {
  return rungs.map((r) => `${dir}${r.files[format]} ${r.w}w`).join(', ');
}

/**
 * A responsive image: AVIF → WebP → JPEG (D9), with AVIF always first (D11).
 *
 * No CSS, no caption, no credits — those are app design-system concerns. Wrap this component
 * rather than extending it.
 */
export function Picture({ manifest, src, alt, sizes, priority = false, className }: PictureProps) {
  const entry = manifest[src];
  const loading = priority ? 'eager' : 'lazy';
  /*
   * camelCase `fetchPriority`, NOT a lowercase spread.
   *
   * React 19 renders this prop verbatim as `fetchPriority="high"`, which looks wrong but is not:
   * HTML attribute names are ASCII case-insensitive, so the parser reads it as `fetchpriority`.
   * The lowercase spread costs two real things — it trips React's "Invalid DOM property" warning
   * on every render, and it suppresses the `<link rel="preload" as="image" fetchPriority="high">`
   * React emits automatically for the camelCase form. That preload is precisely the LCP-discovery
   * win `priority` exists to buy, so spreading the lowercase name would quietly defeat the prop.
   * Verified against react-dom 19.2.8 (2026-08-19).
   */
  const fetchPriority = priority ? 'high' : 'auto';

  // Unknown src: degrade rather than crash — a missing derivative must never blank a page.
  //
  // But the degrade is genuinely lossy: no width/height, so the layout shift this component
  // exists to prevent comes back, and the unoptimized master ships. `verifyImages` catches a
  // master missing from the manifest, but it CANNOT see a call site naming a path that does not
  // exist at all (a typo, or a wrongly-rooted src) — it iterates the manifest, not the callers.
  // Hence the dev-only warning: it is the only signal available for that case.
  if (!entry || entry.rungs.length === 0) {
    // A vector source has no manifest entry BY DESIGN: SVG scales to any size from one file, so
    // rasterising it into a width ladder would be a downgrade, and optimizeImages never treats it
    // as a master. Warning about it would cry wolf on every correct usage.
    if (!VECTOR_RE.test(src) && !isProduction()) {
      console.warn(
        `[react-shared-kit] Picture: no manifest entry for "${src}" — serving the unoptimized ` +
          `master with no intrinsic dimensions. Check the path, or re-run optimizeImages.`,
      );
    }
    return (
      <img
        src={src}
        alt={alt}
        className={className}
        loading={loading}
        fetchPriority={fetchPriority}
        decoding="async"
      />
    );
  }

  const dir = dirOf(src);
  const rungs = [...entry.rungs].sort((a, b) => a.w - b.w);
  const smallest = rungs[0];
  if (smallest === undefined) throw new Error(`Picture: empty rung list for ${src}`);

  return (
    <picture className={className}>
      <source type="image/avif" srcSet={srcsetFor(dir, rungs, 'avif')} sizes={sizes} />
      <source type="image/webp" srcSet={srcsetFor(dir, rungs, 'webp')} sizes={sizes} />
      <img
        src={`${dir}${smallest.files.jpeg}`}
        alt={alt}
        width={entry.w}
        height={entry.h}
        sizes={sizes}
        loading={loading}
        fetchPriority={fetchPriority}
        decoding="async"
      />
    </picture>
  );
}

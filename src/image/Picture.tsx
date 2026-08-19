import type { ImageManifest, Rung } from './types.ts';

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
  priority?: boolean;
  className?: string;
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

  // Unknown src: degrade rather than crash. A missing derivative must never blank a page —
  // `verifyImages` is what makes the miss loud, at build time.
  if (!entry || entry.rungs.length === 0) {
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

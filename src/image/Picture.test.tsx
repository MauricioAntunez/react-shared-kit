import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Picture } from './Picture.tsx';
import type { ImageManifest } from './types.ts';

const MANIFEST: ImageManifest = {
  '/images/blog/foo.jpg': {
    w: 1600,
    h: 900,
    class: 'content',
    rungs: [
      { w: 480, files: { avif: 'foo-480.avif', webp: 'foo-480.webp', jpeg: 'foo-480.jpg' } },
      { w: 1024, files: { avif: 'foo-1024.avif', webp: 'foo-1024.webp', jpeg: 'foo-1024.jpg' } },
    ],
  },
};

const render = (el: ReactElement) => renderToStaticMarkup(el);

describe('Picture', () => {
  it('lists AVIF BEFORE WebP — AVIF-first is unconditional (D11)', () => {
    const html = render(
      <Picture manifest={MANIFEST} src="/images/blog/foo.jpg" alt="A post" sizes="100vw" />,
    );
    expect(html.indexOf('image/avif')).toBeLessThan(html.indexOf('image/webp'));
    expect(html.indexOf('image/avif')).toBeGreaterThan(-1);
  });

  it('uses the SMALLEST rung as the img src (mobile-first, D7)', () => {
    const html = render(
      <Picture manifest={MANIFEST} src="/images/blog/foo.jpg" alt="A post" sizes="100vw" />,
    );
    expect(html).toContain('src="/images/blog/foo-480.jpg"');
    expect(html).not.toContain('src="/images/blog/foo-1024.jpg"');
  });

  it('builds srcset descriptors from the MEASURED rung widths', () => {
    const html = render(
      <Picture manifest={MANIFEST} src="/images/blog/foo.jpg" alt="A post" sizes="100vw" />,
    );
    expect(html).toContain('/images/blog/foo-480.avif 480w');
    expect(html).toContain('/images/blog/foo-1024.avif 1024w');
  });

  it('emits intrinsic width and height for CLS', () => {
    const html = render(
      <Picture manifest={MANIFEST} src="/images/blog/foo.jpg" alt="A post" sizes="100vw" />,
    );
    expect(html).toContain('width="1600"');
    expect(html).toContain('height="900"');
  });

  it('is lazy by default', () => {
    const html = render(
      <Picture manifest={MANIFEST} src="/images/blog/foo.jpg" alt="A post" sizes="100vw" />,
    );
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
  });

  it('priority flips to eager + fetchpriority=high for the LCP image', () => {
    const html = render(
      <Picture manifest={MANIFEST} src="/images/blog/foo.jpg" alt="A" sizes="100vw" priority />,
    );
    expect(html).toContain('loading="eager"');
    // Case-insensitive on purpose: React 19 emits camelCase `fetchPriority`, and HTML attribute
    // names are case-insensitive, so both spellings are correct output. Asserting the exact
    // lowercase string would fail a correct component and push the fix into the wrong file.
    expect(html).toMatch(/fetchpriority="high"/i);
  });

  it('degrades to a plain img on an unknown src rather than throwing', () => {
    const html = render(
      <Picture manifest={MANIFEST} src="/images/blog/missing.jpg" alt="Gone" sizes="100vw" />,
    );
    expect(html).not.toContain('<picture');
    expect(html).toContain('src="/images/blog/missing.jpg"');
    expect(html).toContain('alt="Gone"');
  });

  it('passes an SVG through as a plain img WITHOUT warning — vectors are not rasterised', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const html = render(
      <Picture manifest={MANIFEST} src="/logos/mark.svg" alt="Logo" sizes="100vw" />,
    );
    expect(html).toContain('src="/logos/mark.svg"');
    expect(html).not.toContain('<picture');
    // An SVG has no manifest entry by design; warning here would fire on every correct usage.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('DOES warn for a raster src that is missing from the manifest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(<Picture manifest={MANIFEST} src="/images/blog/typo.jpg" alt="x" sizes="100vw" />);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('passes sizes through to every source and the img', () => {
    const html = render(
      <Picture manifest={MANIFEST} src="/images/blog/foo.jpg" alt="A" sizes="50vw" />,
    );
    expect(html.match(/sizes="50vw"/g)?.length).toBe(3);
  });
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyFontPreload } from './fontPreload.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uxr-font-preload-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const file = join(root, name);
  writeFileSync(file, content);
  return file;
}

/** Standard resolver: strips a leading `/`, joins onto `root`, and fails closed for an empty
 * href — matching cssBudget.test.ts's convention. */
function resolveHref(href: string): string | undefined {
  if (href === '') return undefined;
  return join(root, href.replace(/^\//, ''));
}

const PRELOAD_ONE =
  '<link rel="preload" as="font" href="/one.woff2" crossorigin type="font/woff2">';

describe('verifyFontPreload', () => {
  it('passes clean for a multi-document build with faces in cssFiles', () => {
    write('one.woff2', 'font-bytes');
    const css = write(
      'bundle.css',
      '@font-face { font-family: A; src: url(/one.woff2) format("woff2"); }',
    );
    const a = write('a.html', `<html><head>${PRELOAD_ONE}</head></html>`);
    const b = write('b.html', `<html><head>${PRELOAD_ONE}</head></html>`);

    const result = verifyFontPreload({
      htmlFiles: [a, b],
      cssFiles: [css],
      resolveHref,
      expectedFacesPerDocument: 1,
    });

    expect(result).toEqual({ ok: true, problems: [] });
  });

  it('passes clean with faces declared inline in <style>', () => {
    write('one.woff2', 'font-bytes');
    const html = write(
      'index.html',
      `<html><head><style>@font-face { font-family: A; src: url(/one.woff2) format("woff2"); }</style>${PRELOAD_ONE}</head></html>`,
    );

    const result = verifyFontPreload({
      htmlFiles: [html],
      cssFiles: [],
      resolveHref,
      expectedFacesPerDocument: 1,
    });

    expect(result).toEqual({ ok: true, problems: [] });
  });

  it('reports font-preload-missing naming the one document with the preload removed', () => {
    write('one.woff2', 'font-bytes');
    const css = write(
      'bundle.css',
      '@font-face { font-family: A; src: url(/one.woff2) format("woff2"); }',
    );
    const clean = write('a.html', `<html><head>${PRELOAD_ONE}</head></html>`);
    const broken = write('b.html', '<html><head></head></html>');

    const result = verifyFontPreload({
      htmlFiles: [clean, broken],
      cssFiles: [css],
      resolveHref,
      expectedFacesPerDocument: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'font-preload-missing', html: broken, href: '/one.woff2' }),
      ]),
    );
    expect(result.problems.some((p) => p.kind === 'font-preload-missing' && p.html === clean)).toBe(
      false,
    );
  });

  it('reports font-preload-wrong-crossorigin for crossorigin="use-credentials"', () => {
    write('one.woff2', 'font-bytes');
    const css = write(
      'bundle.css',
      '@font-face { font-family: A; src: url(/one.woff2) format("woff2"); }',
    );
    const html = write(
      'index.html',
      '<html><head><link rel="preload" as="font" href="/one.woff2" crossorigin="use-credentials" type="font/woff2"></head></html>',
    );

    const result = verifyFontPreload({
      htmlFiles: [html],
      cssFiles: [css],
      resolveHref,
      expectedFacesPerDocument: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({
        kind: 'font-preload-wrong-crossorigin',
        html,
        href: '/one.woff2',
        crossorigin: 'use-credentials',
      }),
    ]);
  });

  it('normalises a bare crossorigin to anonymous — no problem reported', () => {
    write('one.woff2', 'font-bytes');
    const css = write(
      'bundle.css',
      '@font-face { font-family: A; src: url(/one.woff2) format("woff2"); }',
    );
    const html = write(
      'index.html',
      '<html><head><link rel="preload" as="font" href="/one.woff2" crossorigin type="font/woff2"></head></html>',
    );

    const result = verifyFontPreload({
      htmlFiles: [html],
      cssFiles: [css],
      resolveHref,
      expectedFacesPerDocument: 0,
    });

    expect(result).toEqual({ ok: true, problems: [] });
  });

  it('reports font-preload-wrong-crossorigin when crossorigin is absent entirely', () => {
    write('one.woff2', 'font-bytes');
    const css = write(
      'bundle.css',
      '@font-face { font-family: A; src: url(/one.woff2) format("woff2"); }',
    );
    const html = write(
      'index.html',
      '<html><head><link rel="preload" as="font" href="/one.woff2" type="font/woff2"></head></html>',
    );

    const result = verifyFontPreload({
      htmlFiles: [html],
      cssFiles: [css],
      resolveHref,
      expectedFacesPerDocument: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({
        kind: 'font-preload-wrong-crossorigin',
        href: '/one.woff2',
        crossorigin: undefined,
      }),
    ]);
  });

  it('reports font-preload-wrong-type for type="font/woff"', () => {
    write('one.woff2', 'font-bytes');
    const css = write(
      'bundle.css',
      '@font-face { font-family: A; src: url(/one.woff2) format("woff2"); }',
    );
    const html = write(
      'index.html',
      '<html><head><link rel="preload" as="font" href="/one.woff2" crossorigin type="font/woff"></head></html>',
    );

    const result = verifyFontPreload({
      htmlFiles: [html],
      cssFiles: [css],
      resolveHref,
      expectedFacesPerDocument: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({
        kind: 'font-preload-wrong-type',
        href: '/one.woff2',
        type: 'font/woff',
      }),
    ]);
  });

  it('reports font-preload-missing for a face in a non-entry cssFiles chunk with no preload', () => {
    write('graph.woff2', 'font-bytes');
    const entryCss = write(
      'root.css',
      '@font-face { font-family: A; src: url(/root.woff2) format("woff2"); }',
    );
    write('root.woff2', 'font-bytes');
    const chunkCss = write(
      'graph.css',
      '@font-face { font-family: B; src: url(/graph.woff2) format("woff2"); }',
    );
    const html = write(
      'index.html',
      '<html><head><link rel="preload" as="font" href="/root.woff2" crossorigin type="font/woff2"></head></html>',
    );

    const result = verifyFontPreload({
      htmlFiles: [html],
      cssFiles: [entryCss, chunkCss],
      resolveHref,
      expectedFacesPerDocument: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'font-preload-missing', html, href: '/graph.woff2' }),
      ]),
    );
  });

  it('treats a preload wrapped in an HTML comment as absent', () => {
    write('one.woff2', 'font-bytes');
    const css = write(
      'bundle.css',
      '@font-face { font-family: A; src: url(/one.woff2) format("woff2"); }',
    );
    const html = write('index.html', `<html><head><!-- ${PRELOAD_ONE} --></head></html>`);

    const result = verifyFontPreload({
      htmlFiles: [html],
      cssFiles: [css],
      resolveHref,
      expectedFacesPerDocument: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'font-preload-missing', html, href: '/one.woff2' }),
      ]),
    );
  });

  it('does not count a preload-shaped string literal inside a <script> body as a real preload', () => {
    write('one.woff2', 'font-bytes');
    const css = write(
      'bundle.css',
      '@font-face { font-family: A; src: url(/one.woff2) format("woff2"); }',
    );
    const html = write(
      'index.html',
      `<html><head><script>var x = '${PRELOAD_ONE}';</script></head></html>`,
    );

    const result = verifyFontPreload({
      htmlFiles: [html],
      cssFiles: [css],
      resolveHref,
      expectedFacesPerDocument: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'font-preload-missing', html, href: '/one.woff2' }),
      ]),
    );
  });

  it('does not count a preload-shaped string literal inside a <style> body as a real preload', () => {
    write('one.woff2', 'font-bytes');
    const css = write(
      'bundle.css',
      '@font-face { font-family: A; src: url(/one.woff2) format("woff2"); }',
    );
    const html = write(
      'index.html',
      `<html><head><style>content: "${PRELOAD_ONE}";</style></head></html>`,
    );

    const result = verifyFontPreload({
      htmlFiles: [html],
      cssFiles: [css],
      resolveHref,
      expectedFacesPerDocument: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'font-preload-missing', html, href: '/one.woff2' }),
      ]),
    );
  });

  it('still finds a real @font-face inside an inline <style> (proves the unblanked view is used for CSS scanning)', () => {
    write('one.woff2', 'font-bytes');
    const html = write(
      'index.html',
      `<html><head><style>@font-face { font-family: A; src: url(/one.woff2) format("woff2"); }</style>${PRELOAD_ONE}</head></html>`,
    );

    const result = verifyFontPreload({
      htmlFiles: [html],
      cssFiles: [],
      resolveHref,
      expectedFacesPerDocument: 1,
    });

    expect(result).toEqual({ ok: true, problems: [] });
  });

  it('reports red (no-faces), not a vacuous pass, when the <style> block is stripped from ALL documents', () => {
    const a = write('a.html', '<html><head></head></html>');
    const b = write('b.html', '<html><head></head></html>');

    const result = verifyFontPreload({
      htmlFiles: [a, b],
      cssFiles: [],
      resolveHref,
      expectedFacesPerDocument: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([expect.objectContaining({ kind: 'no-faces' })]);
  });

  it('reports red naming the ONE document whose <style> block was stripped, out of several', () => {
    write('one.woff2', 'font-bytes');
    const faceStyle = `<style>@font-face { font-family: A; src: url(/one.woff2) format("woff2"); }</style>`;
    const good1 = write('a.html', `<html><head>${faceStyle}${PRELOAD_ONE}</head></html>`);
    const good2 = write('b.html', `<html><head>${faceStyle}${PRELOAD_ONE}</head></html>`);
    const stripped = write('c.html', '<html><head></head></html>');

    const result = verifyFontPreload({
      htmlFiles: [good1, good2, stripped],
      cssFiles: [],
      resolveHref,
      expectedFacesPerDocument: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'under-declared-faces',
          html: stripped,
          count: 0,
          expected: 1,
        }),
      ]),
    );
    expect(
      result.problems.some((p) => p.kind === 'under-declared-faces' && p.html !== stripped),
    ).toBe(false);
  });

  it('reports unresolvable-font-file for a face URL that does not resolve', () => {
    const css = write(
      'bundle.css',
      '@font-face { font-family: A; src: url(/missing.woff2) format("woff2"); }',
    );
    const html = write('index.html', '<html><head></head></html>');

    const result = verifyFontPreload({
      htmlFiles: [html],
      cssFiles: [css],
      resolveHref: () => undefined,
      expectedFacesPerDocument: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'unresolvable-font-file', href: '/missing.woff2' }),
      ]),
    );
  });

  it('reports face-without-woff2 for a @font-face with only a .woff src', () => {
    const css = write(
      'bundle.css',
      '@font-face { font-family: A; src: url(/one.woff) format("woff"); }',
    );
    const html = write('index.html', '<html><head></head></html>');

    const result = verifyFontPreload({
      htmlFiles: [html],
      cssFiles: [css],
      resolveHref,
      expectedFacesPerDocument: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'face-without-woff2', source: css }),
      ]),
    );
  });

  it('reports BOTH font-preload-duplicate and font-preload-wrong-crossorigin when the FIRST of two same-href tags lacks crossorigin', () => {
    write('one.woff2', 'font-bytes');
    const css = write(
      'bundle.css',
      '@font-face { font-family: A; src: url(/one.woff2) format("woff2"); }',
    );
    const brokenFirst = '<link rel="preload" as="font" href="/one.woff2" type="font/woff2">';
    const html = write('index.html', `<html><head>${brokenFirst}${PRELOAD_ONE}</head></html>`);

    const result = verifyFontPreload({
      htmlFiles: [html],
      cssFiles: [css],
      resolveHref,
      expectedFacesPerDocument: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'font-preload-duplicate', href: '/one.woff2', count: 2 }),
        expect.objectContaining({
          kind: 'font-preload-wrong-crossorigin',
          href: '/one.woff2',
          crossorigin: undefined,
        }),
      ]),
    );
  });

  it('aggregates 50 copies of one stray unpaired href into exactly one problem carrying count: 50', () => {
    write('one.woff2', 'font-bytes');
    const css = write(
      'bundle.css',
      '@font-face { font-family: A; src: url(/one.woff2) format("woff2"); }',
    );
    const strayCopies = Array.from(
      { length: 50 },
      () => '<link rel="preload" as="font" href="/stray.woff2" crossorigin type="font/woff2">',
    ).join('');
    const html = write('index.html', `<html><head>${PRELOAD_ONE}${strayCopies}</head></html>`);

    const result = verifyFontPreload({
      htmlFiles: [html],
      cssFiles: [css],
      resolveHref,
      expectedFacesPerDocument: 0,
    });

    expect(result.ok).toBe(false);
    const unpaired = result.problems.filter((p) => p.kind === 'font-preload-unpaired');
    expect(unpaired).toEqual([
      expect.objectContaining({ kind: 'font-preload-unpaired', href: '/stray.woff2', count: 50 }),
    ]);
  });

  it('reports empty-input for an empty htmlFiles list', () => {
    const result = verifyFontPreload({
      htmlFiles: [],
      cssFiles: [],
      resolveHref,
      expectedFacesPerDocument: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([expect.objectContaining({ kind: 'empty-input' })]);
  });

  it('throws TypeError naming resolveHref when the resolver returns a non-string', () => {
    const css = write(
      'bundle.css',
      '@font-face { font-family: A; src: url(/one.woff2) format("woff2"); }',
    );
    const html = write('index.html', '<html><head></head></html>');
    // biome-ignore lint/suspicious/noExplicitAny: deliberately violating the resolver contract
    const badResolver = ((href: string) => new URL(`https://cdn.example.com${href}`)) as any;

    let caught: unknown;
    try {
      verifyFontPreload({
        htmlFiles: [html],
        cssFiles: [css],
        resolveHref: badResolver,
        expectedFacesPerDocument: 0,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toContain('resolveHref');
  });
});

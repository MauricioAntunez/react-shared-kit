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

/** `<link rel="stylesheet" href="...">` tag text — the signal `attributeLinkedCssFaces` requires
 * before a `cssFiles` entry's faces are attributed to a document (PR #8 CRITICAL finding). */
function stylesheetLink(href: string): string {
  return `<link rel="stylesheet" href="${href}">`;
}

const STYLESHEET_BUNDLE = stylesheetLink('/bundle.css');

describe('verifyFontPreload', () => {
  it('passes clean for a multi-document build with faces in cssFiles', () => {
    write('one.woff2', 'font-bytes');
    const css = write(
      'bundle.css',
      '@font-face { font-family: A; src: url(/one.woff2) format("woff2"); }',
    );
    const a = write('a.html', `<html><head>${STYLESHEET_BUNDLE}${PRELOAD_ONE}</head></html>`);
    const b = write('b.html', `<html><head>${STYLESHEET_BUNDLE}${PRELOAD_ONE}</head></html>`);

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
    const clean = write('a.html', `<html><head>${STYLESHEET_BUNDLE}${PRELOAD_ONE}</head></html>`);
    const broken = write('b.html', `<html><head>${STYLESHEET_BUNDLE}</head></html>`);

    const result = verifyFontPreload({
      htmlFiles: [clean, broken],
      cssFiles: [css],
      resolveHref,
      expectedFacesPerDocument: 1,
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
      `<html><head>${STYLESHEET_BUNDLE}<link rel="preload" as="font" href="/one.woff2" crossorigin="use-credentials" type="font/woff2"></head></html>`,
    );

    const result = verifyFontPreload({
      htmlFiles: [html],
      cssFiles: [css],
      resolveHref,
      expectedFacesPerDocument: 1,
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
      `<html><head>${STYLESHEET_BUNDLE}<link rel="preload" as="font" href="/one.woff2" crossorigin type="font/woff2"></head></html>`,
    );

    const result = verifyFontPreload({
      htmlFiles: [html],
      cssFiles: [css],
      resolveHref,
      expectedFacesPerDocument: 1,
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
      `<html><head>${STYLESHEET_BUNDLE}<link rel="preload" as="font" href="/one.woff2" type="font/woff2"></head></html>`,
    );

    const result = verifyFontPreload({
      htmlFiles: [html],
      cssFiles: [css],
      resolveHref,
      expectedFacesPerDocument: 1,
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
      `<html><head>${STYLESHEET_BUNDLE}<link rel="preload" as="font" href="/one.woff2" crossorigin type="font/woff"></head></html>`,
    );

    const result = verifyFontPreload({
      htmlFiles: [html],
      cssFiles: [css],
      resolveHref,
      expectedFacesPerDocument: 1,
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
      `<html><head>${stylesheetLink('/root.css')}${stylesheetLink('/graph.css')}<link rel="preload" as="font" href="/root.woff2" crossorigin type="font/woff2"></head></html>`,
    );

    const result = verifyFontPreload({
      htmlFiles: [html],
      cssFiles: [entryCss, chunkCss],
      resolveHref,
      expectedFacesPerDocument: 2,
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
    const html = write(
      'index.html',
      `<html><head>${STYLESHEET_BUNDLE}<!-- ${PRELOAD_ONE} --></head></html>`,
    );

    const result = verifyFontPreload({
      htmlFiles: [html],
      cssFiles: [css],
      resolveHref,
      expectedFacesPerDocument: 1,
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
      `<html><head>${STYLESHEET_BUNDLE}<script>var x = '${PRELOAD_ONE}';</script></head></html>`,
    );

    const result = verifyFontPreload({
      htmlFiles: [html],
      cssFiles: [css],
      resolveHref,
      expectedFacesPerDocument: 1,
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
      `<html><head>${STYLESHEET_BUNDLE}<style>content: "${PRELOAD_ONE}";</style></head></html>`,
    );

    const result = verifyFontPreload({
      htmlFiles: [html],
      cssFiles: [css],
      resolveHref,
      expectedFacesPerDocument: 1,
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
      expectedFacesPerDocument: 1,
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
      expectedFacesPerDocument: 1,
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
    const html = write(
      'index.html',
      `<html><head>${STYLESHEET_BUNDLE}${brokenFirst}${PRELOAD_ONE}</head></html>`,
    );

    const result = verifyFontPreload({
      htmlFiles: [html],
      cssFiles: [css],
      resolveHref,
      expectedFacesPerDocument: 1,
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
    const html = write(
      'index.html',
      `<html><head>${STYLESHEET_BUNDLE}${PRELOAD_ONE}${strayCopies}</head></html>`,
    );

    const result = verifyFontPreload({
      htmlFiles: [html],
      cssFiles: [css],
      resolveHref,
      expectedFacesPerDocument: 1,
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
        expectedFacesPerDocument: 1,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toContain('resolveHref');
  });

  describe('FINDING 1 — per-document attribution of cssFiles faces (PR #8 CRITICAL)', () => {
    it("reproduces the reviewer's exact fixture: b.html's lost own face is no longer invisible behind shared.css's global union", () => {
      write('shared-a.woff2', 'font-bytes');
      write('shared-b.woff2', 'font-bytes');
      const shared = write(
        'shared.css',
        '@font-face { font-family: A; src: url(/shared-a.woff2) format("woff2"); }\n' +
          '@font-face { font-family: B; src: url(/shared-b.woff2) format("woff2"); }',
      );
      const sharedPreloads =
        '<link rel="preload" as="font" href="/shared-a.woff2" crossorigin type="font/woff2">' +
        '<link rel="preload" as="font" href="/shared-b.woff2" crossorigin type="font/woff2">';
      write('own.woff2', 'font-bytes');

      // a.html: links shared.css AND declares its own inline face — the intact page.
      const a = write(
        'a.html',
        `<html><head>${stylesheetLink('/shared.css')}${sharedPreloads}` +
          '<style>@font-face { font-family: C; src: url(/own.woff2) format("woff2"); }</style>' +
          '<link rel="preload" as="font" href="/own.woff2" crossorigin type="font/woff2">' +
          '</head></html>',
      );
      // b.html: carries the SAME copy-pasted shared preload boilerplate, but neither links
      // shared.css nor has any inline <style> of its own — the exact loss the reviewer
      // reproduced, and the one a build-wide union over cssFiles could not see.
      const b = write('b.html', `<html><head>${sharedPreloads}</head></html>`);

      const result = verifyFontPreload({
        htmlFiles: [a, b],
        cssFiles: [shared],
        resolveHref,
        expectedFacesPerDocument: 2,
      });

      expect(result.ok).toBe(false);
      expect(
        result.problems.some(
          (p) =>
            p.kind === 'under-declared-faces' && p.html === b && p.count === 0 && p.expected === 2,
        ),
      ).toBe(true);
      expect(result.problems.some((p) => 'html' in p && p.html === a)).toBe(false);
    });

    it("a document that does NOT link a given cssFiles chunk does not inherit that chunk's faces", () => {
      write('chunk.woff2', 'font-bytes');
      const chunk = write(
        'chunk.css',
        '@font-face { font-family: A; src: url(/chunk.woff2) format("woff2"); }',
      );
      // The document carries a preload for the chunk's face but never links the stylesheet — the
      // face must not be attributed, so the preload has nothing to pair with.
      const html = write(
        'index.html',
        '<html><head><link rel="preload" as="font" href="/chunk.woff2" crossorigin type="font/woff2"></head></html>',
      );

      const result = verifyFontPreload({
        htmlFiles: [html],
        cssFiles: [chunk],
        resolveHref,
        expectedFacesPerDocument: 1,
      });

      expect(result.ok).toBe(false);
      expect(result.problems).toEqual([
        expect.objectContaining({
          kind: 'under-declared-faces',
          html,
          count: 0,
          expected: 1,
        }),
        expect.objectContaining({
          kind: 'font-preload-unpaired',
          html,
          href: '/chunk.woff2',
          count: 1,
        }),
      ]);
    });

    it('a document that DOES link a cssFiles chunk correctly inherits its faces and passes', () => {
      write('chunk.woff2', 'font-bytes');
      const chunk = write(
        'chunk.css',
        '@font-face { font-family: A; src: url(/chunk.woff2) format("woff2"); }',
      );
      const html = write(
        'index.html',
        `<html><head>${stylesheetLink('/chunk.css')}<link rel="preload" as="font" href="/chunk.woff2" crossorigin type="font/woff2"></head></html>`,
      );

      const result = verifyFontPreload({
        htmlFiles: [html],
        cssFiles: [chunk],
        resolveHref,
        expectedFacesPerDocument: 1,
      });

      expect(result).toEqual({ ok: true, problems: [] });
    });

    it('REGRESSION GUARD: cssFiles: [] with purely inline faces still passes exactly as before this fix', () => {
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

    it('an orphan cssFiles entry that no document links produces no problem of its own', () => {
      write('a.woff2', 'font-bytes');
      write('orphan.woff2', 'font-bytes');
      const used = write(
        'used.css',
        '@font-face { font-family: A; src: url(/a.woff2) format("woff2"); }',
      );
      const orphan = write(
        'orphan.css',
        '@font-face { font-family: B; src: url(/orphan.woff2) format("woff2"); }',
      );
      const html = write(
        'index.html',
        `<html><head>${stylesheetLink('/used.css')}<link rel="preload" as="font" href="/a.woff2" crossorigin type="font/woff2"></head></html>`,
      );

      const result = verifyFontPreload({
        htmlFiles: [html],
        cssFiles: [used, orphan],
        resolveHref,
        expectedFacesPerDocument: 1,
      });

      expect(result).toEqual({ ok: true, problems: [] });
    });

    it('a document linking a stylesheet absent from cssFiles reports unscanned-stylesheet, not a silent "no faces"', () => {
      write('known.woff2', 'font-bytes');
      const known = write(
        'known.css',
        '@font-face { font-family: A; src: url(/known.woff2) format("woff2"); }',
      );
      const html = write(
        'index.html',
        `<html><head>${stylesheetLink('/mystery.css')}</head></html>`,
      );

      const result = verifyFontPreload({
        htmlFiles: [html],
        cssFiles: [known],
        resolveHref,
        expectedFacesPerDocument: 1,
      });

      expect(result.ok).toBe(false);
      expect(result.problems).toEqual([
        expect.objectContaining({
          kind: 'unscanned-stylesheet',
          html,
          href: '/mystery.css',
        }),
        expect.objectContaining({
          kind: 'under-declared-faces',
          html,
          count: 0,
          expected: 1,
        }),
      ]);
    });
  });

  describe('FINDING 2 — href is sanitized in every problem kind that echoes it (PR #8 HIGH)', () => {
    function noControlChars(detail: string): boolean {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting control chars are ABSENT
      return !/[\x00-\x1f\x7f]/.test(detail);
    }

    it('sanitizes href in resolver-threw and unresolvable-font-file (face resolution)', () => {
      const evilThrow = '/evil-throw\nPASS: verifyFontPreload -- forged.woff2';
      const evilMissing = '/evil-missing\nPASS: verifyFontPreload -- forged.woff2';
      const css = write(
        'bundle.css',
        `@font-face { font-family: A; src: url(${evilThrow}) format("woff2"); }\n` +
          `@font-face { font-family: B; src: url(${evilMissing}) format("woff2"); }`,
      );
      const html = write('index.html', '<html><head></head></html>');

      function craftedResolver(href: string): string | undefined {
        if (href === evilThrow) throw new Error('resolver exploded');
        if (href === evilMissing) return undefined;
        return resolveHref(href);
      }

      const result = verifyFontPreload({
        htmlFiles: [html],
        cssFiles: [css],
        resolveHref: craftedResolver,
        expectedFacesPerDocument: 1,
      });

      expect(result.ok).toBe(false);
      const relevant = result.problems.filter(
        (p) => p.kind === 'resolver-threw' || p.kind === 'unresolvable-font-file',
      );
      expect(relevant).toHaveLength(2);
      for (const problem of relevant) {
        expect(problem.detail.includes('\n')).toBe(false);
        expect(noControlChars(problem.detail)).toBe(true);
        // Sanitization must ESCAPE, not destroy: the message still names the offending href.
        expect(problem.detail).toContain('\\n');
        const rawHref = (problem as { href: string }).href;
        const offender = rawHref.split('\n')[0] ?? '';
        expect(problem.detail).toContain(offender);
      }
    });

    it('sanitizes href in font-preload-missing/unpaired/duplicate/wrong-crossorigin/wrong-type', () => {
      const evilMissing = '/evil-missing\nPASS: forged.woff2';
      const evilDup = '/evil-dup\nPASS: forged.woff2';
      const evilType = '/evil-type\nPASS: forged.woff2';
      const evilStray = '/evil-stray\nPASS: forged.woff2';

      const html = write(
        'index.html',
        '<html><head>' +
          `<style>@font-face { font-family: A; src: url(${evilMissing}) format("woff2"); }` +
          `@font-face { font-family: B; src: url(${evilDup}) format("woff2"); }` +
          `@font-face { font-family: C; src: url(${evilType}) format("woff2"); }</style>` +
          `<link rel="preload" as="font" href="${evilDup}" type="font/woff2">` +
          `<link rel="preload" as="font" href="${evilDup}" type="font/woff2">` +
          `<link rel="preload" as="font" href="${evilType}" crossorigin type="font/woff">` +
          `<link rel="preload" as="font" href="${evilStray}" crossorigin type="font/woff2">` +
          '</head></html>',
      );

      const result = verifyFontPreload({
        htmlFiles: [html],
        cssFiles: [],
        resolveHref,
        expectedFacesPerDocument: 1,
      });

      expect(result.ok).toBe(false);
      const targetKinds = [
        'font-preload-missing',
        'font-preload-unpaired',
        'font-preload-duplicate',
        'font-preload-wrong-crossorigin',
        'font-preload-wrong-type',
      ];
      const relevant = result.problems.filter((p) => targetKinds.includes(p.kind));
      expect(targetKinds.every((kind) => relevant.some((p) => p.kind === kind))).toBe(true);
      expect(relevant.length).toBeGreaterThan(0);
      for (const problem of relevant) {
        expect(problem.detail.includes('\n')).toBe(false);
        expect(noControlChars(problem.detail)).toBe(true);
        // Sanitization must ESCAPE, not destroy: the message still names the offending href.
        expect(problem.detail).toContain('\\n');
        const rawHref = (problem as { href: string }).href;
        const offender = rawHref.split('\n')[0] ?? '';
        expect(problem.detail).toContain(offender);
      }
    });

    it('sanitizes href in unscanned-stylesheet', () => {
      write('known.woff2', 'font-bytes');
      const known = write(
        'known.css',
        '@font-face { font-family: A; src: url(/known.woff2) format("woff2"); }',
      );
      const evilHref = '/evil\nPASS: verifyFontPreload -- forged.css';
      const html = write('index.html', `<html><head>${stylesheetLink(evilHref)}</head></html>`);

      const result = verifyFontPreload({
        htmlFiles: [html],
        cssFiles: [known],
        resolveHref,
        expectedFacesPerDocument: 1,
      });

      expect(result.ok).toBe(false);
      const problem = result.problems.find((p) => p.kind === 'unscanned-stylesheet');
      expect(problem).toBeDefined();
      expect(problem?.detail.includes('\n')).toBe(false);
      expect(noControlChars(problem?.detail ?? '')).toBe(true);
      // Sanitization must ESCAPE, not destroy: the message still names the offending href.
      expect(problem?.detail).toContain('\\n');
      expect(problem?.detail).toContain('/evil');
    });
  });

  describe('FINDING 1 — expectedFacesPerDocument is a validated anti-vacuity floor (PR #8 CRITICAL)', () => {
    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2.5])(
      'throws TypeError naming expectedFacesPerDocument for %p',
      (bad) => {
        const html = write('index.html', '<html><head></head></html>');

        let caught: unknown;
        try {
          verifyFontPreload({
            htmlFiles: [html],
            cssFiles: [],
            resolveHref,
            // biome-ignore lint/suspicious/noExplicitAny: deliberately violating the floor's contract
            expectedFacesPerDocument: bad as any,
          });
        } catch (error) {
          caught = error;
        }

        expect(caught).toBeInstanceOf(TypeError);
        expect((caught as Error).message).toContain('expectedFacesPerDocument');
      },
    );

    it('a floor of 0 no longer disables the check — reproduces the 2026.831.3 vacuous pass as a throw instead', () => {
      const docB = write('b.html', '<html><head></head></html>');

      let caught: unknown;
      try {
        verifyFontPreload({
          htmlFiles: [docB],
          cssFiles: [],
          resolveHref,
          // biome-ignore lint/suspicious/noExplicitAny: deliberately violating the floor's contract
          expectedFacesPerDocument: 0 as any,
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(TypeError);
    });
  });

  describe('FINDING 2 — String(error) is sanitized too, not just href (PR #8 HIGH)', () => {
    it('sanitizes a log-injection payload carried in a non-existent html path via String(error)', () => {
      const evilPath = join(
        root,
        'nonexistent\n<<<INJECTED>>> font-preload: OK, 0 problems\npost.html',
      );

      const result = verifyFontPreload({
        htmlFiles: [evilPath],
        cssFiles: [],
        resolveHref,
        expectedFacesPerDocument: 1,
      });

      expect(result.ok).toBe(false);
      const problem = result.problems.find((p) => p.kind === 'unreadable-html');
      expect(problem).toBeDefined();
      expect(problem?.detail.includes('\n')).toBe(false);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting control chars are ABSENT
      expect(/[\x00-\x1f\x7f]/.test(problem?.detail ?? '')).toBe(false);
      // Sanitization must ESCAPE, not destroy: the message still identifies the offending file.
      expect(problem?.detail).toContain('\\n');
      expect(problem?.detail).toContain('nonexistent');
    });
  });
});

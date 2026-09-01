import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fontUrlsFromCss, verifyFontAssets } from './fontAssets.ts';
import { MAX_URL_LENGTH } from './scan.ts';

let root: string;
let fontRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uxr-font-assets-'));
  fontRoot = join(root, 'fonts');
  mkdirSync(fontRoot, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const file = join(root, name);
  writeFileSync(file, content);
  return file;
}

/** A valid minimal woff2: the 4-byte magic signature plus arbitrary padding — enough to pass the
 * magic-byte check without being a real, parseable font. */
function writeValidWoff2(name: string): string {
  const file = join(fontRoot, name);
  writeFileSync(file, Buffer.concat([Buffer.from('wOF2'), Buffer.from('padding-bytes')]));
  return file;
}

function writeInvalidWoff2(name: string): string {
  const file = join(fontRoot, name);
  writeFileSync(file, Buffer.from('NOT-A-FONT-FILE'));
  return file;
}

/** Standard resolver: `/fonts/x.woff2` -> `<fontRoot>/x.woff2`, joined lexically (no sandboxing —
 * containment is the gate's job, not the resolver's), matching how a real Vite-style resolver
 * behaves. */
function resolveHref(href: string): string | undefined {
  if (!href.startsWith('/fonts/')) return undefined;
  return join(fontRoot, href.slice('/fonts/'.length));
}

const FORBIDDEN_ORIGINS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

describe('verifyFontAssets', () => {
  it('passes clean on a well-formed setup', () => {
    writeValidWoff2('inter.woff2');
    const css = write('main.css', '@font-face { src: url(/fonts/inter.woff2) format("woff2"); }');

    const result = verifyFontAssets({
      sourceFiles: [css],
      fontReferences: ['/fonts/inter.woff2'],
      resolveHref,
      forbiddenOrigins: FORBIDDEN_ORIGINS,
      fontRoot,
    });

    expect(result).toEqual({ ok: true, problems: [], warnings: [] });
  });

  it('reports forbidden-origin for a remote font CDN referenced in CSS', () => {
    writeValidWoff2('inter.woff2');
    const css = write('main.css', '@import url(https://fonts.googleapis.com/css2?family=Inter);');

    const result = verifyFontAssets({
      sourceFiles: [css],
      fontReferences: ['/fonts/inter.woff2'],
      resolveHref,
      forbiddenOrigins: FORBIDDEN_ORIGINS,
      fontRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'forbidden-origin', origin: 'fonts.googleapis.com' }),
      ]),
    );
  });

  it('does NOT flag a forbidden origin named inside a CSS comment', () => {
    writeValidWoff2('inter.woff2');
    const css = write(
      'main.css',
      '/* fonts.googleapis.com was removed for perf, see PR #7 */\n' +
        '@font-face { src: url(/fonts/inter.woff2); }',
    );

    const result = verifyFontAssets({
      sourceFiles: [css],
      fontReferences: ['/fonts/inter.woff2'],
      resolveHref,
      forbiddenOrigins: FORBIDDEN_ORIGINS,
      fontRoot,
    });

    expect(result).toEqual({ ok: true, problems: [], warnings: [] });
  });

  it('does NOT flag a forbidden origin named inside an HTML comment', () => {
    writeValidWoff2('inter.woff2');
    const html = write(
      'index.html',
      '<!-- fonts.gstatic.com was removed for perf, see PR #7 -->\n<html></html>',
    );

    const result = verifyFontAssets({
      sourceFiles: [html],
      fontReferences: ['/fonts/inter.woff2'],
      resolveHref,
      forbiddenOrigins: FORBIDDEN_ORIGINS,
      fontRoot,
    });

    expect(result).toEqual({ ok: true, problems: [], warnings: [] });
  });

  it('catches an uppercase URL(...) form referencing a forbidden origin', () => {
    writeValidWoff2('inter.woff2');
    const css = write('main.css', '@import URL(https://fonts.googleapis.com/css2);');

    const result = verifyFontAssets({
      sourceFiles: [css],
      fontReferences: ['/fonts/inter.woff2'],
      resolveHref,
      forbiddenOrigins: FORBIDDEN_ORIGINS,
      fontRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'forbidden-origin' })]),
    );
  });

  it('catches @import/*comment*/"forbidden-origin" — a CSS comment defeats a naive @import\\s+ match', () => {
    writeValidWoff2('inter.woff2');
    const css = write('main.css', '@import/*c*/"https://fonts.googleapis.com/css2";');

    const result = verifyFontAssets({
      sourceFiles: [css],
      fontReferences: ['/fonts/inter.woff2'],
      resolveHref,
      forbiddenOrigins: FORBIDDEN_ORIGINS,
      fontRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'forbidden-origin' })]),
    );
  });

  it('reports unresolvable-font for a referenced font missing on disk', () => {
    const css = write('main.css', '@font-face { src: url(/fonts/ghost.woff2); }');

    const result = verifyFontAssets({
      sourceFiles: [css],
      fontReferences: ['/fonts/ghost.woff2'],
      resolveHref: () => undefined,
      forbiddenOrigins: FORBIDDEN_ORIGINS,
      fontRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: 'unresolvable-font', reference: '/fonts/ghost.woff2' }),
    ]);
  });

  it('reports empty-font-file for a zero-byte font file', () => {
    const file = join(fontRoot, 'empty.woff2');
    writeFileSync(file, Buffer.alloc(0));
    const css = write('main.css', '@font-face { src: url(/fonts/empty.woff2); }');

    const result = verifyFontAssets({
      sourceFiles: [css],
      fontReferences: ['/fonts/empty.woff2'],
      resolveHref,
      forbiddenOrigins: FORBIDDEN_ORIGINS,
      fontRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([expect.objectContaining({ kind: 'empty-font-file', file })]);
  });

  it('reports not-woff2 for a file with wrong magic bytes', () => {
    const file = writeInvalidWoff2('fake.woff2');
    const css = write('main.css', '@font-face { src: url(/fonts/fake.woff2); }');

    const result = verifyFontAssets({
      sourceFiles: [css],
      fontReferences: ['/fonts/fake.woff2'],
      resolveHref,
      forbiddenOrigins: FORBIDDEN_ORIGINS,
      fontRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([expect.objectContaining({ kind: 'not-woff2', file })]);
  });

  it('reports checksum-mismatch with only a PREFIX of the hash in detail, never full content', () => {
    const file = writeValidWoff2('inter.woff2');
    const css = write('main.css', '@font-face { src: url(/fonts/inter.woff2); }');

    const result = verifyFontAssets({
      sourceFiles: [css],
      fontReferences: ['/fonts/inter.woff2'],
      resolveHref,
      forbiddenOrigins: FORBIDDEN_ORIGINS,
      fontRoot,
      checksums: { 'inter.woff2': '0'.repeat(64) },
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([expect.objectContaining({ kind: 'checksum-mismatch', file })]);
    const problem = result.problems[0];
    if (problem === undefined || problem.kind !== 'checksum-mismatch') {
      throw new Error('expected a checksum-mismatch problem');
    }
    // Prefix present, full 64-char hash absent — never the complete file content/hash.
    expect(problem.detail).toContain('000000000000');
    expect(problem.detail).not.toContain('0'.repeat(64));
  });

  it('reports missing-checksum for a referenced font with no pinned entry when checksums IS supplied', () => {
    const file = writeValidWoff2('inter.woff2');
    const css = write('main.css', '@font-face { src: url(/fonts/inter.woff2); }');

    const result = verifyFontAssets({
      sourceFiles: [css],
      fontReferences: ['/fonts/inter.woff2'],
      resolveHref,
      forbiddenOrigins: FORBIDDEN_ORIGINS,
      fontRoot,
      checksums: {},
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([expect.objectContaining({ kind: 'missing-checksum', file })]);
  });

  it('skips checksum checks entirely when checksums is omitted', () => {
    writeValidWoff2('inter.woff2');
    const css = write('main.css', '@font-face { src: url(/fonts/inter.woff2); }');

    const result = verifyFontAssets({
      sourceFiles: [css],
      fontReferences: ['/fonts/inter.woff2'],
      resolveHref,
      forbiddenOrigins: FORBIDDEN_ORIGINS,
      fontRoot,
    });

    expect(result).toEqual({ ok: true, problems: [], warnings: [] });
  });

  it('passes clean with a CORRECT pinned checksum — the match branch is exercised, not just the mismatch branch', () => {
    writeValidWoff2('inter.woff2');
    const css = write('main.css', '@font-face { src: url(/fonts/inter.woff2); }');
    const bytes = Buffer.concat([Buffer.from('wOF2'), Buffer.from('padding-bytes')]);
    const realHash = createHash('sha256').update(bytes).digest('hex');

    const result = verifyFontAssets({
      sourceFiles: [css],
      fontReferences: ['/fonts/inter.woff2'],
      resolveHref,
      forbiddenOrigins: FORBIDDEN_ORIGINS,
      fontRoot,
      checksums: { 'inter.woff2': realHash },
    });

    expect(result).toEqual({ ok: true, problems: [], warnings: [] });
  });

  it('checks checksums per-file: one correctly pinned, one mismatched -> exactly one checksum-mismatch, naming the mismatched file', () => {
    const okBytes = Buffer.concat([Buffer.from('wOF2'), Buffer.from('padding-bytes')]);
    writeFileSync(join(fontRoot, 'inter.woff2'), okBytes);
    const okHash = createHash('sha256').update(okBytes).digest('hex');
    const badFile = writeValidWoff2('bold.woff2');
    const css = write(
      'main.css',
      '@font-face { src: url(/fonts/inter.woff2); } ' +
        '@font-face { font-weight: 700; src: url(/fonts/bold.woff2); }',
    );

    const result = verifyFontAssets({
      sourceFiles: [css],
      fontReferences: ['/fonts/inter.woff2', '/fonts/bold.woff2'],
      resolveHref,
      forbiddenOrigins: FORBIDDEN_ORIGINS,
      fontRoot,
      checksums: { 'inter.woff2': okHash, 'bold.woff2': '0'.repeat(64) },
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: 'checksum-mismatch', file: badFile }),
    ]);
  });

  it('sanitizes a reference containing a newline and control characters in every problem detail that echoes it', () => {
    const evilReference = '/fonts/evil.woff2\nPASS: verifyFontAssets — 0 problems (forged)\x07';
    const css = write('main.css', `@font-face { src: url(${evilReference}); }`);

    // resolver-threw
    const threw = verifyFontAssets({
      sourceFiles: [css],
      fontReferences: [evilReference],
      resolveHref: () => {
        throw new Error(`boom on ${evilReference}`);
      },
      forbiddenOrigins: FORBIDDEN_ORIGINS,
      fontRoot,
    });
    expect(threw.ok).toBe(false);
    for (const problem of threw.problems) {
      expect(problem.detail.includes('\n')).toBe(false);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting control chars are gone
      expect(/[\x00-\x1f\x7f]/.test(problem.detail)).toBe(false);
    }

    // unresolvable-font
    const unresolvable = verifyFontAssets({
      sourceFiles: [css],
      fontReferences: [evilReference],
      resolveHref: () => undefined,
      forbiddenOrigins: FORBIDDEN_ORIGINS,
      fontRoot,
    });
    expect(unresolvable.ok).toBe(false);
    for (const problem of unresolvable.problems) {
      expect(problem.detail.includes('\n')).toBe(false);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting control chars are gone
      expect(/[\x00-\x1f\x7f]/.test(problem.detail)).toBe(false);
    }

    // outside-font-root: reference itself carries the payload past containment
    const secretFile = join(root, 'secret.woff2');
    writeFileSync(secretFile, Buffer.alloc(0));
    const outside = verifyFontAssets({
      sourceFiles: [css],
      fontReferences: [evilReference],
      resolveHref: () => secretFile,
      forbiddenOrigins: FORBIDDEN_ORIGINS,
      fontRoot,
    });
    expect(outside.ok).toBe(false);
    const outsideProblem = outside.problems.find((p) => p.kind === 'outside-font-root');
    expect(outsideProblem).toBeDefined();
    if (outsideProblem !== undefined) {
      expect(outsideProblem.detail.includes('\n')).toBe(false);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting control chars are gone
      expect(/[\x00-\x1f\x7f]/.test(outsideProblem.detail)).toBe(false);
    }
  });

  it('sanitizes the orphan-font-file warning detail for a font-root file with control characters in its path', () => {
    writeValidWoff2('inter.woff2');
    const trickyName = 'orphan\x07evil.woff2';
    writeFileSync(
      join(fontRoot, trickyName),
      Buffer.concat([Buffer.from('wOF2'), Buffer.from('x')]),
    );
    const css = write('main.css', '@font-face { src: url(/fonts/inter.woff2); }');

    const result = verifyFontAssets({
      sourceFiles: [css],
      fontReferences: ['/fonts/inter.woff2'],
      resolveHref,
      forbiddenOrigins: FORBIDDEN_ORIGINS,
      fontRoot,
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(1);
    const warning = result.warnings[0];
    expect(warning).toBeDefined();
    if (warning !== undefined) {
      expect(warning.detail.includes('\n')).toBe(false);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting control chars are gone
      expect(/[\x00-\x1f\x7f]/.test(warning.detail)).toBe(false);
    }
  });

  it('reports outside-font-root for a ../ traversal reference and never reads the file it names', () => {
    // Zero-byte: if the containment guard failed to drop this reference, checkFontFile would
    // read it and push a SECOND problem (empty-font-file) alongside outside-font-root. Asserting
    // exactly one problem is therefore proof the file was never opened after being rejected, not
    // just an assertion about which kind fired first.
    const secretFile = join(root, 'secret.woff2');
    writeFileSync(secretFile, Buffer.alloc(0));
    const css = write('main.css', '@font-face { src: url(/fonts/../secret.woff2); }');

    const result = verifyFontAssets({
      sourceFiles: [css],
      fontReferences: ['/fonts/../secret.woff2'],
      resolveHref: () => secretFile,
      forbiddenOrigins: FORBIDDEN_ORIGINS,
      fontRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({
        kind: 'outside-font-root',
        reference: '/fonts/../secret.woff2',
      }),
    ]);
  });

  it('rejects a prefix-collision path: fontRoot ".../fonts" must not admit ".../fontsX"', () => {
    const collisionDir = `${fontRoot}X`;
    mkdirSync(collisionDir, { recursive: true });
    const collisionFile = join(collisionDir, 'evil.woff2');
    writeFileSync(collisionFile, Buffer.concat([Buffer.from('wOF2'), Buffer.from('x')]));
    const css = write('main.css', '@font-face { src: url(/evil.woff2); }');

    const result = verifyFontAssets({
      sourceFiles: [css],
      fontReferences: ['/evil.woff2'],
      resolveHref: () => collisionFile,
      forbiddenOrigins: FORBIDDEN_ORIGINS,
      fontRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: 'outside-font-root', reference: '/evil.woff2' }),
    ]);
  });

  it('warns (never fails) about an orphan font file under fontRoot', () => {
    writeValidWoff2('inter.woff2');
    writeValidWoff2('orphan.woff2');
    const css = write('main.css', '@font-face { src: url(/fonts/inter.woff2); }');

    const result = verifyFontAssets({
      sourceFiles: [css],
      fontReferences: ['/fonts/inter.woff2'],
      resolveHref,
      forbiddenOrigins: FORBIDDEN_ORIGINS,
      fontRoot,
    });

    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        kind: 'orphan-font-file',
        file: join(fontRoot, 'orphan.woff2'),
      }),
    ]);
  });

  it('reports empty-input for an empty sourceFiles list', () => {
    const result = verifyFontAssets({
      sourceFiles: [],
      fontReferences: ['/fonts/inter.woff2'],
      resolveHref,
      forbiddenOrigins: FORBIDDEN_ORIGINS,
      fontRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([expect.objectContaining({ kind: 'empty-input' })]);
    expect(result.warnings).toEqual([]);
  });

  it('reports empty-input for an empty fontReferences list', () => {
    const css = write('main.css', 'body { color: red; }');

    const result = verifyFontAssets({
      sourceFiles: [css],
      fontReferences: [],
      resolveHref,
      forbiddenOrigins: FORBIDDEN_ORIGINS,
      fontRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([expect.objectContaining({ kind: 'empty-input' })]);
  });

  it('throws a TypeError naming resolveHref when the resolver returns a non-string', () => {
    const css = write('main.css', '@font-face { src: url(/fonts/inter.woff2); }');
    // biome-ignore lint/suspicious/noExplicitAny: deliberately violating the resolver contract
    const contractViolatingResolver = (() => ({ notAPath: true })) as any;

    let caught: unknown;
    try {
      verifyFontAssets({
        sourceFiles: [css],
        fontReferences: ['/fonts/inter.woff2'],
        resolveHref: contractViolatingResolver,
        forbiddenOrigins: FORBIDDEN_ORIGINS,
        fontRoot,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toContain('resolveHref');
  });

  it('reports resolver-threw, distinct from unresolvable-font, when resolveHref itself throws', () => {
    const css = write('main.css', '@font-face { src: url(/fonts/inter.woff2); }');
    const throwingResolver = () => {
      throw new Error('boom: unguarded statSync inside consumer code');
    };

    const result = verifyFontAssets({
      sourceFiles: [css],
      fontReferences: ['/fonts/inter.woff2'],
      resolveHref: throwingResolver,
      forbiddenOrigins: FORBIDDEN_ORIGINS,
      fontRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: 'resolver-threw', reference: '/fonts/inter.woff2' }),
    ]);
  });

  it('reports unreadable-source, without throwing, for a source file that cannot be read', () => {
    const missing = join(root, 'does-not-exist.css');

    const result = verifyFontAssets({
      sourceFiles: [missing],
      fontReferences: ['/fonts/inter.woff2'],
      resolveHref: () => undefined,
      forbiddenOrigins: FORBIDDEN_ORIGINS,
      fontRoot,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'unreadable-source', source: missing }),
        expect.objectContaining({ kind: 'unresolvable-font' }),
      ]),
    );
  });
});

describe('fontUrlsFromCss', () => {
  it('extracts a single woff2 url', () => {
    const css = '@font-face { src: url(/fonts/inter.woff2) format("woff2"); }';
    expect(fontUrlsFromCss(css)).toEqual(['/fonts/inter.woff2']);
  });

  it('extracts multiple urls from one src: with several format() entries, in order', () => {
    const css =
      '@font-face { src: url(/fonts/inter.woff2) format("woff2"), ' +
      'url(/fonts/inter.woff) format("woff"); }';
    expect(fontUrlsFromCss(css)).toEqual(['/fonts/inter.woff2', '/fonts/inter.woff']);
  });

  it('works on minified css with no trailing ; before } (the real boufin case)', () => {
    const css = '@font-face{font-family:"Inter";src:url(/fonts/inter.woff2) format("woff2")}';
    expect(fontUrlsFromCss(css)).toEqual(['/fonts/inter.woff2']);
  });

  it('ignores a commented-out @font-face', () => {
    const css = '/* @font-face { src: url(/fonts/inter.woff2) format("woff2"); } */';
    expect(fontUrlsFromCss(css)).toEqual([]);
  });

  it('deduplicates a url declared in two faces', () => {
    const css =
      '@font-face { font-weight: 400; src: url(/fonts/inter.woff2) format("woff2"); } ' +
      '@font-face { font-weight: 400; font-style: italic; src: url(/fonts/inter.woff2) format("woff2"); }';
    expect(fontUrlsFromCss(css)).toEqual(['/fonts/inter.woff2']);
  });

  it('returns [] for css with no @font-face', () => {
    expect(fontUrlsFromCss('body { color: red; }')).toEqual([]);
  });

  it('does not pick up a url() outside any @font-face block', () => {
    const css =
      '.hero { background-image: url(/images/hero.jpg); } ' +
      '@font-face { src: url(/fonts/inter.woff2) format("woff2"); }';
    expect(fontUrlsFromCss(css)).toEqual(['/fonts/inter.woff2']);
  });

  it('excludes an oversized url (> MAX_URL_LENGTH chars) — verifyFontChain is the gate that reports it, not this helper', () => {
    const longPath = `/fonts/${'a'.repeat(MAX_URL_LENGTH + 100)}.woff2`;
    const css = `@font-face { src: url(${longPath}) format("woff2"); }`;
    expect(fontUrlsFromCss(css)).toEqual([]);
  });
});

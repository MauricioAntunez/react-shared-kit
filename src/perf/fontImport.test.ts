import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyNoFontImport } from './fontImport.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uxr-no-font-import-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const file = join(root, name);
  writeFileSync(file, content);
  return file;
}

/** A resolver that maps specifiers to sibling files in `root` by literal lookup, `undefined` for
 * anything not registered — mirrors how a real bundler resolver behaves for an unconfigured alias. */
function makeResolver(
  map: Record<string, string>,
): (specifier: string, fromFile: string) => string | undefined {
  return (specifier: string) => map[specifier];
}

describe('verifyNoFontImport', () => {
  it('reports font-import for an @import url(...) reaching a known font CDN', () => {
    const file = write('a.css', "@import url('https://fonts.googleapis.com/css2?family=X');\n");

    const result = verifyNoFontImport({ cssFiles: [file], resolveImport: () => undefined });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({
        kind: 'font-import',
        file,
        line: 1,
        specifier: 'https://fonts.googleapis.com/css2?family=X',
      }),
    ]);
  });

  it('reports font-import for @import of an @fontsource package', () => {
    const file = write('a.css', '@import "@fontsource/inter/400.css";\n');

    const result = verifyNoFontImport({ cssFiles: [file], resolveImport: () => undefined });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: 'font-import', specifier: '@fontsource/inter/400.css' }),
    ]);
  });

  it(
    'HEADLINE REGRESSION TEST (the boufin false positive): a font-free composition @import ' +
      'is NOT reported',
    () => {
      const colors = write('colors.css', '.token-a { color: red; }\n');
      const entry = write('index.css', '@import "./colors.css" layer(bf-tokens);\n');
      const resolveImport = makeResolver({ './colors.css': colors });

      const result = verifyNoFontImport({ cssFiles: [entry], resolveImport });

      expect(result).toEqual({ ok: true, problems: [] });
    },
  );

  it('reports font-import, with chain, for an @import whose target directly declares @font-face', () => {
    const fonts = write(
      'fonts.css',
      "@font-face { font-family: 'X'; src: url('/x.woff2') format('woff2'); }\n",
    );
    const entry = write('index.css', '@import "./fonts.css";\n');
    const resolveImport = makeResolver({ './fonts.css': fonts });

    const result = verifyNoFontImport({ cssFiles: [entry], resolveImport });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({
        kind: 'font-import',
        file: entry,
        line: 1,
        specifier: './fonts.css',
        chain: ['./fonts.css'],
      }),
    ]);
  });

  it('TRANSITIVE: a.css imports b.css imports c.css which declares @font-face — full chain reported', () => {
    const c = write(
      'c.css',
      "@font-face { font-family: 'X'; src: url('/x.woff2') format('woff2'); }\n",
    );
    const b = write('b.css', '@import "./c.css";\n');
    const a = write('a.css', '@import "./b.css";\n');
    const resolveImport = makeResolver({ './b.css': b, './c.css': c });

    const result = verifyNoFontImport({ cssFiles: [a], resolveImport });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({
        kind: 'font-import',
        file: a,
        line: 1,
        specifier: './b.css',
        chain: ['./b.css', './c.css'],
      }),
    ]);
  });

  it('an import CYCLE (a -> b -> a) terminates and still reports correctly when a font is present', () => {
    const bPath = join(root, 'b.css');
    const aPath = join(root, 'a.css');
    writeFileSync(
      aPath,
      "@font-face { font-family: 'X'; src: url('/x.woff2') format('woff2'); }\n@import \"./b.css\";\n",
    );
    writeFileSync(bPath, '@import "./a.css";\n');
    const resolveImport = makeResolver({ './b.css': bPath, './a.css': aPath });

    let result: ReturnType<typeof verifyNoFontImport> | undefined;
    expect(() => {
      result = verifyNoFontImport({ cssFiles: [bPath], resolveImport });
    }).not.toThrow();

    expect(result?.ok).toBe(false);
    expect(result?.problems).toEqual([
      expect.objectContaining({
        kind: 'font-import',
        file: bPath,
        specifier: './a.css',
        chain: ['./a.css'],
      }),
    ]);
  });

  it('an import cycle with NO font anywhere terminates cleanly (no hang, no problem)', () => {
    const bPath = join(root, 'b.css');
    const aPath = join(root, 'a.css');
    writeFileSync(aPath, '.a { color: red; }\n@import "./b.css";\n');
    writeFileSync(bPath, '.b { color: blue; }\n@import "./a.css";\n');
    const resolveImport = makeResolver({ './b.css': bPath, './a.css': aPath });

    let result: ReturnType<typeof verifyNoFontImport> | undefined;
    expect(() => {
      result = verifyNoFontImport({ cssFiles: [aPath], resolveImport });
    }).not.toThrow();

    expect(result).toEqual({ ok: true, problems: [] });
  });

  it('reports unresolvable-import for a specifier the resolver cannot resolve — NOT silently passed', () => {
    const file = write('a.css', '@import "unconfigured-alias/x.css";\n');

    const result = verifyNoFontImport({ cssFiles: [file], resolveImport: () => undefined });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({
        kind: 'unresolvable-import',
        file,
        line: 1,
        specifier: 'unconfigured-alias/x.css',
      }),
    ]);
  });

  it('does not report a commented-out font @import', () => {
    const file = write(
      'a.css',
      '/* @import "https://fonts.googleapis.com/css2?family=X"; */\n.a { color: red; }\n',
    );

    const result = verifyNoFontImport({ cssFiles: [file], resolveImport: () => undefined });

    expect(result).toEqual({ ok: true, problems: [] });
  });

  it('does not report @import text inside a string literal, but a real font @import on an adjacent line IS', () => {
    const file = write(
      'a.css',
      '.a { content: "@import fake"; }\n' +
        "@import url('https://fonts.googleapis.com/css2?family=X');\n",
    );

    const result = verifyNoFontImport({ cssFiles: [file], resolveImport: () => undefined });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([expect.objectContaining({ kind: 'font-import', line: 2 })]);
    expect(result.problems).toHaveLength(1);
  });

  it('a .scss file with a font-free @import is not reported', () => {
    const colors = write('_colors.scss', '$primary: red;\n');
    const entry = write('index.scss', '@import "./_colors.scss";\n');
    const resolveImport = makeResolver({ './_colors.scss': colors });

    const result = verifyNoFontImport({ cssFiles: [entry], resolveImport });

    expect(result).toEqual({ ok: true, problems: [] });
  });

  it('a .scss file whose imported partial declares @font-face is reported', () => {
    const fonts = write(
      '_fonts.scss',
      "@font-face { font-family: 'X'; src: url('/x.woff2') format('woff2'); }\n",
    );
    const entry = write('index.scss', '@import "./_fonts.scss";\n');
    const resolveImport = makeResolver({ './_fonts.scss': fonts });

    const result = verifyNoFontImport({ cssFiles: [entry], resolveImport });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: 'font-import', specifier: './_fonts.scss' }),
    ]);
  });

  it('a custom fontSpecifierPatterns list is honoured (default would not catch this specifier)', () => {
    const file = write('a.css', '@import "https://my-custom-font-cdn.example/x.css";\n');

    const withoutCustomPattern = verifyNoFontImport({
      cssFiles: [file],
      resolveImport: () => undefined,
    });
    // The default patterns do not know this host, so the import is unresolvable (resolver
    // returns undefined) rather than a font-import — proving the default alone misses it.
    expect(withoutCustomPattern.problems).toEqual([
      expect.objectContaining({ kind: 'unresolvable-import' }),
    ]);

    const withCustomPattern = verifyNoFontImport({
      cssFiles: [file],
      resolveImport: () => undefined,
      fontSpecifierPatterns: [/my-custom-font-cdn\.example/i],
    });
    expect(withCustomPattern.ok).toBe(false);
    expect(withCustomPattern.problems).toEqual([
      expect.objectContaining({
        kind: 'font-import',
        specifier: 'https://my-custom-font-cdn.example/x.css',
      }),
    ]);
  });

  it('reports no-stylesheets-found for an empty cssFiles list instead of a vacuous pass', () => {
    const result = verifyNoFontImport({ cssFiles: [], resolveImport: () => undefined });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([expect.objectContaining({ kind: 'no-stylesheets-found' })]);
  });

  it("reports unreadable-css for a missing file WITHOUT losing another file's font-import finding", () => {
    const okFile = write('a.css', "@import url('https://fonts.googleapis.com/css2?family=X');\n");
    const missingFile = join(root, 'does-not-exist.css');

    let result: ReturnType<typeof verifyNoFontImport> | undefined;
    expect(() => {
      result = verifyNoFontImport({
        cssFiles: [okFile, missingFile],
        resolveImport: () => undefined,
      });
    }).not.toThrow();

    expect(result?.ok).toBe(false);
    expect(result?.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'font-import', file: okFile }),
        expect.objectContaining({ kind: 'unreadable-css', file: missingFile }),
      ]),
    );
    expect(result?.problems).toHaveLength(2);
  });

  it('reports resolver-threw when resolveImport throws, rather than crashing', () => {
    const file = write('a.css', '@import "./x.css";\n');
    const resolveImport = (): string | undefined => {
      throw new Error('boom');
    };

    let result: ReturnType<typeof verifyNoFontImport> | undefined;
    expect(() => {
      result = verifyNoFontImport({ cssFiles: [file], resolveImport });
    }).not.toThrow();

    expect(result?.ok).toBe(false);
    expect(result?.problems).toEqual([
      expect.objectContaining({ kind: 'resolver-threw', file, specifier: './x.css' }),
    ]);
  });

  it('throws TypeError naming resolveImport when the resolver returns a non-string', () => {
    const file = write('a.css', '@import "./x.css";\n');
    // biome-ignore lint/suspicious/noExplicitAny: deliberately violating the declared contract
    const badResolver = (() => 42) as any;

    let caught: unknown;
    try {
      verifyNoFontImport({ cssFiles: [file], resolveImport: badResolver });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toContain('resolveImport');
  });
});

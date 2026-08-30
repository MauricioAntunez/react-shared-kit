import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyFontChain } from './fontChain.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uxr-fontchain-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(name: string, contents: string): string {
  const path = join(root, name);
  mkdirSync(join(root), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

/** Resolver over a plain specifier -> path map, mirroring what a consumer's Vite/build resolution
 * would supply. Returns undefined for anything not in the map, matching the "unresolvable" contract. */
function resolverFor(map: Record<string, string>): (specifier: string) => string | undefined {
  return (specifier) => map[specifier];
}

describe('verifyFontChain', () => {
  it('reports a font @imported one level deep, naming the chain', () => {
    const fontsSheet = write(
      'fonts.css',
      `@font-face { font-family: 'Inter'; src: url('/inter.woff2') format('woff2'); font-display: swap; }`,
    );
    const entry = write('entry.css', `@import "./fonts.css"; body { color: red; }`);

    const result = verifyFontChain({
      entryStylesheets: [entry],
      resolveImport: resolverFor({ './fonts.css': fontsSheet }),
    });

    expect(result.ok).toBe(false);
    const problem = result.problems.find((p) => p.kind === 'deep-font');
    expect(problem).toBeDefined();
    expect(problem?.subject).toBe('/inter.woff2');
    expect(problem?.chain).toEqual([entry, './fonts.css']);
    expect(problem?.message).toContain('depth 1');
  });

  it('passes clean when @font-face is declared directly in the entry sheet', () => {
    const entry = write(
      'direct.css',
      `@font-face { font-family: 'Inter'; src: url('/inter.woff2') format('woff2'); font-display: swap; } body { color: red; }`,
    );

    const result = verifyFontChain({
      entryStylesheets: [entry],
      resolveImport: resolverFor({}),
    });

    expect(result).toEqual({ ok: true, problems: [] });
  });

  it('reports a font behind two levels of @import, at depth 2', () => {
    const leaf = write(
      'leaf.css',
      `@font-face { font-family: 'Inter'; src: url('/inter.woff2') format('woff2'); }`,
    );
    const mid = write('mid.css', `@import "./leaf.css";`);
    const entry = write('entry-2.css', `@import "./mid.css";`);

    const result = verifyFontChain({
      entryStylesheets: [entry],
      resolveImport: resolverFor({ './mid.css': mid, './leaf.css': leaf }),
    });

    expect(result.ok).toBe(false);
    const problem = result.problems.find((p) => p.kind === 'deep-font');
    expect(problem).toBeDefined();
    expect(problem?.chain).toEqual([entry, './mid.css', './leaf.css']);
    expect(problem?.message).toContain('depth 2');
  });

  it('states that font-display: swap does not resolve the finding, naming both failure modes', () => {
    const fontsSheet = write(
      'fonts-swap.css',
      `@font-face { font-family: 'Inter'; src: url('/inter.woff2'); font-display: swap; }`,
    );
    const entry = write('entry-swap.css', `@import "./fonts-swap.css";`);

    const result = verifyFontChain({
      entryStylesheets: [entry],
      resolveImport: resolverFor({ './fonts-swap.css': fontsSheet }),
    });

    const problem = result.problems.find((p) => p.kind === 'deep-font');
    expect(problem?.message).toContain('font-display: swap does not fix this');
    expect(problem?.message).toContain('RENDERING');
    expect(problem?.message).toContain('DISCOVERY');
  });

  it('reports unresolvable @import specifiers as a problem, not a skipped check', () => {
    const entry = write('entry-broken.css', `@import "./missing.css";`);

    const result = verifyFontChain({
      entryStylesheets: [entry],
      resolveImport: resolverFor({}),
    });

    expect(result.ok).toBe(false);
    const problem = result.problems.find((p) => p.kind === 'unresolvable-import');
    expect(problem).toBeDefined();
    expect(problem?.subject).toBe('./missing.css');
  });

  it('reports an unreadable entry stylesheet as a problem, never a silent pass', () => {
    const missing = join(root, 'does-not-exist.css');

    const result = verifyFontChain({
      entryStylesheets: [missing],
      resolveImport: resolverFor({}),
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: 'unreadable-stylesheet', subject: missing }),
    ]);
  });

  it('does not infinite-loop on a circular @import graph', () => {
    const aPath = join(root, 'a.css');
    const bPath = join(root, 'b.css');
    writeFileSync(aPath, `@import "./b.css";`);
    writeFileSync(
      bPath,
      `@import "./a.css"; @font-face { font-family: 'X'; src: url('/x.woff2'); }`,
    );

    const result = verifyFontChain({
      entryStylesheets: [aPath],
      resolveImport: resolverFor({ './a.css': aPath, './b.css': bPath }),
    });

    // Terminates (the test itself would hang otherwise) and still finds the font behind the cycle.
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.kind === 'deep-font')).toBe(true);
  });

  it('honours a non-zero maxChainDepth, allowing a font one level deep', () => {
    const fontsSheet = write(
      'fonts-allowed.css',
      `@font-face { font-family: 'Inter'; src: url('/inter.woff2'); }`,
    );
    const entry = write('entry-allowed.css', `@import "./fonts-allowed.css";`);

    const result = verifyFontChain({
      entryStylesheets: [entry],
      resolveImport: resolverFor({ './fonts-allowed.css': fontsSheet }),
      maxChainDepth: 1,
    });

    expect(result).toEqual({ ok: true, problems: [] });
  });
});

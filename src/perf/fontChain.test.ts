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

  it('terminates on a circular @import graph with exactly the one real finding — not by tripping the stack limit', () => {
    // PR #4 review finding: the old assertions here (`ok === false`, "some problem is deep-font")
    // held even with the cycle guard DELETED, because an unbounded recursive walk overflowed the
    // stack and the old generic `catch` in readStylesheet reported that RangeError as a plausible
    // "unreadable stylesheet" — a different problem shape that still made `ok === false`. This
    // version pins the EXACT problem list the guard guarantees: one `deep-font` (b.css's font,
    // reached at depth 1) and nothing else — no `unreadable-stylesheet`, no pile of duplicates from
    // walking the cycle repeatedly. That exact shape is unreachable via the stack-overflow path,
    // so it can only pass if the guard is actually doing its job.
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

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: 'deep-font', chain: [aPath, './b.css'] }),
    ]);
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

  it('reports empty-input rather than a vacuous pass when entryStylesheets is empty', () => {
    const result = verifyFontChain({ entryStylesheets: [], resolveImport: resolverFor({}) });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([expect.objectContaining({ kind: 'empty-input' })]);
  });

  it('reports the MINIMUM discovery depth, not whichever @import order the walk happens to see first', () => {
    // entry imports a.css THEN c.css. a.css also imports c.css. c.css carries the font.
    // c.css's true minimum depth is 1 (entry -> c.css directly) even though a DFS following
    // import statements in file order would reach it via entry -> a.css -> c.css at depth 2 first.
    const c = write('c.css', `@font-face { font-family: 'X'; src: url('/c.woff2'); }`);
    const a = write('a-order.css', `@import "./c.css";`);
    const entry = write('entry-order.css', `@import "./a-order.css"; @import "./c.css";`);

    const result = verifyFontChain({
      entryStylesheets: [entry],
      resolveImport: resolverFor({ './a-order.css': a, './c.css': c }),
      maxChainDepth: 1,
    });

    // c.css is reachable at depth 1 (within budget), so this must be clean — not a false
    // deep-font positive caused by the depth-2 path through a.css.
    expect(result).toEqual({ ok: true, problems: [] });
  });

  it('reports resolver-error, distinct from unresolvable-import, when resolveImport throws', () => {
    const entry = write('entry-throws.css', `@import "./boom.css";`);
    const boom = new Error('resolver blew up');

    const result = verifyFontChain({
      entryStylesheets: [entry],
      resolveImport: () => {
        throw boom;
      },
    });

    expect(result.ok).toBe(false);
    const problem = result.problems.find((p) => p.kind === 'resolver-error');
    expect(problem).toBeDefined();
    expect(problem?.subject).toBe('./boom.css');
    expect(problem?.message).toContain('resolver blew up');
    expect(result.problems.some((p) => p.kind === 'unresolvable-import')).toBe(false);
  });

  it('reports unparseable-font-face for a truncated @font-face block instead of dropping it silently', () => {
    const entry = write(
      'truncated.css',
      `@font-face { font-family: 'Broken'; src: url('/broken.woff2');`, // no closing brace
    );

    const result = verifyFontChain({
      entryStylesheets: [entry],
      resolveImport: resolverFor({}),
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: 'unparseable-font-face', subject: entry }),
    ]);
  });

  it('ships chain = [entry] (never an empty array) when the entry stylesheet itself is unreadable', () => {
    const missing = join(root, 'gone.css');

    const result = verifyFontChain({
      entryStylesheets: [missing],
      resolveImport: resolverFor({}),
    });

    const problem = result.problems.find((p) => p.kind === 'unreadable-stylesheet');
    expect(problem?.chain).toEqual([missing]);
  });
});

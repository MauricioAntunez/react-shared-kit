import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyCssBudget } from './cssBudget.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uxr-css-budget-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const file = join(root, name);
  writeFileSync(file, content);
  return file;
}

/** Standard resolver: strips a leading `/`, joins onto `root`, and fails closed for anything a
 * real Vite-style resolver would also fail on (a bare hash fragment, an empty href). */
function resolveHref(href: string): string | undefined {
  if (href === '' || href === '#' || href.endsWith('#')) return undefined;
  return join(root, href.replace(/^\//, ''));
}

describe('verifyCssBudget', () => {
  it('reports over-budget when render-blocking CSS exceeds maxBytes', () => {
    write('main.css', 'x'.repeat(1000));
    const html = write(
      'index.html',
      '<html><head><link rel="stylesheet" href="/main.css"></head></html>',
    );

    const result = verifyCssBudget({ htmlFiles: [html], resolveHref, maxBytes: 500 });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: 'over-budget', bytes: 1000, maxBytes: 500 }),
    ]);
  });

  it('reports unresolvable-href for a trailing "#" that resolves to nothing (the boufin defect)', () => {
    write('graph-DswA4CsK.css', 'x'.repeat(10));
    const html = write(
      'index.html',
      '<html><head><link rel="stylesheet" href="/assets/graph-DswA4CsK.css#"></head></html>',
    );

    const result = verifyCssBudget({ htmlFiles: [html], resolveHref, maxBytes: 1_000_000 });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({
        kind: 'unresolvable-href',
        href: '/assets/graph-DswA4CsK.css#',
      }),
    ]);
    // The unresolvable link must not have silently contributed 0 bytes to a clean verdict —
    // there is no over-budget problem alongside it because it was never counted, but the
    // unresolvable problem itself is what fails the gate, not a vacuous pass.
    expect(result.problems).toHaveLength(1);
  });

  it('does not count media="print" as render-blocking', () => {
    write('print.css', 'x'.repeat(1000));
    const html = write(
      'index.html',
      '<html><head><link rel="stylesheet" href="/print.css" media="print"></head></html>',
    );

    const result = verifyCssBudget({ htmlFiles: [html], resolveHref, maxBytes: 10 });

    expect(result).toEqual({ ok: true, problems: [] });
  });

  it('treats media="all" as render-blocking (over budget)', () => {
    write('all.css', 'x'.repeat(1000));
    const html = write(
      'index.html',
      '<html><head><link rel="stylesheet" href="/all.css" media="all"></head></html>',
    );

    const result = verifyCssBudget({ htmlFiles: [html], resolveHref, maxBytes: 10 });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([expect.objectContaining({ kind: 'over-budget' })]);
  });

  it('passes clean when render-blocking CSS is under budget', () => {
    write('main.css', 'x'.repeat(100));
    const html = write(
      'index.html',
      '<html><head><link rel="stylesheet" href="/main.css"></head></html>',
    );

    const result = verifyCssBudget({ htmlFiles: [html], resolveHref, maxBytes: 500 });

    expect(result).toEqual({ ok: true, problems: [] });
  });

  it('ignores a disabled stylesheet link entirely', () => {
    write('main.css', 'x'.repeat(1000));
    const html = write(
      'index.html',
      '<html><head><link rel="stylesheet" href="/main.css" disabled></head></html>',
    );

    const result = verifyCssBudget({ htmlFiles: [html], resolveHref, maxBytes: 10 });

    expect(result).toEqual({ ok: true, problems: [] });
  });

  it('measures brotli-compressed size when measure is "brotli"', () => {
    // Highly compressible content: raw size is large, brotli size is tiny.
    write('main.css', 'a'.repeat(10_000));
    const html = write(
      'index.html',
      '<html><head><link rel="stylesheet" href="/main.css"></head></html>',
    );

    const raw = verifyCssBudget({ htmlFiles: [html], resolveHref, maxBytes: 5_000 });
    expect(raw.ok).toBe(false); // 10,000 raw bytes over a 5,000 byte budget

    const brotli = verifyCssBudget({
      htmlFiles: [html],
      resolveHref,
      maxBytes: 5_000,
      measure: 'brotli',
    });
    expect(brotli).toEqual({ ok: true, problems: [] });
  });
});

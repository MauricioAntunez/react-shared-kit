import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyCssBudget } from './cssBudget.ts';

/**
 * Round 5 review finding: checkDocument's try block used to wrap BOTH readFileSync and, in
 * 'brotli' mode, brotliCompressSync in one catch — so a compression-layer bug was mislabelled as
 * 'unreadable-file' ("could not read...") about a file that had, in fact, been read successfully.
 * This mock proves the fix: brotliCompressSync can be made to throw independently of any real fs
 * condition, and the test below asserts that throw propagates rather than becoming a problem.
 * Falls through to the REAL implementation whenever not explicitly told to throw, so every other
 * test in this file (none of which exercise 'brotli' mode except the one dedicated test) is
 * unaffected.
 */
const brotliMock = vi.fn<(...args: unknown[]) => unknown>();
vi.mock('node:zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:zlib')>();
  return {
    ...actual,
    brotliCompressSync: (...args: Parameters<typeof actual.brotliCompressSync>) => {
      const mocked = brotliMock(...args);
      return mocked ?? actual.brotliCompressSync(...args);
    },
  };
});

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

  it('propagates a brotliCompressSync failure instead of misreporting it as unreadable-file (round 5 review finding)', () => {
    // The file is read successfully — only the COMPRESSION step fails. Before round 5's fix,
    // checkDocument's one try/catch spanned both readFileSync and brotliCompressSync, so this
    // reported {kind: 'unreadable-file', detail: 'could not read ...'} about a file that WAS read.
    // A compression-layer bug is not a fact about the build and must propagate instead.
    write('main.css', 'body { color: red; }');
    const html = write(
      'index.html',
      '<html><head><link rel="stylesheet" href="/main.css"></head></html>',
    );
    brotliMock.mockImplementationOnce(() => {
      throw new RangeError('BUG: caller passed bad compression options');
    });

    expect(() =>
      verifyCssBudget({ htmlFiles: [html], resolveHref, maxBytes: 5_000, measure: 'brotli' }),
    ).toThrow('BUG: caller passed bad compression options');
  });

  it('passes clean when render-blocking CSS exactly equals maxBytes (boundary, PR #4 IMPORTANT 4)', () => {
    write('main.css', 'x'.repeat(500));
    const html = write(
      'index.html',
      '<html><head><link rel="stylesheet" href="/main.css"></head></html>',
    );

    const result = verifyCssBudget({ htmlFiles: [html], resolveHref, maxBytes: 500 });

    expect(result).toEqual({ ok: true, problems: [] });
  });

  it('reports empty-input for an empty htmlFiles list instead of a vacuous pass (PR #4 MUST-FIX 2)', () => {
    const result = verifyCssBudget({ htmlFiles: [], resolveHref, maxBytes: 1_000_000 });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([expect.objectContaining({ kind: 'empty-input' })]);
  });

  it(
    'reports unreadable-html for a missing HTML file WITHOUT throwing and WITHOUT losing an ' +
      'over-budget finding already collected for another document in the same batch ' +
      "(PR #4 MUST-FIX 1, the reviewer's exact reproduction)",
    () => {
      write('main.css', 'x'.repeat(10_000));
      const overBudgetHtml = write(
        'over-budget.html',
        '<html><head><link rel="stylesheet" href="/main.css"></head></html>',
      );
      const missingHtml = join(root, 'does-not-exist.html'); // never written

      let result: ReturnType<typeof verifyCssBudget> | undefined;
      expect(() => {
        result = verifyCssBudget({
          htmlFiles: [overBudgetHtml, missingHtml],
          resolveHref,
          maxBytes: 10,
        });
      }).not.toThrow();

      expect(result?.ok).toBe(false);
      expect(result?.problems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'over-budget', html: overBudgetHtml }),
          expect.objectContaining({ kind: 'unreadable-html', html: missingHtml }),
        ]),
      );
      expect(result?.problems).toHaveLength(2);
    },
  );

  it('reports unreadable-file when resolveHref names a path that does not exist on disk (PR #4 MUST-FIX 1)', () => {
    const html = write(
      'index.html',
      '<html><head><link rel="stylesheet" href="/ghost.css"></head></html>',
    );
    const ghostPath = join(root, 'ghost.css'); // never written
    const resolveToGhost = () => ghostPath;

    const result = verifyCssBudget({
      htmlFiles: [html],
      resolveHref: resolveToGhost,
      maxBytes: 1_000_000,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: 'unreadable-file', file: ghostPath, href: '/ghost.css' }),
    ]);
  });

  it('reports resolver-threw, distinct from unresolvable-href, when resolveHref itself throws (PR #4 IMPORTANT 3)', () => {
    const html = write(
      'index.html',
      '<html><head><link rel="stylesheet" href="/main.css"></head></html>',
    );
    const throwingResolver = () => {
      throw new Error('boom: unguarded statSync inside consumer code');
    };

    const result = verifyCssBudget({
      htmlFiles: [html],
      resolveHref: throwingResolver,
      maxBytes: 1_000_000,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: 'resolver-threw', href: '/main.css' }),
    ]);
  });

  it('propagates a resolveHref contract violation ({notAPath:true}) instead of misreporting it as unreadable-file', () => {
    // Round 4 review redesign: a resolveHref that violates its declared string | undefined
    // contract now throws from OUR OWN assertResolverReturn boundary check, before the bad value
    // ever reaches readFileSync — not from Node's internal argument validation.
    const html = write(
      'index.html',
      '<html><head><link rel="stylesheet" href="/main.css"></head></html>',
    );
    // biome-ignore lint/suspicious/noExplicitAny: deliberately violating the resolver contract
    const contractViolatingResolver = (() => ({ notAPath: true })) as any;

    let caught: unknown;
    try {
      verifyCssBudget({
        htmlFiles: [html],
        resolveHref: contractViolatingResolver,
        maxBytes: 1_000_000,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toContain('resolveHref');
    expect((caught as Error).message).toContain('/main.css');
  });

  it('propagates a resolveHref returning a URL object instead of misreporting it as unreadable-file (round 4 Finding B)', () => {
    // A resolver returning new URL(href, cdnBase) instead of .pathname is a far likelier slip than
    // {notAPath:true} — and under the round-3 allowlist design it slipped through entirely
    // (readFileSync throws ERR_INVALID_URL_SCHEME for a URL object, uncovered by the allowlist,
    // so it was misreported as a plausible-looking unreadable-file). The boundary check here
    // rejects ANY non-string/non-undefined return, so this needs no special-casing.
    const html = write(
      'index.html',
      '<html><head><link rel="stylesheet" href="/main.css"></head></html>',
    );

    let caught: unknown;
    try {
      verifyCssBudget({
        htmlFiles: [html],
        resolveHref: () => new URL('https://cdn.example.com/main.css') as unknown as string,
        maxBytes: 1_000_000,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toContain('URL object');
  });

  it('propagates a resolveHref returning a Proxy instead of misreporting it as unreadable-file (round 4 Finding B)', () => {
    const html = write(
      'index.html',
      '<html><head><link rel="stylesheet" href="/main.css"></head></html>',
    );
    const proxyReturn = new Proxy({}, { get: () => 'trap' }) as unknown as string;

    let caught: unknown;
    try {
      verifyCssBudget({
        htmlFiles: [html],
        resolveHref: () => proxyReturn,
        maxBytes: 1_000_000,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toContain('resolveHref');
  });

  it('reports a NUL byte in a resolved path as unreadable-file instead of throwing (round 4 Finding A)', () => {
    // A syntactically valid STRING path containing a NUL byte is a real fs condition
    // (readFileSync throws ERR_INVALID_ARG_VALUE for it) — not a caller contract violation. It
    // must pass assertResolverReturn (it IS a string) and be reported as a normal unreadable-file
    // finding, never re-thrown. Reproduction from round 4 review: a NUL byte committed into a
    // built <link href>, extracted verbatim by attr()'s [^"]*, flowing through a fully
    // contract-compliant resolver like (href) => join(dir, href).
    const html = write(
      'index.html',
      '<html><head><link rel="stylesheet" href="/main.css"></head></html>',
    );
    const nulBytePath = `${root}/does-not-exist\0.css`;

    const result = verifyCssBudget({
      htmlFiles: [html],
      resolveHref: () => nulBytePath,
      maxBytes: 1_000_000,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: 'unreadable-file', file: nulBytePath }),
    ]);
  });

  it('reports EISDIR (a real fs-layer condition) as unreadable-file, standing in for ERR_FS_FILE_TOO_LARGE (round 4 Finding A)', () => {
    // A real oversized (>2GiB) fixture is impractical in a test suite. EISDIR — resolving to a
    // real DIRECTORY instead of a file — is a genuine, fully reproducible fs-layer condition with
    // the same shape that matters here: a fact about the entity on disk, not a caller contract
    // violation, that the unconditional catch must report rather than filter and re-throw.
    const html = write(
      'index.html',
      '<html><head><link rel="stylesheet" href="/main.css"></head></html>',
    );

    const result = verifyCssBudget({
      htmlFiles: [html],
      resolveHref: () => root, // a real directory, not a file
      maxBytes: 1_000_000,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: 'unreadable-file', file: root }),
    ]);
  });

  // --- T2 (scan.ts extraction): attr() now comes from the shared ./scan.ts helper, which accepts
  // single-quoted attribute values too — a strict superset of this module's prior double-quote-only
  // behaviour (see scan.ts's attr() doc comment). Pinning it here so a future edit to scan.ts's
  // attr() cannot silently regress this consumer.

  it('reads single-quoted <link> attributes via the shared scan.ts attr() helper', () => {
    write('main.css', 'x'.repeat(100));
    const html = write(
      'index-single-quoted.html',
      "<html><head><link rel='stylesheet' href='/main.css'></head></html>",
    );

    const result = verifyCssBudget({ htmlFiles: [html], resolveHref, maxBytes: 1_000_000 });

    expect(result).toEqual({ ok: true, problems: [] });
  });
});

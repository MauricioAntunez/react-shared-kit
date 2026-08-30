import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal, verifyFontChain } from './fontChain.ts';

let root: string;
let noSignalHtml: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uxr-fontchain-'));
  // A document with neither a font preload nor an inline <style> — the baseline every test that
  // is not specifically exercising the exemption shapes uses, so those tests aren't accidentally
  // passing because of a stray exemption elsewhere in the fixture.
  noSignalHtml = write('index.html', '<!doctype html><html><body>hi</body></html>');
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
  // --- THE FIX: depth is measured from the DOCUMENT, not the entry stylesheet ---------------

  it('RED: reproduces the shipped miss — @font-face in the entry stylesheet, zero @imports, no preload, used to PASS', () => {
    // This is the exact defect this fix exists for. Under the prior (buggy) semantics, depth was
    // measured from the entry stylesheet, so a font declared directly in it scored depth 0 and
    // this call returned { ok: true, problems: [] }. The browser's preload scanner reads the
    // DOCUMENT, not this stylesheet — the font is undiscoverable until the stylesheet is fetched
    // and parsed, which is exactly the shape "a font file must never be imported via CSS" bans.
    const entry = write(
      'direct.css',
      `@font-face { font-family: 'Inter'; src: url('/inter.woff2') format('woff2'); font-display: swap; } body { color: red; }`,
    );

    const result = verifyFontChain({
      htmlFiles: [noSignalHtml],
      entryStylesheets: [entry],
      resolveImport: resolverFor({}),
    });

    expect(result.ok).toBe(false);
    const problem = result.problems.find((p) => p.kind === 'deep-font');
    expect(problem).toBeDefined();
    expect(problem?.subject).toBe('/inter.woff2');
    expect(problem?.chain).toEqual([entry]);
    expect(problem?.message).toContain('1 stylesheet hop');
    expect(problem?.message).toContain('must never be imported via CSS');
  });

  it('passes clean when the font is preloaded via <link rel="preload" as="font" crossorigin>', () => {
    const entry = write(
      'direct-preloaded.css',
      `@font-face { font-family: 'Inter'; src: url('/inter.woff2') format('woff2'); }`,
    );
    const html = write(
      'preloaded.html',
      '<!doctype html><html><head>' +
        '<link rel="preload" as="font" crossorigin href="/inter.woff2">' +
        '</head><body>hi</body></html>',
    );

    const result = verifyFontChain({
      htmlFiles: [html],
      entryStylesheets: [entry],
      resolveImport: resolverFor({}),
    });

    expect(result).toEqual({ ok: true, problems: [] });
  });

  it('does NOT exempt a preload missing crossorigin — that shape double-fetches the font', () => {
    const entry = write(
      'direct-preload-no-cors.css',
      `@font-face { font-family: 'Inter'; src: url('/inter.woff2') format('woff2'); }`,
    );
    const html = write(
      'preload-no-cors.html',
      '<!doctype html><html><head>' +
        '<link rel="preload" as="font" href="/inter.woff2">' +
        '</head><body>hi</body></html>',
    );

    const result = verifyFontChain({
      htmlFiles: [html],
      entryStylesheets: [entry],
      resolveImport: resolverFor({}),
    });

    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.kind === 'deep-font')).toBe(true);
  });

  it('passes clean when @font-face is declared inside an inline <style> in the document', () => {
    const entry = write(
      'direct-also-inline.css',
      `@font-face { font-family: 'Inter'; src: url('/inter.woff2') format('woff2'); }`,
    );
    const html = write(
      'inline.html',
      '<!doctype html><html><head><style>' +
        "@font-face { font-family: 'Inter'; src: url('/inter.woff2') format('woff2'); }" +
        '</style></head><body>hi</body></html>',
    );

    const result = verifyFontChain({
      htmlFiles: [html],
      entryStylesheets: [entry],
      resolveImport: resolverFor({}),
    });

    expect(result).toEqual({ ok: true, problems: [] });
  });

  it('reports a font behind one @import on top of the document->stylesheet hop, at depth 2', () => {
    const fontsSheet = write(
      'fonts.css',
      `@font-face { font-family: 'Inter'; src: url('/inter.woff2') format('woff2'); font-display: swap; }`,
    );
    const entry = write('entry.css', `@import "./fonts.css"; body { color: red; }`);

    const result = verifyFontChain({
      htmlFiles: [noSignalHtml],
      entryStylesheets: [entry],
      resolveImport: resolverFor({ './fonts.css': fontsSheet }),
    });

    expect(result.ok).toBe(false);
    const problem = result.problems.find((p) => p.kind === 'deep-font');
    expect(problem).toBeDefined();
    expect(problem?.subject).toBe('/inter.woff2');
    expect(problem?.chain).toEqual([entry, './fonts.css']);
    expect(problem?.message).toContain('2 stylesheet hop');
  });

  it('reports a font behind two levels of @import, at depth 3 (1 document hop + 2 import hops)', () => {
    const leaf = write(
      'leaf.css',
      `@font-face { font-family: 'Inter'; src: url('/inter.woff2') format('woff2'); }`,
    );
    const mid = write('mid.css', `@import "./leaf.css";`);
    const entry = write('entry-2.css', `@import "./mid.css";`);

    const result = verifyFontChain({
      htmlFiles: [noSignalHtml],
      entryStylesheets: [entry],
      resolveImport: resolverFor({ './mid.css': mid, './leaf.css': leaf }),
    });

    expect(result.ok).toBe(false);
    const problem = result.problems.find((p) => p.kind === 'deep-font');
    expect(problem).toBeDefined();
    expect(problem?.chain).toEqual([entry, './mid.css', './leaf.css']);
    expect(problem?.message).toContain('3 stylesheet hop');
  });

  it('there is no depth that passes without an exemption — no maxChainDepth knob exists to accept the defect', () => {
    // Owner ruling: "a font file must never be imported via CSS" is a hard rule, not a budget.
    // A consumer cannot opt into accepting an @import-nested font by raising a threshold, because
    // there is no threshold option any more (see VerifyFontChainOptions — no maxChainDepth field).
    const leaf = write(
      'leaf-nothresh.css',
      `@font-face { font-family: 'Inter'; src: url('/inter.woff2'); }`,
    );
    const entry = write('entry-nothresh.css', `@import "./leaf-nothresh.css";`);

    const result = verifyFontChain({
      htmlFiles: [noSignalHtml],
      entryStylesheets: [entry],
      // @ts-expect-error maxChainDepth is not part of the options type any more
      maxChainDepth: 99,
      resolveImport: resolverFor({ './leaf-nothresh.css': leaf }),
    });

    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.kind === 'deep-font')).toBe(true);
  });

  // --- The message: firm about the rule, dual remedy, still warns against blanket preloading -

  it('states that font-display: swap does not resolve the finding, naming both failure modes', () => {
    const fontsSheet = write(
      'fonts-swap.css',
      `@font-face { font-family: 'Inter'; src: url('/inter.woff2'); font-display: swap; }`,
    );
    const entry = write('entry-swap.css', `@import "./fonts-swap.css";`);

    const result = verifyFontChain({
      htmlFiles: [noSignalHtml],
      entryStylesheets: [entry],
      resolveImport: resolverFor({ './fonts-swap.css': fontsSheet }),
    });

    const problem = result.problems.find((p) => p.kind === 'deep-font');
    expect(problem?.message).toContain('font-display: swap does not fix this');
    expect(problem?.message).toContain('RENDERING');
    expect(problem?.message).toContain('DISCOVERY');
  });

  it('states both remedies, recommends inlining, and warns against preloading every face', () => {
    const entry = write(
      'direct-message.css',
      `@font-face { font-family: 'Inter'; src: url('/inter.woff2'); }`,
    );

    const result = verifyFontChain({
      htmlFiles: [noSignalHtml],
      entryStylesheets: [entry],
      resolveImport: resolverFor({}),
    });

    const problem = result.problems.find((p) => p.kind === 'deep-font');
    expect(problem?.message).toContain('inline this @font-face block');
    expect(problem?.message).toContain('preload');
    expect(problem?.message).toContain('Do NOT preload every face');
    expect(problem?.message).toContain('usually the better choice');
  });

  // --- Existing coverage, ported to the new required htmlFiles input -------------------------

  it('reports unresolvable @import specifiers as a problem, not a skipped check', () => {
    const entry = write('entry-broken.css', `@import "./missing.css";`);

    const result = verifyFontChain({
      htmlFiles: [noSignalHtml],
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
      htmlFiles: [noSignalHtml],
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
    // reached at depth 2 — 1 document hop + 1 import hop) and nothing else — no
    // `unreadable-stylesheet`, no pile of duplicates from walking the cycle repeatedly. That exact
    // shape is unreachable via the stack-overflow path, so it can only pass if the guard works.
    const aPath = join(root, 'a.css');
    const bPath = join(root, 'b.css');
    writeFileSync(aPath, `@import "./b.css";`);
    writeFileSync(
      bPath,
      `@import "./a.css"; @font-face { font-family: 'X'; src: url('/x.woff2'); }`,
    );

    const result = verifyFontChain({
      htmlFiles: [noSignalHtml],
      entryStylesheets: [aPath],
      resolveImport: resolverFor({ './a.css': aPath, './b.css': bPath }),
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: 'deep-font', chain: [aPath, './b.css'] }),
    ]);
  });

  it('reports the MINIMUM discovery depth, not whichever @import order the walk happens to see first', () => {
    // entry imports a.css THEN c.css. a.css also imports c.css. c.css carries the font.
    // c.css's true minimum depth is 2 (document -> entry -> c.css) even though a DFS following
    // import statements in file order would reach it via entry -> a.css -> c.css at depth 3 first.
    // Since there is no depth threshold any more, this only affects the reported number, not
    // ok/problems — pinned via the message text instead of a maxChainDepth-gated pass/fail.
    const c = write('c.css', `@font-face { font-family: 'X'; src: url('/c.woff2'); }`);
    const a = write('a-order.css', `@import "./c.css";`);
    const entry = write('entry-order.css', `@import "./a-order.css"; @import "./c.css";`);

    const result = verifyFontChain({
      htmlFiles: [noSignalHtml],
      entryStylesheets: [entry],
      resolveImport: resolverFor({ './a-order.css': a, './c.css': c }),
    });

    expect(result.ok).toBe(false);
    const problem = result.problems.find((p) => p.kind === 'deep-font');
    expect(problem?.chain).toEqual([entry, './c.css']);
    expect(problem?.message).toContain('2 stylesheet hop');
  });

  it('reports resolver-error, distinct from unresolvable-import, when resolveImport throws', () => {
    const entry = write('entry-throws.css', `@import "./boom.css";`);
    const boom = new Error('resolver blew up');

    const result = verifyFontChain({
      htmlFiles: [noSignalHtml],
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
      htmlFiles: [noSignalHtml],
      entryStylesheets: [entry],
      resolveImport: resolverFor({}),
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: 'unparseable-font-face', subject: entry }),
    ]);
  });

  it('reports unparseable-font-face with the RESOLVED file path, not the @import specifier, under a renaming resolver at depth > 0', () => {
    // Round 2 review finding: the only prior test for this kind put the truncated block in the
    // ENTRY sheet, where `chain[chain.length - 1]` (the specifier "as written") coincidentally
    // equals the resolved path. This is the module doc's own motivating scenario — a resolver that
    // does NOT return the specifier verbatim, which is how every real bundler resolver behaves
    // (alias/package resolution) — and it is one @import hop deep, so `chain.length > 1`.
    const nestedRealFile = write(
      'nested-real-file.css',
      `@font-face { font-family: 'Broken'; src: url('/broken.woff2');`, // no closing brace
    );
    const entry = write('entry-renamed.css', `@import "nested-specifier.css";`);

    const result = verifyFontChain({
      htmlFiles: [noSignalHtml],
      entryStylesheets: [entry],
      resolveImport: resolverFor({ 'nested-specifier.css': nestedRealFile }),
    });

    expect(result.ok).toBe(false);
    const problem = result.problems.find((p) => p.kind === 'unparseable-font-face');
    expect(problem).toBeDefined();
    // The reported subject must be the file that actually holds the malformed block — opening
    // the raw specifier "nested-specifier.css" would find nothing, since it never exists on disk.
    expect(problem?.subject).toBe(nestedRealFile);
    expect(problem?.subject).not.toBe('nested-specifier.css');
    expect(problem?.message).toContain(nestedRealFile);
  });

  it('reports the TRUE MINIMUM depth across a 3-level graph, not whichever path the queue order visits first', () => {
    // Round 2 review finding: the prior min-depth test only covered two paths that are both
    // direct children of the entry, resolved inside one synchronous loop before queue order (BFS
    // vs. a `pop()`-based LIFO mutation) could ever matter — a `shift()` -> `pop()` regression
    // slipped through it undetected. This fixture forces the queue to actually order across
    // levels: entry imports p.css THEN m.css; p.css imports shared.css directly (true depth 3:
    // document -> entry -> p.css -> shared.css); m.css imports n.css, which imports shared.css
    // (depth 4 via the longer path). With correct FIFO/BFS, shared.css is marked visited at
    // depth 3 (via p.css, processed first) and the later, longer arrival via n.css is skipped.
    const shared = write('shared.css', `@font-face { font-family: 'S'; src: url('/s.woff2'); }`);
    const p = write('p.css', `@import "./shared.css";`);
    const n = write('n.css', `@import "./shared.css";`);
    const m = write('m.css', `@import "./n.css";`);
    const entry = write('entry-3level.css', `@import "./p.css"; @import "./m.css";`);

    const result = verifyFontChain({
      htmlFiles: [noSignalHtml],
      entryStylesheets: [entry],
      resolveImport: resolverFor({
        './p.css': p,
        './m.css': m,
        './n.css': n,
        './shared.css': shared,
      }),
    });

    expect(result.ok).toBe(false);
    const problems = result.problems.filter((p2) => p2.kind === 'deep-font');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.chain).toEqual([entry, './p.css', './shared.css']);
    expect(problems[0]?.message).toContain('3 stylesheet hop');
  });

  it('ships chain = [entry] (never an empty array) when the entry stylesheet itself is unreadable', () => {
    const missing = join(root, 'gone.css');

    const result = verifyFontChain({
      htmlFiles: [noSignalHtml],
      entryStylesheets: [missing],
      resolveImport: resolverFor({}),
    });

    const problem = result.problems.find((p) => p.kind === 'unreadable-stylesheet');
    expect(problem?.chain).toEqual([missing]);
  });

  it('propagates a resolver-contract violation ({notAPath:true}) instead of misreporting it as unreadable-stylesheet', () => {
    // Round 4 review redesign: a `resolveImport` that violates its declared `string | undefined`
    // contract now throws from OUR OWN `assertResolverReturn` boundary check, before the bad
    // value ever reaches `readFileSync` — not from Node's internal argument validation. Earlier
    // rounds tried to classify the error AFTER readFileSync threw it (by .code, by prefix, by a
    // narrow allowlist) and each attempt failed a different way; this validates the input instead.
    const entry = write('entry-contract-violation.css', `@import "./whatever.css";`);
    let caught: unknown;
    try {
      verifyFontChain({
        htmlFiles: [noSignalHtml],
        entryStylesheets: [entry],
        // biome-ignore lint/suspicious/noExplicitAny: deliberately violating the resolver contract
        resolveImport: (() => ({ notAPath: true })) as any,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toContain('resolveImport');
    expect((caught as Error).message).toContain('./whatever.css');
  });

  it('propagates a resolveImport returning a URL object instead of misreporting it as unreadable-stylesheet (round 4 Finding B)', () => {
    // A resolver returning `new URL(specifier, base)` instead of `.pathname` is a far likelier
    // slip than {notAPath:true} — and under the round-3 allowlist design it slipped through
    // entirely (readFileSync throws ERR_INVALID_URL_SCHEME for a URL object, which was not in the
    // allowlist, so it was misreported as unreadable-stylesheet). The boundary check here rejects
    // ANY non-string/non-undefined return, so this needs no special-casing.
    const entry = write('entry-url-return.css', `@import "./whatever.css";`);
    let caught: unknown;
    try {
      verifyFontChain({
        htmlFiles: [noSignalHtml],
        entryStylesheets: [entry],
        resolveImport: () => new URL('https://example.com/whatever.css') as unknown as string,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toContain('URL object');
  });

  it('propagates a resolveImport returning a Proxy instead of misreporting it as unreadable-stylesheet (round 4 Finding B)', () => {
    // Any exotic non-string shape must be rejected, not just the two shapes already covered by
    // other tests — a Proxy is typeof 'object', same as a plain object, and must fail the same way.
    const entry = write('entry-proxy-return.css', `@import "./whatever.css";`);
    const proxyReturn = new Proxy({}, { get: () => 'trap' }) as unknown as string;
    let caught: unknown;
    try {
      verifyFontChain({
        htmlFiles: [noSignalHtml],
        entryStylesheets: [entry],
        resolveImport: () => proxyReturn,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toContain('resolveImport');
  });

  it('reports a NUL byte in a resolved path as unreadable-stylesheet instead of throwing (round 4 Finding A)', () => {
    // A syntactically valid STRING path containing a NUL byte is a real fs condition
    // (readFileSync throws ERR_INVALID_ARG_VALUE for it) — not a caller contract violation. It
    // must pass assertResolverReturn (it IS a string) and be reported as a normal
    // unreadable-stylesheet finding, never re-thrown.
    const entry = write('entry-nul-byte.css', `@import "./whatever.css";`);
    const nulBytePath = `${root}/does-not-exist\0.css`;

    const result = verifyFontChain({
      htmlFiles: [noSignalHtml],
      entryStylesheets: [entry],
      resolveImport: () => nulBytePath,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: 'unreadable-stylesheet', subject: nulBytePath }),
    ]);
  });

  it('reports EISDIR (a real fs-layer condition) as unreadable-stylesheet, standing in for ERR_FS_FILE_TOO_LARGE (round 4 Finding A)', () => {
    // A real oversized (>2GiB) fixture is impractical in a test suite. EISDIR — resolving to a
    // real DIRECTORY instead of a file — is a genuine, fully reproducible fs-layer condition with
    // the same shape that matters here: a fact about the entity on disk, not a caller contract
    // violation, that the unconditional catch must report rather than filter and re-throw.
    const entry = write('entry-eisdir.css', `@import "./whatever.css";`);

    const result = verifyFontChain({
      htmlFiles: [noSignalHtml],
      entryStylesheets: [entry],
      resolveImport: () => root, // a real directory, not a file
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: 'unreadable-stylesheet', subject: root }),
    ]);
  });

  it('propagates a stripComments failure instead of misreporting it as unreadable-stylesheet (round 5 review finding)', () => {
    // The file is read successfully — only the comment-stripping TRANSFORM fails. Before round 5's
    // fix, readStylesheet's one try/catch spanned both readFileSync and stripComments, so this
    // would have reported {kind: 'unreadable-stylesheet', message: 'could not read ...'} about a
    // file that WAS read. A bug in our own transform is not a fact about the build and must
    // propagate instead. stripComments has no external module boundary to mock (unlike
    // brotliCompressSync in cssBudget.ts), so `internal.stripComments` is a test-only indirection
    // point that exists purely to make this provable.
    const entry = write('entry-strip-comments-bug.css', `body { color: red; }`);
    const spy = vi.spyOn(internal, 'stripComments').mockImplementationOnce(() => {
      throw new RangeError('BUG: comment-stripping regex blew up');
    });

    try {
      expect(() =>
        verifyFontChain({
          htmlFiles: [noSignalHtml],
          entryStylesheets: [entry],
          resolveImport: () => undefined,
        }),
      ).toThrow('BUG: comment-stripping regex blew up');
    } finally {
      spy.mockRestore();
    }
  });

  // --- Anti-vacuity: empty input must never read as clean, for EITHER list -------------------

  it('RED: fires empty-input when entryStylesheets is empty', () => {
    const result = verifyFontChain({
      htmlFiles: [noSignalHtml],
      entryStylesheets: [],
      resolveImport: resolverFor({}),
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: 'empty-input', subject: '(entryStylesheets)' }),
    ]);
  });

  it('RED: fires empty-input when htmlFiles is empty', () => {
    const entry = write('entry-no-html.css', `body { color: red; }`);

    const result = verifyFontChain({
      htmlFiles: [],
      entryStylesheets: [entry],
      resolveImport: resolverFor({}),
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: 'empty-input', subject: '(htmlFiles)' }),
    ]);
  });

  it('reports both empty-input kinds when both lists are empty, without also walking anything', () => {
    const result = verifyFontChain({
      htmlFiles: [],
      entryStylesheets: [],
      resolveImport: resolverFor({}),
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: 'empty-input', subject: '(htmlFiles)' }),
      expect.objectContaining({ kind: 'empty-input', subject: '(entryStylesheets)' }),
    ]);
  });

  // --- unreadable-html: reported, never thrown, never abandons other files -------------------

  it('RED: reports unreadable-html instead of throwing when an html file is a directory', () => {
    const badHtml = join(root, 'bad.html');
    mkdirSync(badHtml);
    const entry = write('entry-bad-html.css', `body { color: red; }`);

    let threw = false;
    let result: ReturnType<typeof verifyFontChain> | undefined;
    try {
      result = verifyFontChain({
        htmlFiles: [badHtml],
        entryStylesheets: [entry],
        resolveImport: resolverFor({}),
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(
      result?.problems.some((p) => p.kind === 'unreadable-html' && p.subject === badHtml),
    ).toBe(true);
  });

  it('an unreadable html file does not stop a preload elsewhere from being collected', () => {
    const badHtml = join(root, 'bad2.html');
    mkdirSync(badHtml);
    const goodHtml = write(
      'good.html',
      '<link rel="preload" as="font" crossorigin href="/inter.woff2">',
    );
    const entry = write(
      'entry-mixed-html.css',
      `@font-face { font-family: 'Inter'; src: url('/inter.woff2'); }`,
    );

    const result = verifyFontChain({
      htmlFiles: [badHtml, goodHtml],
      entryStylesheets: [entry],
      resolveImport: resolverFor({}),
    });

    expect(result.problems.some((p) => p.kind === 'unreadable-html')).toBe(true);
    expect(result.problems.some((p) => p.kind === 'deep-font')).toBe(false);
  });

  it('propagates an htmlFiles element contract violation instead of misreporting it', () => {
    const entry = write('entry-html-contract.css', `body { color: red; }`);
    let caught: unknown;
    try {
      verifyFontChain({
        // biome-ignore lint/suspicious/noExplicitAny: deliberately violating the htmlFiles element contract
        htmlFiles: [{ notAPath: true } as any],
        entryStylesheets: [entry],
        resolveImport: resolverFor({}),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toContain('htmlFiles[0]');
  });
});

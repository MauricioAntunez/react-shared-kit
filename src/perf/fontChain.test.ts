import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FontChainProblem } from './fontChain.ts';
import { internal, verifyFontChain } from './fontChain.ts';

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
 * would supply. Returns undefined for anything not in the map, matching the "unresolvable"
 * contract. Shared shape for both `resolveStylesheet` and `resolveImport` — they take the same
 * `(specifier) => string | undefined` signature. */
function resolverFor(map: Record<string, string>): (specifier: string) => string | undefined {
  return (specifier) => map[specifier];
}

/** A stub `resolveStylesheet` that always fails — used by tests exercising `resolveImport`/parsing
 * behaviour where the document either has no `<link rel="stylesheet">` at all (so the resolver is
 * never called) or a caller wires the entry directly via a single href/path pair through
 * `htmlWithStylesheet` + `resolverFor` instead. */
const noStylesheets = resolverFor({});

/** One document with a single `<link rel="stylesheet" href="STYLESHEET_HREF">` plus arbitrary
 * extra head markup (a preload tag, an inline `<style>`, an HTML comment, ...). This is the
 * standard fixture shape for every test that needs exactly one entry stylesheet to walk — pair it
 * with `resolverFor({ [STYLESHEET_HREF]: entryPath })` for `resolveStylesheet`. */
const STYLESHEET_HREF = '/entry.css';
function htmlWithStylesheet(name: string, extraHead = ''): string {
  return write(
    name,
    `<!doctype html><html><head><link rel="stylesheet" href="${STYLESHEET_HREF}">${extraHead}</head><body>hi</body></html>`,
  );
}

/** A document with NO `<link rel="stylesheet">` at all — the baseline every test that only needs
 * "a valid document with no font signal and no stylesheet of its own" uses (e.g. a *different*
 * document in a multi-document test where only one page matters for the assertion). */
function htmlWithNoStylesheet(name: string): string {
  return write(name, '<!doctype html><html><body>hi</body></html>');
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
    const html = htmlWithStylesheet('index.html');

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: entry }),
      resolveImport: resolverFor({}),
    });

    expect(result.ok).toBe(false);
    const problem = result.problems.find((p) => p.kind === 'deep-font');
    expect(problem).toBeDefined();
    expect(problem?.document).toBe(html);
    expect(problem?.fontUrl).toBe('/inter.woff2');
    expect(problem?.chain).toEqual([entry]);
    expect(problem?.message).toContain('1 stylesheet hop');
    expect(problem?.message).toContain('must never be imported via CSS');
  });

  it('K1 RED: reports deep-font for a chained face whose LAST src: declaration has no trailing semicolon (minified CSS)', () => {
    // Fontchain plan (docs/plans/fontchain-minified-src.md), K1. CSS makes the `;` after a
    // block's last declaration optional, and every minifier omits it — so a real production
    // stylesheet ends `...url(...)format("woff2")}` with no `;` before the `}`. Before the K2
    // fix, `urlsInFontFaceBody`'s `/src\s*:\s*([^;]+);/g` required that trailing `;` to match at
    // all, so this exact shape contributed ZERO urls and the font was never discovered — the gate
    // returned a false `{ ok: true, problems: [] }` on the one CSS shape every real build ships.
    const nested = write(
      'nested-minified.css',
      `@font-face{font-family:X;src:url(/x.woff2) format("woff2")}`,
    );
    const entry = write('entry-minified.css', `@import "./nested-minified.css";`);
    const html = htmlWithStylesheet('index-minified.html');

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: entry }),
      resolveImport: resolverFor({ './nested-minified.css': nested }),
    });

    expect(result.ok).toBe(false);
    const problem = result.problems.find((p) => p.kind === 'deep-font');
    expect(problem).toBeDefined();
    expect(problem?.fontUrl).toBe('/x.woff2');
  });

  it('K3: reaches the SAME verdict whether or not the last src: declaration in a @font-face block carries a trailing semicolon', () => {
    // Mechanical pairing (not narrative) per the plan's K3: both fixtures below differ ONLY in
    // the trailing `;` before the block's closing `}`, and must produce the identical shape of
    // finding — so a future edit that re-breaks either direction goes red here.
    const variants = [
      {
        label: 'no trailing semicolon (minified)',
        body: `@font-face{font-family:X;src:url(/x.woff2) format("woff2")}`,
      },
      {
        label: 'trailing semicolon (pretty-printed)',
        body: `@font-face{font-family:X;src:url(/x.woff2) format("woff2");}`,
      },
    ];

    const verdicts = variants.map(({ label, body }, i) => {
      const nested = write(`nested-k3-${i}.css`, body);
      const entry = write(`entry-k3-${i}.css`, `@import "./nested-k3-${i}.css";`);
      const html = htmlWithStylesheet(`index-k3-${i}.html`);

      const result = verifyFontChain({
        htmlFiles: [html],
        resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: entry }),
        resolveImport: resolverFor({ [`./nested-k3-${i}.css`]: nested }),
      });

      const problem = result.problems.find((p) => p.kind === 'deep-font');
      return { label, ok: result.ok, deepFontUrl: problem?.fontUrl };
    });

    expect(verdicts[0]).toEqual({ label: variants[0]?.label, ok: false, deepFontUrl: '/x.woff2' });
    expect(verdicts[1]).toEqual({ label: variants[1]?.label, ok: false, deepFontUrl: '/x.woff2' });
  });

  it('K5: reports EVERY src: descriptor in a block whose last one is unterminated (multi-descriptor minified)', () => {
    // Raised independently by two review lenses on PR #7: the K1/K3 pair pins the single-`src:`
    // shape, and the fix handles the multi-descriptor shape correctly today — but nothing pinned
    // it. A legacy `src:url(...eot);` followed by an unterminated modern `src:` is the exact case
    // where a future edit to the regex's loop or anchoring could silently re-break ONLY the last
    // descriptor, which is the one carrying the woff2 every modern browser actually fetches.
    // Whitespace before the closing `}` is folded in here for the same reason: `[^;]+` is
    // whitespace-agnostic by construction, and that is a property worth pinning rather than
    // re-deriving.
    const nested = write(
      'nested-multi.css',
      `@font-face{font-family:X;src:url(/legacy.eot);src:url(/x.woff2) format("woff2")  }`,
    );
    const entry = write('entry-multi.css', `@import "./nested-multi.css";`);
    const html = htmlWithStylesheet('index-multi.html');

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: entry }),
      resolveImport: resolverFor({ './nested-multi.css': nested }),
    });

    expect(result.ok).toBe(false);
    const fontUrls = result.problems
      .filter((p) => p.kind === 'deep-font')
      .map((p) => p.fontUrl)
      .sort();
    expect(fontUrls).toEqual(['/legacy.eot', '/x.woff2']);
  });

  it('passes clean when the font is preloaded via <link rel="preload" as="font" crossorigin>', () => {
    const entry = write(
      'direct-preloaded.css',
      `@font-face { font-family: 'Inter'; src: url('/inter.woff2') format('woff2'); }`,
    );
    const html = htmlWithStylesheet(
      'preloaded.html',
      '<link rel="preload" as="font" crossorigin href="/inter.woff2">',
    );

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: entry }),
      resolveImport: resolverFor({}),
    });

    expect(result).toEqual({ ok: true, problems: [] });
  });

  it('does NOT exempt a preload missing crossorigin — that shape double-fetches the font', () => {
    const entry = write(
      'direct-preload-no-cors.css',
      `@font-face { font-family: 'Inter'; src: url('/inter.woff2') format('woff2'); }`,
    );
    const html = htmlWithStylesheet(
      'preload-no-cors.html',
      '<link rel="preload" as="font" href="/inter.woff2">',
    );

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: entry }),
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
    const html = htmlWithStylesheet(
      'inline.html',
      '<style>' +
        "@font-face { font-family: 'Inter'; src: url('/inter.woff2') format('woff2'); }" +
        '</style>',
    );

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: entry }),
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
    const html = htmlWithStylesheet('index-import.html');

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: entry }),
      resolveImport: resolverFor({ './fonts.css': fontsSheet }),
    });

    expect(result.ok).toBe(false);
    const problem = result.problems.find((p) => p.kind === 'deep-font');
    expect(problem).toBeDefined();
    expect(problem?.fontUrl).toBe('/inter.woff2');
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
    const html = htmlWithStylesheet('index-2level.html');

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: entry }),
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
    const html = htmlWithStylesheet('index-nothresh.html');

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: entry }),
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
    const html = htmlWithStylesheet('index-swap.html');

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: entry }),
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
    const html = htmlWithStylesheet('index-message.html');

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: entry }),
      resolveImport: resolverFor({}),
    });

    const problem = result.problems.find((p) => p.kind === 'deep-font');
    expect(problem?.message).toContain('inline this @font-face block');
    expect(problem?.message).toContain('preload');
    expect(problem?.message).toContain('Do NOT preload every face');
    expect(problem?.message).toContain('usually the better choice');
  });

  // --- Existing coverage, ported to the new per-document resolveStylesheet input -------------

  it('reports unresolvable @import specifiers as a problem, not a skipped check', () => {
    const entry = write('entry-broken.css', `@import "./missing.css";`);
    const html = htmlWithStylesheet('index-broken.html');

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: entry }),
      resolveImport: resolverFor({}),
    });

    expect(result.ok).toBe(false);
    const problem = result.problems.find((p) => p.kind === 'unresolvable-import');
    expect(problem).toBeDefined();
    expect(problem?.specifier).toBe('./missing.css');
    // K5 item 3: `document` is threaded onto every emission site, not just deep-font.
    expect(problem?.document).toBe(html);
  });

  it('reports an unreadable entry stylesheet as a problem, never a silent pass', () => {
    const missing = join(root, 'does-not-exist.css');
    const html = htmlWithStylesheet('index-unreadable-entry.html');

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: missing }),
      resolveImport: resolverFor({}),
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      // K5 item 3: document is pinned at this emission site too.
      expect.objectContaining({
        kind: 'unreadable-stylesheet',
        stylesheet: missing,
        document: html,
      }),
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
    const html = htmlWithStylesheet('index-cycle.html');

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: aPath }),
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
    const html = htmlWithStylesheet('index-order.html');

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: entry }),
      resolveImport: resolverFor({ './a-order.css': a, './c.css': c }),
    });

    expect(result.ok).toBe(false);
    const problem = result.problems.find((p) => p.kind === 'deep-font');
    expect(problem?.chain).toEqual([entry, './c.css']);
    expect(problem?.message).toContain('2 stylesheet hop');
  });

  it('reports resolver-error, distinct from unresolvable-import, when resolveImport throws', () => {
    const entry = write('entry-throws.css', `@import "./boom.css";`);
    const html = htmlWithStylesheet('index-resolver-throws.html');
    const boom = new Error('resolver blew up');

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: entry }),
      resolveImport: () => {
        throw boom;
      },
    });

    expect(result.ok).toBe(false);
    const problem = result.problems.find((p) => p.kind === 'resolver-error');
    expect(problem).toBeDefined();
    expect(problem?.specifier).toBe('./boom.css');
    expect(problem?.message).toContain('resolver blew up');
    expect(result.problems.some((p) => p.kind === 'unresolvable-import')).toBe(false);
    // K5 item 3: document is pinned at this emission site too.
    expect(problem?.document).toBe(html);
  });

  it('reports unparseable-font-face for a truncated @font-face block instead of dropping it silently', () => {
    const entry = write(
      'truncated.css',
      `@font-face { font-family: 'Broken'; src: url('/broken.woff2');`, // no closing brace
    );
    const html = htmlWithStylesheet('index-truncated.html');

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: entry }),
      resolveImport: resolverFor({}),
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      // K5 item 3: document is pinned at this emission site too.
      expect.objectContaining({ kind: 'unparseable-font-face', stylesheet: entry, document: html }),
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
    const html = htmlWithStylesheet('index-renamed.html');

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: entry }),
      resolveImport: resolverFor({ 'nested-specifier.css': nestedRealFile }),
    });

    expect(result.ok).toBe(false);
    const problem = result.problems.find((p) => p.kind === 'unparseable-font-face');
    expect(problem).toBeDefined();
    // The reported stylesheet must be the file that actually holds the malformed block — opening
    // the raw specifier "nested-specifier.css" would find nothing, since it never exists on disk.
    expect(problem?.stylesheet).toBe(nestedRealFile);
    expect(problem?.stylesheet).not.toBe('nested-specifier.css');
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
    const html = htmlWithStylesheet('index-3level.html');

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: entry }),
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
    const html = htmlWithStylesheet('index-gone.html');

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: missing }),
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
    const html = htmlWithStylesheet('index-contract-violation.html');
    let caught: unknown;
    try {
      verifyFontChain({
        htmlFiles: [html],
        resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: entry }),
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
    const html = htmlWithStylesheet('index-url-return.html');
    let caught: unknown;
    try {
      verifyFontChain({
        htmlFiles: [html],
        resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: entry }),
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
    const html = htmlWithStylesheet('index-proxy-return.html');
    const proxyReturn = new Proxy({}, { get: () => 'trap' }) as unknown as string;
    let caught: unknown;
    try {
      verifyFontChain({
        htmlFiles: [html],
        resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: entry }),
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
    const html = htmlWithStylesheet('index-nul-byte.html');
    const nulBytePath = `${root}/does-not-exist\0.css`;

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: entry }),
      resolveImport: () => nulBytePath,
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: 'unreadable-stylesheet', stylesheet: nulBytePath }),
    ]);
  });

  it('reports EISDIR (a real fs-layer condition) as unreadable-stylesheet, standing in for ERR_FS_FILE_TOO_LARGE (round 4 Finding A)', () => {
    // A real oversized (>2GiB) fixture is impractical in a test suite. EISDIR — resolving to a
    // real DIRECTORY instead of a file — is a genuine, fully reproducible fs-layer condition with
    // the same shape that matters here: a fact about the entity on disk, not a caller contract
    // violation, that the unconditional catch must report rather than filter and re-throw.
    const entry = write('entry-eisdir.css', `@import "./whatever.css";`);
    const html = htmlWithStylesheet('index-eisdir.html');

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: entry }),
      resolveImport: () => root, // a real directory, not a file
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: 'unreadable-stylesheet', stylesheet: root }),
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
    const html = htmlWithStylesheet('index-strip-comments-bug.html');
    const spy = vi.spyOn(internal, 'stripComments').mockImplementationOnce(() => {
      throw new RangeError('BUG: comment-stripping regex blew up');
    });

    try {
      expect(() =>
        verifyFontChain({
          htmlFiles: [html],
          resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: entry }),
          resolveImport: () => undefined,
        }),
      ).toThrow('BUG: comment-stripping regex blew up');
    } finally {
      spy.mockRestore();
    }
  });

  // --- CRITICAL 1 (font half): HTML comments must never be treated as live -------------------

  it('does NOT exempt a font whose only preload link is commented out (a debug-leftover comment must not silence a real defect)', () => {
    const entry = write(
      'entry-commented-preload.css',
      `@font-face { font-family: 'Inter'; src: url('/inter.woff2') format('woff2'); }`,
    );
    const html = htmlWithStylesheet(
      'index-commented-preload.html',
      '<!-- <link rel="preload" as="font" crossorigin href="/inter.woff2"> -->',
    );

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: entry }),
      resolveImport: resolverFor({}),
    });

    expect(result.ok).toBe(false);
    expect(
      result.problems.some((p) => p.kind === 'deep-font' && p.fontUrl === '/inter.woff2'),
    ).toBe(true);
  });

  it('does NOT walk a commented-out <link rel="stylesheet"> as part of the graph', () => {
    const entry = write(
      'entry-would-be-commented.css',
      `@font-face { font-family: 'Inter'; src: url('/inter.woff2'); }`,
    );
    const html = write(
      'index-commented-stylesheet.html',
      `<!doctype html><html><head><!-- <link rel="stylesheet" href="${STYLESHEET_HREF}"> --></head><body>hi</body></html>`,
    );

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: entry }),
      resolveImport: resolverFor({}),
    });

    // The document now has zero LIVE stylesheets — it must be reported as such (see the
    // empty-input-per-document tests below), never silently pass because a commented-out link
    // still counted as one.
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: 'empty-input', document: html, input: '(stylesheets)' }),
    ]);
  });

  it('RED (round-2 review MUST-FIX #2 reproduction): a well-formed link followed by an unterminated <!-- must not read as a clean pass, even though the hrefless/unresolvable links hidden behind it are never seen', () => {
    // Reviewer's exact scenario: a well-formed stylesheet link, then an unterminated `<!--`, then
    // a hrefless link and an unresolvable one. BEFORE this fix: the entry stylesheet (clean, no
    // font-face at all) resolves and walks with zero problems, and the two links after the
    // unterminated comment are silently stripped away along with it — `verifyFontChain` returned
    // `{ ok: true, problems: [] }`, hiding a truncated build artifact AND two real defects it
    // happened to swallow. The per-document `empty-input` never fired either, because the first
    // stylesheet link WAS found and WAS fine.
    const entry = write('entry-clean.css', 'body { color: red; }');
    const html = write(
      'index-unterminated-comment.html',
      `<!doctype html><html><head><link rel="stylesheet" href="${STYLESHEET_HREF}">` +
        '<!-- unterminated comment starts here ' +
        '<link rel="stylesheet">' +
        '<link rel="stylesheet" href="/never-resolves.css">' +
        '</head><body>hi</body></html>',
    );

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: entry }),
      resolveImport: resolverFor({}),
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: 'unterminated-html-comment', document: html, html }),
    ]);
  });

  it('does NOT exempt an inline @font-face declared inside a commented-out <style> block', () => {
    const entry = write(
      'entry-commented-inline.css',
      `@font-face { font-family: 'Inter'; src: url('/inter.woff2'); }`,
    );
    const html = htmlWithStylesheet(
      'index-commented-inline.html',
      "<!-- <style>@font-face { font-family: 'Inter'; src: url('/inter.woff2'); }</style> -->",
    );

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: entry }),
      resolveImport: resolverFor({}),
    });

    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.kind === 'deep-font')).toBe(true);
  });

  // --- CRITICAL 2: per-document scoping — a preload in one document never exempts another -----

  it('reports pageB (which does not preload) even though pageA (which does) shares the same stylesheet', () => {
    const shared = write(
      'shared.css',
      `@font-face { font-family: 'Inter'; src: url('/inter.woff2') format('woff2'); }`,
    );
    const pageA = htmlWithStylesheet(
      'pageA.html',
      '<link rel="preload" as="font" crossorigin href="/inter.woff2">',
    );
    const pageB = htmlWithStylesheet('pageB.html');

    const result = verifyFontChain({
      htmlFiles: [pageA, pageB],
      resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: shared }),
      resolveImport: resolverFor({}),
    });

    expect(result.ok).toBe(false);
    const deepFontProblems = result.problems.filter((p) => p.kind === 'deep-font');
    expect(deepFontProblems).toHaveLength(1);
    expect(deepFontProblems[0]?.document).toBe(pageB);
    // pageA must NOT be reported — its own preload correctly exempts it.
    expect(deepFontProblems.some((p) => p.document === pageA)).toBe(false);
  });

  it('reports a document with no <link rel="stylesheet"> at all, never as a vacuous pass', () => {
    const html = htmlWithNoStylesheet('index-no-stylesheet.html');

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: noStylesheets,
      resolveImport: resolverFor({}),
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: 'empty-input', document: html, input: '(stylesheets)' }),
    ]);
  });

  it('reports unresolvable-stylesheet, never a silent skip, when resolveStylesheet returns undefined', () => {
    const html = htmlWithStylesheet('index-unresolvable-stylesheet.html');

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: noStylesheets,
      resolveImport: resolverFor({}),
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({
        kind: 'unresolvable-stylesheet',
        document: html,
        href: STYLESHEET_HREF,
      }),
    ]);
  });

  it('reports unresolvable-stylesheet, distinct case, when resolveStylesheet throws', () => {
    const html = htmlWithStylesheet('index-resolvestylesheet-throws.html');
    const boom = new Error('resolveStylesheet blew up');

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: () => {
        throw boom;
      },
      resolveImport: resolverFor({}),
    });

    expect(result.ok).toBe(false);
    const problem = result.problems.find((p) => p.kind === 'unresolvable-stylesheet');
    expect(problem).toBeDefined();
    expect(problem?.href).toBe(STYLESHEET_HREF);
    expect(problem?.message).toContain('resolveStylesheet blew up');
    // Round-2 review IMPORTANT #4: this was the one unpinned `document` emission site out of ten
    // — mutating `document` to `''` in the CATCH branch of `resolveStylesheetHref` left all 435
    // tests green, while the sibling undefined-return branch above already pinned it. Verified by
    // reproduction: mutating the catch branch's `document,` to `document: '',` makes this
    // assertion fail (see task evidence).
    expect(problem?.document).toBe(html);
  });

  it('propagates a resolveStylesheet contract violation instead of misreporting it', () => {
    const html = htmlWithStylesheet('index-resolvestylesheet-contract.html');
    let caught: unknown;
    try {
      verifyFontChain({
        htmlFiles: [html],
        // biome-ignore lint/suspicious/noExplicitAny: deliberately violating the resolver contract
        resolveStylesheet: (() => ({ notAPath: true })) as any,
        resolveImport: resolverFor({}),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toContain('resolveStylesheet');
  });

  // --- IMPORTANT 5: attr() must accept single-quoted attribute values too --------------------

  it('exempts a font preloaded with single-quoted <link> attributes (valid HTML5)', () => {
    const entry = write(
      'entry-single-quoted.css',
      `@font-face { font-family: 'Inter'; src: url('/inter.woff2'); }`,
    );
    const html = write(
      'index-single-quoted.html',
      `<!doctype html><html><head><link rel='stylesheet' href='${STYLESHEET_HREF}'>` +
        "<link rel='preload' as='font' crossorigin href='/inter.woff2'>" +
        '</head><body>hi</body></html>',
    );

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: entry }),
      resolveImport: resolverFor({}),
    });

    expect(result).toEqual({ ok: true, problems: [] });
  });

  // --- IMPORTANT 6: guard against deleting the as="font" check --------------------------------

  it('does NOT exempt a preload with as="style" — only as="font" satisfies the exemption', () => {
    // If the `as === 'font'` check in extractPreloadFontUrls were deleted, this preload (which
    // merely shares the same href, with the wrong `as`) would wrongly exempt the font, and this
    // test would go RED — this is IMPORTANT 6's guard against exactly that regression.
    const entry = write(
      'entry-wrong-as.css',
      `@font-face { font-family: 'Inter'; src: url('/inter.woff2'); }`,
    );
    const html = htmlWithStylesheet(
      'index-wrong-as.html',
      '<link rel="preload" as="style" crossorigin href="/inter.woff2">',
    );

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: entry }),
      resolveImport: resolverFor({}),
    });

    expect(result.ok).toBe(false);
    expect(
      result.problems.some((p) => p.kind === 'deep-font' && p.fontUrl === '/inter.woff2'),
    ).toBe(true);
  });

  // --- Anti-vacuity: empty input must never read as clean, for either level ------------------

  it('RED: fires empty-input when htmlFiles is empty', () => {
    const result = verifyFontChain({
      htmlFiles: [],
      resolveStylesheet: noStylesheets,
      resolveImport: resolverFor({}),
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: 'empty-input', input: '(htmlFiles)' }),
    ]);
    // K5 item 3: the batch-level empty-input's document is DELIBERATELY empty (there is no
    // document to name when the whole input list is empty) — pin that it IS empty, not merely
    // unspecified.
    expect(result.problems[0]?.document).toBe('');
  });

  it('RED: fires a per-document empty-input when a document has no <link rel="stylesheet"> tags, alongside a clean sibling document', () => {
    const entry = write('entry-mixed-empty.css', `body { color: red; }`);
    const withStylesheet = htmlWithStylesheet('index-with-stylesheet.html');
    const withoutStylesheet = htmlWithNoStylesheet('index-without-stylesheet.html');

    const result = verifyFontChain({
      htmlFiles: [withStylesheet, withoutStylesheet],
      resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: entry }),
      resolveImport: resolverFor({}),
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: 'empty-input', document: withoutStylesheet }),
    ]);
  });

  // --- unreadable-html: reported, never thrown, never abandons other files -------------------

  it('RED: reports unreadable-html instead of throwing when an html file is a directory', () => {
    const badHtml = join(root, 'bad.html');
    mkdirSync(badHtml);

    let threw = false;
    let result: ReturnType<typeof verifyFontChain> | undefined;
    try {
      result = verifyFontChain({
        htmlFiles: [badHtml],
        resolveStylesheet: noStylesheets,
        resolveImport: resolverFor({}),
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result?.problems.some((p) => p.kind === 'unreadable-html' && p.html === badHtml)).toBe(
      true,
    );
    // K5 item 3: document is pinned at this emission site too.
    expect(
      result?.problems.some((p) => p.kind === 'unreadable-html' && p.document === badHtml),
    ).toBe(true);
  });

  it('an unreadable html file does not stop a preload elsewhere from being collected', () => {
    const badHtml = join(root, 'bad2.html');
    mkdirSync(badHtml);
    const entry = write(
      'entry-mixed-html.css',
      `@font-face { font-family: 'Inter'; src: url('/inter.woff2'); }`,
    );
    const goodHtml = htmlWithStylesheet(
      'good.html',
      '<link rel="preload" as="font" crossorigin href="/inter.woff2">',
    );

    const result = verifyFontChain({
      htmlFiles: [badHtml, goodHtml],
      resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: entry }),
      resolveImport: resolverFor({}),
    });

    expect(result.problems.some((p) => p.kind === 'unreadable-html')).toBe(true);
    expect(result.problems.some((p) => p.kind === 'deep-font')).toBe(false);
  });

  it('propagates an htmlFiles element contract violation instead of misreporting it', () => {
    let caught: unknown;
    try {
      verifyFontChain({
        // biome-ignore lint/suspicious/noExplicitAny: deliberately violating the htmlFiles element contract
        htmlFiles: [{ notAPath: true } as any],
        resolveStylesheet: noStylesheets,
        resolveImport: resolverFor({}),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toContain('htmlFiles[0]');
  });

  // --- K5 item 1: an hrefless <link rel="stylesheet"> must be reported, never silently dropped -

  it('RED: reports malformed-stylesheet-link for a hrefless <link rel="stylesheet">, alongside a well-formed sibling', () => {
    const entry = write(
      'deep-font.css',
      `@font-face { font-family: 'Inter'; src: url('/inter.woff2'); }`,
    );
    // Before the fix: a well-formed sibling link made the hrefless one vanish with zero record —
    // the confirmed repro from the controller (result: [ 'deep-font' ], the malformed link
    // produced nothing). After the fix, both are reported.
    const html = write(
      'index-hrefless-link.html',
      '<!doctype html><html><head><link rel="stylesheet"><link rel="stylesheet" ' +
        `href="${STYLESHEET_HREF}"></head><body>hi</body></html>`,
    );

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: resolverFor({ [STYLESHEET_HREF]: entry }),
      resolveImport: resolverFor({}),
    });

    expect(result.ok).toBe(false);
    const malformed = result.problems.find((p) => p.kind === 'malformed-stylesheet-link');
    expect(malformed).toBeDefined();
    expect(malformed?.document).toBe(html);
    expect(malformed?.tag).toBe('<link rel="stylesheet">');
    // The well-formed sibling's finding must still be reported — the malformed tag no longer
    // silences it, and it no longer silences the malformed tag either.
    expect(
      result.problems.some((p) => p.kind === 'deep-font' && p.fontUrl === '/inter.woff2'),
    ).toBe(true);
  });

  it('reports ONLY malformed-stylesheet-link (never a false "no <link rel=stylesheet> tags" empty-input) when the ONLY link lacks an href', () => {
    const html = write(
      'index-only-hrefless-link.html',
      '<!doctype html><html><head><link rel="stylesheet"></head><body>hi</body></html>',
    );

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: noStylesheets,
      resolveImport: resolverFor({}),
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({
        kind: 'malformed-stylesheet-link',
        document: html,
        tag: '<link rel="stylesheet">',
      }),
    ]);
    // The old, now-inaccurate message ("has no <link rel="stylesheet"> tags") must not appear —
    // the document DOES have one, it is just malformed.
    expect(result.problems.some((p) => p.kind === 'empty-input')).toBe(false);
  });

  // --- Round-2 review MEDIUM #7: raw tag text in malformed-stylesheet-link is capped and
  // sanitized — it comes from FILE CONTENT (the less-trusted side of this package's own trust
  // boundary), and `/<link\s[^>]*>/gi`'s `[^>]*` is unbounded and does not exclude newlines.

  it('RED (before the cap): an oversized malformed <link> tag is truncated, never embedded verbatim', () => {
    const hugeAttr = 'x'.repeat(2_000_000);
    const html = write(
      'index-huge-malformed-link.html',
      `<!doctype html><html><head><link rel="stylesheet" data-huge="${hugeAttr}"></head><body>hi</body></html>`,
    );

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: noStylesheets,
      resolveImport: resolverFor({}),
    });

    expect(result.ok).toBe(false);
    const malformed = result.problems.find((p) => p.kind === 'malformed-stylesheet-link');
    expect(malformed).toBeDefined();
    // The raw tag is well over 2,000,000 characters; the reported tag and message must both be
    // bounded to a sane length — never the full raw match verbatim.
    expect(malformed?.tag.length).toBeLessThan(1000);
    expect(malformed?.message.length).toBeLessThan(1200);
    expect(malformed?.tag).toContain('truncated');
  });

  it('RED (before sanitizing): a malformed <link> tag with an embedded newline must not land verbatim in message (log-forging surface)', () => {
    // Reviewer's reproduction: a raw tag containing a newline lands byte-for-byte in `message` —
    // a log-forging surface, since this package's own README suggests printing one problem per
    // line. A single malformed build-content tag must not be able to forge extra "lines".
    const html = write(
      'index-newline-malformed-link.html',
      '<!doctype html><html><head><link rel="stylesheet" data-x="a\nFAKE LOG LINE: pwned"></head>' +
        '<body>hi</body></html>',
    );

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: noStylesheets,
      resolveImport: resolverFor({}),
    });

    expect(result.ok).toBe(false);
    const malformed = result.problems.find((p) => p.kind === 'malformed-stylesheet-link');
    expect(malformed).toBeDefined();
    // No raw newline anywhere in the reported tag or message — it must be escaped, not verbatim.
    expect(malformed?.tag).not.toContain('\n');
    expect(malformed?.message).not.toContain('\n');
    expect(malformed?.tag).toContain('\\n');
  });

  // --- K8 item 2a: pin the MAX_MALFORMED_TAG_LENGTH boundary (`<=` vs `<`) — only the 2,000,000
  // char case above was covered, which cannot distinguish the boundary condition itself. 300 chars
  // exactly must NOT be truncated; 301 must be.

  it('a malformed tag of EXACTLY 300 chars (the cap) is reported verbatim, untruncated', () => {
    const filler = 'x'.repeat(267); // prefix (31) + filler (267) + suffix (2) = 300
    const html = write(
      'index-cap-exact.html',
      `<!doctype html><html><head><link rel="stylesheet" data-x="${filler}"></head><body>hi</body></html>`,
    );

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: noStylesheets,
      resolveImport: resolverFor({}),
    });

    const malformed = result.problems.find((p) => p.kind === 'malformed-stylesheet-link');
    expect(malformed).toBeDefined();
    expect(malformed?.tag.length).toBe(300);
    expect(malformed?.tag).not.toContain('truncated');
  });

  it('a malformed tag of 301 chars (one over the cap) IS truncated', () => {
    const filler = 'x'.repeat(268); // prefix (31) + filler (268) + suffix (2) = 301
    const html = write(
      'index-cap-over.html',
      `<!doctype html><html><head><link rel="stylesheet" data-x="${filler}"></head><body>hi</body></html>`,
    );

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: noStylesheets,
      resolveImport: resolverFor({}),
    });

    const malformed = result.problems.find((p) => p.kind === 'malformed-stylesheet-link');
    expect(malformed).toBeDefined();
    // Truncated output is the first-300-chars slice plus a "… [truncated, N chars]" suffix, so it
    // is LONGER than 300 raw chars, not shorter — the boundary this pins is "did truncation kick
    // in at 301", not overall output length (see the 300-char sibling test for that assertion).
    // The slice drops exactly the final character of the 301-char tag (the closing `>`).
    const fullTag = `<link rel="stylesheet" data-x="${filler}">`;
    expect(malformed?.tag).toContain('truncated');
    expect(malformed?.tag.startsWith(fullTag.slice(0, 300))).toBe(true);
    expect(malformed?.tag).not.toBe(fullTag);
  });

  // --- K8 item 2b: pin the `\t`-specific escape branch — without it, a tab falls through to the
  // generic `\xNN` form (`\x09`) and nothing distinguishes the two, so a mutant removing the `\t`
  // branch stays green.

  it('escapes an embedded tab as the literal `\\t` form, not the generic `\\x09`', () => {
    const html = write(
      'index-tab-malformed-link.html',
      '<!doctype html><html><head><link rel="stylesheet" data-x="a\tFAKE\tTAB"></head>' +
        '<body>hi</body></html>',
    );

    const result = verifyFontChain({
      htmlFiles: [html],
      resolveStylesheet: noStylesheets,
      resolveImport: resolverFor({}),
    });

    const malformed = result.problems.find((p) => p.kind === 'malformed-stylesheet-link');
    expect(malformed).toBeDefined();
    expect(malformed?.tag).not.toContain('\t');
    expect(malformed?.tag).toContain('\\t');
    expect(malformed?.tag).not.toContain('\\x09');
  });

  // --- K5 item 2: FontChainProblem is a discriminated union, not a flat interface with prose-only
  // field validity. This is a TYPE-ONLY regression guard (it.skip: never executed, only
  // type-checked by `npm run typecheck` / `tsc`) proving the consumer footgun described in the
  // module doc comment no longer compiles.
  it.skip('TYPE-ONLY: grouping FontChainProblem by `.entry` across kinds must not compile', () => {
    const problems: FontChainProblem[] = [];
    const map = new Map<string, FontChainProblem[]>();
    for (const p of problems) {
      // @ts-expect-error -- `entry` does not exist on every FontChainProblem variant: grouping by
      // it would silently merge empty-input/unreadable-html/malformed-stylesheet-link/
      // unresolvable-stylesheet findings from UNRELATED documents into one '' bucket, which is
      // the exact bug this union fixes (see module doc comment on FontChainProblem).
      const key: string = p.entry;
      const bucket = map.get(key) ?? [];
      bucket.push(p);
      map.set(key, bucket);
    }
  });

  // --- Round-2 review IMPORTANT #5: `subject: string` is gone entirely, replaced by a
  // kind-specific field per variant (`input`/`html`/`tag`/`href`/`stylesheet`/`specifier`/
  // `fontUrl` — see the FontChainProblem doc comment). This is a TYPE-ONLY regression guard
  // (it.skip: never executed, only type-checked) proving the exact reproduction from the review
  // no longer compiles: grouping by `.subject` used to conflate a resolved stylesheet PATH, an
  // `@import` SPECIFIER, and a font URL into one bucket, because every variant claimed the same
  // generic field name for three semantically different payloads.
  it.skip('TYPE-ONLY: grouping FontChainProblem by `.subject` must not compile — the field no longer exists on any variant', () => {
    const problems: FontChainProblem[] = [];
    const paths = new Set<string>();
    for (const p of problems) {
      // @ts-expect-error -- `subject` does not exist on ANY FontChainProblem variant any more:
      // this is the exact reproduction from the review — conflating a resolved stylesheet path
      // (unreadable-stylesheet/unparseable-font-face), an @import specifier
      // (unresolvable-import/resolver-error), and a font URL (deep-font) by reading them all
      // through one shared, misleadingly generic field name.
      if ('entry' in p) paths.add(p.subject);
    }
  });
});

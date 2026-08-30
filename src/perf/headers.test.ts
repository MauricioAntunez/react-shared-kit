import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyHeaders } from './headers.ts';

let root: string;
let assetsDir: string;
let headersFile: string;

const BYTES = Buffer.from('not-a-real-asset');

/** A minimal, fully-clean fixture: one hashed asset, an /assets/* immutable rule, and no rule at
 * all for HTML — the host's default (revalidate everything not explicitly cached) is what keeps
 * HTML safe, and a passing fixture must not itself contain one of the forbidden HTML-like rule
 * paths (`/*` included — that is one of them). Every RED test below starts here and mutates
 * exactly one thing. */
function writeCleanFixture(): void {
  writeFileSync(join(assetsDir, 'app-a1B2c3D4.js'), BYTES);
  writeFileSync(
    headersFile,
    ['/assets/*', '  Cache-Control: public, max-age=31536000, immutable', ''].join('\n'),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uxr-headers-'));
  assetsDir = join(root, 'assets');
  headersFile = join(root, '_headers');
  mkdirSync(assetsDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('verifyHeaders', () => {
  it('passes clean on a fully consistent fixture', () => {
    writeCleanFixture();
    const result = verifyHeaders({ headersFile, assetsDir, immutablePrefixes: ['/assets/'] });
    expect(result).toEqual({ ok: true, problems: [] });
  });

  // --- Check 1: headers file must exist -----------------------------------------------------

  it('RED: fires missing-headers-file when the built _headers file does not exist', () => {
    // Defect: no _headers was ever written (deploy config never authored, or build step skipped).
    writeFileSync(join(assetsDir, 'app-a1B2c3D4.js'), BYTES);
    const result = verifyHeaders({ headersFile, assetsDir, immutablePrefixes: ['/assets/'] });
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.kind === 'missing-headers-file')).toBe(true);
  });

  it('GREEN: missing-headers-file does not fire once the file exists', () => {
    writeCleanFixture();
    const result = verifyHeaders({ headersFile, assetsDir, immutablePrefixes: ['/assets/'] });
    expect(result.problems.some((p) => p.kind === 'missing-headers-file')).toBe(false);
  });

  // --- Check 2: every asset must be content-hashed ------------------------------------------

  it('RED: fires unhashed-asset for a file under assetsDir with no content hash', () => {
    // Defect: a bundler config regression (or a hand-copied file) that skips hashing entirely —
    // an /assets/* immutable rule would then cache this exact file forever.
    writeCleanFixture();
    writeFileSync(join(assetsDir, 'app.js'), BYTES);
    const result = verifyHeaders({ headersFile, assetsDir, immutablePrefixes: ['/assets/'] });
    expect(result.ok).toBe(false);
    expect(
      result.problems.some((p) => p.kind === 'unhashed-asset' && p.path.endsWith('app.js')),
    ).toBe(true);
  });

  it('GREEN: unhashed-asset does not fire when every asset carries a hash', () => {
    writeCleanFixture();
    const result = verifyHeaders({ headersFile, assetsDir, immutablePrefixes: ['/assets/'] });
    expect(result.problems.some((p) => p.kind === 'unhashed-asset')).toBe(false);
  });

  // --- Check 3: immutable only inside immutablePrefixes (safety-critical) -------------------

  it('RED: fires unauthorized-immutable when a broad /* rule grants immutable', () => {
    // Defect: cache poisoning — a rule outside the hashed-asset prefix grants immutable, so an
    // unhashed (or HTML) path gets cached for a year with no way to bust it.
    writeFileSync(join(assetsDir, 'app-a1B2c3D4.js'), BYTES);
    writeFileSync(
      headersFile,
      [
        '/assets/*',
        '  Cache-Control: public, max-age=31536000, immutable',
        '',
        '/*',
        '  Cache-Control: public, max-age=31536000, immutable',
        '',
      ].join('\n'),
    );
    const result = verifyHeaders({ headersFile, assetsDir, immutablePrefixes: ['/assets/'] });
    expect(result.ok).toBe(false);
    expect(
      result.problems.some((p) => p.kind === 'unauthorized-immutable' && p.path === '/*'),
    ).toBe(true);
  });

  it('GREEN: unauthorized-immutable does not fire when immutable is confined to immutablePrefixes', () => {
    writeCleanFixture();
    const result = verifyHeaders({ headersFile, assetsDir, immutablePrefixes: ['/assets/'] });
    expect(result.problems.some((p) => p.kind === 'unauthorized-immutable')).toBe(false);
  });

  // --- Check 4: no rule may match an HTML-like path -----------------------------------------

  it('RED: fires html-rule when a rule matches /index.html', () => {
    // Defect: HTML pinned to a non-revalidating rule — deploys stop surfacing because clients
    // keep serving the previous HTML.
    writeCleanFixture();
    const contents = [
      '/assets/*',
      '  Cache-Control: public, max-age=31536000, immutable',
      '',
      '/index.html',
      '  Cache-Control: public, max-age=31536000',
      '',
    ].join('\n');
    writeFileSync(headersFile, contents);
    const result = verifyHeaders({ headersFile, assetsDir, immutablePrefixes: ['/assets/'] });
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.kind === 'html-rule' && p.path === '/index.html')).toBe(
      true,
    );
  });

  it('GREEN: html-rule does not fire when no rule matches an htmlPattern', () => {
    writeCleanFixture();
    const result = verifyHeaders({ headersFile, assetsDir, immutablePrefixes: ['/assets/'] });
    expect(result.problems.some((p) => p.kind === 'html-rule')).toBe(false);
  });

  it('respects a custom htmlPatterns list', () => {
    // A rule path that is NOT one of the defaults, so it only fires once declared as custom —
    // proves the parameter, not just the default list, is what drives the check.
    writeFileSync(join(assetsDir, 'app-a1B2c3D4.js'), BYTES);
    writeFileSync(
      headersFile,
      [
        '/assets/*',
        '  Cache-Control: public, max-age=31536000, immutable',
        '',
        '/app.html',
        '  Cache-Control: public, max-age=0, must-revalidate',
        '',
      ].join('\n'),
    );

    const withDefault = verifyHeaders({ headersFile, assetsDir, immutablePrefixes: ['/assets/'] });
    expect(withDefault.problems.some((p) => p.kind === 'html-rule')).toBe(false);

    const withCustom = verifyHeaders({
      headersFile,
      assetsDir,
      immutablePrefixes: ['/assets/'],
      htmlPatterns: ['/app.html'],
    });
    expect(withCustom.problems.some((p) => p.kind === 'html-rule' && p.path === '/app.html')).toBe(
      true,
    );
  });

  // --- Anti-vacuity (plan §2 constraint 4): a readable-but-empty input must never read as clean.

  it('RED: fires empty-input when assetsDir is readable but contains 0 files', () => {
    // Defect: the build produced no assets at all (a skipped or broken build step) — with no
    // asset-hash check to fail, this must still not read as "everything is hashed".
    writeFileSync(
      headersFile,
      ['/assets/*', '  Cache-Control: public, max-age=31536000, immutable', ''].join('\n'),
    );
    // assetsDir exists (created in beforeEach) but is left empty.
    const result = verifyHeaders({ headersFile, assetsDir, immutablePrefixes: ['/assets/'] });
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.kind === 'empty-input' && p.path === assetsDir)).toBe(
      true,
    );
  });

  it('GREEN: empty-input (assetsDir) does not fire once assetsDir has files', () => {
    writeCleanFixture();
    const result = verifyHeaders({ headersFile, assetsDir, immutablePrefixes: ['/assets/'] });
    expect(result.problems.some((p) => p.kind === 'empty-input' && p.path === assetsDir)).toBe(
      false,
    );
  });

  it('RED: fires empty-input when headersFile exists but parses to 0 rules', () => {
    // Defect: a truncated write, or a build step that emitted an empty/comment-only file — the
    // file "exists" (check 1 passes) but there is nothing in it to verify.
    writeFileSync(join(assetsDir, 'app-a1B2c3D4.js'), BYTES);
    writeFileSync(headersFile, '# no rules here, just a comment\n');
    const result = verifyHeaders({ headersFile, assetsDir, immutablePrefixes: ['/assets/'] });
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.kind === 'empty-input' && p.path === headersFile)).toBe(
      true,
    );
  });

  it('GREEN: empty-input (headersFile) does not fire once the file parses to at least one rule', () => {
    writeCleanFixture();
    const result = verifyHeaders({ headersFile, assetsDir, immutablePrefixes: ['/assets/'] });
    expect(result.problems.some((p) => p.kind === 'empty-input' && p.path === headersFile)).toBe(
      false,
    );
  });

  // --- MUST-FIX 1: assetsDir must be walked recursively -------------------------------------

  it('RED: fires unhashed-asset naming a nested unhashed file, not the directory entry', () => {
    // Reviewer repro: Vite's `assets/[ext]/[name]-[hash][extname]` layout nests by extension. A
    // non-recursive scan tests the DIRECTORY NAME ("fonts") against the hash pattern instead of
    // the real file inside it — reporting a nonsense problem while the actual risk passes clean.
    writeFileSync(join(assetsDir, 'app-a1B2c3D4.js'), BYTES);
    mkdirSync(join(assetsDir, 'fonts'), { recursive: true });
    writeFileSync(join(assetsDir, 'fonts', 'unhashed-font.woff2'), BYTES);
    writeFileSync(
      headersFile,
      ['/assets/*', '  Cache-Control: public, max-age=31536000, immutable', ''].join('\n'),
    );
    const result = verifyHeaders({ headersFile, assetsDir, immutablePrefixes: ['/assets/'] });
    expect(result.ok).toBe(false);
    // The problem must name the real file, not the "fonts" directory entry.
    expect(
      result.problems.some(
        (p) => p.kind === 'unhashed-asset' && p.path.endsWith('fonts/unhashed-font.woff2'),
      ),
    ).toBe(true);
    expect(
      result.problems.some((p) => p.path.endsWith('/fonts') && p.kind === 'unhashed-asset'),
    ).toBe(false);
  });

  it('GREEN: a nested asset that IS hashed does not fire unhashed-asset', () => {
    writeCleanFixture();
    mkdirSync(join(assetsDir, 'fonts'), { recursive: true });
    writeFileSync(join(assetsDir, 'fonts', 'font-a1B2c3D4.woff2'), BYTES);
    const result = verifyHeaders({ headersFile, assetsDir, immutablePrefixes: ['/assets/'] });
    expect(result.problems.some((p) => p.kind === 'unhashed-asset')).toBe(false);
  });

  // --- MUST-FIX 2: immutablePrefixes must be boundary-matched, not a bare startsWith ---------

  it('RED: fires unauthorized-immutable for a sibling-path collision (/assets2 vs /assets)', () => {
    // Reviewer repro #1: with immutablePrefixes: ['/assets'] (no trailing slash — nothing requires
    // one), a bare startsWith lets a wholly different path share the prefix as a string.
    writeFileSync(join(assetsDir, 'app-a1B2c3D4.js'), BYTES);
    writeFileSync(
      headersFile,
      [
        '/assets/*',
        '  Cache-Control: public, max-age=31536000, immutable',
        '',
        '/assets2/evil.js',
        '  Cache-Control: public, max-age=31536000, immutable',
        '',
      ].join('\n'),
    );
    const result = verifyHeaders({ headersFile, assetsDir, immutablePrefixes: ['/assets'] });
    expect(result.ok).toBe(false);
    expect(
      result.problems.some(
        (p) => p.kind === 'unauthorized-immutable' && p.path === '/assets2/evil.js',
      ),
    ).toBe(true);
  });

  it('RED: fires unauthorized-immutable for a sibling-path collision (/assets-legacy/* vs /assets)', () => {
    // Reviewer repro #2: same class, a hyphenated sibling directory.
    writeFileSync(join(assetsDir, 'app-a1B2c3D4.js'), BYTES);
    writeFileSync(
      headersFile,
      [
        '/assets/*',
        '  Cache-Control: public, max-age=31536000, immutable',
        '',
        '/assets-legacy/*',
        '  Cache-Control: public, max-age=31536000, immutable',
        '',
      ].join('\n'),
    );
    const result = verifyHeaders({ headersFile, assetsDir, immutablePrefixes: ['/assets'] });
    expect(result.ok).toBe(false);
    expect(
      result.problems.some(
        (p) => p.kind === 'unauthorized-immutable' && p.path === '/assets-legacy/*',
      ),
    ).toBe(true);
  });

  it('GREEN: a boundary-less prefix ("/assets") still authorises its own subtree', () => {
    // Proves the fix does not overcorrect into rejecting the legitimate case.
    writeFileSync(join(assetsDir, 'app-a1B2c3D4.js'), BYTES);
    writeFileSync(
      headersFile,
      ['/assets/*', '  Cache-Control: public, max-age=31536000, immutable', ''].join('\n'),
    );
    const result = verifyHeaders({ headersFile, assetsDir, immutablePrefixes: ['/assets'] });
    expect(result.problems.some((p) => p.kind === 'unauthorized-immutable')).toBe(false);
  });

  // --- MUST-FIX 3 / IMPORTANT 4 / IMPORTANT 5: unreadable inputs must be reported, not thrown -

  it('RED: reports unreadable-headers-file instead of throwing when headersFile is a directory', () => {
    // Reproduces the TOCTOU/EISDIR case: existsSync is true for a directory, so the unguarded
    // readFileSync used to throw EISDIR straight out of this "pure" function.
    writeFileSync(join(assetsDir, 'app-a1B2c3D4.js'), BYTES);
    mkdirSync(headersFile);
    let threw = false;
    let result: ReturnType<typeof verifyHeaders> | undefined;
    try {
      result = verifyHeaders({ headersFile, assetsDir, immutablePrefixes: ['/assets/'] });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result?.ok).toBe(false);
    expect(result?.problems.some((p) => p.kind === 'unreadable-headers-file')).toBe(true);
  });

  it('RED: fires unreadable-assets-dir (not unhashed-asset) when assetsDir does not exist', () => {
    // IMPORTANT 4: assetsDir is always created in beforeEach across every other test, so this path
    // was untested — gutting the catch body left all other tests green.
    // IMPORTANT 5: must carry its OWN kind, distinct from unhashed-asset, so a consumer
    // aggregating by kind is told "the directory is unreadable", not "1 unhashed file".
    rmSync(assetsDir, { recursive: true, force: true });
    writeFileSync(
      headersFile,
      ['/assets/*', '  Cache-Control: public, max-age=31536000, immutable', ''].join('\n'),
    );
    const result = verifyHeaders({ headersFile, assetsDir, immutablePrefixes: ['/assets/'] });
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.kind === 'unreadable-assets-dir')).toBe(true);
    expect(result.problems.some((p) => p.kind === 'unhashed-asset')).toBe(false);
  });

  it('GREEN: neither unreadable-assets-dir nor unreadable-headers-file fires on the clean fixture', () => {
    writeCleanFixture();
    const result = verifyHeaders({ headersFile, assetsDir, immutablePrefixes: ['/assets/'] });
    expect(result.problems.some((p) => p.kind === 'unreadable-assets-dir')).toBe(false);
    expect(result.problems.some((p) => p.kind === 'unreadable-headers-file')).toBe(false);
  });

  it('propagates an assetsDir contract violation instead of misreporting it as unreadable-assets-dir', () => {
    // Round 4 review redesign: assetsDir is validated to be a real string on entry to
    // verifyHeaders (assertStringOption), so a violation now throws OUR OWN TypeError immediately
    // — before existsSync/walkFiles ever run — not Node's internal argument validation.
    writeCleanFixture();
    let caught: unknown;
    try {
      verifyHeaders({
        headersFile,
        // biome-ignore lint/suspicious/noExplicitAny: deliberately violating the assetsDir contract
        assetsDir: { notAPath: true } as any,
        immutablePrefixes: ['/assets/'],
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toContain('assetsDir');
  });

  it('propagates a headersFile contract violation (a URL object) instead of misreporting it (round 4 Finding B)', () => {
    // A caller passing new URL(...) instead of a path string for headersFile — a far likelier
    // slip than {notAPath:true} — must also be rejected at the boundary.
    writeCleanFixture();
    let caught: unknown;
    try {
      verifyHeaders({
        // biome-ignore lint/suspicious/noExplicitAny: deliberately violating the headersFile contract
        headersFile: new URL('file:///nonexistent/_headers') as any,
        assetsDir,
        immutablePrefixes: ['/assets/'],
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toContain('headersFile');
    expect((caught as Error).message).toContain('URL object');
  });

  it('reports a NUL byte in assetsDir as unreadable-assets-dir instead of throwing (round 4 Finding A)', () => {
    // A syntactically valid STRING directory path containing a NUL byte is a real fs condition
    // (readdirSync throws ERR_INVALID_ARG_VALUE for it) — not a caller contract violation. It must
    // pass assertStringOption (it IS a string) and be reported as a normal unreadable-assets-dir
    // finding, never re-thrown.
    writeFileSync(
      headersFile,
      ['/assets/*', '  Cache-Control: public, max-age=31536000, immutable', ''].join('\n'),
    );
    const nulByteDir = `${root}/does-not-exist\0`;

    const result = verifyHeaders({
      headersFile,
      assetsDir: nulByteDir,
      immutablePrefixes: ['/assets/'],
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'unreadable-assets-dir', path: nulByteDir }),
      ]),
    );
  });

  // --- Round-2 MUST-FIX 1: an empty or root prefix must never authorise everything ----------

  it('RED: fires invalid-immutable-prefix for a root prefix ("/") instead of authorising everything', () => {
    // Reviewer repro: with immutablePrefixes: ['/'], the old boundary computed "" and every
    // absolute path (including an unhashed one) satisfied startsWith('') — a clean ok:true while
    // granting immutable to anything. '/' is not exotic — it is "assets served from site root".
    writeFileSync(join(assetsDir, 'unhashed.js'), BYTES); // deliberately NOT hashed
    writeFileSync(
      headersFile,
      ['/etc/passwd', '  Cache-Control: public, max-age=31536000, immutable', ''].join('\n'),
    );
    const result = verifyHeaders({ headersFile, assetsDir, immutablePrefixes: ['/'] });
    expect(result.ok).toBe(false);
    expect(
      result.problems.some((p) => p.kind === 'invalid-immutable-prefix' && p.path === '/'),
    ).toBe(true);
    // The invalid entry must not have silently authorised the rule either.
    expect(
      result.problems.some((p) => p.kind === 'unauthorized-immutable' && p.path === '/etc/passwd'),
    ).toBe(true);
  });

  it('RED: fires invalid-immutable-prefix for an empty-string prefix, never a silent pass', () => {
    // Reviewer repro #2: immutablePrefixes: [''] — same collapse, an empty string.
    writeFileSync(join(assetsDir, 'app-a1B2c3D4.js'), BYTES);
    writeFileSync(
      headersFile,
      ['/anything/at/all', '  Cache-Control: public, max-age=31536000, immutable', ''].join('\n'),
    );
    const result = verifyHeaders({ headersFile, assetsDir, immutablePrefixes: [''] });
    expect(result.ok).toBe(false);
    expect(
      result.problems.some((p) => p.kind === 'invalid-immutable-prefix' && p.path === ''),
    ).toBe(true);
  });

  it('GREEN: invalid-immutable-prefix does not fire for a specific, non-root prefix', () => {
    writeCleanFixture();
    const result = verifyHeaders({ headersFile, assetsDir, immutablePrefixes: ['/assets/'] });
    expect(result.problems.some((p) => p.kind === 'invalid-immutable-prefix')).toBe(false);
  });

  // --- Round-2 IMPORTANT 2: the exact-match branch of isUnderPrefix needs its own test -------

  it('GREEN: a rule path exactly equal to the prefix (no wildcard/subpath) is authorised', () => {
    // A single bundled entry served at exactly "/assets" (no trailing "/*" or subpath) is unusual
    // but legitimate. Removing the `path === boundary ||` disjunct in isUnderPrefix would flip
    // this to a spurious unauthorized-immutable while every other test stays green.
    writeFileSync(join(assetsDir, 'app-a1B2c3D4.js'), BYTES);
    writeFileSync(
      headersFile,
      ['/assets', '  Cache-Control: public, max-age=31536000, immutable', ''].join('\n'),
    );
    const result = verifyHeaders({ headersFile, assetsDir, immutablePrefixes: ['/assets'] });
    expect(result.problems.some((p) => p.kind === 'unauthorized-immutable')).toBe(false);
  });

  it('respects a custom hashPattern', () => {
    // A non-Vite bundler's hash shape: 12 lowercase hex chars in brackets.
    writeFileSync(join(assetsDir, 'app.[deadbeefcafe].js'), BYTES);
    writeFileSync(
      headersFile,
      ['/assets/*', '  Cache-Control: public, max-age=31536000, immutable', ''].join('\n'),
    );
    const failsUnderDefault = verifyHeaders({
      headersFile,
      assetsDir,
      immutablePrefixes: ['/assets/'],
    });
    expect(failsUnderDefault.problems.some((p) => p.kind === 'unhashed-asset')).toBe(true);

    const passesUnderCustom = verifyHeaders({
      headersFile,
      assetsDir,
      immutablePrefixes: ['/assets/'],
      hashPattern: /^.+\.\[[0-9a-f]{12}\]\.[^./]+$/,
    });
    expect(passesUnderCustom.problems.some((p) => p.kind === 'unhashed-asset')).toBe(false);
  });
});

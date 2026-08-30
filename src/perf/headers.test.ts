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

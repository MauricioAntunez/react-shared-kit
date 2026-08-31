import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findDanglingClasses } from './danglingClasses.ts';

let root: string;
let htmlFile: string;
let cssFile: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uxr-dangling-'));
  htmlFile = join(root, 'index.html');
  cssFile = join(root, 'page.module.css');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('findDanglingClasses', () => {
  it('passes clean when every hashed class in CSS appears on an element in HTML', () => {
    writeFileSync(cssFile, '._hiwViz_18mh8_533 { width: 100%; }');
    writeFileSync(htmlFile, '<div class="_hiwViz_18mh8_533">hi</div>');
    const result = findDanglingClasses({ htmlFiles: [htmlFile], cssFiles: [cssFile] });
    expect(result).toEqual({ ok: true, problems: [] });
  });

  // --- The defect: a cross-module-hash selector matches nothing ----------------------------

  it('RED: fires dangling-class when a hashed selector matches no element in any built HTML', () => {
    // Defect mechanism: page.module.css's ._hiwViz hashes to _18mh8_533, but the only class on
    // any element is home.module.css's _hiwViz hashed to _1o51b_39 — a different file, a
    // different hash, syntactically valid, matches nothing.
    writeFileSync(cssFile, '._hiwViz_18mh8_533 { width: 465px; }');
    writeFileSync(htmlFile, '<div class="_hiwViz_1o51b_39">hi</div>');
    const result = findDanglingClasses({ htmlFiles: [htmlFile], cssFiles: [cssFile] });
    expect(result.ok).toBe(false);
    expect(
      result.problems.some(
        (p) => p.kind === 'dangling-class' && p.className === '_hiwViz_18mh8_533',
      ),
    ).toBe(true);
  });

  it('GREEN: dangling-class does not fire once the mutation is reverted', () => {
    writeFileSync(cssFile, '._hiwViz_18mh8_533 { width: 465px; }');
    writeFileSync(htmlFile, '<div class="_hiwViz_18mh8_533">hi</div>');
    const result = findDanglingClasses({ htmlFiles: [htmlFile], cssFiles: [cssFile] });
    expect(result.problems.some((p) => p.kind === 'dangling-class')).toBe(false);
  });

  // --- Allowlisted runtime-conditional variants ---------------------------------------------

  it('does not fire on an allowlisted runtime-conditional variant, matched by LOGICAL name', () => {
    // `loading && styles.loading` — absent from every prerendered page because no current route
    // passes the prop, not because the rule is broken.
    writeFileSync(cssFile, '._loading_18mh8_40 { opacity: 0.5; }');
    writeFileSync(htmlFile, '<div class="unrelated">hi</div>');
    const result = findDanglingClasses({
      htmlFiles: [htmlFile],
      cssFiles: [cssFile],
      allowlist: [/^(loading|dark|error|indeterminate)$/],
    });
    expect(result).toEqual({ ok: true, problems: [] });
  });

  it('RED: the allowlist entry does not also excuse an unrelated dangling class', () => {
    writeFileSync(
      cssFile,
      '._loading_18mh8_40 { opacity: 0.5; }\n._hiwViz_18mh8_533 { width: 465px; }',
    );
    writeFileSync(htmlFile, '<div class="unrelated">hi</div>');
    const result = findDanglingClasses({
      htmlFiles: [htmlFile],
      cssFiles: [cssFile],
      allowlist: [/^(loading|dark|error|indeterminate)$/],
    });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: 'dangling-class', className: '_hiwViz_18mh8_533' }),
    ]);
  });

  it('allowlist survives a hash change across rebuilds (matches by logical name, not hash)', () => {
    // Same logical name "loading", different hash+line — proves the allowlist entry is not
    // pinned to one build's specific hash.
    writeFileSync(cssFile, '._loading_9zz01_7 { opacity: 0.5; }');
    writeFileSync(htmlFile, '<div class="unrelated">hi</div>');
    const result = findDanglingClasses({
      htmlFiles: [htmlFile],
      cssFiles: [cssFile],
      allowlist: [/^loading$/],
    });
    expect(result.problems.some((p) => p.kind === 'dangling-class')).toBe(false);
  });

  // --- CRITICAL 1 (class half): commented-out markup must not launder a dangling class -------

  it('RED: a commented-out <div class="..."> still reports the class as dangling', () => {
    // Leftover debug markup — not adversarial input — must not silence a genuine defect: today
    // (before stripHtmlComments is applied) this returns {ok:true, problems:[]}.
    writeFileSync(cssFile, '._hiwViz_18mh8_533 { width: 465px; }');
    writeFileSync(htmlFile, '<!-- <div class="_hiwViz_18mh8_533">hi</div> -->');
    const result = findDanglingClasses({ htmlFiles: [htmlFile], cssFiles: [cssFile] });
    expect(result.ok).toBe(false);
    expect(
      result.problems.some(
        (p) => p.kind === 'dangling-class' && p.className === '_hiwViz_18mh8_533',
      ),
    ).toBe(true);
  });

  // --- Round-2 review MUST-FIX #2: a genuinely unterminated <!-- must be reported, never silent -

  it('RED: reports unterminated-html-comment instead of silently swallowing a genuinely dangling class after a truncated comment', () => {
    // Before this fix: a class after an unterminated `<!--` is silently dropped from
    // `htmlClasses`, same failure class as fontChain.ts's sibling defect. Here that means a class
    // genuinely present on the page (just past the truncation point) never gets recorded as
    // "seen" — the gate must at least name the truncation rather than pass or fail for the wrong
    // reason.
    writeFileSync(cssFile, '._hiwViz_18mh8_533 { width: 465px; }');
    writeFileSync(
      htmlFile,
      '<div>ok</div><!-- never closed <div class="_hiwViz_18mh8_533">hi</div>',
    );
    const result = findDanglingClasses({ htmlFiles: [htmlFile], cssFiles: [cssFile] });
    expect(result.ok).toBe(false);
    expect(
      result.problems.some((p) => p.kind === 'unterminated-html-comment' && p.html === htmlFile),
    ).toBe(true);
  });

  // --- LOW 8: commented-out CSS must not be reported as dangling (false positive) -------------

  it('does not report a commented-out CSS rule as dangling (LOW 8 false positive)', () => {
    writeFileSync(cssFile, '/* ._oldHash_1a2b3c_12 { width: 465px; } */');
    writeFileSync(htmlFile, '<div class="unrelated">hi</div>');
    const result = findDanglingClasses({ htmlFiles: [htmlFile], cssFiles: [cssFile] });
    expect(result).toEqual({ ok: true, problems: [] });
  });

  // --- IMPORTANT 4: allowlist entries can be scoped to one specific cssFiles entry -----------

  it('RED: an allowlist entry scoped to one file does not excuse the same name in a different file', () => {
    // Reproduced defect: allowlisting a legitimate `hiwViz` in nav.module.css must not also
    // exempt a genuine cross-module bug named `hiwViz` in page.module.css.
    const navCssFile = join(root, 'nav.module.css');
    writeFileSync(navCssFile, '._hiwViz_9zz01_7 { opacity: 0.5; }');
    writeFileSync(cssFile, '._hiwViz_18mh8_533 { width: 465px; }'); // page.module.css
    writeFileSync(htmlFile, '<div class="unrelated">hi</div>');

    const result = findDanglingClasses({
      htmlFiles: [htmlFile],
      cssFiles: [navCssFile, cssFile],
      allowlist: [{ pattern: /^hiwViz$/, file: navCssFile }],
    });

    expect(result.ok).toBe(false);
    expect(
      result.problems.some(
        (p) => p.kind === 'dangling-class' && p.className === '_hiwViz_18mh8_533',
      ),
    ).toBe(true);
    // The scoped entry still excuses the name in the file it names.
    expect(
      result.problems.some((p) => p.kind === 'dangling-class' && p.className === '_hiwViz_9zz01_7'),
    ).toBe(false);
  });

  it('a bare RegExp allowlist entry keeps its global meaning across every cssFiles entry', () => {
    const navCssFile = join(root, 'nav.module.css');
    writeFileSync(navCssFile, '._hiwViz_9zz01_7 { opacity: 0.5; }');
    writeFileSync(cssFile, '._hiwViz_18mh8_533 { width: 465px; }');
    writeFileSync(htmlFile, '<div class="unrelated">hi</div>');

    const result = findDanglingClasses({
      htmlFiles: [htmlFile],
      cssFiles: [navCssFile, cssFile],
      allowlist: [/^hiwViz$/],
    });

    expect(result).toEqual({ ok: true, problems: [] });
  });

  // --- Only hashed classes are in scope --------------------------------------------------

  it('never flags a plain, non-hashed global class', () => {
    writeFileSync(cssFile, '.container { max-width: 1200px; }');
    writeFileSync(htmlFile, '<div class="unrelated">hi</div>');
    const result = findDanglingClasses({ htmlFiles: [htmlFile], cssFiles: [cssFile] });
    expect(result).toEqual({ ok: true, problems: [] });
  });

  // --- Anti-vacuity: empty input must never read as clean -----------------------------------

  it('RED: fires empty-input(htmlFiles) when htmlFiles is empty', () => {
    writeFileSync(cssFile, '._hiwViz_18mh8_533 { width: 465px; }');
    const result = findDanglingClasses({ htmlFiles: [], cssFiles: [cssFile] });
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.kind === 'empty-input' && p.input === 'htmlFiles')).toBe(
      true,
    );
  });

  it('GREEN: empty-input(htmlFiles) does not fire once htmlFiles is non-empty', () => {
    writeFileSync(cssFile, '._hiwViz_18mh8_533 { width: 465px; }');
    writeFileSync(htmlFile, '<div class="_hiwViz_18mh8_533">hi</div>');
    const result = findDanglingClasses({ htmlFiles: [htmlFile], cssFiles: [cssFile] });
    expect(result.problems.some((p) => p.kind === 'empty-input')).toBe(false);
  });

  it('RED: fires empty-input(cssFiles) when cssFiles is empty', () => {
    writeFileSync(htmlFile, '<div class="whatever">hi</div>');
    const result = findDanglingClasses({ htmlFiles: [htmlFile], cssFiles: [] });
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.kind === 'empty-input' && p.input === 'cssFiles')).toBe(
      true,
    );
  });

  it('GREEN: empty-input(cssFiles) does not fire once cssFiles is non-empty', () => {
    writeFileSync(cssFile, '._hiwViz_18mh8_533 { width: 465px; }');
    writeFileSync(htmlFile, '<div class="_hiwViz_18mh8_533">hi</div>');
    const result = findDanglingClasses({ htmlFiles: [htmlFile], cssFiles: [cssFile] });
    expect(result.problems.some((p) => p.kind === 'empty-input')).toBe(false);
  });

  it('reports both empty-input kinds, and does not also flood with dangling-class noise', () => {
    const result = findDanglingClasses({ htmlFiles: [], cssFiles: [] });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: 'empty-input', input: 'htmlFiles' }),
      expect.objectContaining({ kind: 'empty-input', input: 'cssFiles' }),
    ]);
  });

  // --- Unreadable file: reported, never thrown -----------------------------------------------

  it('RED: reports unreadable-css instead of throwing when cssFile is a directory', () => {
    mkdirSync(cssFile);
    writeFileSync(htmlFile, '<div class="whatever">hi</div>');
    let threw = false;
    let result: ReturnType<typeof findDanglingClasses> | undefined;
    try {
      result = findDanglingClasses({ htmlFiles: [htmlFile], cssFiles: [cssFile] });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result?.ok).toBe(false);
    expect(result?.problems.some((p) => p.kind === 'unreadable-css' && p.css === cssFile)).toBe(
      true,
    );
  });

  it('GREEN: unreadable-css does not fire once cssFile is a real readable file', () => {
    writeFileSync(cssFile, '._hiwViz_18mh8_533 { width: 465px; }');
    writeFileSync(htmlFile, '<div class="_hiwViz_18mh8_533">hi</div>');
    const result = findDanglingClasses({ htmlFiles: [htmlFile], cssFiles: [cssFile] });
    expect(result.problems.some((p) => p.kind === 'unreadable-css')).toBe(false);
  });

  it('RED: reports unreadable-html instead of throwing when htmlFile is a directory', () => {
    mkdirSync(htmlFile);
    writeFileSync(cssFile, '._hiwViz_18mh8_533 { width: 465px; }');
    let threw = false;
    let result: ReturnType<typeof findDanglingClasses> | undefined;
    try {
      result = findDanglingClasses({ htmlFiles: [htmlFile], cssFiles: [cssFile] });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result?.ok).toBe(false);
    expect(result?.problems.some((p) => p.kind === 'unreadable-html' && p.html === htmlFile)).toBe(
      true,
    );
  });

  it('an unreadable HTML file does not abort the loop over the remaining files', () => {
    // Fail-closed, but not fail-stop: a second, readable HTML file's classes must still be
    // collected even though the first one could not be read.
    const secondHtml = join(root, 'second.html');
    mkdirSync(htmlFile);
    writeFileSync(secondHtml, '<div class="_hiwViz_18mh8_533">hi</div>');
    writeFileSync(cssFile, '._hiwViz_18mh8_533 { width: 465px; }');
    const result = findDanglingClasses({ htmlFiles: [htmlFile, secondHtml], cssFiles: [cssFile] });
    expect(result.problems.some((p) => p.kind === 'unreadable-html')).toBe(true);
    expect(result.problems.some((p) => p.kind === 'dangling-class')).toBe(false);
  });

  // --- Boundary validation: a contract violation throws, it is not misreported --------------

  it('propagates an htmlFiles element contract violation instead of misreporting it', () => {
    writeFileSync(cssFile, '._hiwViz_18mh8_533 { width: 465px; }');
    let caught: unknown;
    try {
      findDanglingClasses({
        // biome-ignore lint/suspicious/noExplicitAny: deliberately violating the htmlFiles element contract
        htmlFiles: [new URL('file:///nonexistent/index.html') as any],
        cssFiles: [cssFile],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toContain('htmlFiles[0]');
  });

  it('propagates a cssFiles element contract violation instead of misreporting it', () => {
    writeFileSync(htmlFile, '<div class="whatever">hi</div>');
    let caught: unknown;
    try {
      findDanglingClasses({
        htmlFiles: [htmlFile],
        // biome-ignore lint/suspicious/noExplicitAny: deliberately violating the cssFiles element contract
        cssFiles: [{ notAPath: true } as any],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toContain('cssFiles[0]');
  });

  // --- Custom hashPattern ---------------------------------------------------------------------

  it('respects a custom hashPattern, including its logical-name capture group', () => {
    // A non-CSS-Modules hash shape: `name__hash`, logical name is group 1.
    writeFileSync(cssFile, '.hiwViz__a1b2c3 { width: 465px; }\n.loading__d4e5f6 { opacity: 0.5; }');
    writeFileSync(htmlFile, '<div class="unrelated">hi</div>');
    const customPattern = /^([A-Za-z0-9]+)__[a-f0-9]+$/;

    const result = findDanglingClasses({
      htmlFiles: [htmlFile],
      cssFiles: [cssFile],
      hashPattern: customPattern,
      allowlist: [/^loading$/],
    });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: 'dangling-class', className: 'hiwViz__a1b2c3' }),
    ]);
  });

  // --- IMPORTANT 7: hashPattern with NO capture group falls back to the full hashed name -----

  it('a hashPattern with no capture group falls back to matching the full hashed name for allowlist', () => {
    // No capture group at all — logicalName's `?? className` fallback is what this test pins.
    // Every other fixture in this file uses a pattern WITH a capture group, which is exactly why
    // this fallback line could regress with 19/19 green elsewhere (IMPORTANT 7).
    const noGroupPattern = /^[A-Za-z0-9]+__[a-f0-9]+$/;
    writeFileSync(cssFile, '.hiwViz__a1b2c3 { width: 465px; }');
    writeFileSync(htmlFile, '<div class="unrelated">hi</div>');

    const result = findDanglingClasses({
      htmlFiles: [htmlFile],
      cssFiles: [cssFile],
      hashPattern: noGroupPattern,
      // The allowlist pattern must match the FULL hashed name, since there is no capture group
      // to extract a shorter logical name from.
      allowlist: [/^hiwViz__a1b2c3$/],
    });
    expect(result).toEqual({ ok: true, problems: [] });
  });

  // --- HIGH 3: hashPattern is consumer-supplied and must be bounded before matching ---------

  it('RED: reports oversized-class-name, not dangling-class, for a selector token over the cap — and never hangs even against a pathological hashPattern', () => {
    // A 200-char class name is far over MAX_HASH_PATTERN_TOKEN_LENGTH (128). /^(a+)+$/ is a
    // classic catastrophic-backtracking pattern — the measured evidence (see errors.ts) is 51.9s
    // against a mere 36-char token. If this selector token ever reached hashPattern.test(), this
    // test would hang for a very long time. The cap must reject it BEFORE the regex ever runs.
    // Trailing 'b' (not 'a') is deliberate: a pure run of 'a' would MATCH /^(a+)+$/ immediately
    // with no backtracking at all — the catastrophic case only triggers when the match ultimately
    // FAILS, forcing the engine to exhaust every way to partition the 'a' run first.
    const oversizedName = `${'a'.repeat(199)}b`;
    writeFileSync(cssFile, `.${oversizedName} { width: 100%; }`);
    writeFileSync(htmlFile, '<div class="unrelated">hi</div>');

    const start = Date.now();
    const result = findDanglingClasses({
      htmlFiles: [htmlFile],
      cssFiles: [cssFile],
      hashPattern: /^(a+)+$/,
    });
    const elapsedMs = Date.now() - start;

    // Generous, not tight (see plan §K3): this only needs to prove "did not hang", not pin a
    // specific millisecond figure that the next person refreshes away.
    expect(elapsedMs).toBeLessThan(5000);
    expect(result.ok).toBe(false);
    expect(
      result.problems.some(
        (p) => p.kind === 'oversized-class-name' && p.className === oversizedName,
      ),
    ).toBe(true);
    // Not silently passed either: the oversized selector must never ALSO be reported as
    // dangling-class (that would claim hashPattern was actually run against it, which it never
    // was).
    expect(
      result.problems.some((p) => p.kind === 'dangling-class' && p.className === oversizedName),
    ).toBe(false);
  });

  it('GREEN: a class name at or under the cap is tested against hashPattern normally', () => {
    writeFileSync(cssFile, '._hiwViz_18mh8_533 { width: 100%; }');
    writeFileSync(htmlFile, '<div class="_hiwViz_18mh8_533">hi</div>');
    const result = findDanglingClasses({ htmlFiles: [htmlFile], cssFiles: [cssFile] });
    expect(result.problems.some((p) => p.kind === 'oversized-class-name')).toBe(false);
  });

  // --- IMPORTANT (review round 2026-08-30): a ScopedAllowlistEntry.file spelling mismatch must
  // be LOUD, never a silent no-op ------------------------------------------------------------

  it('RED (pre-fix behaviour would be silent): an absolute-vs-relative ScopedAllowlistEntry.file mismatch is reported, not swallowed', () => {
    // Reproduced defect: cssFiles carries the absolute path (as resolve()/glob output commonly
    // does) while the allowlist entry names the same file relatively. Exact-string matching in
    // isAllowlisted made this entry permanently inert — the class it names never gets excused,
    // and the resulting dangling-class message tells the consumer to add exactly the entry they
    // already added, with no hint the allowlist was ever involved.
    writeFileSync(cssFile, '._hiwViz_18mh8_533 { width: 100%; }');
    writeFileSync(htmlFile, '<div class="unrelated">hi</div>');

    const result = findDanglingClasses({
      htmlFiles: [htmlFile],
      cssFiles: [cssFile], // absolute (join() against an absolute tmpdir root)
      allowlist: [{ pattern: /^hiwViz$/, file: 'page.module.css' }], // relative spelling
    });

    expect(result.ok).toBe(false);
    expect(
      result.problems.some(
        (p) => p.kind === 'unmatched-allowlist-file' && p.file === 'page.module.css',
      ),
    ).toBe(true);
    // The class still reports dangling too — the fix does not paper over the underlying
    // still-unexcused class, it adds a second, explicit signal naming the config mistake.
    expect(
      result.problems.some(
        (p) => p.kind === 'dangling-class' && p.className === '_hiwViz_18mh8_533',
      ),
    ).toBe(true);
  });

  it('GREEN: a ScopedAllowlistEntry.file spelled identically to its cssFiles entry excuses the class and raises no unmatched-allowlist-file problem', () => {
    writeFileSync(cssFile, '._hiwViz_18mh8_533 { width: 100%; }');
    writeFileSync(htmlFile, '<div class="unrelated">hi</div>');

    const result = findDanglingClasses({
      htmlFiles: [htmlFile],
      cssFiles: [cssFile],
      allowlist: [{ pattern: /^hiwViz$/, file: cssFile }],
    });

    expect(result).toEqual({ ok: true, problems: [] });
  });

  it('a bare RegExp allowlist entry is never checked against cssFiles (it has no file field)', () => {
    writeFileSync(cssFile, '._hiwViz_18mh8_533 { width: 100%; }');
    writeFileSync(htmlFile, '<div class="unrelated">hi</div>');

    const result = findDanglingClasses({
      htmlFiles: [htmlFile],
      cssFiles: [cssFile],
      allowlist: [/^hiwViz$/],
    });

    expect(result.problems.some((p) => p.kind === 'unmatched-allowlist-file')).toBe(false);
  });
});

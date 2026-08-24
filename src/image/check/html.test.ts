import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractImgTags, hasObjectFit, verifyHtmlImages } from './html.ts';

/**
 * Built-HTML image gate: presence mode (web-usa) and full mode (boufin), one gate.
 *
 * Real temp trees with real PNG bytes, matching the house adversarial-fs style — a gate is the
 * highest-risk artifact here, so it must fail for the right reason over real bytes, not stubs.
 */

let dir: string;

function write(rel: string, content: string | Buffer): void {
  const full = join(dir, rel);
  mkdirSync(full.slice(0, full.lastIndexOf(sep)), { recursive: true });
  writeFileSync(full, content);
}

/** A real 8-bit RGB PNG of the given size. Only the IHDR is meaningful to the reader under test. */
function pngBytes(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); // chunk length
  ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; // bit depth
  ihdr[17] = 2; // colour type: truecolour
  return Buffer.concat([signature, ihdr]);
}

/**
 * boufin's sandboxed resolver, reconstructed here rather than imported: `resolveAsset` is a
 * caller-supplied option (D17), so the kit's job is only to call it with (src, dir) and honour
 * `undefined` as "skip" — the sandbox itself belongs to whoever wires the gate into their build.
 */
function resolveAsset(src: string, root: string): string | undefined {
  const clean = (src.split('?')[0] as string).split('#')[0] as string;
  if (!clean.startsWith('/')) return undefined;
  const resolved = resolve(root, `.${clean}`);
  const base = resolve(root);
  if (resolved !== base && !resolved.startsWith(base + sep)) return undefined;
  return resolved;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'html-gate-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('extractImgTags', () => {
  it('reads src, dimensions and classes off a rendered tag', () => {
    const [img] = extractImgTags('<img src="/a.png" class="x y" width="10" height="20"/>');
    expect(img).toEqual({ src: '/a.png', width: 10, height: 20, classes: ['x', 'y'] });
  });

  it('treats a non-numeric or zero dimension as absent', () => {
    const [img] = extractImgTags('<img src="/a.png" width="auto" height="0"/>');
    expect(img?.width).toBeUndefined();
    expect(img?.height).toBeUndefined();
  });

  it('treats an empty width attribute as absent', () => {
    const [img] = extractImgTags('<img src="/a.png" width="" height="20"/>');
    expect(img?.width).toBeUndefined();
  });

  it('defaults classes to an empty list with no class attribute', () => {
    const [img] = extractImgTags('<img src="/a.png" width="10" height="20"/>');
    expect(img?.classes).toEqual([]);
  });
});

describe('hasObjectFit', () => {
  const css = '._photo_abc{object-fit:cover}._plain_abc{border:0}._fill_abc{object-fit:fill}';

  it('finds a reshaping fit on the element own class', () => {
    expect(hasObjectFit(['_photo_abc'], css)).toBe(true);
  });

  it('does not treat object-fit:fill as intentional', () => {
    expect(hasObjectFit(['_fill_abc'], css)).toBe(false);
  });

  it('does not match a class that merely shares a prefix', () => {
    expect(hasObjectFit(['_photo'], '._photoWrapper{object-fit:cover}')).toBe(false);
  });

  it('is false when the class has no fit at all', () => {
    expect(hasObjectFit(['_plain_abc'], css)).toBe(false);
  });

  // Step 4: one regression per historical defeat of this matcher.

  it('DEFEAT 1 — does not read object-fit out of a CSS COMMENT', () => {
    const commented =
      '.photo{width:100%;/* TODO: consider object-fit: cover here */background:red}';
    expect(hasObjectFit(['photo'], commented)).toBe(false);
  });

  it('DEFEAT 2 — does not treat a DESCENDANT rule as a fit on the ancestor', () => {
    // `.wrap .img { object-fit: cover }` gives the fit to `.img`. Reading it as if `.wrap` had it
    // falsely excused every element carrying `.wrap` from the stretch check.
    expect(hasObjectFit(['wrap'], '.wrap .img{object-fit:cover}')).toBe(false);
    expect(hasObjectFit(['img'], '.wrap .img{object-fit:cover}')).toBe(true);
  });

  it('DEFEAT 3 — does not read a class out of a quoted ATTRIBUTE VALUE', () => {
    // `.unrelated[title=" .photo"]` splits on the space INSIDE the quoted value, leaving a fake
    // trailing compound `.photo"]` that matched — falsely exempting every `.photo` image.
    const withAttr = '.photo{width:100%}\n.unrelated[title=" .photo"]{object-fit:cover}';
    expect(hasObjectFit(['photo'], withAttr)).toBe(false);
    expect(hasObjectFit(['unrelated'], withAttr)).toBe(true);
  });

  it('DEFEAT 4 — handles a BACKSLASH-ESCAPED close bracket inside an attribute value', () => {
    // The first fix blanked `\[[^\]]*\]`, which stops at the first literal `]` — an escaped `\]`
    // inside the value ended the blank early and let the tail through.
    expect(hasObjectFit(['photo'], '.decoy[data-x="a\\]b .photo"]{object-fit:cover}')).toBe(false);
  });
});

describe('verifyHtmlImages — presence mode (resolveAsset omitted)', () => {
  it('passes tags that all carry numeric width/height', () => {
    write('a/index.html', '<html><img src="/x.png" width="10" height="20"/></html>');
    const result = verifyHtmlImages({ dir });
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.imagesChecked).toBe(1);
    expect(result.htmlFiles).toBe(1);
  });

  it('fails a tag with no width/height attributes at all', () => {
    write('a/index.html', '<html><img src="/x.png"/></html>');
    const result = verifyHtmlImages({ dir });
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.message).toContain('no width/height');
  });

  it('fails width="" as absent, not present-but-empty', () => {
    write('a/index.html', '<html><img src="/x.png" width="" height="20"/></html>');
    const result = verifyHtmlImages({ dir });
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
  });

  it('fails a non-numeric dimension', () => {
    write('a/index.html', '<html><img src="/x.png" width="auto" height="20"/></html>');
    const result = verifyHtmlImages({ dir });
    expect(result.ok).toBe(false);
  });

  it('fails when zero HTML files exist under dir, unconditionally', () => {
    const result = verifyHtmlImages({ dir });
    expect(result.ok).toBe(false);
    expect(result.htmlFiles).toBe(0);
    expect(result.problems.some((p) => p.message.includes('no HTML found'))).toBe(true);
  });

  it('applies the minImages anti-vacuity floor only when set', () => {
    write('a/index.html', '<html><img src="/x.png" width="10" height="20"/></html>');
    const unbounded = verifyHtmlImages({ dir });
    expect(unbounded.ok).toBe(true); // minImages defaults to 0 = off

    const bounded = verifyHtmlImages({ dir, minImages: 5 });
    expect(bounded.ok).toBe(false);
    expect(bounded.problems.some((p) => p.message.includes('expected at least 5'))).toBe(true);
  });
});

describe('verifyHtmlImages — full mode (resolveAsset provided)', () => {
  it('passes a box whose declared ratio matches the file', () => {
    write('x.png', pngBytes(100, 50));
    write('a/index.html', '<html><img src="/x.png" width="200" height="100"/></html>');
    const result = verifyHtmlImages({ dir, resolveAsset });
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it('fails a ratio mismatch with no object-fit escape hatch', () => {
    write('wide.png', pngBytes(1000, 250)); // 4:1
    write('a/index.html', '<html><img src="/wide.png" width="100" height="100"/></html>');
    const result = verifyHtmlImages({ dir, resolveAsset });
    expect(result.ok).toBe(false);
    expect(result.problems[0]?.message).toContain('1000x250');
  });

  it('excuses a ratio mismatch when object-fit: cover is declared', () => {
    write('wide.png', pngBytes(1000, 250));
    write('styles.css', '._crop{object-fit:cover}');
    write(
      'a/index.html',
      '<html><img src="/wide.png" class="_crop" width="100" height="100"/></html>',
    );
    const result = verifyHtmlImages({ dir, resolveAsset });
    expect(result.ok).toBe(true);
  });

  it('does NOT let object-fit: fill excuse a mismatch', () => {
    write('wide.png', pngBytes(1000, 250));
    write('styles.css', '._fill{object-fit:fill}');
    write(
      'a/index.html',
      '<html><img src="/wide.png" class="_fill" width="100" height="100"/></html>',
    );
    const result = verifyHtmlImages({ dir, resolveAsset });
    expect(result.ok).toBe(false);
  });

  it('does NOT let an unknown object-fit value excuse a mismatch', () => {
    write('wide.png', pngBytes(1000, 250));
    write('styles.css', '._weird{object-fit:revert-layer}');
    write(
      'a/index.html',
      '<html><img src="/wide.png" class="_weird" width="100" height="100"/></html>',
    );
    const result = verifyHtmlImages({ dir, resolveAsset });
    expect(result.ok).toBe(false);
  });

  it('fails a resolvable file that cannot be measured, rather than passing it', () => {
    write('mystery.xyz', Buffer.from('not an image, but long enough to read a header from'));
    write('a/index.html', '<html><img src="/mystery.xyz" width="10" height="10"/></html>');
    const result = verifyHtmlImages({ dir, resolveAsset });
    expect(result.ok).toBe(false);
    expect(result.problems[0]?.message).toContain('could not be measured');
  });

  it('skips (does not crash on) a src that escapes the tree via ../', () => {
    write('x.png', pngBytes(100, 50));
    write('a/index.html', '<html><img src="/../../etc/hosts" width="1" height="1"/></html>');
    const result = verifyHtmlImages({ dir, resolveAsset });
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it('skips a src with query/hash fragments that resolves once stripped', () => {
    write('x.png', pngBytes(100, 50));
    write('a/index.html', '<html><img src="/x.png?v=2#frag" width="200" height="100"/></html>');
    const result = verifyHtmlImages({ dir, resolveAsset });
    expect(result.ok).toBe(true);
  });

  it('does not exempt SVG src from the ratio check', () => {
    write('logo.svg', '<svg width="10" height="10" viewBox="0 0 400 100"></svg>');
    write('a/index.html', '<html><img src="/logo.svg" width="20" height="20"/></html>');
    const result = verifyHtmlImages({ dir, resolveAsset });
    expect(result.ok).toBe(false);
  });
});

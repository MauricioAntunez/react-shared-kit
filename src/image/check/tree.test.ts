import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ImageManifest, Rung, RungFiles } from '../types.ts';
import { verifyImageTree } from './tree.ts';

// No image is ever decoded here (this module is sharp-free by construction), so file CONTENT is
// arbitrary — only filenames and byte counts matter. Plain byte buffers stand in for real images.
const BYTES = Buffer.from('not-a-real-image');

let root: string;
let masters: string;
let output: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uxr-tree-'));
  masters = join(root, 'assets');
  output = join(root, 'public');
  mkdirSync(masters, { recursive: true });
  mkdirSync(output, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function rungFiles(base: string, w: number): RungFiles {
  return { avif: `${base}-${w}.avif`, webp: `${base}-${w}.webp`, jpeg: `${base}-${w}.jpeg` };
}

/** Writes a master + its full rung ladder to disk and returns the manifest entry for it. */
function plantEntry(key: string, widths: number[]): { rungs: Rung[] } {
  const base = key.slice(key.lastIndexOf('/') + 1);
  const dir = key.slice(0, key.lastIndexOf('/')) || '/';
  mkdirSync(join(masters, dir), { recursive: true });
  mkdirSync(join(output, dir), { recursive: true });
  writeFileSync(join(masters, key), BYTES);

  const rungs: Rung[] = widths.map((w) => {
    const files = rungFiles(base, w);
    for (const name of Object.values(files)) writeFileSync(join(output, dir, name), BYTES);
    return { w, files };
  });
  return { rungs };
}

function manifestOf(key: string, widths: number[]): ImageManifest {
  const { rungs } = plantEntry(key, widths);
  return { [key]: { w: 800, h: 600, class: 'hero', rungs } };
}

describe('verifyImageTree', () => {
  it('passes clean on a fully consistent tree', () => {
    const manifest = manifestOf('/hero.jpg', [320, 640]);
    const result = verifyImageTree({ manifest, outputDir: output, mastersDir: masters });
    expect(result).toEqual({ ok: true, issues: [], filesChecked: expect.any(Number) });
    expect(result.filesChecked).toBeGreaterThan(0);
  });

  it('fires empty-manifest for a manifest with no entries', () => {
    const result = verifyImageTree({ manifest: {}, outputDir: output, mastersDir: masters });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.kind === 'empty-manifest')).toBe(true);
  });

  it('fires invalid-key for a key missing the leading slash', () => {
    const manifest: ImageManifest = { 'hero.jpg': { w: 1, h: 1, class: 'x', rungs: [] } };
    const result = verifyImageTree({ manifest, outputDir: output, mastersDir: masters });
    expect(result.issues.some((i) => i.kind === 'invalid-key')).toBe(true);
  });

  it('fires invalid-key (containment probe) for a key containing ".."', () => {
    const manifest: ImageManifest = { '/../etc/hero.jpg': { w: 1, h: 1, class: 'x', rungs: [] } };
    const result = verifyImageTree({ manifest, outputDir: output, mastersDir: masters });
    expect(result.issues.some((i) => i.kind === 'invalid-key')).toBe(true);
    // A rejected key must never reach a path join — no path-escape should also fire for it.
    expect(result.issues.some((i) => i.kind === 'path-escape')).toBe(false);
  });

  it('fires no-rungs when an entry declares zero rungs', () => {
    writeFileSync(join(masters, 'hero.jpg'), BYTES);
    const manifest: ImageManifest = { '/hero.jpg': { w: 1, h: 1, class: 'x', rungs: [] } };
    const result = verifyImageTree({ manifest, outputDir: output, mastersDir: masters });
    expect(result.issues.some((i) => i.kind === 'no-rungs')).toBe(true);
  });

  it('fires missing-format when a rung omits one format', () => {
    const manifest = manifestOf('/hero.jpg', [320]);
    const entry = manifest['/hero.jpg'];
    if (!entry) throw new Error('test setup invariant violated');
    const rung = entry.rungs[0];
    if (!rung) throw new Error('test setup invariant violated');
    (rung.files as unknown as Record<string, string | undefined>).jpeg = undefined;
    const result = verifyImageTree({ manifest, outputDir: output, mastersDir: masters });
    expect(result.issues.some((i) => i.kind === 'missing-format')).toBe(true);
  });

  it('fires path-escape (containment probe) for a rung filename containing "../"', () => {
    const manifest = manifestOf('/hero.jpg', [320]);
    const entry = manifest['/hero.jpg'];
    if (!entry) throw new Error('test setup invariant violated');
    const rung = entry.rungs[0];
    if (!rung) throw new Error('test setup invariant violated');
    rung.files.avif = '../../etc/evil.avif';
    const result = verifyImageTree({ manifest, outputDir: output, mastersDir: masters });
    expect(result.issues.some((i) => i.kind === 'path-escape')).toBe(true);
  });

  it('fires missing-file when a declared rung file does not exist on disk', () => {
    const manifest = manifestOf('/hero.jpg', [320]);
    const entry = manifest['/hero.jpg'];
    if (!entry) throw new Error('test setup invariant violated');
    const rung = entry.rungs[0];
    if (!rung) throw new Error('test setup invariant violated');
    rmSync(join(output, rung.files.webp));
    const result = verifyImageTree({ manifest, outputDir: output, mastersDir: masters });
    expect(result.issues.some((i) => i.kind === 'missing-file')).toBe(true);
  });

  it('fires empty-file when a declared file exists but is zero bytes', () => {
    const manifest = manifestOf('/hero.jpg', [320]);
    const entry = manifest['/hero.jpg'];
    if (!entry) throw new Error('test setup invariant violated');
    const rung = entry.rungs[0];
    if (!rung) throw new Error('test setup invariant violated');
    writeFileSync(join(output, rung.files.webp), Buffer.alloc(0));
    const result = verifyImageTree({ manifest, outputDir: output, mastersDir: masters });
    expect(result.issues.some((i) => i.kind === 'empty-file')).toBe(true);
  });

  it('fires ladder-violation for a non-ascending rung ladder', () => {
    const manifest = manifestOf('/hero.jpg', [640, 320]);
    const result = verifyImageTree({ manifest, outputDir: output, mastersDir: masters });
    expect(result.issues.some((i) => i.kind === 'ladder-violation')).toBe(true);
  });

  it('fires ladder-violation for a duplicate rung width', () => {
    const manifest = manifestOf('/hero.jpg', [320, 320]);
    const result = verifyImageTree({ manifest, outputDir: output, mastersDir: masters });
    expect(result.issues.some((i) => i.kind === 'ladder-violation')).toBe(true);
  });

  it('fires orphan-rung for a rung-shaped file the manifest never declares', () => {
    const manifest = manifestOf('/hero.jpg', [320]);
    writeFileSync(join(output, 'hero.jpg-999.avif'), BYTES);
    const result = verifyImageTree({ manifest, outputDir: output, mastersDir: masters });
    expect(result.issues.some((i) => i.kind === 'orphan-rung')).toBe(true);
  });

  it('ignores a non-rung-shaped file in a managed directory (no orphan-rung)', () => {
    const manifest = manifestOf('/hero.jpg', [320]);
    writeFileSync(join(output, 'README.txt'), BYTES);
    const result = verifyImageTree({ manifest, outputDir: output, mastersDir: masters });
    expect(result.issues.some((i) => i.kind === 'orphan-rung')).toBe(false);
  });

  it('fires master-not-in-manifest for a master-shaped file under mastersDir with no entry', () => {
    const manifest = manifestOf('/hero.jpg', [320]);
    writeFileSync(join(masters, 'stray.jpg'), BYTES);
    const result = verifyImageTree({ manifest, outputDir: output, mastersDir: masters });
    expect(
      result.issues.some((i) => i.kind === 'master-not-in-manifest' && i.path === '/stray.jpg'),
    ).toBe(true);
  });

  it('fires hash-missing when masterHashes omits a key the manifest declares', () => {
    const manifest = manifestOf('/hero.jpg', [320]);
    const result = verifyImageTree({
      manifest,
      outputDir: output,
      mastersDir: masters,
      masterHashes: {},
    });
    expect(result.issues.some((i) => i.kind === 'hash-missing')).toBe(true);
  });

  it('fires master-changed when the recorded hash does not match the file on disk', () => {
    const manifest = manifestOf('/hero.jpg', [320]);
    const result = verifyImageTree({
      manifest,
      outputDir: output,
      mastersDir: masters,
      masterHashes: { '/hero.jpg': 'deadbeef'.repeat(8) },
    });
    expect(result.issues.some((i) => i.kind === 'master-changed')).toBe(true);
  });

  it('fires master-missing when a recorded hash names a master that is no longer on disk', () => {
    const manifest = manifestOf('/hero.jpg', [320]);
    rmSync(join(masters, 'hero.jpg'));
    const result = verifyImageTree({
      manifest,
      outputDir: output,
      mastersDir: masters,
      masterHashes: { '/hero.jpg': 'deadbeef'.repeat(8) },
    });
    expect(result.issues.some((i) => i.kind === 'master-missing')).toBe(true);
  });

  it('skips every hash check when masterHashes is omitted, while structure still verifies', () => {
    const manifest = manifestOf('/hero.jpg', [320]);
    const result = verifyImageTree({ manifest, outputDir: output, mastersDir: masters });
    expect(result.ok).toBe(true);
    expect(result.issues.some((i) => i.kind === 'hash-missing')).toBe(false);
    expect(result.issues.some((i) => i.kind === 'master-changed')).toBe(false);
    expect(result.issues.some((i) => i.kind === 'master-missing')).toBe(false);
  });
});

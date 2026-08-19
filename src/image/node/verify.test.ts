import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ImageManifest } from '../types.ts';
import { verifyImages } from './verify.ts';

const CLASSES = { content: { widths: [480, 768], masterMin: 768 } };
let dir: string;

async function write(path: string, width: number, height: number) {
  await sharp({ create: { width, height, channels: 3, background: '#123456' } })
    .jpeg()
    .toFile(path);
}

function manifest(rungW: number): ImageManifest {
  return {
    '/images/blog/foo.jpg': {
      w: 1000,
      h: 600,
      class: 'content',
      rungs: [
        { w: rungW, files: { avif: 'foo-480.avif', webp: 'foo-480.webp', jpeg: 'foo-480.jpg' } },
      ],
    },
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'uxr-ver-'));
  const blog = join(dir, 'images', 'blog');
  await mkdir(blog, { recursive: true });
  await write(join(blog, 'foo.jpg'), 1000, 600);
  await write(join(blog, 'foo-480.jpg'), 480, 288);
  await write(join(blog, 'foo-480.webp'), 480, 288);
  await write(join(blog, 'foo-480.avif'), 480, 288);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('verifyImages', () => {
  it('passes a consistent tree', async () => {
    const r = await verifyImages({ manifest: manifest(480), classes: CLASSES, sourceDir: dir });
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('fails on a missing derivative', async () => {
    await rm(join(dir, 'images', 'blog', 'foo-480.webp'));
    const r = await verifyImages({ manifest: manifest(480), classes: CLASSES, sourceDir: dir });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.kind === 'missing-file')).toBe(true);
  });

  it('fails when a descriptor disagrees with the file it names (D10 mechanism 3)', async () => {
    const r = await verifyImages({ manifest: manifest(1600), classes: CLASSES, sourceDir: dir });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.kind === 'descriptor-mismatch')).toBe(true);
  });

  it('fails when a derivative is wider than its master', async () => {
    await write(join(dir, 'images', 'blog', 'foo.jpg'), 300, 200);
    const r = await verifyImages({ manifest: manifest(480), classes: CLASSES, sourceDir: dir });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.kind === 'upscale')).toBe(true);
  });

  it('fails on a master below its class masterMin', async () => {
    await write(join(dir, 'images', 'blog', 'foo.jpg'), 600, 400);
    const m = manifest(480);
    const entry = m['/images/blog/foo.jpg'];
    if (entry) entry.w = 600;
    const r = await verifyImages({ manifest: m, classes: CLASSES, sourceDir: dir });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.kind === 'undersized-master')).toBe(true);
  });
});

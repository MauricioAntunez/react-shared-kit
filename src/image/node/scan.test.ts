import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { orientedSize } from './scan.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'uxr-scan-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('orientedSize', () => {
  it('reports stored dimensions for an unrotated master', async () => {
    const p = join(dir, 'flat.jpg');
    await sharp({ create: { width: 900, height: 300, channels: 3, background: '#123' } })
      .jpeg()
      .toFile(p);
    expect(await orientedSize(p)).toEqual({ width: 900, height: 300 });
  });

  it('SWAPS the axes for EXIF orientations 5-8', async () => {
    const p = join(dir, 'rot.jpg');
    await sharp({ create: { width: 900, height: 300, channels: 3, background: '#123' } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toFile(p);
    // imagetools auto-orients before resizing, so the encoded image is 300 wide, not 900.
    expect(await orientedSize(p)).toEqual({ width: 300, height: 900 });
  });

  it('falls back to decoding rather than failing, and NEVER returns zero', async () => {
    const p = join(dir, 'viewbox.svg');
    // No width/height attributes — dimensions come from the viewBox, which is the shape of input
    // whose header may not carry them directly.
    await writeFile(
      p,
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 150">' +
        '<rect width="300" height="150" fill="red"/></svg>',
    );
    const size = await orientedSize(p);
    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(0);
  });

  it('throws for a file that cannot be decoded at all', async () => {
    const p = join(dir, 'broken.jpg');
    await writeFile(p, 'not an image');
    await expect(orientedSize(p)).rejects.toThrow();
  });
});

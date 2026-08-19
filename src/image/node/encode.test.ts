import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encodeOne } from './encode.ts';

const MASTER = 'src/image/node/__fixtures__/master-1200.jpg';

describe('encodeOne', () => {
  it('has a fixture to work with', () => {
    expect(existsSync(MASTER)).toBe(true);
  });

  it('encodes AVIF at the requested width through imagetools-core', async () => {
    const out = await encodeOne(MASTER, 320, 'avif', 55);
    expect(out.width).toBe(320);
    expect(out.data.length).toBeGreaterThan(0);
  });

  it('encodes WebP at the requested width', async () => {
    const out = await encodeOne(MASTER, 320, 'webp', 72);
    expect(out.width).toBe(320);
    expect(out.data.length).toBeGreaterThan(0);
  });

  it('NEVER upscales: a rung wider than the master returns the master width', async () => {
    const out = await encodeOne(MASTER, 4000, 'webp', 72);
    expect(out.width).toBe(1200);
  });

  it('reports the MEASURED width, not the requested one', async () => {
    const out = await encodeOne(MASTER, 4000, 'webp', 72);
    expect(out.width).not.toBe(4000);
  });
});

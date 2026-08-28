import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { intrinsicSize, sameAspect } from './dimensions.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'uxr-dims-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function put(name: string, data: Buffer | string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, data);
  return p;
}

/** 8-byte signature, then an IHDR chunk whose payload opens with two big-endian uint32s. */
function pngFixture(w: number, h: number): Buffer {
  const b = Buffer.alloc(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

/** SOI, an APP0 (JFIF) segment, then a progressive SOF2 carrying the frame size. */
function jpegFixture(w: number, h: number): Buffer {
  const b = Buffer.alloc(32);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  b[3] = 0xe0;
  b.writeUInt16BE(16, 4);
  b.write('JFIF', 6, 'ascii');
  b[20] = 0xff;
  b[21] = 0xcb;
  b.writeUInt16BE(7, 22);
  b[24] = 8;
  b.writeUInt16BE(h, 25);
  b.writeUInt16BE(w, 27);
  return b;
}

function webpBase(chunk: string, chunkSize: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(4 + chunkSize, 4);
  b.write('WEBP', 8, 'ascii');
  b.write(chunk, 12, 'ascii');
  b.writeUInt32LE(chunkSize, 16);
  return b;
}

function webpVP8X(w: number, h: number): Buffer {
  const b = webpBase('VP8X', 10);
  b[24] = (w - 1) & 0xff;
  b[25] = ((w - 1) >> 8) & 0xff;
  b[26] = ((w - 1) >> 16) & 0xff;
  b[27] = (h - 1) & 0xff;
  b[28] = ((h - 1) >> 8) & 0xff;
  b[29] = ((h - 1) >> 16) & 0xff;
  return b;
}

function webpVP8(w: number, h: number): Buffer {
  const b = webpBase('VP8 ', 6);
  b[23] = 0x9d;
  b[24] = 0x01;
  b[25] = 0x2a;
  b.writeUInt16LE(w, 26);
  b.writeUInt16LE(h, 28);
  return b;
}

function webpVP8L(w: number, h: number): Buffer {
  const b = webpBase('VP8L', 5);
  b[20] = 0x2f;
  b.writeUInt32LE(((h - 1) << 14) | (w - 1), 21);
  return b;
}

/** ftyp box, then an `ispe` box right after it — the first one in the file. */
function avifFixture(w: number, h: number): Buffer {
  const b = Buffer.alloc(32);
  b.writeUInt32BE(12, 0);
  b.write('ftyp', 4, 'ascii');
  b.write('avif', 8, 'ascii');
  const at = 16;
  b.writeUInt32BE(20, at - 4);
  b.write('ispe', at, 'ascii');
  b.writeUInt32BE(0, at + 4);
  b.writeUInt32BE(w, at + 8);
  b.writeUInt32BE(h, at + 12);
  return b;
}

describe('intrinsicSize', () => {
  it('reads a minimal PNG (signature + IHDR)', async () => {
    const p = await put('a.png', pngFixture(976, 1100));
    expect(intrinsicSize(p)).toEqual({ width: 976, height: 1100 });
  });

  it('walks past non-SOF segments to a progressive SOF2', async () => {
    const p = await put('a.jpg', jpegFixture(640, 480));
    expect(intrinsicSize(p)).toEqual({ width: 640, height: 480 });
  });

  it('reads the VP8X extended canvas', async () => {
    const p = await put('a.webp', webpVP8X(1024, 768));
    expect(intrinsicSize(p)).toEqual({ width: 1024, height: 768 });
  });

  it('reads the VP8 lossy frame', async () => {
    const p = await put('a.webp', webpVP8(800, 600));
    expect(intrinsicSize(p)).toEqual({ width: 800, height: 600 });
  });

  it('reads the VP8L lossless frame', async () => {
    const p = await put('a.webp', webpVP8L(512, 384));
    expect(intrinsicSize(p)).toEqual({ width: 512, height: 384 });
  });

  it('reads the first ispe box of an AVIF', async () => {
    const p = await put('a.avif', avifFixture(1280, 720));
    expect(intrinsicSize(p)).toEqual({ width: 1280, height: 720 });
  });

  it('reads an SVG viewBox as the intrinsic size', async () => {
    const p = await put(
      'a.svg',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600"><rect/></svg>',
    );
    expect(intrinsicSize(p)).toEqual({ width: 800, height: 600 });
  });

  it('falls back to width/height attributes when there is no viewBox', async () => {
    const p = await put(
      'a.svg',
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"></svg>',
    );
    expect(intrinsicSize(p)).toEqual({ width: 320, height: 240 });
  });
});

describe('intrinsicSize — adversarial', () => {
  it('returns undefined for a zero-byte file', async () => {
    const p = await put('a.png', Buffer.alloc(0));
    expect(intrinsicSize(p)).toBeUndefined();
  });

  it('returns undefined for a 15-byte file', async () => {
    const p = await put('a.png', Buffer.alloc(15, 0x89));
    expect(intrinsicSize(p)).toBeUndefined();
  });

  it('returns undefined for unknown magic', async () => {
    const p = await put('a.gif', Buffer.from(`GIF89a${'x'.repeat(20)}`));
    expect(intrinsicSize(p)).toBeUndefined();
  });

  it('returns undefined for a missing file instead of throwing', async () => {
    expect(intrinsicSize(join(dir, 'nope.png'))).toBeUndefined();
  });

  it('returns undefined for a PNG whose IHDR is not IHDR', async () => {
    const b = pngFixture(10, 10);
    b.write('JUNK', 12, 'ascii');
    const p = await put('a.png', b);
    expect(intrinsicSize(p)).toBeUndefined();
  });

  it('does not loop on a JPEG segment with a zero length', async () => {
    const b = Buffer.alloc(20);
    b[0] = 0xff;
    b[1] = 0xd8;
    b[2] = 0xff;
    b[3] = 0xe0;
    b.writeUInt16BE(0, 4);
    const p = await put('a.jpg', b);
    expect(intrinsicSize(p)).toBeUndefined();
  });

  it('returns undefined for a VP8X truncated before its canvas size', async () => {
    const p = await put('a.webp', webpVP8X(1024, 768).subarray(0, 29));
    expect(intrinsicSize(p)).toBeUndefined();
  });

  it('returns undefined for a VP8 truncated before its frame size', async () => {
    const p = await put('a.webp', webpVP8(800, 600).subarray(0, 29));
    expect(intrinsicSize(p)).toBeUndefined();
  });

  it('returns undefined for a VP8L truncated before its packed bits', async () => {
    const p = await put('a.webp', webpVP8L(512, 384).subarray(0, 24));
    expect(intrinsicSize(p)).toBeUndefined();
  });

  it('returns undefined for an ispe truncated in its final four bytes (boufin regression)', async () => {
    const p = await put('a.avif', avifFixture(1280, 720).subarray(0, 28));
    expect(intrinsicSize(p)).toBeUndefined();
  });

  it('returns undefined for an AVIF with no ispe box', async () => {
    const b = avifFixture(1280, 720);
    b.write('junk', 16, 'ascii');
    const p = await put('a.avif', b);
    expect(intrinsicSize(p)).toBeUndefined();
  });
});

describe('sameAspect', () => {
  it('passes a difference of exactly the 1% tolerance', () => {
    expect(sameAspect({ width: 10000, height: 1 }, { width: 9900, height: 1 })).toBe(true);
  });

  it('fails just over the 1% tolerance', () => {
    expect(sameAspect({ width: 10000, height: 1 }, { width: 9899, height: 1 })).toBe(false);
  });

  it('passes the 976x1100 master vs 320x361 rung rounding case', () => {
    expect(sameAspect({ width: 976, height: 1100 }, { width: 320, height: 361 })).toBe(true);
  });

  it('fails a genuinely different shape', () => {
    expect(sameAspect({ width: 1000, height: 600 }, { width: 480, height: 480 })).toBe(false);
  });

  it('honours a custom tolerance', () => {
    expect(sameAspect({ width: 10000, height: 1 }, { width: 9899, height: 1 }, 0.02)).toBe(true);
  });
});

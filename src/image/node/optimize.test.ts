import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineImageClasses } from '../imageClasses.ts';
import { optimizeImages } from './optimize.ts';

const { classes, classForPath } = defineImageClasses(
  { content: { widths: [480, 768], masterMin: 768 } },
  { blog: 'content' },
);

let dir: string;
let opts: Parameters<typeof optimizeImages>[0];

async function makeMaster(path: string, width: number, height: number, tint = 200) {
  await sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 20, b: tint } },
  })
    .jpeg({ quality: 92 })
    .toFile(path);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'uxr-img-'));
  await writeFile(join(dir, '.keep'), '');
  const blog = join(dir, 'images', 'blog');
  await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } })
    .jpeg()
    .toFile(join(dir, '.seed.jpg'))
    .catch(() => undefined);
  await rm(join(dir, '.seed.jpg'), { force: true });
  await (await import('node:fs/promises')).mkdir(blog, { recursive: true });
  await makeMaster(join(blog, 'foo.jpg'), 1000, 600);
  opts = {
    sourceDir: dir,
    classes,
    classForPath,
    manifestPath: join(dir, 'manifest.json'),
    ledgerPath: join(dir, 'ledger.json'),
  };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('optimizeImages', () => {
  it('encodes every rung on the first run', async () => {
    const r = await optimizeImages(opts);
    expect(r.encoded).toBeGreaterThan(0);
    expect(existsSync(join(dir, 'images', 'blog', 'foo-480.avif'))).toBe(true);
    expect(existsSync(join(dir, 'images', 'blog', 'foo-480.webp'))).toBe(true);
    expect(existsSync(join(dir, 'images', 'blog', 'foo-480.jpg'))).toBe(true);
  });

  it('does ZERO work on an unchanged second run', async () => {
    await optimizeImages(opts);
    const second = await optimizeImages(opts);
    expect(second.encoded).toBe(0);
    expect(second.bytesWritten).toBe(0);
    expect(second.skipped).toBeGreaterThan(0);
  });

  it('re-encodes when the master CONTENT changes', async () => {
    await optimizeImages(opts);
    await makeMaster(join(dir, 'images', 'blog', 'foo.jpg'), 1000, 600, 40);
    const second = await optimizeImages(opts);
    expect(second.encoded).toBeGreaterThan(0);
  });

  it('does NOT re-encode when only the mtime changes (D6 — never mtime)', async () => {
    await optimizeImages(opts);
    const future = new Date(Date.now() + 86_400_000);
    await utimes(join(dir, 'images', 'blog', 'foo.jpg'), future, future);
    const second = await optimizeImages(opts);
    expect(second.encoded).toBe(0);
  });

  it('re-encodes when a generation param changes', async () => {
    await optimizeImages(opts);
    const second = await optimizeImages({ ...opts, formats: { avif: 40 } });
    expect(second.encoded).toBeGreaterThan(0);
  });

  it('regenerates a deleted derivative without touching the others', async () => {
    await optimizeImages(opts);
    await rm(join(dir, 'images', 'blog', 'foo-480.webp'));
    const second = await optimizeImages(opts);
    expect(second.encoded).toBeGreaterThan(0);
    expect(existsSync(join(dir, 'images', 'blog', 'foo-480.webp'))).toBe(true);
  });

  it('NEVER upscales: rungs above the master are truncated away entirely (D10)', async () => {
    const blog = join(dir, 'images', 'blog');
    await rm(join(blog, 'foo.jpg'));
    await makeMaster(join(blog, 'small.jpg'), 600, 400);
    const r = await optimizeImages(opts);
    expect(existsSync(join(blog, 'small-768.webp'))).toBe(false);
    expect(existsSync(join(blog, 'small-480.webp'))).toBe(true);
    expect(r.truncated.length).toBe(1);
  });

  it('reports an undersized master instead of silently shipping it', async () => {
    const blog = join(dir, 'images', 'blog');
    await rm(join(blog, 'foo.jpg'));
    await makeMaster(join(blog, 'small.jpg'), 600, 400);
    const r = await optimizeImages(opts);
    expect(r.undersized.length).toBe(1);
    expect(r.undersized[0]?.masterMin).toBe(768);
  });

  it('records MEASURED widths in the manifest', async () => {
    const r = await optimizeImages(opts);
    const entry = r.manifest['/images/blog/foo.jpg'];
    expect(entry?.w).toBe(1000);
    expect(entry?.rungs.map((x) => x.w)).toEqual([480, 768]);
  });

  it('ALWAYS emits AVIF, even when it is the larger file (D11)', async () => {
    const r = await optimizeImages(opts);
    const entry = r.manifest['/images/blog/foo.jpg'];
    for (const rung of entry?.rungs ?? []) {
      expect(existsSync(join(dir, 'images', 'blog', rung.files.avif))).toBe(true);
    }
  });

  it('produces an IDENTICAL manifest on the skip path as on the encode path (D10 mechanism 3)', async () => {
    const first = await optimizeImages(opts);
    const second = await optimizeImages(opts);
    expect(second.encoded).toBe(0);
    // The skip path must REPLAY measured widths from the ledger, not re-derive them from the
    // requested ladder. Re-deriving reintroduces the lying-descriptor bug on the incremental
    // path — which is the common path, so it would be wrong on nearly every build.
    expect(second.manifest).toEqual(first.manifest);
  });

  it('replays measured rungs from the ledger rather than the requested ladder', async () => {
    await optimizeImages(opts);
    const ledger = JSON.parse(await readFile(opts.ledgerPath, 'utf8'));
    expect(ledger['/images/blog/foo.jpg'].rungs.map((r: { w: number }) => r.w)).toEqual([480, 768]);
  });

  it('measures an EXIF-ROTATED master on the oriented axis, so no descriptor lies (D10)', async () => {
    const blog = join(dir, 'images', 'blog');
    await rm(join(blog, 'foo.jpg'));
    // orientation 6 = rotate 90cw. sharp metadata reports 1000x600; imagetools autoOrients before
    // resizing, so the encoded image is really 600 wide. Measuring the STORED width would both
    // truncate against the wrong axis and name a 600px file "-768".
    await sharp({ create: { width: 1000, height: 600, channels: 3, background: '#345' } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toFile(join(blog, 'rot.jpg'));
    const r = await optimizeImages(opts);
    const entry = r.manifest['/images/blog/rot.jpg'];
    expect(entry?.w).toBe(600);
    for (const rung of entry?.rungs ?? []) {
      const meta = await sharp(join(blog, rung.files.jpeg)).metadata();
      expect(meta.width).toBe(rung.w);
    }
  });

  it('treats a master whose name ENDS in -<digits> as a master, not our derivative', async () => {
    const blog = join(dir, 'images', 'blog');
    // Real files from the consumer repos: web-usa guides/form-1583.jpg, and uxr-react's
    // '…-content-1.webp' series. A shape-only check silently skips them — no error, no manifest
    // entry, image never optimized.
    await makeMaster(join(blog, 'form-1583.jpg'), 1000, 600);
    await makeMaster(join(blog, 'notes-content-1.jpg'), 1000, 600);
    const r = await optimizeImages(opts);
    expect(r.manifest['/images/blog/form-1583.jpg']).toBeDefined();
    expect(r.manifest['/images/blog/notes-content-1.jpg']).toBeDefined();
  });

  it('still skips a REAL derivative, identified by its sibling master', async () => {
    await optimizeImages(opts);
    const second = await optimizeImages(opts);
    // foo-480.jpg etc. sit beside foo.jpg, so they are ours and must never be re-ingested as
    // masters — that would generate derivatives of derivatives on every run.
    expect(Object.keys(second.manifest)).toEqual(['/images/blog/foo.jpg']);
  });

  it('leaves the manifest untouched when the scan finds nothing', async () => {
    await writeFile(opts.manifestPath, '{"pre":"existing"}');
    const empty = { ...opts, sourceDir: join(dir, 'nowhere') };
    await optimizeImages(empty).catch(() => undefined);
    expect(await readFile(opts.manifestPath, 'utf8')).toBe('{"pre":"existing"}');
  });
});

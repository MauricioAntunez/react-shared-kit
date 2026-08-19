import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
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
    expect(existsSync(join(dir, 'images', 'blog', 'foo.jpg-480.avif'))).toBe(true);
    expect(existsSync(join(dir, 'images', 'blog', 'foo.jpg-480.webp'))).toBe(true);
    expect(existsSync(join(dir, 'images', 'blog', 'foo.jpg-480.jpg'))).toBe(true);
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
    await rm(join(dir, 'images', 'blog', 'foo.jpg-480.webp'));
    const second = await optimizeImages(opts);
    expect(second.encoded).toBeGreaterThan(0);
    expect(existsSync(join(dir, 'images', 'blog', 'foo.jpg-480.webp'))).toBe(true);
  });

  it('NEVER upscales: rungs above the master are truncated away entirely (D10)', async () => {
    const blog = join(dir, 'images', 'blog');
    await rm(join(blog, 'foo.jpg'));
    await makeMaster(join(blog, 'small.jpg'), 600, 400);
    const r = await optimizeImages(opts);
    expect(existsSync(join(blog, 'small.jpg-768.webp'))).toBe(false);
    expect(existsSync(join(blog, 'small.jpg-480.webp'))).toBe(true);
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

  it('gives two masters differing only by extension DISTINCT derivatives', async () => {
    const blog = join(dir, 'images', 'blog');
    // hero.jpg + hero.webp co-exist in uxr-react and web-mexico today. Naming derivatives from the
    // stem alone made them collide and silently overwrite each other, so Picture rendered one
    // master's pixels under the other's manifest entry.
    await rm(join(blog, 'foo.jpg'));
    await makeMaster(join(blog, 'hero.jpg'), 1000, 600, 10);
    await sharp({ create: { width: 1000, height: 600, channels: 3, background: '#ff0000' } })
      .webp()
      .toFile(join(blog, 'hero.webp'));
    const r = await optimizeImages(opts);

    const a = r.manifest['/images/blog/hero.jpg'];
    const b = r.manifest['/images/blog/hero.webp'];
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    const aFiles = (a?.rungs ?? []).flatMap((x) => Object.values(x.files));
    const bFiles = (b?.rungs ?? []).flatMap((x) => Object.values(x.files));
    expect(aFiles.some((f) => bFiles.includes(f))).toBe(false);
    for (const f of [...aFiles, ...bFiles]) {
      expect(existsSync(join(blog, f))).toBe(true);
    }
  });

  it('keeps a genuine master that sits beside a same-stem sibling (form.jpg + form-1583.jpg)', async () => {
    const blog = join(dir, 'images', 'blog');
    await rm(join(blog, 'foo.jpg'));
    // The sibling test used to be symmetric: it proved "a master with this stem exists", not "this
    // file came from that master", so form-1583.jpg was silently dropped whenever form.jpg existed.
    await makeMaster(join(blog, 'form.jpg'), 1000, 600);
    await makeMaster(join(blog, 'form-1583.jpg'), 1000, 600, 90);
    const r = await optimizeImages(opts);
    expect(r.manifest['/images/blog/form.jpg']).toBeDefined();
    expect(r.manifest['/images/blog/form-1583.jpg']).toBeDefined();
    expect(r.mastersFound).toBe(2);
  });

  it('PROPAGATES a corrupt master instead of reporting an empty success', async () => {
    const blog = join(dir, 'images', 'blog');
    // A zero-byte file is a half-uploaded master. Swallowing this returned encoded:0/manifest:{}
    // that read as "nothing to do", skipped the manifest write, and left a stale manifest that
    // verifyImages then blessed as ok.
    await writeFile(join(blog, 'broken.jpg'), '');
    await expect(optimizeImages(opts)).rejects.toThrow();
  });

  it('REPORTS an AVIF used as a source instead of scanning past it', async () => {
    const blog = join(dir, 'images', 'blog');
    // boufin ships iso-27001-140.avif / -280.avif with no sibling master. AVIF is an output
    // format so it is not accepted as a master — but being skipped must be visible, since the
    // manifest-driven verifier can never see a file that never became a master.
    await sharp({ create: { width: 800, height: 600, channels: 3, background: '#0a0' } })
      .avif()
      .toFile(join(blog, 'standalone.avif'));
    const r = await optimizeImages(opts);
    const hit = r.ignored.find((i) => i.publicPath === '/images/blog/standalone.avif');
    expect(hit?.reason).toBe('output-format-as-source');
  });

  it('does NOT report our own AVIF derivatives as ignored', async () => {
    const first = await optimizeImages(opts);
    expect(first.ignored).toEqual([]);
    const second = await optimizeImages(opts);
    // The emitted .avif rungs sit beside their master; classifying them as ignored would flood
    // the report with our own output on every incremental run.
    expect(second.ignored).toEqual([]);
  });

  it('does NOT re-adopt orphaned derivatives as masters after the master is renamed', async () => {
    const blog = join(dir, 'images', 'blog');
    await optimizeImages(opts);
    // The ordinary result of `git mv` on an image. The leftovers used to be re-ingested as
    // masters and re-encoded into derivatives-of-derivatives -- 24 garbage files from one rename,
    // growing every build and never self-healing.
    await rename(join(blog, 'foo.jpg'), join(blog, 'banner.jpg'));
    const second = await optimizeImages(opts);

    expect(Object.keys(second.manifest)).toEqual(['/images/blog/banner.jpg']);
    expect(second.ignored.some((i) => i.reason === 'orphaned-derivative')).toBe(true);
    expect(existsSync(join(blog, 'foo.jpg-480.webp-480.avif'))).toBe(false);

    const third = await optimizeImages(opts);
    expect(third.mastersFound).toBe(1);
  });

  it('treats .jfif and .jpe as the JPEGs they are, not unknown formats', async () => {
    const blog = join(dir, 'images', 'blog');
    // Chrome saved downloads as .jfif for years, so they land in public/ routinely, and sharp
    // sniffs by content. Dropping them on extension alone was a silent skip.
    await makeMaster(join(blog, 'chrome.jfif'), 1000, 600, 30);
    const r = await optimizeImages(opts);
    expect(r.manifest['/images/blog/chrome.jfif']).toBeDefined();
  });

  it('reports an APNG rather than letting it fall through both lists', async () => {
    const blog = join(dir, 'images', 'blog');
    await writeFile(join(blog, 'loader.apng'), 'not really an apng');
    const r = await optimizeImages(opts);
    const hit = r.ignored.find((i) => i.publicPath === '/images/blog/loader.apng');
    expect(hit?.reason).toBe('animation-unsupported');
  });

  it('flags a missing sourceDir instead of reporting a successful empty run', async () => {
    const r = await optimizeImages({ ...opts, sourceDir: join(dir, 'nowhere') });
    expect(r.sourceDirMissing).toBe(true);
    expect(r.mastersFound).toBe(0);
  });

  it('THROWS on an unreadable sourceDir rather than calling it empty', async () => {
    const locked = join(dir, 'locked');
    await mkdir(locked, { recursive: true });
    await chmod(locked, 0o000);
    try {
      // existsSync() returns false for EACCES too, so this used to report "empty" and stay green
      // forever in a CI container over a restrictive mount.
      await expect(optimizeImages({ ...opts, sourceDir: join(locked, 'inner') })).rejects.toThrow();
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it('throws when sourceDir is a file rather than a directory', async () => {
    const notDir = join(dir, 'a-file.txt');
    await writeFile(notDir, 'x');
    await expect(optimizeImages({ ...opts, sourceDir: notDir })).rejects.toThrow(/not a directory/);
  });

  it('re-encodes a ledger entry written before inversions were recorded', async () => {
    await optimizeImages(opts);
    const ledger: Record<string, { inversions?: unknown }> = JSON.parse(
      await readFile(opts.ledgerPath, 'utf8'),
    );
    for (const entry of Object.values(ledger)) delete entry.inversions;
    await writeFile(opts.ledgerPath, JSON.stringify(ledger));
    // Replaying nothing would be the vacuous-green the field exists to prevent, narrowed to one
    // ledger generation -- so a pre-inversions entry is stale by definition.
    const second = await optimizeImages(opts);
    expect(second.encoded).toBeGreaterThan(0);
  });

  it('PROPAGATES a readdir failure on a nested directory', async () => {
    const locked = join(dir, 'images', 'blog', 'locked');
    await mkdir(locked, { recursive: true });
    await chmod(locked, 0o000);
    try {
      // The scan walks recursively, so a permission error deep in the tree must surface too --
      // returning fewer masters than exist is indistinguishable from success.
      await expect(optimizeImages(opts)).rejects.toThrow();
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it('distinguishes an UNREADABLE ledger from an absent one', async () => {
    await optimizeImages(opts);
    // write-only: the READ fails, the end-of-run write still succeeds, so the reset reason is
    // observable in the result rather than masked by a write error.
    await chmod(opts.ledgerPath, 0o222);
    try {
      const r = await optimizeImages(opts);
      // Reported as 'missing', a 589-byte ledger sitting on disk is indistinguishable from a
      // first build: incrementality dies every run and the diagnostic points away from the cause.
      expect(r.ledgerReset).toBe('unreadable');
    } finally {
      await chmod(opts.ledgerPath, 0o644);
    }
  });

  it('flags an existing but master-less sourceDir distinctly from a missing one', async () => {
    const empty = join(dir, 'empty2');
    await mkdir(empty, { recursive: true });
    const r = await optimizeImages({ ...opts, sourceDir: empty });
    expect(r.sourceDirEmpty).toBe(true);
    expect(r.sourceDirMissing).toBeUndefined();
  });

  it('accepts the whole JFIF family, not just .jfif', async () => {
    const blog = join(dir, 'images', 'blog');
    await makeMaster(join(blog, 'a.jif'), 1000, 600, 40);
    await makeMaster(join(blog, 'b.jfi'), 1000, 600, 50);
    const r = await optimizeImages(opts);
    expect(r.manifest['/images/blog/a.jif']).toBeDefined();
    expect(r.manifest['/images/blog/b.jfi']).toBeDefined();
  });

  it('reports animated AVIF rather than letting it vanish', async () => {
    const blog = join(dir, 'images', 'blog');
    await writeFile(join(blog, 'motion.avifs'), 'x');
    const r = await optimizeImages(opts);
    expect(r.ignored.find((i) => i.publicPath === '/images/blog/motion.avifs')?.reason).toBe(
      'animation-unsupported',
    );
  });

  it('does not write the manifest when sourceDir does not exist', async () => {
    await writeFile(opts.manifestPath, '{"pre":"existing"}');
    await optimizeImages({ ...opts, sourceDir: join(dir, 'nowhere') });
    expect(await readFile(opts.manifestPath, 'utf8')).toBe('{"pre":"existing"}');
  });

  it('does not write the manifest when a REAL but EMPTY directory is scanned', async () => {
    // The original test pointed at a NONEXISTENT directory, so readdir threw and the throw was
    // swallowed — the plans.length === 0 guard was never reached and deleting it kept the suite
    // green. This exercises the guard itself: an existing, empty tree must not clobber a manifest.
    const empty = join(dir, 'empty');
    await mkdir(empty, { recursive: true });
    await writeFile(opts.manifestPath, '{"pre":"existing"}');
    const r = await optimizeImages({ ...opts, sourceDir: empty });
    expect(r.mastersFound).toBe(0);
    expect(await readFile(opts.manifestPath, 'utf8')).toBe('{"pre":"existing"}');
  });

  it('reports inversions on a SKIPPED run, not only on the encode run', async () => {
    const first = await optimizeImages(opts);
    const second = await optimizeImages(opts);
    expect(second.encoded).toBe(0);
    // Otherwise `if (res.inversions.length) fail()` is green on every warm-cache build while the
    // oversized AVIF keeps shipping first.
    expect(second.inversions).toEqual(first.inversions);
  });

  it('flags a corrupt ledger instead of silently resetting incrementality', async () => {
    await optimizeImages(opts);
    // An array parses fine, accepts string property assignment, then JSON.stringify drops every
    // one — so the file rewrites as [] and incrementality is dead permanently, silently.
    await writeFile(opts.ledgerPath, '[]');
    const r = await optimizeImages(opts);
    expect(r.ledgerReset).toBe('corrupt');
    expect(r.encoded).toBeGreaterThan(0);
  });

  it('keeps master counts reconcilable: mastersFound === mastersEncoded + skipped', async () => {
    const first = await optimizeImages(opts);
    expect(first.mastersFound).toBe(first.mastersEncoded + first.skipped);
    const second = await optimizeImages(opts);
    expect(second.mastersFound).toBe(second.mastersEncoded + second.skipped);
    expect(second.skipped).toBe(second.mastersFound);
  });
});

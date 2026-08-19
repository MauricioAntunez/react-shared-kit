import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

function manifest(rungW: number, masterW = 1000, masterH = 600): ImageManifest {
  return {
    '/images/blog/foo.jpg': {
      w: masterW,
      h: masterH,
      class: 'content',
      rungs: [
        {
          w: rungW,
          files: { avif: 'foo.jpg-480.avif', webp: 'foo.jpg-480.webp', jpeg: 'foo.jpg-480.jpg' },
        },
      ],
    },
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'uxr-ver-'));
  const blog = join(dir, 'images', 'blog');
  await mkdir(blog, { recursive: true });
  await write(join(blog, 'foo.jpg'), 1000, 600);
  await write(join(blog, 'foo.jpg-480.jpg'), 480, 288);
  await write(join(blog, 'foo.jpg-480.webp'), 480, 288);
  await write(join(blog, 'foo.jpg-480.avif'), 480, 288);
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
    await rm(join(dir, 'images', 'blog', 'foo.jpg-480.webp'));
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
    // The manifest must describe the master accurately, or master-dimension-mismatch fires first
    // and returns — every later check reads entry.w/entry.h and would blame the wrong thing.
    const r = await verifyImages({
      manifest: manifest(480, 300, 200),
      classes: CLASSES,
      sourceDir: dir,
    });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.kind === 'upscale')).toBe(true);
  });

  it('fails on an EXTRA derivative the manifest does not declare (count-mismatch)', async () => {
    // No test previously exercised this kind at all: disabling the comparison entirely left the
    // suite green, so the check was shipped unprotected.
    await write(join(dir, 'images', 'blog', 'foo.jpg-999.jpg'), 999, 600);
    const r = await verifyImages({ manifest: manifest(480), classes: CLASSES, sourceDir: dir });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.kind === 'count-mismatch')).toBe(true);
  });

  it('SURFACES ignored files rather than computing and discarding them', async () => {
    // A verify-only CI job is the natural split, since optimizeImages needs sharp and write
    // access. Discarding this meant such a job could never learn about an AVIF used as a source.
    await write(join(dir, 'images', 'blog', 'source.avif'), 800, 600);
    const r = await verifyImages({ manifest: manifest(480), classes: CLASSES, sourceDir: dir });
    expect(r.ignored.some((i) => i.publicPath === '/images/blog/source.avif')).toBe(true);
  });

  it('reports an unreadable file as unreadable, not as missing', async () => {
    await writeFile(join(dir, 'images', 'blog', 'foo.jpg-480.webp'), 'not an image');
    const r = await verifyImages({ manifest: manifest(480), classes: CLASSES, sourceDir: dir });
    // Telling a developer a file they can see does not exist gives them no next step.
    expect(r.issues.some((i) => i.kind === 'unreadable-file')).toBe(true);
    expect(r.issues.some((i) => i.kind === 'missing-file')).toBe(false);
  });

  it('fails a derivative of the right WIDTH but the wrong image', async () => {
    // A stale derivative from a previous master that produced the same rung width passes a
    // width-only check. optimizeImages has the sha256 ledger; a verify-only job has nothing.
    await write(join(dir, 'images', 'blog', 'foo.jpg-480.webp'), 480, 100);
    const r = await verifyImages({ manifest: manifest(480), classes: CLASSES, sourceDir: dir });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.kind === 'aspect-mismatch')).toBe(true);
  });

  it('fails a derivative off by exactly ONE pixel — generation is deterministic', async () => {
    // 1000x600 master, 480w rung => expected height exactly 288. Writing 289 must fail: any
    // change to the master regenerates every derivative, so a pixel-perfect match is always
    // reachable and slack could only ever hide a real mismatch.
    await write(join(dir, 'images', 'blog', 'foo.jpg-480.webp'), 480, 289);
    const r = await verifyImages({ manifest: manifest(480), classes: CLASSES, sourceDir: dir });
    expect(r.issues.some((i) => i.kind === 'aspect-mismatch')).toBe(true);
  });

  it('keeps ok independent of ignored — ignored is advisory', async () => {
    await write(join(dir, 'images', 'blog', 'source.avif'), 800, 600);
    const r = await verifyImages({ manifest: manifest(480), classes: CLASSES, sourceDir: dir });
    expect(r.ignored.length).toBeGreaterThan(0);
    // Documented contract: an unsupported source format is a fact about the tree, not a build
    // failure. A consumer gating only on ok must be told to read ignored separately.
    expect(r.ok).toBe(true);
  });

  it('fails when the MASTER no longer matches the dimensions the manifest records', async () => {
    await write(join(dir, 'images', 'blog', 'foo.jpg'), 1000, 800);
    // Swap a master for a different crop at the SAME width: derivatives still agree with the
    // manifest, the manifest still agrees with itself, and every page renders the previous image
    // at a declared aspect ratio that no longer matches it.
    const r = await verifyImages({ manifest: manifest(480), classes: CLASSES, sourceDir: dir });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.kind === 'master-dimension-mismatch')).toBe(true);
  });

  it('reports a zero-dimension manifest entry instead of skipping the aspect check', async () => {
    const r = await verifyImages({
      manifest: manifest(480, 0, 0),
      classes: CLASSES,
      sourceDir: dir,
    });
    // w: 0 was the one value that turned the check off, silently — and it is exactly the kind of
    // drift an untrusted on-disk manifest produces.
    expect(r.issues.some((i) => i.kind === 'invalid-manifest-entry')).toBe(true);
  });

  it('measures an EXIF-rotated master on the ORIENTED axis, matching the manifest', async () => {
    const blog = join(dir, 'images', 'blog');
    await sharp({ create: { width: 1000, height: 600, channels: 3, background: '#246' } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toFile(join(blog, 'foo.jpg'));
    // optimizeImages records ORIENTED dimensions (600x1000). If verify measured STORED ones it
    // would report a dimension mismatch on a perfectly good master.
    const r = await verifyImages({
      manifest: manifest(480, 600, 1000),
      classes: CLASSES,
      sourceDir: dir,
    });
    expect(r.issues.some((i) => i.kind === 'master-dimension-mismatch')).toBe(false);
  });

  it('does not accuse innocent derivatives when the MANIFEST is the stale part', async () => {
    await write(join(dir, 'images', 'blog', 'foo.jpg'), 1600, 1200);
    await write(join(dir, 'images', 'blog', 'foo.jpg-480.avif'), 480, 360);
    await write(join(dir, 'images', 'blog', 'foo.jpg-480.webp'), 480, 360);
    await write(join(dir, 'images', 'blog', 'foo.jpg-480.jpg'), 480, 360);
    // The derivatives genuinely come from this master; only the manifest height is stale. Running
    // the rung checks first produced one "does not come from this master" accusation per file.
    const r = await verifyImages({
      manifest: manifest(480, 1600, 1000),
      classes: CLASSES,
      sourceDir: dir,
    });
    expect(r.issues.some((i) => i.kind === 'master-dimension-mismatch')).toBe(true);
    expect(r.issues.some((i) => i.kind === 'aspect-mismatch')).toBe(false);
  });

  it('still reports a stale orphan while the manifest is stale, not on a second trip', async () => {
    await write(join(dir, 'images', 'blog', 'foo.jpg'), 1600, 1200);
    await write(join(dir, 'images', 'blog', 'foo.jpg-999.webp'), 999, 749);
    const r = await verifyImages({
      manifest: manifest(480, 1600, 1000),
      classes: CLASSES,
      sourceDir: dir,
    });
    expect(r.issues.some((i) => i.kind === 'master-dimension-mismatch')).toBe(true);
    expect(r.issues.some((i) => i.kind === 'count-mismatch')).toBe(true);
  });

  it('PROPAGATES a readdir failure instead of floating the rejection', async () => {
    const blog = join(dir, 'images', 'blog');
    // 0111: traversable, so the master still stats and decodes, but not listable — the exact
    // condition countDerivativesOnDisk rethrows for.
    //
    // Asserting only that verifyImages rejects proves nothing: findMasters walks the same
    // directory afterwards and throws too, so the call rejects either way. What distinguishes an
    // awaited call from a floated one is whether a rejection escapes into the process — floated,
    // it is unowned, and Node kills the process on it by default.
    const escaped: unknown[] = [];
    const onUnhandled = (reason: unknown) => escaped.push(reason);
    process.on('unhandledRejection', onUnhandled);
    await chmod(blog, 0o111);
    try {
      await verifyImages({ manifest: manifest(480), classes: CLASSES, sourceDir: dir }).catch(
        () => undefined,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(escaped).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await chmod(blog, 0o755);
    }
  });

  it('fails an entry whose class is not in the configured classes', async () => {
    // optimizeImages treats an unknown class as fatal; returning silently here made the
    // permissive half the one running as the gate. Reachable whenever a class is renamed and a
    // committed manifest still carries the old name.
    const r = await verifyImages({
      manifest: manifest(480),
      classes: { other: { widths: [480], masterMin: 480 } },
      sourceDir: dir,
    });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.kind === 'invalid-manifest-entry')).toBe(true);
  });

  it('fails when a master on disk is ABSENT from the manifest', async () => {
    // verifyImages iterates the manifest, so every way a master can go missing FROM the manifest
    // was invisible to it — a stale manifest, a misclassified file, or an image added since the
    // last successful run. Each ships an unoptimized master with no width/height, silently.
    await write(join(dir, 'images', 'blog', 'newcomer.jpg'), 1000, 600);
    const r = await verifyImages({ manifest: manifest(480), classes: CLASSES, sourceDir: dir });
    expect(r.ok).toBe(false);
    const issue = r.issues.find((i) => i.kind === 'master-not-in-manifest');
    expect(issue?.path).toBe('/images/blog/newcomer.jpg');
  });

  it('fails on a master below its class masterMin', async () => {
    await write(join(dir, 'images', 'blog', 'foo.jpg'), 600, 400);
    const r = await verifyImages({
      manifest: manifest(480, 600, 400),
      classes: CLASSES,
      sourceDir: dir,
    });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.kind === 'undersized-master')).toBe(true);
  });
});

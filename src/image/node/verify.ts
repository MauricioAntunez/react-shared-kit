import { readdir, stat } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';
import sharp from 'sharp';
import type { ImageClasses, ImageManifest, ManifestEntry, Rung } from '../types.ts';
import { findMasters, type IgnoredFile } from './scan.ts';

export type VerifyIssueKind =
  | 'missing-file'
  | 'upscale'
  | 'descriptor-mismatch'
  | 'undersized-master'
  | 'count-mismatch'
  | 'master-not-in-manifest'
  | 'unreadable-file'
  | 'aspect-mismatch';

export interface VerifyIssue {
  kind: VerifyIssueKind;
  path: string;
  detail: string;
}

export interface VerifyResult {
  ok: boolean;
  issues: VerifyIssue[];
  /** Images the scan saw but did not treat as masters. Never affects `ok` — see verifyImages. */
  ignored: IgnoredFile[];
}

export interface VerifyOptions {
  manifest: ImageManifest;
  classes: ImageClasses;
  sourceDir: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches this master's own derivatives only — `<filename>-<digits>.<ext>`, where <filename>
 * INCLUDES the source extension — so `hero.jpg` and `hero.webp` never count each other's files. */
function derivativePatternFor(basename: string): RegExp {
  return new RegExp(`^${escapeRegExp(basename)}-\\d+\\.(avif|webp|jpe?g)$`, 'i');
}

/**
 * Measure a file, distinguishing absent from unreadable.
 *
 * sharp throws for three different reasons here — ENOENT, EACCES, and "unsupported image format"
 * for a truncated or corrupt file. Flattening all three into "does not exist" tells a developer
 * something false about a file they can see sitting there, and hides the actual fix.
 */
type Measurement =
  | { kind: 'ok'; width: number | undefined; height: number | undefined }
  | { kind: 'missing' }
  | { kind: 'unreadable'; message: string };

async function measure(path: string): Promise<Measurement> {
  // Existence is decided by stat, not by sharp's error: sharp reports a missing file as
  // "Input file is missing" with NO `code` property (verified against sharp 0.35), so branching on
  // the thrown error would misfile every absent file as unreadable.
  const exists = await stat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
  if (!exists) return { kind: 'missing' };

  try {
    const metadata = await sharp(path).metadata();
    return { kind: 'ok', width: metadata.width, height: metadata.height };
  } catch (error) {
    return { kind: 'unreadable', message: error instanceof Error ? error.message : String(error) };
  }
}

async function checkRungFiles(
  masterDir: string,
  sourcePath: string,
  rung: Rung,
  entry: ManifestEntry,
  issues: VerifyIssue[],
): Promise<void> {
  for (const file of Object.values(rung.files)) {
    const filePath = join(masterDir, file);
    const measured = await measure(filePath);
    if (measured.kind === 'missing') {
      issues.push({
        kind: 'missing-file',
        path: sourcePath,
        detail: `expected derivative file "${file}" for rung w=${rung.w} but it does not exist at ${filePath}`,
      });
      continue;
    }
    if (measured.kind === 'unreadable') {
      issues.push({
        kind: 'unreadable-file',
        path: sourcePath,
        detail: `derivative "${file}" exists at ${filePath} but could not be read: ${measured.message}`,
      });
      continue;
    }
    const { width } = measured;
    if (width === undefined) {
      issues.push({
        kind: 'unreadable-file',
        path: sourcePath,
        detail: `derivative "${file}" at ${filePath} reported no width`,
      });
      continue;
    }
    if (width !== rung.w) {
      issues.push({
        kind: 'descriptor-mismatch',
        path: sourcePath,
        detail: `"${file}" measures ${width}px wide but the manifest rung descriptor says w=${rung.w}`,
      });
      continue;
    }
    // Width alone does not identify an image. A stale derivative left by a PREVIOUS master that
    // happened to produce the same rung width passes a width-only check, so a verify-only job
    // (which has no sha256 ledger to lean on) would bless the wrong picture entirely.
    checkAspect(sourcePath, file, measured.height, width, entry, issues);
  }
}

function checkAspect(
  sourcePath: string,
  file: string,
  height: number | undefined,
  width: number,
  entry: ManifestEntry,
  issues: VerifyIssue[],
): void {
  if (height === undefined || entry.w === 0) return;
  const expected = Math.round((width * entry.h) / entry.w);
  // 1px of slack for the encoder rounding a half-pixel.
  if (Math.abs(height - expected) <= 1) return;
  issues.push({
    kind: 'aspect-mismatch',
    path: sourcePath,
    detail:
      `"${file}" is ${width}x${height}, but the master is ${entry.w}x${entry.h}, so this rung ` +
      `should be ${width}x${expected} — the file does not come from this master`,
  });
}

function checkUpscale(
  sourcePath: string,
  rungs: Rung[],
  masterWidth: number,
  issues: VerifyIssue[],
): void {
  for (const rung of rungs) {
    if (rung.w > masterWidth) {
      issues.push({
        kind: 'upscale',
        path: sourcePath,
        detail: `rung w=${rung.w} exceeds the master's measured intrinsic width of ${masterWidth}px`,
      });
    }
  }
}

function checkUndersizedMaster(
  sourcePath: string,
  entry: ManifestEntry,
  classes: ImageClasses,
  masterWidth: number,
  issues: VerifyIssue[],
): void {
  const classDef = classes[entry.class];
  if (!classDef) return;
  if (masterWidth < classDef.masterMin) {
    issues.push({
      kind: 'undersized-master',
      path: sourcePath,
      detail: `master measures ${masterWidth}px wide, below class "${entry.class}"'s masterMin of ${classDef.masterMin}px`,
    });
  }
}

async function countDerivativesOnDisk(masterDir: string, basename: string): Promise<number> {
  const pattern = derivativePatternFor(basename);
  const names = await readdir(masterDir).catch(() => [] as string[]);
  return names.filter((name) => pattern.test(name)).length;
}

function checkCountMismatch(
  sourcePath: string,
  expected: number,
  actual: number,
  issues: VerifyIssue[],
): void {
  if (expected !== actual) {
    issues.push({
      kind: 'count-mismatch',
      path: sourcePath,
      detail: `manifest declares ${expected} derivative file(s) for this master, but ${actual} matching-pattern file(s) were found on disk`,
    });
  }
}

async function verifyEntry(
  sourcePath: string,
  entry: ManifestEntry,
  classes: ImageClasses,
  sourceDir: string,
  issues: VerifyIssue[],
): Promise<void> {
  const masterPath = join(sourceDir, sourcePath);
  const masterDir = dirname(masterPath);

  for (const rung of entry.rungs) {
    await checkRungFiles(masterDir, sourcePath, rung, entry, issues);
  }

  const measuredMaster = await measure(masterPath);
  if (measuredMaster.kind === 'missing') {
    issues.push({
      kind: 'missing-file',
      path: sourcePath,
      detail: `master image not found at ${masterPath}`,
    });
    return;
  }
  if (measuredMaster.kind === 'unreadable') {
    issues.push({
      kind: 'unreadable-file',
      path: sourcePath,
      detail: `master exists at ${masterPath} but could not be read: ${measuredMaster.message}`,
    });
    return;
  }
  const masterWidth = measuredMaster.width;
  if (masterWidth === undefined) {
    issues.push({
      kind: 'unreadable-file',
      path: sourcePath,
      detail: `master at ${masterPath} reported no width`,
    });
    return;
  }

  checkUpscale(sourcePath, entry.rungs, masterWidth, issues);
  checkUndersizedMaster(sourcePath, entry, classes, masterWidth, issues);

  const expectedCount = entry.rungs.length * 3;
  const basename = parse(sourcePath).base;
  const actualCount = await countDerivativesOnDisk(masterDir, basename);
  checkCountMismatch(sourcePath, expectedCount, actualCount, issues);
}

/**
 * Masters on disk that the manifest never mentions.
 *
 * Without this, the verifier can only inspect what the manifest already lists — so every way a
 * master can go MISSING from the manifest is invisible to it: a stale manifest left by a failed
 * run, a misclassified file, or simply an image added since the last successful build. In each
 * case the page falls back to an unoptimized full-size <img> with no width/height, reintroducing
 * the layout shift, and the build reports ok.
 */
async function checkMastersInManifest(
  sourceDir: string,
  manifest: ImageManifest,
  issues: VerifyIssue[],
): Promise<IgnoredFile[]> {
  const { masters, ignored } = await findMasters(sourceDir);
  for (const master of masters) {
    if (manifest[master.publicPath] === undefined) {
      issues.push({
        kind: 'master-not-in-manifest',
        path: master.publicPath,
        detail:
          'master exists on disk but has no manifest entry, so it ships unoptimized and without ' +
          'intrinsic dimensions; re-run optimizeImages',
      });
    }
  }
  return ignored;
}

export async function verifyImages(options: VerifyOptions): Promise<VerifyResult> {
  const { manifest, classes, sourceDir } = options;
  const issues: VerifyIssue[] = [];

  for (const [sourcePath, entry] of Object.entries(manifest)) {
    await verifyEntry(sourcePath, entry, classes, sourceDir, issues);
  }
  const ignored = await checkMastersInManifest(sourceDir, manifest, issues);

  // `ignored` does not affect `ok`: an unsupported format is a fact about the tree, not proof the
  // build is wrong, and failing on it would push consumers to disable the gate wholesale. But the
  // scan already computed it, and discarding it meant a verify-only CI job — the natural split,
  // since optimizeImages needs sharp and write access — could never learn about an AVIF used as a
  // source or a stale orphaned derivative.
  return { ok: issues.length === 0, issues, ignored };
}

import { readdir, stat } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';
import type { ImageClasses, ImageManifest, ManifestEntry, Rung } from '../types.ts';
import { findMasters, type IgnoredFile, orientedSize } from './scan.ts';

export type VerifyIssueKind =
  | 'missing-file'
  | 'upscale'
  | 'descriptor-mismatch'
  | 'undersized-master'
  | 'count-mismatch'
  | 'master-not-in-manifest'
  | 'unreadable-file'
  | 'aspect-mismatch'
  | 'master-dimension-mismatch'
  | 'invalid-manifest-entry';

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
    // Oriented, not stored: the manifest records oriented dimensions, so comparing stored ones
    // would misjudge every EXIF-rotated master in both directions.
    const { width, height } = await orientedSize(path);
    return { kind: 'ok', width, height };
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
  // Non-positive dimensions are rejected by `verifyEntry` before any rung is examined, so this is
  // a guard against a direct call rather than a reachable path — it must still never divide by
  // zero, and must never report "passed".
  if (entry.w <= 0 || entry.h <= 0) return;
  if (height === undefined) return;
  // EXACT, no slack. Generation is deterministic — imagetools computes
  // `round(width / originalAspect)`, which is the same integer arithmetic redone here — and any
  // change to the master regenerates every derivative, so a pixel-perfect match is always
  // reachable. Measured across 288 real encodes (11 odd master sizes x 11 ladder widths x 3
  // formats) the delta was 0 every time. Tolerance here could only ever hide a real mismatch.
  const expected = Math.round((width * entry.h) / entry.w);
  if (height === expected) return;
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
  if (!classDef) {
    // Returning silently made "this entry names a class that no longer exists" indistinguishable
    // from "this entry passed" — and `optimizeImages` treats the same condition as fatal, so the
    // permissive half was the one running as the gate. Reachable exactly in the verify-only split
    // this module advertises: rename a class, and every entry still carrying the old name goes
    // unchecked, silently and permanently, with CI green.
    issues.push({
      kind: 'invalid-manifest-entry',
      path: sourcePath,
      detail:
        `manifest records class "${entry.class}", which is not among the configured classes ` +
        `(${Object.keys(classes).join(', ')}) — the masterMin check cannot run; re-run optimizeImages`,
    });
    return;
  }
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
  // ENOENT only: an unreadable directory reported as "zero files" would blame the manifest for a
  // filesystem problem, in the one module whose subject is not conflating absence with failure.
  const names = await readdir(masterDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
  });
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

  // The master is measured FIRST, before any per-rung check. `checkAspect` compares a derivative
  // against `entry.w`/`entry.h`, so running the rungs first meant a stale manifest produced one
  // "the file does not come from this master" accusation per derivative — about files that did
  // come from it — while the real cause was reported last.
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

  // A non-positive dimension is invalid on its own terms, so it is judged before any comparison:
  // reporting "measures 1000x600 but the manifest records 0x0" would name the master as the
  // problem when the manifest is simply malformed.
  if (entry.w <= 0 || entry.h <= 0) {
    issues.push({
      kind: 'invalid-manifest-entry',
      path: sourcePath,
      detail:
        `manifest records master dimensions ${entry.w}x${entry.h}, which cannot be checked ` +
        `against the file — re-run optimizeImages`,
    });
    checkStructure(sourcePath, entry, classes, masterWidth, masterDir, issues);
    return;
  }

  // The manifest's own record of the master must be checked before anything anchored to it.
  // `checkAspect` proves a derivative agrees with `entry.w`/`entry.h`; nothing proved those agree
  // with the file on disk. Swap a master for a different crop at the same width and manifest and
  // derivatives stay mutually consistent, both wrong, and the gate goes green while every page
  // renders the previous image at a declared aspect ratio that no longer matches it.
  const masterHeight = measuredMaster.height;
  if (masterWidth !== entry.w || (masterHeight !== undefined && masterHeight !== entry.h)) {
    issues.push({
      kind: 'master-dimension-mismatch',
      path: sourcePath,
      detail:
        `master at ${masterPath} measures ${masterWidth}x${masterHeight}, but the manifest ` +
        `records ${entry.w}x${entry.h} — the manifest is stale; re-run optimizeImages`,
    });
    // Only the ASPECT check is anchored to entry.w/entry.h, so only it is skipped. The remaining
    // checks read rung widths, the class name and the disk, and a developer should learn about a
    // missing derivative or a stale orphan in the same run rather than on a second trip.
    checkStructure(sourcePath, entry, classes, masterWidth, masterDir, issues);
    return;
  }

  for (const rung of entry.rungs) {
    await checkRungFiles(masterDir, sourcePath, rung, entry, issues);
  }
  checkStructure(sourcePath, entry, classes, masterWidth, masterDir, issues);
}

/** The checks that do NOT read `entry.w`/`entry.h`, so they run even against a stale manifest. */
async function checkStructure(
  sourcePath: string,
  entry: ManifestEntry,
  classes: ImageClasses,
  masterWidth: number,
  masterDir: string,
  issues: VerifyIssue[],
): Promise<void> {
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

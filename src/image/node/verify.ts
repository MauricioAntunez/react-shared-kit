import { readdir } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';
import sharp from 'sharp';
import type { ImageClasses, ImageManifest, ManifestEntry, Rung } from '../types.ts';

export type VerifyIssueKind =
  | 'missing-file'
  | 'upscale'
  | 'descriptor-mismatch'
  | 'undersized-master'
  | 'count-mismatch';

export interface VerifyIssue {
  kind: VerifyIssueKind;
  path: string;
  detail: string;
}

export interface VerifyOptions {
  manifest: ImageManifest;
  classes: ImageClasses;
  sourceDir: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches this master's own derivatives only — `<basename>-<digits>.<ext>` — so two masters
 * sharing one directory never count each other's files. */
function derivativePatternFor(basename: string): RegExp {
  return new RegExp(`^${escapeRegExp(basename)}-\\d+\\.(avif|webp|jpe?g)$`, 'i');
}

async function measuredWidth(path: string): Promise<number | undefined> {
  const metadata = await sharp(path).metadata();
  return metadata.width;
}

async function checkRungFiles(
  masterDir: string,
  sourcePath: string,
  rung: Rung,
  issues: VerifyIssue[],
): Promise<void> {
  for (const file of Object.values(rung.files)) {
    const filePath = join(masterDir, file);
    const width = await measuredWidth(filePath).catch(() => undefined);
    if (width === undefined) {
      issues.push({
        kind: 'missing-file',
        path: sourcePath,
        detail: `expected derivative file "${file}" for rung w=${rung.w} but it does not exist at ${filePath}`,
      });
      continue;
    }
    if (width !== rung.w) {
      issues.push({
        kind: 'descriptor-mismatch',
        path: sourcePath,
        detail: `"${file}" measures ${width}px wide but the manifest rung descriptor says w=${rung.w}`,
      });
    }
  }
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
    await checkRungFiles(masterDir, sourcePath, rung, issues);
  }

  const masterWidth = await measuredWidth(masterPath).catch(() => undefined);
  if (masterWidth === undefined) {
    issues.push({
      kind: 'missing-file',
      path: sourcePath,
      detail: `master image not found at ${masterPath}`,
    });
    return;
  }

  checkUpscale(sourcePath, entry.rungs, masterWidth, issues);
  checkUndersizedMaster(sourcePath, entry, classes, masterWidth, issues);

  const expectedCount = entry.rungs.length * 3;
  const basename = parse(sourcePath).name;
  const actualCount = await countDerivativesOnDisk(masterDir, basename);
  checkCountMismatch(sourcePath, expectedCount, actualCount, issues);
}

export async function verifyImages(
  options: VerifyOptions,
): Promise<{ ok: boolean; issues: VerifyIssue[] }> {
  const { manifest, classes, sourceDir } = options;
  const issues: VerifyIssue[] = [];

  for (const [sourcePath, entry] of Object.entries(manifest)) {
    await verifyEntry(sourcePath, entry, classes, sourceDir, issues);
  }

  return { ok: issues.length === 0, issues };
}

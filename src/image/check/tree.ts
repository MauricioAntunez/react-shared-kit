/**
 * Sharp-free structural manifest verify (D18), ported from boufin's `scripts/verify-images.ts`.
 *
 * Deliberately synchronous and deliberately ignorant of pixels: it never decodes an image, so it
 * never needs sharp. Everything it checks is a fact about paths, filenames, and byte counts —
 * whether the manifest is internally consistent and whether the two directories it describes
 * agree with it. Dimension/aspect correctness (which DOES require decoding) stays in the
 * sharp-dependent `../node/verify.ts`; running both is the intended split (D18: no delegation yet
 * — their checks interleave too much to merge safely in one unit of work).
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { RUNG_FILE_RE, rungMasterOf } from '../node/scanfs.ts';
import type { ImageManifest, ManifestEntry, RungFiles } from '../types.ts';
import { walkFiles } from './walk.ts';

export type TreeIssueKind =
  | 'empty-manifest'
  | 'invalid-key'
  | 'no-rungs'
  | 'missing-format'
  | 'path-escape'
  | 'missing-file'
  | 'empty-file'
  | 'ladder-violation'
  | 'orphan-rung'
  | 'master-changed'
  | 'master-missing'
  | 'master-not-in-manifest'
  | 'hash-missing';

export interface TreeIssue {
  kind: TreeIssueKind;
  path: string;
  detail: string;
}

export interface VerifyImageTreeOptions {
  manifest: ImageManifest;
  /** Where rung (derivative) files live — boufin: `public/`. */
  outputDir: string;
  /** Where master files live — boufin: `assets/`. */
  mastersDir: string;
  /** Master path -> sha256 hex. Omit to skip every hash-related check (structure still runs). */
  masterHashes?: Record<string, string>;
  formats?: readonly string[];
}

export interface VerifyImageTreeResult {
  ok: boolean;
  issues: TreeIssue[];
  filesChecked: number;
}

const DEFAULT_FORMATS: readonly string[] = ['avif', 'webp', 'jpeg'];

/**
 * Manifest keys are trusted as directory-relative paths, but the JSON they came from is not
 * type-checked at runtime — a hand-edited or corrupted manifest can carry a key that escapes
 * `mastersDir`/`outputDir` the moment it is joined onto them. Rejected before anything is
 * derived from it, so no downstream check ever joins an unsafe key onto a real path.
 */
function isValidKey(key: string): boolean {
  return key.startsWith('/') && !key.includes('..');
}

function checkKeySanity(key: string, issues: TreeIssue[]): boolean {
  if (isValidKey(key)) return true;
  issues.push({
    kind: 'invalid-key',
    path: key,
    detail: `manifest key "${key}" must start with "/" and must not contain ".."`,
  });
  return false;
}

/**
 * Is `target` inside `root` once resolved? Key sanity alone does not cover this: a rung
 * FILENAME (not the manifest key) is also caller-controlled data, and `../../etc/passwd` as a
 * `rung.files.avif` value would otherwise resolve outside `outputDir` untouched.
 */
function isContained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function checkContainment(
  root: string,
  resolved: string,
  path: string,
  issues: TreeIssue[],
): boolean {
  if (isContained(root, resolved)) return true;
  issues.push({
    kind: 'path-escape',
    path,
    detail: `resolves to "${resolved}", which is outside "${root}"`,
  });
  return false;
}

/** `RungFiles` is a fixed three-key shape at the type level, but a hand-edited manifest is not
 * guaranteed to honor it — indexing by a caller-supplied format name needs a runtime view. */
function rungFile(files: RungFiles, format: string): string | undefined {
  return (files as unknown as Record<string, string | undefined>)[format];
}

function checkRungCompleteness(
  key: string,
  entry: ManifestEntry,
  formats: readonly string[],
  issues: TreeIssue[],
): void {
  const rungs = Array.isArray(entry.rungs) ? entry.rungs : [];
  if (rungs.length === 0) {
    issues.push({ kind: 'no-rungs', path: key, detail: 'manifest entry has no rungs' });
    return;
  }
  for (const rung of rungs) {
    for (const format of formats) {
      const name = rungFile(rung.files, format);
      if (name === undefined || name === '') {
        issues.push({
          kind: 'missing-format',
          path: key,
          detail: `rung w=${rung.w} has no "${format}" file name`,
        });
      }
    }
  }
}

/** Ascending, duplicate-free — the ladder invariant `optimizeImages` guarantees on write. A
 * violation here means the manifest was hand-edited or corrupted after generation. */
function checkLadder(key: string, entry: ManifestEntry, issues: TreeIssue[]): void {
  const rungs = Array.isArray(entry.rungs) ? entry.rungs : [];
  const seen = new Set<number>();
  let prev: number | undefined;
  for (const rung of rungs) {
    if (seen.has(rung.w)) {
      issues.push({
        kind: 'ladder-violation',
        path: key,
        detail: `duplicate rung width w=${rung.w}`,
      });
    } else if (prev !== undefined && rung.w <= prev) {
      issues.push({
        kind: 'ladder-violation',
        path: key,
        detail: `rung w=${rung.w} does not ascend past the previous rung w=${prev}`,
      });
    }
    seen.add(rung.w);
    prev = rung.w;
  }
}

/** Existence + non-zero size for one already-contained path. Returns nothing: callers only need
 * the issues pushed, not the file's size. */
function checkFileOnDisk(key: string, absPath: string, issues: TreeIssue[]): void {
  let size: number;
  try {
    const st = statSync(absPath);
    if (!st.isFile()) {
      issues.push({
        kind: 'missing-file',
        path: key,
        detail: `expected a file at "${absPath}" but found something else`,
      });
      return;
    }
    size = st.size;
  } catch {
    issues.push({
      kind: 'missing-file',
      path: key,
      detail: `expected file not found at "${absPath}"`,
    });
    return;
  }
  if (size === 0) {
    issues.push({ kind: 'empty-file', path: key, detail: `file at "${absPath}" is zero bytes` });
  }
}

/**
 * The manifest->disk direction for one entry: master + every rung file it declares, each
 * containment-checked before it is ever stat'd. Returns the count of files it attempted to
 * check, so the caller can report a total across every entry without re-deriving it.
 */
function checkEntryFiles(
  key: string,
  entry: ManifestEntry,
  mastersDir: string,
  outputDir: string,
  formats: readonly string[],
  issues: TreeIssue[],
): number {
  let filesChecked = 0;
  const masterPath = join(mastersDir, key);
  if (checkContainment(mastersDir, masterPath, key, issues)) {
    checkFileOnDisk(key, masterPath, issues);
    filesChecked += 1;
  }

  const dir = dirname(key);
  const rungs = Array.isArray(entry.rungs) ? entry.rungs : [];
  for (const rung of rungs) {
    for (const format of formats) {
      const name = rungFile(rung.files, format);
      if (name === undefined || name === '') continue; // already reported by missing-format
      const rungPath = join(outputDir, dir, name);
      if (!checkContainment(outputDir, rungPath, key, issues)) continue;
      checkFileOnDisk(key, rungPath, issues);
      filesChecked += 1;
    }
  }
  return filesChecked;
}

/** Every rung filename each manifest entry declares, grouped by the output-side directory it
 * lives in — the "managed dirs" the plan scopes orphan detection to, so a directory the manifest
 * never mentions is never scanned (and never falsely accused of holding orphans). */
/** Every non-empty format filename declared across one entry's rungs, split out so the
 * three-level nesting counts against a small function instead of the caller's budget. */
function rungFilesOf(entry: ManifestEntry, formats: readonly string[]): string[] {
  const names: string[] = [];
  for (const rung of Array.isArray(entry.rungs) ? entry.rungs : []) {
    for (const format of formats) {
      const name = rungFile(rung.files, format);
      if (name !== undefined && name !== '') names.push(name);
    }
  }
  return names;
}

function expectedRungFilesByDir(
  manifest: ImageManifest,
  formats: readonly string[],
): Map<string, Set<string>> {
  const byDir = new Map<string, Set<string>>();
  for (const [key, entry] of Object.entries(manifest)) {
    if (!isValidKey(key)) continue;
    const dir = dirname(key);
    const set = byDir.get(dir) ?? new Set<string>();
    for (const name of rungFilesOf(entry, formats)) set.add(name);
    byDir.set(dir, set);
  }
  return byDir;
}

/**
 * Disk->manifest direction: a file in a managed directory that is shaped like one of our rungs
 * (`RUNG_FILE_RE`, the canonical pattern from `scanfs.ts` — never respelled here) but that no
 * manifest entry declares. A non-matching filename is not ours to judge and is ignored, matching
 * `scanfs`'s own contract for anything outside its two closed patterns.
 */
function checkOrphanRungs(
  manifest: ImageManifest,
  outputDir: string,
  formats: readonly string[],
  issues: TreeIssue[],
): void {
  const expectedByDir = expectedRungFilesByDir(manifest, formats);
  for (const [dir, expected] of expectedByDir) {
    const absDir = join(outputDir, dir);
    let names: string[];
    try {
      names = readdirSync(absDir);
    } catch {
      continue; // absence of the dir itself is already reported per-entry as missing-file
    }
    for (const name of names) {
      if (!RUNG_FILE_RE.test(name) || expected.has(name)) continue;
      const impliedMaster = rungMasterOf(name);
      issues.push({
        kind: 'orphan-rung',
        path: `${dir}/${name}`.replace(/\/{2,}/g, '/'),
        detail:
          `"${name}" in "${absDir}" matches the rung filename pattern` +
          (impliedMaster !== undefined ? ` (implies master "${impliedMaster}")` : '') +
          ' but is declared by no manifest entry',
      });
    }
  }
}

/** Every file under `root`, recursively, as a leading-`/` path relative to `root` — mirrors the
 * `publicPath` shape `scanfs.findMasters` produces. An unreadable subtree is skipped, not fatal
 * (`onReaddirError: 'skip'`): its absence is already reported per-entry as `missing-file`. */
function walkRelative(root: string, dir: string): string[] {
  return walkFiles(dir, { onReaddirError: 'skip' }).map(
    (abs) => `/${relative(root, abs).split(sep).join('/')}`,
  );
}

/**
 * Reverse of the manifest->disk direction: every file under ALL of `mastersDir` (not just the
 * directories the manifest already manages) that the manifest never mentions. Rung-shaped files
 * are skipped — they are not masters, and a derivative accidentally left under `mastersDir` is a
 * tree-layout mistake this check is not positioned to diagnose.
 */
function checkMastersNotInManifest(
  manifest: ImageManifest,
  mastersDir: string,
  issues: TreeIssue[],
): void {
  const knownKeys = new Set(Object.keys(manifest).filter(isValidKey));
  for (const relPath of walkRelative(mastersDir, mastersDir)) {
    const name = relPath.slice(relPath.lastIndexOf('/') + 1);
    if (RUNG_FILE_RE.test(name)) continue;
    if (!knownKeys.has(relPath)) {
      issues.push({
        kind: 'master-not-in-manifest',
        path: relPath,
        detail: `file exists under "${mastersDir}" but has no manifest entry`,
      });
    }
  }
}

/**
 * Master-hash staleness, only when `masterHashes` is supplied. Three distinct failures share the
 * word "missing" in the plan's prose but are NOT the same fact: `hash-missing` is a parity gap
 * (the manifest has an entry the hash map does not); `master-missing` is the hash map naming a
 * master whose file is no longer on disk; `master-changed` is both present but disagreeing.
 */
function checkMasterHashes(
  manifest: ImageManifest,
  mastersDir: string,
  masterHashes: Record<string, string> | undefined,
  issues: TreeIssue[],
): void {
  if (masterHashes === undefined) return;
  for (const key of Object.keys(manifest)) {
    if (!isValidKey(key)) continue;
    const recorded = masterHashes[key];
    if (recorded === undefined) {
      issues.push({
        kind: 'hash-missing',
        path: key,
        detail: 'manifest entry has no corresponding recorded master hash',
      });
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(mastersDir, key));
    } catch {
      issues.push({
        kind: 'master-missing',
        path: key,
        detail: 'a master hash was recorded but the file is no longer present on disk',
      });
      continue;
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== recorded) {
      issues.push({
        kind: 'master-changed',
        path: key,
        detail: `master sha256 is now "${actual}" but the recorded hash is "${recorded}" — the master changed since it was hashed`,
      });
    }
  }
}

/**
 * Structural verify over an `ImageManifest`, requiring no image decode. See the module doc
 * comment for why this exists beside `../node/verify.ts` instead of replacing it.
 *
 * Fail-closed per D15: an empty manifest is `empty-manifest`, not a vacuous pass — a verify that
 * examined nothing must never report `ok: true`.
 */
export function verifyImageTree(options: VerifyImageTreeOptions): VerifyImageTreeResult {
  const { manifest, outputDir, mastersDir, masterHashes, formats = DEFAULT_FORMATS } = options;
  const issues: TreeIssue[] = [];
  let filesChecked = 0;

  if (Object.keys(manifest).length === 0) {
    issues.push({
      kind: 'empty-manifest',
      path: '',
      detail: 'manifest has no entries — nothing was examined',
    });
  }

  for (const [key, entry] of Object.entries(manifest)) {
    if (!checkKeySanity(key, issues)) continue;
    checkRungCompleteness(key, entry, formats, issues);
    checkLadder(key, entry, issues);
    filesChecked += checkEntryFiles(key, entry, mastersDir, outputDir, formats, issues);
  }

  checkOrphanRungs(manifest, outputDir, formats, issues);
  checkMastersNotInManifest(manifest, mastersDir, issues);
  checkMasterHashes(manifest, mastersDir, masterHashes, issues);

  return { ok: issues.length === 0, issues, filesChecked };
}

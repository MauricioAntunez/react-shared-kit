import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { extname, join, relative } from 'node:path';
import sharp from 'sharp';
import type { ImageClasses, ImageManifest, ManifestEntry, Rung } from '../types.ts';
import { type EncodeFormat, encodeOne } from './encode.ts';
import { fileSha256, type Ledger, type LedgerEntry, needsEncode, paramsKey } from './ledger.ts';

export interface OptimizeOptions {
  sourceDir: string;
  classes: ImageClasses;
  classForPath: (path: string) => string;
  formats?: { avif?: number; webp?: number; jpeg?: number };
  manifestPath: string;
  ledgerPath: string;
  concurrency?: number;
  force?: boolean;
}

export interface OptimizeResult {
  encoded: number;
  skipped: number;
  bytesWritten: number;
  manifest: ImageManifest;
  truncated: Array<{ path: string; requested: number[]; emitted: number[] }>;
  inversions: Array<{ path: string; width: number; avifBytes: number; webpBytes: number }>;
  undersized: Array<{ path: string; intrinsic: number; masterMin: number }>;
}

type Formats = Required<NonNullable<OptimizeOptions['formats']>>;

const MASTER_RE = /\.(jpg|jpeg|png|webp)$/i;
/**
 * A candidate that LOOKS like one of our outputs: `<stem>-<width>.<ext>`.
 *
 * Shape alone is NOT enough to classify it — see `isOwnDerivative`. Real content in these repos
 * matches this pattern while being a genuine master: `form-1583.jpg` (a US tax form number),
 * `iso-27001-280.avif` (a standard number), and uxr-react's `…-content-1.webp` series.
 */
const DERIVATIVE_SHAPE_RE = /^(.*)-\d+\.(avif|webp|jpg)$/i;
const MASTER_EXTS = ['.jpg', '.jpeg', '.png', '.webp'] as const;
const EXT_BY_FORMAT: Record<EncodeFormat, string> = { avif: 'avif', webp: 'webp', jpeg: 'jpg' };
const DEFAULT_QUALITY: Formats = { avif: 55, webp: 72, jpeg: 80 };
const FORMAT_ORDER = ['avif', 'webp', 'jpeg'] as const;

interface MasterFile {
  /** Absolute filesystem path. */
  abs: string;
  /** Public-style path, `sourceDir`-relative with a leading `/`. */
  publicPath: string;
}

interface RungPlan {
  master: MasterFile;
  className: string;
  intrinsicWidth: number;
  intrinsicHeight: number;
  widths: number[];
}

async function walk(dir: string, root: string, out: MasterFile[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  const siblings = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(abs, root, out);
      continue;
    }
    if (!entry.isFile() || !MASTER_RE.test(entry.name) || isOwnDerivative(entry.name, siblings)) {
      continue;
    }
    const rel = relative(root, abs).split('\\').join('/');
    out.push({ abs, publicPath: `/${rel}` });
  }
}

/**
 * Is this file one of OUR emitted derivatives, rather than a master that merely looks like one?
 *
 * The name shape is ambiguous, so it is resolved by evidence: a derivative only exists because a
 * master was encoded, so the master must be sitting beside it. No sibling master with that stem
 * means the file is a master in its own right.
 *
 * Getting this wrong is SILENT — a misclassified master is skipped, never optimized, never in the
 * manifest, and nothing errors. Verified against real files: web-usa's `guides/form-1583.jpg`,
 * boufin's `iso-27001-280.avif`, and uxr-react's `…-content-1.webp` series would all have been
 * dropped by a shape-only test.
 */
function isOwnDerivative(name: string, siblings: Set<string>): boolean {
  const match = DERIVATIVE_SHAPE_RE.exec(name);
  const stem = match?.[1];
  if (stem === undefined) return false;
  return MASTER_EXTS.some(
    (ext) => siblings.has(stem + ext) || siblings.has(stem + ext.toUpperCase()),
  );
}

function stemOf(master: MasterFile): string {
  const file = master.publicPath.slice(master.publicPath.lastIndexOf('/') + 1);
  return file.slice(0, file.length - extname(file).length);
}

function outDirOf(master: MasterFile): string {
  return master.abs.slice(0, master.abs.lastIndexOf('/'));
}

function planRung(
  master: MasterFile,
  classes: ImageClasses,
  classForPath: (path: string) => string,
  intrinsicWidth: number,
  intrinsicHeight: number,
  result: OptimizeResult,
): RungPlan {
  const className = classForPath(master.publicPath);
  const def = classes[className];
  if (!def) throw new Error(`optimizeImages: unknown class "${className}" for ${master.abs}`);
  const widths = def.widths.filter((w) => w <= intrinsicWidth);
  if (widths.length < def.widths.length) {
    result.truncated.push({
      path: master.publicPath,
      requested: [...def.widths],
      emitted: [...widths],
    });
  }
  if (intrinsicWidth < def.masterMin) {
    result.undersized.push({
      path: master.publicPath,
      intrinsic: intrinsicWidth,
      masterMin: def.masterMin,
    });
  }
  return { master, className, intrinsicWidth, intrinsicHeight, widths };
}

/** Encode one rung's three formats, writing files beside the master. Reports AVIF inversions. */
interface EncodedRung {
  rung: Rung;
  bytesWritten: number;
}

async function encodeRung(
  master: MasterFile,
  requestedWidth: number,
  formats: Formats,
  result: OptimizeResult,
): Promise<EncodedRung> {
  const stem = stemOf(master);
  const outDir = outDirOf(master);
  const files: Record<EncodeFormat, { file: string; bytes: number }> = {
    avif: { file: '', bytes: 0 },
    webp: { file: '', bytes: 0 },
    jpeg: { file: '', bytes: 0 },
  };
  let measuredWidth = requestedWidth;

  for (const format of FORMAT_ORDER) {
    const encoded = await encodeOne(master.abs, requestedWidth, format, formats[format]);
    measuredWidth = encoded.width;
    const file = `${stem}-${encoded.width}.${EXT_BY_FORMAT[format]}`;
    await writeFile(join(outDir, file), encoded.data);
    files[format] = { file, bytes: encoded.data.length };
  }

  if (files.avif.bytes >= files.webp.bytes) {
    result.inversions.push({
      path: master.publicPath,
      width: measuredWidth,
      avifBytes: files.avif.bytes,
      webpBytes: files.webp.bytes,
    });
  }

  return {
    rung: {
      w: measuredWidth,
      files: { avif: files.avif.file, webp: files.webp.file, jpeg: files.jpeg.file },
    },
    bytesWritten: files.avif.bytes + files.webp.bytes + files.jpeg.bytes,
  };
}

function rungOutputFiles(rung: Rung): string[] {
  return [rung.files.avif, rung.files.webp, rung.files.jpeg];
}

function rungFileNames(stem: string, w: number): Rung['files'] {
  return { avif: `${stem}-${w}.avif`, webp: `${stem}-${w}.webp`, jpeg: `${stem}-${w}.jpg` };
}

/**
 * Rungs for a SKIPPED master, without re-encoding.
 *
 * D10 mechanism 3 says a descriptor is a claim about a file and must be generated FROM the file.
 * Deriving it from the requested ladder instead would reintroduce the lying-descriptor bug on the
 * incremental path — which is the common path, so the weaker version would be wrong almost every
 * build. The ledger therefore persists the widths that were actually measured, and this replays
 * them.
 *
 * The disk fallback covers a ledger written before `rungs` existed: measure the emitted files
 * rather than trust the ladder. Header-only metadata reads, no decode, so a skip stays cheap.
 */
async function rungsForSkip(
  master: MasterFile,
  widths: number[],
  entry: LedgerEntry | undefined,
): Promise<Rung[]> {
  const stem = stemOf(master);
  if (entry?.rungs && entry.rungs.length > 0) return entry.rungs;

  const outDir = outDirOf(master);
  const measured: Rung[] = [];
  for (const w of widths) {
    const files = rungFileNames(stem, w);
    const { width } = await sharp(join(outDir, files.jpeg)).metadata();
    measured.push({ w: width ?? w, files });
  }
  return measured;
}

async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let index = 0;
  async function worker(): Promise<void> {
    while (index < items.length) {
      const current = index++;
      const item = items[current];
      if (item !== undefined) await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

async function loadJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function manifestEntry(plan: RungPlan, rungs: Rung[]): ManifestEntry {
  return { w: plan.intrinsicWidth, h: plan.intrinsicHeight, class: plan.className, rungs };
}

async function processMaster(
  plan: RungPlan,
  formats: Formats,
  ledger: Ledger,
  result: OptimizeResult,
): Promise<void> {
  const { master, className, widths } = plan;
  const outDir = outDirOf(master);
  const sha256 = await fileSha256(master.abs);
  const params = paramsKey({ class: className, widths, formats });
  const key = master.publicPath;
  const entry = ledger[key];
  const outputsExist = (file: string) => existsSync(join(outDir, file));

  if (!needsEncode({ entry, sha256, params, outputsExist })) {
    result.skipped++;
    result.manifest[key] = manifestEntry(plan, await rungsForSkip(master, widths, entry));
    return;
  }

  const rungs: Rung[] = [];
  for (const w of widths) {
    const { rung, bytesWritten } = await encodeRung(master, w, formats, result);
    rungs.push(rung);
    result.encoded++;
    result.bytesWritten += bytesWritten;
  }

  result.manifest[key] = manifestEntry(plan, rungs);
  ledger[key] = { sha256, params, outputs: rungs.flatMap(rungOutputFiles), rungs };
}

function sortManifest(manifest: ImageManifest): ImageManifest {
  const sorted: ImageManifest = {};
  for (const key of Object.keys(manifest).sort()) {
    const entry = manifest[key];
    if (entry) sorted[key] = entry;
  }
  return sorted;
}

/**
 * Intrinsic size AFTER EXIF auto-orientation.
 *
 * `sharp().metadata()` reports the stored, pre-rotation dimensions, but imagetools-core's
 * `autoOrient` transform runs before the resize — so for EXIF orientations 5–8 (the 90°/270°
 * cases) the axes are swapped relative to what actually gets encoded. Measuring the stored width
 * would truncate the ladder against the wrong axis AND make every descriptor a lie: a 1000x600
 * master stored with orientation 6 encodes to 600px wide, so a rung named `-768` would really be
 * 600w. Verified against sharp 0.35 / imagetools-core 10 (2026-08-19).
 */
async function orientedSize(abs: string): Promise<{ width: number; height: number }> {
  const meta = await sharp(abs).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  return (meta.orientation ?? 1) >= 5 ? { width: h, height: w } : { width: w, height: h };
}

async function buildPlans(
  sourceDir: string,
  classes: ImageClasses,
  classForPath: (path: string) => string,
  result: OptimizeResult,
): Promise<RungPlan[]> {
  const masters: MasterFile[] = [];
  await walk(sourceDir, sourceDir, masters);
  const plans: RungPlan[] = [];
  for (const master of masters) {
    const { width, height } = await orientedSize(master.abs);
    plans.push(planRung(master, classes, classForPath, width, height, result));
  }
  return plans;
}

export async function optimizeImages(options: OptimizeOptions): Promise<OptimizeResult> {
  const formats: Formats = {
    avif: options.formats?.avif ?? DEFAULT_QUALITY.avif,
    webp: options.formats?.webp ?? DEFAULT_QUALITY.webp,
    jpeg: options.formats?.jpeg ?? DEFAULT_QUALITY.jpeg,
  };
  const result: OptimizeResult = {
    encoded: 0,
    skipped: 0,
    bytesWritten: 0,
    manifest: {},
    truncated: [],
    inversions: [],
    undersized: [],
  };

  let plans: RungPlan[];
  try {
    plans = await buildPlans(options.sourceDir, options.classes, options.classForPath, result);
  } catch {
    return result;
  }
  if (plans.length === 0) return result;

  const concurrency = options.concurrency ?? Math.max(2, cpus().length);
  const ledger: Ledger = options.force ? {} : await loadJson<Ledger>(options.ledgerPath, {});

  await runPool(plans, concurrency, (plan) => processMaster(plan, formats, ledger, result));

  result.manifest = sortManifest(result.manifest);
  await mkdir(join(options.manifestPath, '..'), { recursive: true });
  await writeFile(options.manifestPath, JSON.stringify(result.manifest, null, 2));
  await writeFile(options.ledgerPath, JSON.stringify(ledger, null, 2));

  return result;
}

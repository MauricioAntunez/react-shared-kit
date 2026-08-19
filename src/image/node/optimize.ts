import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { basename, dirname, join } from 'node:path';
import sharp from 'sharp';
import type { ImageClasses, ImageManifest, Inversion, ManifestEntry, Rung } from '../types.ts';
import { type EncodeFormat, encodeOne } from './encode.ts';
import { fileSha256, type Ledger, type LedgerEntry, needsEncode, paramsKey } from './ledger.ts';
import {
  derivativeName,
  findMasters,
  type IgnoredFile,
  type MasterFile,
  orientedSize,
} from './scan.ts';

export interface OptimizeOptions {
  sourceDir: string;
  classes: ImageClasses;
  classForPath: (path: string) => string;
  formats?: { avif?: number; webp?: number; jpeg?: number } | undefined;
  manifestPath: string;
  ledgerPath: string;
  concurrency?: number | undefined;
  force?: boolean | undefined;
}

export interface OptimizeResult {
  /** Masters found by the scan. `mastersFound === mastersEncoded + skipped` always holds. */
  mastersFound: number;
  /** Masters re-encoded this run. */
  mastersEncoded: number;
  /** Individual RUNGS encoded — not masters, hence the separate master counters above. */
  encoded: number;
  /** Masters skipped because the ledger proved their derivatives current. */
  skipped: number;
  bytesWritten: number;
  manifest: ImageManifest;
  truncated: Array<{ path: string; requested: number[]; emitted: number[] }>;
  /**
   * Rungs whose AVIF came out no smaller than its WebP sibling.
   *
   * Replayed from the ledger for skipped masters so this stays complete on incremental runs. It
   * would otherwise empty out after the first build, and a CI gate on it would pass vacuously —
   * green forever on any warm cache while oversized AVIFs kept shipping first.
   */
  inversions: Inversion[];
  undersized: Array<{ path: string; intrinsic: number; masterMin: number }>;
  /**
   * Image files seen but not treated as masters — an AVIF used as a source, an animated GIF, an
   * unsupported format. Reported so that "not optimized" is never indistinguishable from
   * "not present": the manifest-driven verifier cannot see these, because they never become
   * masters.
   */
  ignored: IgnoredFile[];
  /**
   * Set when the ledger could not be used and incrementality was reset. Distinguishes a cold cache
   * from a corrupt one — otherwise a ledger being clobbered every run looks exactly like a normal
   * first build, forever.
   */
  ledgerReset?: 'missing' | 'corrupt' | 'unreadable' | undefined;
  /**
   * Set when `sourceDir` does not exist. Distinguishes a misconfigured path from a genuinely
   * empty tree — both otherwise report mastersFound: 0 and look like success.
   */
  sourceDirMissing?: boolean | undefined;
  /**
   * Set when `sourceDir` exists but contains no masters. Distinct from `sourceDirMissing`: the
   * manifest is left untouched in BOTH cases, so without this the returned (empty) manifest and
   * the one on disk disagree with nothing saying so.
   */
  sourceDirEmpty?: boolean | undefined;
}

type Formats = Required<NonNullable<OptimizeOptions['formats']>>;

const EXT_BY_FORMAT: Record<EncodeFormat, string> = { avif: 'avif', webp: 'webp', jpeg: 'jpg' };
const DEFAULT_QUALITY: Formats = { avif: 55, webp: 72, jpeg: 80 };
const FORMAT_ORDER = ['avif', 'webp', 'jpeg'] as const;

interface RungPlan {
  master: MasterFile;
  className: string;
  intrinsicWidth: number;
  intrinsicHeight: number;
  widths: number[];
}

/** The master's full filename INCLUDING extension — see `derivativeName` for why. */
function baseOf(master: MasterFile): string {
  return basename(master.publicPath);
}

function outDirOf(master: MasterFile): string {
  return dirname(master.abs);
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

interface EncodedRung {
  rung: Rung;
  bytesWritten: number;
  inversion?: Inversion;
}

/** Encode one rung's three formats, writing the files beside the master. */
async function encodeRung(
  master: MasterFile,
  requestedWidth: number,
  formats: Formats,
): Promise<EncodedRung> {
  const base = baseOf(master);
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
    const file = derivativeName(base, encoded.width, EXT_BY_FORMAT[format]);
    await writeFile(join(outDir, file), encoded.data);
    files[format] = { file, bytes: encoded.data.length };
  }

  const rung: Rung = {
    w: measuredWidth,
    files: { avif: files.avif.file, webp: files.webp.file, jpeg: files.jpeg.file },
  };
  const bytesWritten = files.avif.bytes + files.webp.bytes + files.jpeg.bytes;

  // AVIF is emitted and served first regardless. An inversion means the SOURCE is an already-lossy
  // re-encode, not that the chain should reorder — so it is reported, never acted on.
  if (files.avif.bytes >= files.webp.bytes) {
    const inversion: Inversion = {
      path: master.publicPath,
      width: measuredWidth,
      avifBytes: files.avif.bytes,
      webpBytes: files.webp.bytes,
    };
    return { rung, bytesWritten, inversion };
  }
  return { rung, bytesWritten };
}

function rungOutputFiles(rung: Rung): string[] {
  return [rung.files.avif, rung.files.webp, rung.files.jpeg];
}

/**
 * Rungs for a SKIPPED master, without re-encoding.
 *
 * A descriptor is a claim about a file and must be generated FROM the file. Deriving it from the
 * requested ladder instead reintroduces the lying-descriptor bug on the incremental path — which
 * is the common path, so the weaker version would be wrong on nearly every build. The ledger
 * persists the widths actually measured; this replays them.
 *
 * The disk fallback covers a ledger written before `rungs` existed: measure the emitted files
 * rather than trust the ladder. Header-only metadata reads, no decode, so a skip stays cheap.
 */
async function rungsForSkip(
  master: MasterFile,
  widths: number[],
  entry: LedgerEntry | undefined,
): Promise<Rung[]> {
  if (entry?.rungs && entry.rungs.length > 0) return entry.rungs;

  const base = baseOf(master);
  const outDir = outDirOf(master);
  const measured: Rung[] = [];
  for (const w of widths) {
    const files = {
      avif: derivativeName(base, w, 'avif'),
      webp: derivativeName(base, w, 'webp'),
      jpeg: derivativeName(base, w, 'jpg'),
    };
    const jpegPath = join(outDir, files.jpeg);
    const { width } = await sharp(jpegPath).metadata();
    // Guessing the requested width here would be the lying descriptor this module exists to
    // prevent, so an unmeasurable derivative is an error rather than an assumption.
    if (width === undefined) {
      throw new Error(`optimizeImages: cannot measure ${jpegPath} to replay a skipped master`);
    }
    measured.push({ w: width, files });
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

/**
 * Load the ledger, distinguishing "absent" from "unusable".
 *
 * A ledger is a cache, so failing to read one must never fail the build — but it must not be
 * silent either. A parseable value of the wrong SHAPE is the dangerous case: an array accepts
 * string property assignment, then `JSON.stringify` drops every one of them, so the file rewrites
 * as `[]` and incrementality is dead permanently while every build still looks normal.
 */
async function loadLedger(
  path: string,
): Promise<{ ledger: Ledger; reset?: 'missing' | 'corrupt' | 'unreadable' }> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    // Only ENOENT is data — the same rule optimizeImages applies to sourceDir and measure() applies
    // in verify.ts. An unreadable ledger reported as 'missing' is indistinguishable from a first
    // build, so incrementality dies every run and the one field meant to surface that points away
    // from the cause.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { ledger: {}, reset: 'unreadable' };
    }
    return { ledger: {}, reset: 'missing' };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ledger: {}, reset: 'corrupt' };
    }
    return { ledger: parsed as Ledger };
  } catch {
    return { ledger: {}, reset: 'corrupt' };
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

  // An entry written before `inversions` existed cannot replay them, and silently contributing
  // none is the vacuous-green this field was added to prevent. Treat it as stale so one upgrade
  // build re-encodes and repopulates it.
  const predatesInversions = entry !== undefined && entry.inversions === undefined;
  if (!predatesInversions && !needsEncode({ entry, sha256, params, outputsExist })) {
    result.skipped++;
    result.manifest[key] = manifestEntry(plan, await rungsForSkip(master, widths, entry));
    if (entry?.inversions) result.inversions.push(...entry.inversions);
    return;
  }

  const rungs: Rung[] = [];
  const inversions: Inversion[] = [];
  for (const w of widths) {
    const encoded = await encodeRung(master, w, formats);
    rungs.push(encoded.rung);
    if (encoded.inversion) inversions.push(encoded.inversion);
    result.encoded++;
    result.bytesWritten += encoded.bytesWritten;
  }

  result.mastersEncoded++;
  result.inversions.push(...inversions);
  result.manifest[key] = manifestEntry(plan, rungs);
  ledger[key] = { sha256, params, outputs: rungs.flatMap(rungOutputFiles), rungs, inversions };
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
 * Optimize every master under `options.sourceDir`.
 *
 * Scan failures PROPAGATE. An earlier version wrapped the scan in a blanket `catch` that returned
 * an empty but successful-looking result, so one corrupt file, one permission error or one
 * unmapped directory silently produced `encoded: 0, manifest: {}` — and, because the write was
 * skipped, left the PREVIOUS manifest on disk for `verifyImages` to bless. That is the "the output
 * exists, so we are done" failure this module exists to eliminate, reconstituted one layer up.
 *
 * Two conditions are treated as data rather than error, each carrying its own flag so neither is
 * silent: a missing `sourceDir` (`sourceDirMissing`) and an existing one holding no masters
 * (`sourceDirEmpty`). Both return early and write NOTHING, so a misconfigured path cannot clobber
 * a good manifest with `{}`.
 */
export async function optimizeImages(options: OptimizeOptions): Promise<OptimizeResult> {
  const formats: Formats = {
    avif: options.formats?.avif ?? DEFAULT_QUALITY.avif,
    webp: options.formats?.webp ?? DEFAULT_QUALITY.webp,
    jpeg: options.formats?.jpeg ?? DEFAULT_QUALITY.jpeg,
  };
  const result: OptimizeResult = {
    mastersFound: 0,
    mastersEncoded: 0,
    encoded: 0,
    skipped: 0,
    bytesWritten: 0,
    manifest: {},
    truncated: [],
    inversions: [],
    undersized: [],
    ignored: [],
  };

  // existsSync() returns false for ANY stat failure, so it silently swallowed EACCES (a CI
  // container over a restrictive mount) and a dangling symlink into an absent sibling checkout —
  // both reported as "the directory is empty" and green forever while nothing was optimized.
  // Only ENOENT is data; everything else is an error.
  const sourceStat = await stat(options.sourceDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (sourceStat === undefined) {
    result.sourceDirMissing = true;
    return result;
  }
  if (!sourceStat.isDirectory()) {
    throw new Error(`optimizeImages: sourceDir is not a directory: ${options.sourceDir}`);
  }

  const { masters, ignored } = await findMasters(options.sourceDir);
  result.ignored = ignored;
  result.mastersFound = masters.length;
  if (masters.length === 0) {
    // Deliberately does NOT write an empty manifest: pointing at a wrong-but-existing directory
    // is a real misconfiguration, and clobbering a good manifest with {} would be unrecoverable.
    // The flag is what keeps that silence from being indistinguishable from success.
    result.sourceDirEmpty = true;
    return result;
  }

  const plans: RungPlan[] = [];
  for (const master of masters) {
    const { width, height } = await orientedSize(master.abs);
    plans.push(planRung(master, options.classes, options.classForPath, width, height, result));
  }

  const concurrency = options.concurrency ?? Math.max(2, cpus().length);
  let ledger: Ledger = {};
  if (!options.force) {
    const loaded = await loadLedger(options.ledgerPath);
    ledger = loaded.ledger;
    if (loaded.reset) result.ledgerReset = loaded.reset;
  }

  await runPool(plans, concurrency, (plan) => processMaster(plan, formats, ledger, result));

  result.manifest = sortManifest(result.manifest);
  await mkdir(dirname(options.manifestPath), { recursive: true });
  await writeFile(options.manifestPath, JSON.stringify(result.manifest, null, 2));
  await mkdir(dirname(options.ledgerPath), { recursive: true });
  await writeFile(options.ledgerPath, JSON.stringify(ledger, null, 2));

  return result;
}

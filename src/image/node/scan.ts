import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import sharp from 'sharp';

export interface MasterFile {
  /** Absolute filesystem path. */
  abs: string;
  /** Public-style path, `sourceDir`-relative with a leading `/`. */
  publicPath: string;
}

/** An image the scan saw but did not treat as a master. Surfaced so nothing is skipped silently. */
export interface IgnoredFile {
  publicPath: string;
  reason:
    | 'output-format-as-source'
    | 'animation-unsupported'
    | 'unsupported-source-format'
    | 'not-an-accepted-master-format'
    | 'orphaned-derivative';
}

export interface ScanResult {
  masters: MasterFile[];
  ignored: IgnoredFile[];
}

/**
 * Source formats accepted as a master.
 *
 * `jfif` and `jpe` are JPEG — Chrome saved downloads as `.jfif` for years, so they land in
 * `public/` routinely, and sharp sniffs by content rather than extension. Dropping them on their
 * extension alone was a silent skip. AVIF is deliberately absent: it is an output format, and
 * accepting it risks re-ingesting our own derivatives.
 */
const MASTER_RE = /\.(jpg|jpeg|jfif|jfi|jif|jpe|png|webp)$/i;

/**
 * Image files that are neither masters nor ours. Reported, never silently passed over.
 *
 * This list and `MASTER_RE` are BOTH closed, so anything absent from both vanishes without a
 * trace — which is the failure `ignored` exists to prevent. Keep it broad: every raster format a
 * consumer might plausibly drop in `public/` belongs here, even the obscure ones.
 *
 * SVG is absent on purpose: a vector needs no derivatives, so skipping it is the correct outcome
 * rather than a problem to report, and listing every icon would drown the real signal.
 */
const IGNORED_IMAGE_RE =
  /\.(avif|avifs|gif|apng|bmp|dib|tiff?|heic|heics|heif|heifs|hif|jxl|ico|cur|jp2|j2k|jpf|jpx|jpm|mj2|tga|icb|vda|vst|dng|cr2|cr3|nef|arw|orf|rw2|raf|srw|pef|x3f|erf|kdc|mos|iiq|3fr|psd|psb|xcf|pbm|pgm|ppm|pnm|pam|pfm|exr|hdr|pcx|wbmp|ras|sgi|rgb|qoi)$/i;

/**
 * Extension → the sharp format key that decodes it.
 *
 * Only used to pick a diagnostic message, and deliberately NOT a hardcoded "sharp can read this"
 * list: sharp's prebuilt libvips ships with JPEG 2000 and JPEG XL input DISABLED, so claiming they
 * are decodable would tell a developer to convert a file that sharp will refuse to open. The
 * capability is read from `sharp.format` at runtime, so this stays true against whatever libvips
 * build the consumer actually installed rather than against the one present when this was written.
 */
const SHARP_FORMAT_BY_EXT: Record<string, string> = {
  tif: 'tiff',
  tiff: 'tiff',
  heic: 'heif',
  heif: 'heif',
  hif: 'heif',
  jp2: 'jp2',
  j2k: 'jp2',
  jpf: 'jp2',
  jpx: 'jp2',
  jxl: 'jxl',
};

function isDecodableBySharp(name: string): boolean {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  const format = SHARP_FORMAT_BY_EXT[ext];
  if (format === undefined) return false;
  return sharp.format[format as keyof typeof sharp.format]?.input?.file === true;
}

function reasonFor(name: string): IgnoredFile['reason'] {
  if (/\.avif$/i.test(name)) return 'output-format-as-source';
  if (/\.(gif|apng|avifs|heics|heifs|mj2)$/i.test(name)) return 'animation-unsupported';
  // Decodable but excluded by policy: the remedy is to convert, not to give up.
  if (isDecodableBySharp(name)) return 'not-an-accepted-master-format';
  return 'unsupported-source-format';
}

/**
 * A file shaped like one of our outputs: `<master filename>-<width>.<ext>`.
 *
 * Note the captured group is the master's FULL filename including its extension, because that is
 * how `derivativeName` builds them — `hero.jpg-480.webp`, not `hero-480.webp`. Two things fall out
 * of that, both of them bugs we already shipped once:
 *
 *   1. Two masters differing only by extension (`hero.jpg` and `hero.webp`, which occur in
 *      uxr-react and web-mexico today) no longer emit colliding derivative names and silently
 *      overwrite each other.
 *   2. A genuine master whose name merely ENDS in `-<digits>` — `form-1583.jpg`, or uxr-react's
 *      `…-content-1.webp` series — captures a group with NO file extension (`form`), which can
 *      never be one of our derivatives, so it is correctly kept as a master. (`iso-27001-280.avif`
 *      is a different case: AVIF is not a master format at all, so it is reported via `ignored`.)
 */
const DERIVATIVE_SHAPE_RE = /^(.*)-\d+\.(avif|webp|jpg)$/i;

/** The name of a derivative emitted from `masterFileName` at `width` in `ext`. */
export function derivativeName(masterFileName: string, width: number, ext: string): string {
  return `${masterFileName}-${width}.${ext}`;
}

/**
 * Is `name` one of OUR emitted derivatives, a stale one, or a master that merely looks like one?
 *
 * Resolved by evidence, never by shape alone: a derivative exists only because a master was
 * encoded, so that master must be sitting beside it under the exact filename we derived from.
 * `siblings` holds the real filenames in the same directory. Getting this wrong is SILENT in both
 * directions — a misclassified master is never optimized, never in the manifest, and nothing
 * errors; `verifyImages`' `masters-not-in-manifest` check is the backstop that makes such a
 * mistake loud rather than invisible.
 *
 * Three outcomes, not two — the missing third is what made a rename corrupt the tree.
 *
 * - `derivative`: shaped like ours AND its master is present. Skip silently; it is our output.
 * - `orphaned-derivative`: shaped like ours, master GONE. Do not adopt it as a master. Renaming
 *   `hero.jpg` left `hero.jpg-480.webp` behind, which used to be re-ingested as a master and
 *   re-encoded into `hero.jpg-480.webp-480.avif` and so on — 24 garbage files from one `git mv`,
 *   growing every build and never self-healing. Reported so the fix is one line of `rm`.
 * - `not-derivative`: the captured group has no master extension (`form` from `form-1583.jpg`),
 *   so it cannot be one of ours and is a genuine master.
 */
export function classify(
  name: string,
  siblings: ReadonlySet<string>,
): 'derivative' | 'orphaned-derivative' | 'not-derivative' {
  const captured = DERIVATIVE_SHAPE_RE.exec(name)?.[1];
  // Our derivatives embed the master's FULL filename, so the captured group must itself look like
  // a master. `form` does not; `hero.jpg` does.
  if (captured === undefined || !MASTER_RE.test(captured)) return 'not-derivative';
  return siblings.has(captured) ? 'derivative' : 'orphaned-derivative';
}

/**
 * Every master under `root`, depth-first.
 *
 * Errors are NOT swallowed. An unreadable directory, a permission error or a corrupt entry
 * propagates to the caller: a scan that silently returns fewer masters than exist is exactly the
 * failure this module was written to eliminate, and it is indistinguishable from success.
 */
export async function findMasters(root: string, dir: string = root): Promise<ScanResult> {
  const entries = await readdir(dir, { withFileTypes: true });
  const siblings = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const masters: MasterFile[] = [];
  const ignored: IgnoredFile[] = [];

  for (const entry of entries) {
    const abs = join(dir, entry.name);
    const publicPath = `/${relative(root, abs).split('\\').join('/')}`;

    if (entry.isDirectory()) {
      const nested = await findMasters(root, abs);
      masters.push(...nested.masters);
      ignored.push(...nested.ignored);
      continue;
    }
    if (!entry.isFile()) continue;

    const classified = classifyFile(entry.name, abs, publicPath, siblings);
    if (classified === undefined) continue;
    if ('reason' in classified) ignored.push(classified);
    else masters.push(classified);
  }

  return { masters, ignored };
}

/**
 * One file's verdict: a master, an ignored image, or nothing to say about it.
 *
 * Split out of `findMasters` to keep that function within the complexity budget — the recursion
 * and the per-file decision are two separate jobs and read better apart.
 */
function classifyFile(
  name: string,
  abs: string,
  publicPath: string,
  siblings: ReadonlySet<string>,
): MasterFile | IgnoredFile | undefined {
  const kind = classify(name, siblings);
  if (kind === 'derivative') return undefined;
  if (kind === 'orphaned-derivative') return { publicPath, reason: 'orphaned-derivative' };
  if (MASTER_RE.test(name)) return { abs, publicPath };
  // Not a master, not ours, but unmistakably an image. Reported rather than dropped: an AVIF-only
  // source (boufin ships two today) would otherwise be scanned past in silence — no derivatives,
  // no manifest entry, and invisible to the manifest-driven verifier.
  if (IGNORED_IMAGE_RE.test(name)) return { publicPath, reason: reasonFor(name) };
  return undefined;
}

/**
 * Intrinsic size AFTER EXIF auto-orientation.
 *
 * `sharp().metadata()` reports STORED dimensions, but imagetools-core auto-orients before
 * resizing, so for EXIF orientations 5-8 the axes are swapped relative to what is actually
 * encoded. Shared by the generator and the verifier deliberately: when only the generator applied
 * the swap, the verifier compared a rotated master's stored width against the manifest's oriented
 * width and drew the wrong conclusion in both directions.
 *
 * When the header does not carry dimensions, this DECODES the image to measure them rather than
 * failing — an image that is perfectly usable must not break a build. What it must never do is
 * default to zero: the previous `?? 0` is how `w: 0` reached the manifest, where it is silent
 * everywhere and disables the verifier's aspect check on the entry most likely to be corrupt. An
 * image that cannot be decoded at all still throws, from sharp itself.
 *
 * Honest caveat: on sharp 0.35 / libvips 8.18 this fallback is UNREACHABLE and therefore not
 * covered by a test that can fail. Probed with truncated JPEGs (corrupt header → throws), an SVG
 * with only a viewBox (resolves to 300x150), 16-bit and CMYK inputs — `metadata()` either yields
 * both dimensions or throws, never one without the other. It is kept as defence against a
 * different libvips build or a future format, not because a case is known to reach it.
 */
export async function orientedSize(abs: string): Promise<{ width: number; height: number }> {
  const meta = await sharp(abs).metadata();
  if (meta.width === undefined || meta.height === undefined) {
    // `autoOrient()` so the decoded dimensions already carry the EXIF swap, matching the branch
    // below rather than needing it reapplied.
    const { info } = await sharp(abs).autoOrient().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height };
  }
  const swapped = (meta.orientation ?? 1) >= 5;
  return swapped
    ? { width: meta.height, height: meta.width }
    : { width: meta.width, height: meta.height };
}

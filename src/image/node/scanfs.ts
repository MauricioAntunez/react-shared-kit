/**
 * The sharp-free filesystem half of the scanner (D14): master discovery and derivative
 * classification by name alone. The sharp-dependent half — `orientedSize` and the sharp-aware
 * refinement of the ignored reasons — lives in `scan.ts`, which re-composes them. Modules that
 * must stay sharp-free (a `./check` tree verifier, for example) import ONLY from here.
 */
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

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
 * The ONE canonical spelling of a rung (derivative) filename: it ENDS in `-<width>.<ext>` — the
 * master's FULL filename (see `derivativeName`) precedes it. The rung counters in `verify.ts`
 * and any sharp-free tree verifier test names against this pattern rather than respelling it.
 */
export const RUNG_FILE_RE = /-\d+\.(avif|webp|jpe?g)$/i;

/**
 * The master's FULL filename embedded in a rung name — `hero.jpg` out of `hero.jpg-480.webp` —
 * or `undefined` when `name` is not rung-shaped.
 *
 * Note the captured part is the master's FULL filename including its extension, because that is
 * how `derivativeName` builds them — `hero.jpg-480.webp`, not `hero-480.webp`. Two things fall out
 * of that, both of them bugs we already shipped once:
 *
 *   1. Two masters differing only by extension (`hero.jpg` and `hero.webp`, which occur in
 *      uxr-react and web-mexico today) no longer emit colliding derivative names and silently
 *      overwrite each other.
 *   2. A genuine master whose name merely ENDS in `-<digits>` — `form-1583.jpg`, or uxr-react's
 *      `…-content-1.webp` series — yields a part with NO file extension (`form`), which can never
 *      be one of our derivatives, so it is correctly kept as a master. (`iso-27001-280.avif` is a
 *      different case: AVIF is not a master format at all, so it is reported via `ignored`.)
 */
export function rungMasterOf(name: string): string | undefined {
  const suffix = RUNG_FILE_RE.exec(name)?.[0];
  if (suffix === undefined) return undefined;
  return name.slice(0, name.length - suffix.length);
}

/** The name of a derivative emitted from `masterFileName` at `width` in `ext`. */
export function derivativeName(masterFileName: string, width: number, ext: string): string {
  return `${masterFileName}-${width}.${ext}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches this master's own derivatives only — `<filename>-<digits>.<ext>`, where <filename>
 * INCLUDES the source extension — so `hero.jpg` and `hero.webp` never count each other's files. */
export function derivativePatternFor(basename: string): RegExp {
  return new RegExp(`^${escapeRegExp(basename)}-\\d+\\.(avif|webp|jpe?g)$`, 'i');
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
  const captured = rungMasterOf(name);
  // Our derivatives embed the master's FULL filename, so the captured group must itself look like
  // a master. `form` does not; `hero.jpg` does.
  if (captured === undefined || !MASTER_RE.test(captured)) return 'not-derivative';
  return siblings.has(captured) ? 'derivative' : 'orphaned-derivative';
}

/**
 * The sharp-free verdicts for a file that is unmistakably an image but not a master.
 *
 * The one distinction this half CANNOT draw is 'not-an-accepted-master-format' vs
 * 'unsupported-source-format': it depends on what the consumer's libvips can decode, which is
 * read from `sharp.format` in `scan.ts`'s `reasonFor`. Sharp-free callers (a tree verifier) get
 * these verdicts as-is; `optimizeImages` and `verifyImages` inject the sharp-aware refinement.
 */
export function baseReasonFor(name: string): IgnoredFile['reason'] {
  if (/\.avif$/i.test(name)) return 'output-format-as-source';
  if (/\.(gif|apng|avifs|heics|heifs|mj2)$/i.test(name)) return 'animation-unsupported';
  return 'unsupported-source-format';
}

/**
 * Every master under `root`, depth-first.
 *
 * Errors are NOT swallowed. An unreadable directory, a permission error or a corrupt entry
 * propagates to the caller: a scan that silently returns fewer masters than exist is exactly the
 * failure this module was written to eliminate, and it is indistinguishable from success.
 *
 * `reasonFor` decides the verdict for an ignored image; it defaults to the sharp-free
 * `baseReasonFor` and is injected where the sharp-aware refinement is available (`scan.ts`).
 */
export async function findMasters(
  root: string,
  dir: string = root,
  reasonFor: (name: string) => IgnoredFile['reason'] = baseReasonFor,
): Promise<ScanResult> {
  const entries = await readdir(dir, { withFileTypes: true });
  const siblings = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const masters: MasterFile[] = [];
  const ignored: IgnoredFile[] = [];

  for (const entry of entries) {
    const abs = join(dir, entry.name);
    const publicPath = `/${relative(root, abs).split('\\').join('/')}`;

    if (entry.isDirectory()) {
      const nested = await findMasters(root, abs, reasonFor);
      masters.push(...nested.masters);
      ignored.push(...nested.ignored);
      continue;
    }
    if (!entry.isFile()) continue;

    const classified = classifyFile(entry.name, abs, publicPath, siblings, reasonFor);
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
  reasonFor: (name: string) => IgnoredFile['reason'],
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

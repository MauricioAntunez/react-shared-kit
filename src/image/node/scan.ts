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
  reason: 'output-format-as-source' | 'animation-unsupported' | 'unsupported-source-format';
}

export interface ScanResult {
  masters: MasterFile[];
  ignored: IgnoredFile[];
}

/** Source formats accepted as a master. AVIF is deliberately absent — it is an output format. */
const MASTER_RE = /\.(jpg|jpeg|png|webp)$/i;

/**
 * Image files that are neither masters nor ours. Reported, never silently passed over.
 *
 * SVG is absent on purpose: a vector needs no derivatives, so skipping it is the correct outcome
 * rather than a problem to report, and listing every icon would drown the real signal.
 */
const IGNORED_IMAGE_RE = /\.(avif|gif|bmp|tiff?|heic|heif|jxl)$/i;

function reasonFor(name: string): IgnoredFile['reason'] {
  if (/\.avif$/i.test(name)) return 'output-format-as-source';
  if (/\.gif$/i.test(name)) return 'animation-unsupported';
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
 *   2. A genuine master whose name merely ENDS in `-<digits>` — `form-1583.jpg`,
 *      `iso-27001-280.avif`, uxr-react's `…-content-1.webp` series — captures a group with no file
 *      extension (`form`, `iso-27001`), which can never match a real filename, so it is correctly
 *      kept as a master.
 */
const DERIVATIVE_SHAPE_RE = /^(.*)-\d+\.(avif|webp|jpg)$/i;

/** The name of a derivative emitted from `masterFileName` at `width` in `ext`. */
export function derivativeName(masterFileName: string, width: number, ext: string): string {
  return `${masterFileName}-${width}.${ext}`;
}

/**
 * Is `name` one of OUR emitted derivatives rather than a master that merely looks like one?
 *
 * Resolved by evidence, never by shape alone: a derivative exists only because a master was
 * encoded, so that master must be sitting beside it under the exact filename we derived from.
 * `siblings` holds the real filenames in the same directory.
 *
 * Getting this wrong is SILENT in both directions — a misclassified master is never optimized,
 * never in the manifest, and nothing errors. `verifyImages`' `masters-not-in-manifest` check is
 * the backstop that makes such a mistake loud rather than invisible.
 */
export function isOwnDerivative(name: string, siblings: ReadonlySet<string>): boolean {
  const captured = DERIVATIVE_SHAPE_RE.exec(name)?.[1];
  if (captured === undefined) return false;
  return siblings.has(captured);
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
    if (isOwnDerivative(entry.name, siblings)) continue;

    if (MASTER_RE.test(entry.name)) {
      masters.push({ abs, publicPath });
      continue;
    }
    // Not a master, not ours, but unmistakably an image. Reported rather than dropped: an
    // AVIF-only source (boufin ships two today) would otherwise be scanned past in silence —
    // no derivatives, no manifest entry, and invisible to the manifest-driven verifier.
    if (IGNORED_IMAGE_RE.test(entry.name)) {
      ignored.push({ publicPath, reason: reasonFor(entry.name) });
    }
  }

  return { masters, ignored };
}

/**
 * The sharp-dependent half of the scanner (D14): measurement via sharp metadata and the
 * sharp-aware refinement of the ignored reasons. The sharp-free filesystem logic — master
 * discovery, derivative classification, the rung-filename pattern — lives in `scanfs.ts`.
 */
import sharp from 'sharp';
import { baseReasonFor, type IgnoredFile } from './scanfs.ts';

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

/**
 * The full verdict for an ignored image: the sharp-free base verdict from `scanfs.ts`, refined
 * with what the consumer's sharp can actually decode. Injected into `findMasters` by the callers
 * that surface `ignored` (`optimizeImages`, `verifyImages`).
 */
export function reasonFor(name: string): IgnoredFile['reason'] {
  const reason = baseReasonFor(name);
  // Decodable but excluded by policy: the remedy is to convert, not to give up.
  if (reason === 'unsupported-source-format' && isDecodableBySharp(name)) {
    return 'not-an-accepted-master-format';
  }
  return reason;
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

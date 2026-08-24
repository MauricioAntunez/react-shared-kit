import { closeSync, openSync, readFileSync, readSync } from 'node:fs';

/**
 * An image's intrinsic pixel dimensions, read straight from its file header.
 *
 * **Why not `sharp`.** This subpath exists so verification gates run with zero native binaries
 * on the deploy chain — sharp is an optional peer dependency `./check` must never import. Every
 * format this reader knows states its dimensions in the first few dozen bytes, so a header read
 * is enough: no decode, no dependency, no image data in memory.
 */
export interface IntrinsicSize {
  width: number;
  height: number;
}

/** Read the first `n` bytes without pulling a whole image into memory. */
function head(file: string, n: number): Buffer {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function png(b: Buffer): IntrinsicSize | undefined {
  // 8-byte signature, then an IHDR chunk whose payload opens with two big-endian uint32s.
  if (b.length < 24 || b.toString('ascii', 12, 16) !== 'IHDR') return undefined;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function jpeg(file: string): IntrinsicSize | undefined {
  // JPEG has no fixed header offset: walk the marker segments to the SOFn that carries the frame
  // size. Baseline is SOF0 but progressive (SOF2) is just as common from an export pipeline, so
  // accept the whole SOF family except C4/C8/CC, which fall in that range but are not frame
  // headers.
  const b = readFileSync(file);
  let i = 2; // skip SOI
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = b[i + 1] as number;
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return undefined; // malformed: a zero-length segment would loop forever
    i += 2 + len;
  }
  return undefined;
}

function webp(b: Buffer): IntrinsicSize | undefined {
  // Three sub-formats under one RIFF container, each storing the size differently.
  //
  // Each branch states the number of bytes it needs BEFORE reading. Node's `Buffer.read*` are
  // bounds-checked and THROW on overrun, so a truncated file here does not read stray memory — it
  // takes the whole gate down with a raw stack trace, which is the failure this module's contract
  // exists to prevent. Reproduced in review on all three branches.
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    // Canvas size as two 24-bit little-endian values, stored minus one. Last byte read is 29.
    if (b.length < 30) return undefined;
    return { width: readUInt24LE(b, 24) + 1, height: readUInt24LE(b, 27) + 1 };
  }
  if (chunk === 'VP8 ') {
    // Lossy: 14 bits of each dimension after the start code. Last byte read is 29.
    if (b.length < 30) return undefined;
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    // Lossless: 14 bits each, packed across a 32-bit little-endian field, stored minus one.
    // Last byte read is 24.
    if (b.length < 25) return undefined;
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return undefined;
}

function readUInt24LE(b: Buffer, offset: number): number {
  return (
    (b[offset] as number) | ((b[offset + 1] as number) << 8) | ((b[offset + 2] as number) << 16)
  );
}

function avif(file: string): IntrinsicSize | undefined {
  // ISOBMFF. Rather than walking the box tree, find the `ispe` (image spatial extents) box, which
  // is the only place the canvas size is stated. The first one is the primary item's; alpha or
  // thumbnail items would add more, which is why this takes the FIRST and not the largest.
  const b = readFileSync(file);
  const at = b.indexOf('ispe', 0, 'ascii');
  // 4 bytes of version/flags follow the box type, then width and height as big-endian uint32s, so
  // the last byte read is `at + 15`. The guard was `at + 12` once, which is the OFFSET of the
  // height read rather than its end — off by the width of the read itself, so an `ispe` truncated
  // in its final four bytes threw instead of returning undefined. Reproduced in review.
  if (at === -1 || at + 16 > b.length) return undefined;
  return { width: b.readUInt32BE(at + 8), height: b.readUInt32BE(at + 12) };
}

function svg(file: string): IntrinsicSize | undefined {
  // SVG is resolution-independent, so "intrinsic size" means its declared aspect. viewBox is the
  // authoritative ratio when present; width/height attributes are a fallback and may carry units.
  // Only the first 4096 bytes are read — the declaration is expected in the opening tag.
  const text = readFileSync(file, 'utf8').slice(0, 4096);
  const viewBox = /viewBox\s*=\s*["']\s*[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(
    text,
  );
  if (viewBox) return { width: Number(viewBox[1]), height: Number(viewBox[2]) };
  const w = /\bwidth\s*=\s*["']([\d.]+)/.exec(text);
  const h = /\bheight\s*=\s*["']([\d.]+)/.exec(text);
  if (w && h) return { width: Number(w[1]), height: Number(h[1]) };
  return undefined;
}

/** Dispatch on the magic bytes. Every branch is individually bounds-checked; see `intrinsicSize`. */
function parse(file: string, b: Buffer): IntrinsicSize | undefined {
  if (b.toString('ascii', 1, 4) === 'PNG') return png(b);
  if (b[0] === 0xff && b[1] === 0xd8) return jpeg(file);
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return webp(b);
  if (b.toString('ascii', 4, 8) === 'ftyp') return avif(file);
  if (file.endsWith('.svg')) return svg(file);
  return undefined;
}

/**
 * Measure `file`, or `undefined` if it cannot be read as an image this reader understands.
 *
 * Measures STORED dimensions from the file header — it does NOT apply EXIF orientation, which a
 * header-only read cannot see. Manifests record ORIENTED dimensions (`optimizeImages` measures
 * them through sharp); re-encoded rungs have orientation baked in, and the escape hatch for an
 * EXIF-rotated master served verbatim is a non-distorting `object-fit`. Where oriented axes
 * matter, consumers also run the sharp-based `verifyImages`.
 *
 * The `try` is a backstop, not the primary defence — every parser above bounds-checks its own
 * reads, and this catch exists so that a format added later, or a corruption nobody predicted,
 * degrades to `undefined` instead of taking down whichever gate is calling.
 *
 * It FAILS CLOSED, which is what makes the catch safe rather than a swallowed error: callers
 * treat `undefined` as a verification FAILURE ("could not be measured — add its format to
 * `src/image/check/dimensions.ts`"), never as a pass. Nothing is silenced; the build still
 * stops, it just stops with the gate's own actionable message instead of a raw stack trace.
 */
export function intrinsicSize(file: string): IntrinsicSize | undefined {
  try {
    const b = head(file, 32);
    if (b.length < 16) return undefined;
    return parse(file, b);
  } catch {
    return undefined;
  }
}

/**
 * Do two sizes describe the same shape?
 *
 * `tolerance` is a fraction of the aspect ratio, defaulting to 1%. Exact equality is the wrong
 * bar: a 976x1100 master and a 320x361 rung are the same picture, but integer rounding at each
 * rung makes their ratios differ in the third decimal. 1% is far below the ~3% at which a stretch
 * starts being visible on a face or a logo, so it separates rounding from distortion without
 * hand-tuning.
 */
export function sameAspect(a: IntrinsicSize, b: IntrinsicSize, tolerance = 0.01): boolean {
  const ra = a.width / a.height;
  const rb = b.width / b.height;
  return Math.abs(ra - rb) / Math.max(ra, rb) <= tolerance;
}

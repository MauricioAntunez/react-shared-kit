import { readFile } from 'node:fs/promises';
import { walkFiles } from './walk.ts';

/**
 * EXIF/XMP/IPTC found in an image file — a metadata *leak*, not a full parse.
 *
 * `kinds` is presence-only (D19): it says which container types were seen, never what they hold.
 * Judging relevance (a GPS tag vs. a harmless colour profile note) needs a decoder, which is
 * exactly the dependency this module exists to avoid — see `../node/verify.ts`'s decoder-based
 * path for that job. `unreadable: true` means the scanner could not tell either way; that is FAILURE,
 * never a silent clean bill (D15) — the incident this module answers to (a shipped master leaking
 * a camera serial in 29.6 KB of untouched XMP) was invisible to every check that treated "could
 * not parse" as "nothing to report".
 */
export interface MetadataLeak {
  /** Filesystem path as joined from the `dir` the caller passed in — not rebased to an id. */
  path: string;
  kinds: string[];
  unreadable: boolean;
}

type Kind = 'exif' | 'xmp' | 'iptc';

const DEFAULT_MATCH = /\.(jpe?g|png|webp|avif)$/i;

/** Recognises a JPEG APP1 EXIF segment: TIFF header immediately follows this exact tag. */
const EXIF_TAG = Buffer.from('Exif\0\0', 'ascii');
/** The XMP namespace URI is the whole of an APP1 XMP segment's identifying prefix. */
const XMP_TAG = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'ascii');

/** What one already-bounds-checked APP1/APP13 payload carries, if anything. */
function jpegSegmentKind(marker: number, payload: Buffer): Kind | undefined {
  if (marker === 0xe1) {
    if (payload.subarray(0, 6).equals(EXIF_TAG)) return 'exif';
    if (payload.subarray(0, 29).equals(XMP_TAG)) return 'xmp';
    return undefined;
  }
  if (marker === 0xed && payload.includes('8BIM')) return 'iptc';
  return undefined;
}

/**
 * One length-prefixed segment at `i` (marker byte and its 0xff already consumed by the caller):
 * where it ends, and what it carries. `undefined` for a length that under-reads (would loop
 * forever) or over-reads past the buffer — both are this format's truncation signal.
 */
function readJpegSegment(
  b: Buffer,
  i: number,
  marker: number,
): { segEnd: number; kind: Kind | undefined } | undefined {
  if (i + 4 > b.length) return undefined;
  const len = b.readUInt16BE(i + 2);
  if (len < 2) return undefined;
  const segEnd = i + 2 + len;
  if (segEnd > b.length) return undefined;
  return { segEnd, kind: jpegSegmentKind(marker, b.subarray(i + 4, segEnd)) };
}

/**
 * JPEG: walk marker segments from SOI, looking only at APP1 (EXIF/XMP) and APP13 (Photoshop
 * IPTC) — the same segment-walk idiom `dimensions.ts` uses for SOF, stopped at SOS/EOI because
 * entropy-coded scan data is not made of markers. `undefined` covers every way this walk can fail
 * to reach a real end: a non-marker byte where one was expected, a segment whose declared length
 * runs past the buffer, or running out of bytes before SOS/EOI — each is a truncation this format
 * cannot self-report, so it fails closed rather than reporting whatever partial `kinds` it saw.
 */
function jpegMarkers(b: Buffer): Set<Kind> | undefined {
  const kinds = new Set<Kind>();
  let i = 2; // past SOI
  while (i + 2 <= b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1] as number;
    if (marker === 0xd8) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return kinds; // EOI / SOS: header segments are done
    const seg = readJpegSegment(b, i, marker);
    if (seg === undefined) return undefined;
    if (seg.kind !== undefined) kinds.add(seg.kind);
    i = seg.segEnd;
  }
  return undefined; // ran out of bytes without reaching SOS/EOI: truncated
}

/** The first null-terminated field of a PNG text chunk's payload — its keyword, always first. */
function textKeyword(data: Buffer): string {
  const nul = data.indexOf(0);
  return nul === -1 ? data.toString('latin1') : data.toString('latin1', 0, nul);
}

/**
 * What a `tEXt`/`zTXt`/`iTXt` chunk's keyword names, if anything — XMP and the ImageMagick IPTC
 * convention both ride in text chunks, compressed or not, so all three chunk types are checked;
 * the keyword itself is never compressed.
 */
function pngTextKind(type: string, data: Buffer): Kind | undefined {
  if (type !== 'tEXt' && type !== 'zTXt' && type !== 'iTXt') return undefined;
  const keyword = textKeyword(data);
  if (keyword === 'XML:com.adobe.xmp') return 'xmp';
  if (/raw profile type.*iptc/i.test(keyword)) return 'iptc';
  return undefined;
}

/**
 * PNG: walk chunks from after the signature, looking at `eXIf` and every text chunk's keyword.
 * Reaching `IEND` is the only way this function calls itself successful: without it, a truncated
 * chunk declaring a length beyond the buffer, or a file cut off before `IEND` ever appears, both
 * fail closed the same way a real decoder would refuse to render the image at all.
 */
function pngMarkers(b: Buffer): Set<Kind> | undefined {
  const kinds = new Set<Kind>();
  let pos = 8; // past the 8-byte signature
  while (pos + 8 <= b.length) {
    const len = b.readUInt32BE(pos);
    const type = b.toString('ascii', pos + 4, pos + 8);
    const dataStart = pos + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > b.length) return undefined; // data + CRC truncated
    if (type === 'eXIf') kinds.add('exif');
    else {
      const kind = pngTextKind(type, b.subarray(dataStart, dataEnd));
      if (kind !== undefined) kinds.add(kind);
    }
    pos = dataEnd + 4;
    if (type === 'IEND') return kinds;
  }
  return undefined; // never reached IEND: truncated
}

/**
 * WebP: a RIFF container. Chunks below the top `RIFF`/size/`WEBP` header are `fourcc` + LE size +
 * data, padded to an even boundary. The declared RIFF size is checked against the actual buffer
 * length up front — a file cut off mid-chunk is the truncation case this format needs to fail
 * closed on, matching `dimensions.ts`'s WebP branch guarding every read before making it.
 */
function webpMarkers(b: Buffer): Set<Kind> | undefined {
  const declaredEnd = b.readUInt32LE(4) + 8;
  if (declaredEnd > b.length) return undefined;
  const kinds = new Set<Kind>();
  let pos = 12; // past 'RIFF' + size + 'WEBP'
  while (pos + 8 <= declaredEnd) {
    const fourcc = b.toString('ascii', pos, pos + 4);
    const size = b.readUInt32LE(pos + 4);
    const dataEnd = pos + 8 + size;
    if (dataEnd > declaredEnd) return undefined; // chunk truncated
    if (fourcc === 'EXIF') kinds.add('exif');
    else if (fourcc === 'XMP ') kinds.add('xmp');
    pos = dataEnd + (size % 2); // chunks pad to an even size
  }
  return kinds;
}

/**
 * The end offset of one ISOBMFF box starting at `pos`, honouring the 32-bit `size` already read
 * there plus its rare 64-bit and "extends to EOF" forms. `undefined` only for the 64-bit form
 * whose own extra size field is itself truncated — the ordinary bounds check happens in the
 * caller, which also has to reject a size of `0`/`1` producing a non-advancing box.
 */
function avifBoxEnd(b: Buffer, pos: number, size: number): number | undefined {
  if (size === 1) {
    if (pos + 16 > b.length) return undefined;
    return pos + Number(b.readBigUInt64BE(pos + 8));
  }
  if (size === 0) return b.length; // box extends to end of file
  return pos + size;
}

/**
 * Item markers found directly in a `meta` box's raw bytes — a substring lookup for the item-type
 * tag (`Exif`) and the XMP mime type (`application/rdf+xml`), the same style as `dimensions.ts`'s
 * `ispe` search rather than a full `iinf`/`iloc` item-tree walk. Presence detection, not a parse
 * (D19's own limitation).
 */
function avifMetaKinds(meta: Buffer): Kind[] {
  const kinds: Kind[] = [];
  if (meta.includes('Exif', 0, 'ascii')) kinds.push('exif');
  if (meta.includes('application/rdf+xml', 0, 'ascii')) kinds.push('xmp');
  return kinds;
}

/** What one box (already sliced to its own bytes) contributes — only `meta` boxes carry markers. */
function avifBoxKinds(type: string, box: Buffer): Kind[] {
  return type === 'meta' ? avifMetaKinds(box) : [];
}

/**
 * AVIF: ISOBMFF. The top-level box walk bounds-checks every box (including the rare 64-bit size
 * form) so a truncated file is distinguished from a genuinely metadata-free one; `ftyp` must be
 * seen for this to count as a real ISOBMFF file at all.
 */
function avifMarkers(b: Buffer): Set<Kind> | undefined {
  const kinds = new Set<Kind>();
  let pos = 0;
  let sawFtyp = false;
  while (pos + 8 <= b.length) {
    const size = b.readUInt32BE(pos);
    const type = b.toString('ascii', pos + 4, pos + 8);
    const boxEnd = avifBoxEnd(b, pos, size);
    if (boxEnd === undefined || boxEnd > b.length || boxEnd <= pos) return undefined;
    if (type === 'ftyp') sawFtyp = true;
    for (const kind of avifBoxKinds(type, b.subarray(pos, boxEnd))) kinds.add(kind);
    if (size === 0) break;
    pos = boxEnd;
  }
  return sawFtyp ? kinds : undefined;
}

/** Dispatch on magic bytes, mirroring `dimensions.ts`'s `parse`. Unrecognised ⇒ fail closed. */
function detect(b: Buffer): Set<Kind> | undefined {
  if (b.length < 12) return undefined;
  if (b.toString('ascii', 1, 4) === 'PNG') return pngMarkers(b);
  if (b[0] === 0xff && b[1] === 0xd8) return jpegMarkers(b);
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    return webpMarkers(b);
  }
  if (b.toString('ascii', 4, 8) === 'ftyp') return avifMarkers(b);
  return undefined;
}

async function scanFile(path: string): Promise<MetadataLeak | undefined> {
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch {
    return { path, kinds: [], unreadable: true };
  }
  const kinds = detect(buf);
  if (kinds === undefined) return { path, kinds: [], unreadable: true };
  if (kinds.size === 0) return undefined; // parsed fine, nothing to report: not a leak
  return { path, kinds: [...kinds], unreadable: false };
}

/**
 * Recursively scan `dir` for images carrying EXIF/XMP/IPTC, detected by container structure
 * without decoding (D19). Returns only files with something to report — a leak (`kinds.length >
 * 0`) or a parse failure (`unreadable: true`); a file that parses cleanly with no markers is
 * absent from the result, not present with an empty `kinds`.
 *
 * Directory listing (`walkFiles`, `onReaddirError: 'throw'` — the default) is NOT swallowed,
 * matching `findMasters` (D15): a scan that silently returns fewer leaks than exist is
 * indistinguishable from a clean tree. The walk itself is synchronous (shared with `html.ts`/
 * `tree.ts` via `walk.ts`); only the per-file read+parse below is async, and stays sequential
 * (not `Promise.all`) to match this function's original one-file-at-a-time order exactly.
 */
export async function scanMetadataLeaks(
  dir: string,
  options?: { match?: RegExp },
): Promise<MetadataLeak[]> {
  const match = options?.match ?? DEFAULT_MATCH;
  const files = walkFiles(dir, { filter: (name) => match.test(name) });
  const leaks: MetadataLeak[] = [];
  for (const file of files) {
    const leak = await scanFile(file);
    if (leak !== undefined) leaks.push(leak);
  }
  return leaks;
}

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanMetadataLeaks } from './metadata.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'uxr-metadata-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function put(name: string, data: Buffer): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, data);
  return p;
}

// --- Hand-built fixtures (Buffer only, no sharp) -----------------------------------------------

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const len = payload.length + 2;
  return Buffer.concat([Buffer.from([0xff, marker, len >> 8, len & 0xff]), payload]);
}

function jpegFixture(...segments: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8]), ...segments, Buffer.from([0xff, 0xd9])]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]); // CRC unchecked
}

function pngIhdr(): Buffer {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(1, 0);
  b.writeUInt32BE(1, 4);
  b[8] = 8; // bit depth
  b[9] = 2; // colour type: truecolour
  return b;
}

function pngFixture(...chunks: Buffer[]): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    pngChunk('IHDR', pngIhdr()),
    ...chunks,
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function riffChunk(fourcc: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, 'ascii');
  head.writeUInt32LE(data.length, 4);
  const pad = data.length % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0);
  return Buffer.concat([head, data, pad]);
}

function webpFixture(...chunks: Buffer[]): Buffer {
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(4 + body.length, 4); // covers 'WEBP' + chunks, not the RIFF header itself
  header.write('WEBP', 8, 'ascii');
  return Buffer.concat([header, body]);
}

function isobmffBox(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, payload]);
}

function avifFixture(...boxes: Buffer[]): Buffer {
  return Buffer.concat(boxes);
}

const ftypBox = isobmffBox('ftyp', Buffer.from('avifavifmif1miaf', 'ascii'));

describe('scanMetadataLeaks — JPEG (hand-built)', () => {
  it('flags an APP1 EXIF segment', async () => {
    await put('a.jpg', jpegFixture(jpegSegment(0xe1, Buffer.from('Exif\0\0\0\0', 'ascii'))));
    const leaks = await scanMetadataLeaks(dir);
    expect(leaks).toHaveLength(1);
    expect(leaks[0]).toMatchObject({ kinds: ['exif'], unreadable: false });
  });

  it('flags an APP1 XMP segment by its namespace URI', async () => {
    const payload = Buffer.concat([
      Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'ascii'),
      Buffer.from('<x:xmpmeta/>', 'ascii'),
    ]);
    await put('a.jpg', jpegFixture(jpegSegment(0xe1, payload)));
    const leaks = await scanMetadataLeaks(dir);
    expect(leaks[0]?.kinds).toEqual(['xmp']);
  });

  it('flags an APP13 Photoshop/8BIM segment as iptc', async () => {
    const payload = Buffer.from('Photoshop 3.0\x008BIM\x04\x04', 'ascii');
    await put('a.jpg', jpegFixture(jpegSegment(0xed, payload)));
    const leaks = await scanMetadataLeaks(dir);
    expect(leaks[0]?.kinds).toEqual(['iptc']);
  });

  it('reports nothing for a clean JPEG', async () => {
    await put('clean.jpg', jpegFixture(jpegSegment(0xdb, Buffer.alloc(4))));
    expect(await scanMetadataLeaks(dir)).toEqual([]);
  });

  it('fails closed on a truncated APP1 segment (declared length beyond the buffer)', async () => {
    // A segment header claiming a 200-byte payload but only 4 bytes actually follow.
    const truncated = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0xc8]),
      Buffer.from('Exif', 'ascii'),
    ]);
    await put('bad.jpg', truncated);
    const leaks = await scanMetadataLeaks(dir);
    expect(leaks).toEqual([{ path: join(dir, 'bad.jpg'), kinds: [], unreadable: true }]);
  });
});

describe('scanMetadataLeaks — PNG (hand-built)', () => {
  it('flags an eXIf chunk', async () => {
    await put('a.png', pngFixture(pngChunk('eXIf', Buffer.from('II*\0junk', 'ascii'))));
    const leaks = await scanMetadataLeaks(dir);
    expect(leaks[0]?.kinds).toEqual(['exif']);
  });

  it('flags a tEXt XMP chunk by its exact keyword', async () => {
    const data = Buffer.concat([
      Buffer.from('XML:com.adobe.xmp', 'ascii'),
      Buffer.from([0]),
      Buffer.from('<x:xmpmeta/>', 'ascii'),
    ]);
    await put('a.png', pngFixture(pngChunk('tEXt', data)));
    expect((await scanMetadataLeaks(dir))[0]?.kinds).toEqual(['xmp']);
  });

  it('flags the ImageMagick "Raw profile type: iptc" keyword even when compressed (zTXt)', async () => {
    const data = Buffer.concat([
      Buffer.from('Raw profile type: iptc', 'ascii'),
      Buffer.from([0, 0]), // compression method byte + start of (unparsed) compressed data
    ]);
    await put('a.png', pngFixture(pngChunk('zTXt', data)));
    expect((await scanMetadataLeaks(dir))[0]?.kinds).toEqual(['iptc']);
  });

  it('reports nothing for a clean PNG', async () => {
    await put('clean.png', pngFixture(pngChunk('pHYs', Buffer.alloc(9))));
    expect(await scanMetadataLeaks(dir)).toEqual([]);
  });

  it('fails closed on a truncated chunk (no IEND, declared length beyond the buffer)', async () => {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = pngChunk('IHDR', pngIhdr());
    const lenOnly = Buffer.alloc(4);
    lenOnly.writeUInt32BE(198, 0); // declares 198 bytes; none follow
    const truncated = Buffer.concat([sig, ihdr, lenOnly, Buffer.from('eXIf', 'ascii')]);
    await put('bad.png', truncated);
    expect(await scanMetadataLeaks(dir)).toEqual([
      { path: join(dir, 'bad.png'), kinds: [], unreadable: true },
    ]);
  });
});

describe('scanMetadataLeaks — WebP (hand-built)', () => {
  it('flags an EXIF RIFF chunk', async () => {
    await put('a.webp', webpFixture(riffChunk('EXIF', Buffer.from('junk', 'ascii'))));
    expect((await scanMetadataLeaks(dir))[0]?.kinds).toEqual(['exif']);
  });

  it('flags an "XMP " RIFF chunk', async () => {
    await put('a.webp', webpFixture(riffChunk('XMP ', Buffer.from('<x:xmpmeta/>', 'ascii'))));
    expect((await scanMetadataLeaks(dir))[0]?.kinds).toEqual(['xmp']);
  });

  it('reports nothing for a clean WebP', async () => {
    await put('clean.webp', webpFixture(riffChunk('VP8 ', Buffer.alloc(10))));
    expect(await scanMetadataLeaks(dir)).toEqual([]);
  });

  it('fails closed when the declared RIFF size overruns the buffer', async () => {
    const header = Buffer.alloc(12);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(9999, 4); // wildly beyond the real file
    header.write('WEBP', 8, 'ascii');
    await put('bad.webp', header);
    expect(await scanMetadataLeaks(dir)).toEqual([
      { path: join(dir, 'bad.webp'), kinds: [], unreadable: true },
    ]);
  });
});

describe('scanMetadataLeaks — AVIF (hand-built)', () => {
  it('flags an Exif item type inside the meta box', async () => {
    const meta = isobmffBox('meta', Buffer.from('....Exif....', 'ascii'));
    await put('a.avif', avifFixture(ftypBox, meta));
    expect((await scanMetadataLeaks(dir))[0]?.kinds).toEqual(['exif']);
  });

  it('flags an application/rdf+xml mime item inside the meta box (XMP)', async () => {
    const meta = isobmffBox('meta', Buffer.from('..application/rdf+xml..', 'ascii'));
    await put('a.avif', avifFixture(ftypBox, meta));
    expect((await scanMetadataLeaks(dir))[0]?.kinds).toEqual(['xmp']);
  });

  it('reports nothing for a clean AVIF', async () => {
    const meta = isobmffBox('meta', Buffer.from('nothing of interest here', 'ascii'));
    await put('clean.avif', avifFixture(ftypBox, meta));
    expect(await scanMetadataLeaks(dir)).toEqual([]);
  });

  it('fails closed when a box declares a size beyond the buffer', async () => {
    const brokenMeta = Buffer.alloc(8);
    brokenMeta.writeUInt32BE(500, 0); // claims 500 bytes; the file has none of them
    brokenMeta.write('meta', 4, 'ascii');
    await put('bad.avif', Buffer.concat([ftypBox, brokenMeta]));
    expect(await scanMetadataLeaks(dir)).toEqual([
      { path: join(dir, 'bad.avif'), kinds: [], unreadable: true },
    ]);
  });
});

describe('scanMetadataLeaks — cross-format behaviour', () => {
  it('treats a zero-byte file as unreadable', async () => {
    await put('empty.png', Buffer.alloc(0));
    expect(await scanMetadataLeaks(dir)).toEqual([
      { path: join(dir, 'empty.png'), kinds: [], unreadable: true },
    ]);
  });

  it('ignores files that do not match the default extension pattern', async () => {
    await put('notes.txt', Buffer.from('Exif\0\0 pretend this is metadata', 'ascii'));
    expect(await scanMetadataLeaks(dir)).toEqual([]);
  });

  it('recurses into subdirectories', async () => {
    await mkdir(join(dir, 'nested', 'deeper'), { recursive: true });
    await writeFile(
      join(dir, 'nested', 'deeper', 'a.jpg'),
      jpegFixture(jpegSegment(0xe1, Buffer.from('Exif\0\0\0\0', 'ascii'))),
    );
    const leaks = await scanMetadataLeaks(dir);
    expect(leaks).toEqual([
      { path: join(dir, 'nested', 'deeper', 'a.jpg'), kinds: ['exif'], unreadable: false },
    ]);
  });

  it('honours a custom match pattern', async () => {
    await put('a.jpeg', jpegFixture(jpegSegment(0xe1, Buffer.from('Exif\0\0\0\0', 'ascii'))));
    expect(await scanMetadataLeaks(dir, { match: /\.png$/ })).toEqual([]);
  });
});

// --- Oracle-based fixtures (sharp encodes; shipped code never imports it) ----------------------

describe('scanMetadataLeaks — agrees with sharp().metadata() as oracle', () => {
  const formats = ['jpeg', 'png', 'webp', 'avif'] as const;

  it.each(formats)('%s: with and without embedded EXIF/XMP', async (format) => {
    const withMeta = join(dir, `with.${format}`);
    const stripped = join(dir, `stripped.${format}`);
    const pipeline = () =>
      sharp({ create: { width: 20, height: 10, channels: 3, background: '#336699' } });

    await pipeline()
      .withExif({ IFD0: { Software: 'react-shared-kit-test' } })
      .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"></x:xmpmeta>')
      [format]()
      .toFile(withMeta);
    await pipeline()[format]().toFile(stripped);

    const oracle = await sharp(withMeta).metadata();
    expect(Boolean(oracle.exif)).toBe(true);
    expect(Boolean(oracle.xmp)).toBe(true);

    const leaks = await scanMetadataLeaks(dir, { match: new RegExp(`\\.${format}$`) });
    const withLeak = leaks.find((l) => l.path === withMeta);
    const strippedLeak = leaks.find((l) => l.path === stripped);

    expect(withLeak).toBeDefined();
    expect(withLeak?.unreadable).toBe(false);
    expect(withLeak?.kinds).toEqual(expect.arrayContaining(['exif', 'xmp']));
    expect(strippedLeak).toBeUndefined(); // sharp strips metadata by default: nothing to report
  });
});

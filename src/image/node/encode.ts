import {
  applyTransforms,
  builtinOutputFormats,
  builtins,
  generateTransforms,
  resolveConfigs,
} from 'imagetools-core';
import sharp from 'sharp';

export type EncodeFormat = 'avif' | 'webp' | 'jpeg';

export interface EncodedImage {
  data: Buffer;
  /** MEASURED output width — never the requested width (D10 mechanism 3). */
  width: number;
  height: number;
}

/**
 * No-upscale is enforced by imagetools-core's `resize` transform itself: its `allowUpscale`
 * directive defaults to `false` when omitted, which clamps the output back to the master's
 * intrinsic dimensions whenever the requested width/height would exceed them. There is no
 * `withoutEnlargement` directive in imagetools-core (that name is sharp's own resize option) —
 * `resize` already calls `image.resize({ ..., withoutEnlargement: !allowUpscale, ... })`
 * internally, so simply never sending `allowUpscale: 'true'` is the correct, sufficient guard.
 */
export async function encodeOne(
  input: string,
  width: number,
  format: EncodeFormat,
  quality: number,
): Promise<EncodedImage> {
  const entries: Array<[string, string[]]> = [
    ['w', [String(width)]],
    ['format', [format]],
    ['quality', [String(quality)]],
  ];
  const configs = resolveConfigs(entries, builtinOutputFormats);
  const config = configs[0];
  if (!config) throw new Error(`encodeOne: no config resolved for ${input} @${width} ${format}`);
  const { transforms } = generateTransforms(config, builtins, new URLSearchParams());
  const { image } = await applyTransforms(transforms, sharp(input));
  const { data, info } = await image.toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

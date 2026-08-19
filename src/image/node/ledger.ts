import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Rung } from '../types.ts';
import type { Inversion } from './optimize.ts';

export interface LedgerEntry {
  sha256: string;
  params: string;
  outputs: string[];
  /**
   * The MEASURED rungs written on the last encode (D10 mechanism 3).
   *
   * Persisted so a skipped master replays measured widths instead of re-deriving them from the
   * requested ladder. Optional only for backward compatibility with a ledger written before this
   * field existed; `optimizeImages` measures from disk when it is absent.
   */
  rungs?: Rung[];
  /**
   * Inversions recorded on the last encode, replayed for skipped masters.
   *
   * Without this, `OptimizeResult.inversions` empties out on every incremental run and a CI gate
   * on it passes vacuously — green forever on a warm cache while oversized AVIFs keep shipping.
   */
  inversions?: Inversion[];
}

export type Ledger = Record<string, LedgerEntry>;

export async function fileSha256(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * A stable key for everything that affects the OUTPUT but is not the input bytes.
 * Keys are sorted so an object-literal reordering never invalidates a cache.
 */
export function paramsKey(input: {
  class: string;
  widths: readonly number[];
  formats: Record<string, number>;
}): string {
  const formats = Object.keys(input.formats)
    .sort()
    .map((k) => `${k}:${input.formats[k]}`)
    .join(',');
  return `${input.class}|${[...input.widths].join(';')}|${formats}`;
}

/**
 * Work is skipped only when ALL THREE hold: content hash matches, generation params match, and
 * every recorded output is still on disk.
 *
 * Keying on content rather than mtime (D6) is what makes a checkout or branch switch free — those
 * rewrite mtimes without changing bytes. Including params is what makes a quality change or a new
 * rung re-encode. Checking outputs is what makes a deleted derivative come back.
 */
export function needsEncode(args: {
  entry: LedgerEntry | undefined;
  sha256: string;
  params: string;
  outputsExist: (file: string) => boolean;
}): boolean {
  const { entry, sha256, params, outputsExist } = args;
  if (!entry) return true;
  if (entry.sha256 !== sha256) return true;
  if (entry.params !== params) return true;
  return !entry.outputs.every(outputsExist);
}

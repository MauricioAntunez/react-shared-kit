import { type Dirent, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Shared recursive directory walker, extracted from three near-identical copies that grew
 * independently in `html.ts`, `tree.ts`, and `metadata.ts` (the project CLAUDE.md's "3+
 * occurrences: MUST refactor" rule). The three were not IDENTICAL, so this does not just delete
 * two of them — it keeps their real differences as explicit options instead of flattening them:
 *
 * - `tree.ts`'s original walker caught a `readdirSync` failure per-subtree and returned `[]` for
 *   just that subtree (deliberate: an unreadable/missing directory there is already reported by a
 *   different check, so the walk must not abort the rest of the tree over it). `html.ts` and
 *   `metadata.ts` both let a `readdir` failure propagate (fail-closed, D15 — a walk that silently
 *   returns fewer files than exist is indistinguishable from a clean tree). Default here is
 *   `'throw'`; `tree.ts` opts into `'skip'`.
 * - `html.ts`'s original walker used `readdirSync(dir)` (names only) + `statSync` per entry, which
 *   FOLLOWS symlinks — a symlinked subdirectory was recursed into, a symlinked file was matched by
 *   name. `tree.ts` and `metadata.ts` both used `readdirSync(dir, { withFileTypes: true })`, whose
 *   `Dirent` is lstat-based and does NOT follow symlinks — a symlink is neither file nor directory
 *   to them. No existing test exercises this edge, but changing it silently would be exactly the
 *   kind of behaviour drift this whole toolkit exists to prevent. `followSymlinks` preserves both:
 *   default `false` (Dirent semantics), `html.ts` passes `true`.
 */
export interface WalkFilesOptions {
  /** Only files for which this returns true are included. Default: every file. */
  filter?: (name: string, absPath: string) => boolean;
  /**
   * `'throw'` (default) propagates a `readdirSync` failure — matches `html.ts`/`metadata.ts`'s
   * original fail-closed behaviour. `'skip'` catches it and treats that directory as empty,
   * matching `tree.ts`'s original behaviour for a directory whose absence is reported elsewhere.
   */
  onReaddirError?: 'throw' | 'skip';
  /** Default `false`: a symlink is neither a file nor a directory (lstat/`Dirent` semantics,
   * matching `tree.ts`/`metadata.ts`'s original walkers). Pass `true` to follow symlinks via
   * `statSync`, matching `html.ts`'s original walker. */
  followSymlinks?: boolean;
}

/** `followSymlinks: true` mode — ported verbatim from `html.ts`'s original `findFiles`: names via
 * plain `readdirSync`, classified with `statSync` (follows symlinks), no `isFile` check on the
 * non-directory branch (matches the original exactly: anything not a directory whose name passes
 * `filter` is included, whatever its actual type). */
function walkFollowingSymlinks(dir: string, options: WalkFilesOptions): string[] {
  const { filter } = options;
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkFollowingSymlinks(full, options));
    else if (filter === undefined || filter(name, full)) out.push(full);
  }
  return out;
}

/** Default mode — ported from `tree.ts`'s original `walkFiles` / `metadata.ts`'s original `walk`:
 * `Dirent`-based, does not follow symlinks, recognises only real directories and real files. */
function walkDirentBased(dir: string, options: WalkFilesOptions): string[] {
  const { filter, onReaddirError = 'throw' } = options;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (onReaddirError === 'skip') return [];
    throw err;
  }
  const out: string[] = [];
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkDirentBased(abs, options));
      continue;
    }
    if (!entry.isFile()) continue;
    if (filter === undefined || filter(entry.name, abs)) out.push(abs);
  }
  return out;
}

/** Recursively lists every matching file's absolute path under `dir`, depth-first. Synchronous —
 * all three original walkers did their directory listing synchronously; `metadata.ts`'s async
 * work (reading file contents) happens after collection, not during the walk (see its call site). */
export function walkFiles(dir: string, options: WalkFilesOptions = {}): string[] {
  return options.followSymlinks === true
    ? walkFollowingSymlinks(dir, options)
    : walkDirentBased(dir, options);
}

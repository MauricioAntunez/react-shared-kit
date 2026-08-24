import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Whether `entryPath` and `modulePath` refer to the SAME file, resolving symlinks on BOTH sides
 * before comparing (ported from boufin's `scripts/lib/entry.ts`, D21).
 *
 * `process.argv[1]` is absolutised but NOT realpath'd; `fileURLToPath(import.meta.url)` IS
 * realpath'd by Node. Comparing them raw (`process.argv[1] === fileURLToPath(import.meta.url)`)
 * silently breaks the moment any component of the path to the script is a symlink: the two
 * strings differ, the entry-point check goes false, and the gate's `main()` never runs — the
 * module falls off the end having verified nothing, with zero output, exit code 0. A
 * `package.json` script chained with `&&` reads a silently-skipped gate as a passing one.
 * Reproduced in boufin: same tree, reached once through a direct path (exit 1 on a real
 * violation) and once through a symlinked path to that same file (exit 0, zero bytes of output).
 */
export function isSameEntryModule(entryPath: string, modulePath: string): boolean {
  return realpathSync(entryPath) === realpathSync(modulePath);
}

/**
 * Builds one script's own `isEntryPoint(argv1, moduleUrl)` check, closing over `scriptName` so the
 * "no entry point" error names the calling script — the name is how a silent skip gets diagnosed,
 * so it must survive sharing one implementation across scripts.
 */
export function makeEntryPointCheck(
  scriptName: string,
): (argv1: string | undefined, moduleUrl: string) => boolean {
  return (argv1, moduleUrl) => {
    if (argv1 === undefined) {
      throw new Error(`${scriptName}: no entry point in process.argv[1]`);
    }
    return isSameEntryModule(argv1, fileURLToPath(moduleUrl));
  };
}

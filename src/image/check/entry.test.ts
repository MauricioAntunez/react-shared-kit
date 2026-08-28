import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isSameEntryModule, makeEntryPointCheck } from './entry.ts';

const moduleUrl = new URL('./entry.ts', import.meta.url);
const modulePath = fileURLToPath(moduleUrl);

describe('isSameEntryModule', () => {
  it('is true for the same file reached through a symlinked path — the regression this module exists to fix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uxr-entry-symlink-'));
    const linkPath = join(dir, 'entry.ts');
    try {
      symlinkSync(modulePath, linkPath);
      // The symlink path and the real path are different strings — a raw `===` comparison (the
      // defect this function exists to fix) would report `false` here and let the caller skip its
      // gate silently, with zero output and exit code 0.
      expect(linkPath).not.toBe(modulePath);
      expect(isSameEntryModule(linkPath, modulePath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is false for genuinely different files', () => {
    const otherPath = fileURLToPath(new URL('./entry.test.ts', import.meta.url));
    expect(isSameEntryModule(otherPath, modulePath)).toBe(false);
  });

  it('propagates realpathSync failure for a path that does not exist', () => {
    expect(() =>
      isSameEntryModule(join(modulePath, '..', 'does-not-exist.ts'), modulePath),
    ).toThrow();
  });
});

describe('makeEntryPointCheck', () => {
  const isThisEntryPoint = makeEntryPointCheck('entry.test.ts');

  it('resolves true when the entry is reached through a symlinked path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uxr-entry-check-symlink-'));
    const linkPath = join(dir, 'entry.ts');
    try {
      symlinkSync(modulePath, linkPath);
      expect(isThisEntryPoint(linkPath, moduleUrl.href)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves false for genuinely different files', () => {
    const otherPath = fileURLToPath(new URL('./entry.test.ts', import.meta.url));
    expect(isThisEntryPoint(otherPath, moduleUrl.href)).toBe(false);
  });

  it('throws when argv[1] is undefined, rather than silently reporting "not the entry point"', () => {
    expect(() => isThisEntryPoint(undefined, moduleUrl.href)).toThrow(
      'entry.test.ts: no entry point in process.argv[1]',
    );
  });
});

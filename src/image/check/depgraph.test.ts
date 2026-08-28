import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * D22: the property this whole subpath exists to guarantee — `./check` runs with zero native
 * binaries — protected as a test that goes red the moment the invariant breaks, the way this
 * repo protects every other load-bearing invariant.
 *
 * Scoped to IMPLEMENTATION files only (`*.ts`, excluding `*.test.ts`). `metadata.test.ts`
 * deliberately imports `sharp` as a test ORACLE (it encodes fixtures with sharp and asserts this
 * module's sharp-free reader agrees with `sharp().metadata()`) — that is correct, sharp is a
 * devDependency for exactly that purpose, and this guard must not flag it. Do not "fix" that by
 * widening the glob to test files; the exception is deliberate, not an oversight.
 */
const CHECK_DIR = new URL('.', import.meta.url).pathname;

const FORBIDDEN_IMPORTS = ['sharp', 'imagetools-core', 'react'];

/** Matches an ES import/export `from '...'` or a bare `import '...'` specifier. */
const IMPORT_SPECIFIER_RE = /(?:from|import)\s+['"]([^'"]+)['"]/g;

function implementationFiles(): string[] {
  return readdirSync(CHECK_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => join(CHECK_DIR, name));
}

function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(IMPORT_SPECIFIER_RE)].map((match) => match[1] as string);
}

describe('src/image/check — dependency graph guard (D22)', () => {
  const files = implementationFiles();

  it('finds implementation files to check (a guard over an empty set proves nothing)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((file) => [file] as const))(
    '%s imports neither sharp, imagetools-core, nor react',
    (file) => {
      const imports = importsOf(file);
      for (const forbidden of FORBIDDEN_IMPORTS) {
        expect(imports).not.toContain(forbidden);
      }
    },
  );

  it.each(files.map((file) => [file] as const))(
    '%s imports nothing from ../node/ other than scanfs.ts',
    (file) => {
      const nodeImports = importsOf(file).filter((spec) => spec.startsWith('../node/'));
      for (const spec of nodeImports) {
        expect(spec).toBe('../node/scanfs.ts');
      }
    },
  );

  it('scanfs.ts itself imports neither sharp nor imagetools-core', () => {
    const scanfs = new URL('../node/scanfs.ts', import.meta.url).pathname;
    const imports = importsOf(scanfs);
    expect(imports).not.toContain('sharp');
    expect(imports).not.toContain('imagetools-core');
  });
});

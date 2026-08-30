import { describe, expect, it } from 'vitest';
import { isFsError } from './errors.ts';

/**
 * Direct unit tests of the shared discriminator, since it is what every gate's `catch` delegates
 * to — proving it here proves the integration in `fontChain.ts`, `cssBudget.ts`, and `headers.ts`
 * by construction, without needing to mock `node:fs` in three different places.
 *
 * `ERR_FS_FILE_TOO_LARGE` (round 3 review Finding A) is proven with a CONSTRUCTED error object
 * carrying that shape, not an actual >2GiB file on disk — the review explicitly asked for this
 * ("mock the throw, do not create a 2GB file").
 */

/** Builds an object matching Node's `NodeJS.ErrnoException` shape without needing a real
 * filesystem call to produce it. */
function errnoException(
  ctor: typeof Error | typeof TypeError | typeof RangeError,
  code: string,
  message: string,
): NodeJS.ErrnoException {
  const error = new ctor(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe('isFsError', () => {
  it('accepts a genuine POSIX fs error (ENOENT)', () => {
    expect(isFsError(errnoException(Error, 'ENOENT', 'no such file or directory'))).toBe(true);
  });

  it('accepts a genuine POSIX fs error (EACCES)', () => {
    expect(isFsError(errnoException(Error, 'EACCES', 'permission denied'))).toBe(true);
  });

  it('accepts ERR_FS_FILE_TOO_LARGE — a genuine fs condition despite the ERR_ prefix (round 3 Finding A)', () => {
    // The reproduction: readFileSync on a file over ~2GiB throws exactly this shape. Round 2's
    // fix excluded EVERY `ERR_`-prefixed code, which wrongly rejected this one too — an oversized
    // stylesheet would have crashed the gate instead of being reported.
    const error = errnoException(
      RangeError,
      'ERR_FS_FILE_TOO_LARGE',
      'File size (2200000000) is greater than 2 GiB',
    );
    expect(isFsError(error)).toBe(true);
  });

  it('accepts ERR_FS_EISDIR — another genuine Node fs-layer code with the ERR_ prefix', () => {
    expect(
      isFsError(errnoException(Error, 'ERR_FS_EISDIR', 'illegal operation on a directory')),
    ).toBe(true);
  });

  it('rejects ERR_INVALID_ARG_TYPE — a caller contract violation, not a filesystem fact', () => {
    const error = errnoException(TypeError, 'ERR_INVALID_ARG_TYPE', 'wrong type');
    expect(isFsError(error)).toBe(false);
  });

  it('rejects ERR_INVALID_ARG_VALUE — same contract-violation class', () => {
    const error = errnoException(TypeError, 'ERR_INVALID_ARG_VALUE', 'invalid value');
    expect(isFsError(error)).toBe(false);
  });

  it('rejects a stack-overflow RangeError, which carries no .code at all', () => {
    function recurse(): never {
      return recurse();
    }
    let caught: unknown;
    try {
      recurse();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RangeError);
    expect(isFsError(caught)).toBe(false);
  });

  it('rejects a non-Error thrown value', () => {
    expect(isFsError('a plain string was thrown')).toBe(false);
    expect(isFsError({ code: 'ENOENT' })).toBe(false);
  });
});

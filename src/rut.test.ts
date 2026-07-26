import { describe, expect, it } from 'vitest';
import { formatRut, isValidRut } from './rut.ts';

// Anchors: both are widely published as valid RUTs, so they check the algorithm
// against something other than this implementation's own output.
const VALID_PLAIN = '123456785';
const VALID_FORMATTED = '12.345.678-5';

describe('isValidRut', () => {
  it('accepts a known-valid RUT, formatted or bare', () => {
    expect(isValidRut(VALID_FORMATTED)).toBe(true);
    expect(isValidRut(VALID_PLAIN)).toBe(true);
    expect(isValidRut('11.111.111-1')).toBe(true);
  });

  it('accepts a K check digit in either case', () => {
    expect(isValidRut('12.345.670-K')).toBe(true);
    expect(isValidRut('12.345.670-k')).toBe(true);
  });

  it('rejects a wrong check digit', () => {
    expect(isValidRut('12.345.678-4')).toBe(false);
    expect(isValidRut('11.111.111-2')).toBe(false);
  });

  it('rejects a K in the body', () => {
    expect(isValidRut('1K.345.678-5')).toBe(false);
  });

  it('rejects non-numeric bodies and stray characters', () => {
    expect(isValidRut('abc-5')).toBe(false);
    expect(isValidRut('12.345.67a-5')).toBe(false);
    expect(isValidRut('12,345,678-5')).toBe(false);
  });

  it('rejects inputs too short to carry a check digit', () => {
    expect(isValidRut('')).toBe(false);
    expect(isValidRut('5')).toBe(false);
    expect(isValidRut('-')).toBe(false);
  });

  it('ignores surrounding and interior whitespace', () => {
    expect(isValidRut('  12.345.678-5  ')).toBe(true);
    expect(isValidRut('12 345 678 5')).toBe(true);
  });

  it('treats 0 as the check digit when the remainder is 11', () => {
    // Body 12.345.675 sums to a multiple of 11, the branch that yields '0'.
    expect(isValidRut('12.345.675-0')).toBe(true);
  });
});

describe('formatRut', () => {
  it('formats a bare RUT with dots and a hyphen', () => {
    expect(formatRut(VALID_PLAIN)).toBe(VALID_FORMATTED);
  });

  it('is idempotent on already-formatted input', () => {
    expect(formatRut(VALID_FORMATTED)).toBe(VALID_FORMATTED);
  });

  it('uppercases a lowercase K', () => {
    expect(formatRut('12345670k')).toBe('12.345.670-K');
  });

  it('formats a 7-digit body without a leading dot', () => {
    expect(formatRut('55555540')).toBe('5.555.554-0');
  });

  it('returns the cleaned input unchanged when the RUT is invalid', () => {
    // Documented contract: formatting never throws and never signals failure.
    expect(formatRut('12.345.678-4')).toBe('123456784');
    expect(formatRut('nonsense')).toBe('nonsense');
    expect(formatRut('')).toBe('');
  });
});

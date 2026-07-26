/**
 * Chilean RUT validation and formatting.
 *
 * A RUT is a numeric body plus a mod-11 check digit ("dígito verificador"), which
 * is 0-9 or K. Validation is purely arithmetic — it proves the digits are
 * internally consistent, NOT that the RUT was ever issued to anyone. Treat a
 * `true` here as "well-formed", never as "this person exists".
 */

const SEPARATORS = /[.\-\s]/g;
const DIGITS_ONLY = /^\d+$/;
const CHECK_DIGIT = /^[\dK]$/;
const THOUSANDS = /\B(?=(\d{3})+(?!\d))/g;

/** Strip dots, hyphens and spaces from a RUT, returning the bare body+DV string. */
function cleanRut(rut: string): string {
  return rut.replace(SEPARATORS, '');
}

/**
 * Compute the mod-11 check digit ('0'..'9' or 'K') for a numeric body.
 *
 * Precondition: `body` matches `DIGITS_ONLY`. `charCodeAt` is used rather than
 * indexing because `body[i]` is `string | undefined` under
 * `noUncheckedIndexedAccess`, and `Number(undefined)` is `NaN` — which would
 * silently poison the sum instead of failing.
 */
function computeCheckDigit(body: string): string {
  let sum = 0;
  let multiplier = 2;

  for (let i = body.length - 1; i >= 0; i--) {
    sum += (body.charCodeAt(i) - 48) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }

  const remainder = 11 - (sum % 11);
  if (remainder === 11) return '0';
  if (remainder === 10) return 'K';
  return String(remainder);
}

/** Validates an already-cleaned RUT, so callers that cleaned it need not do so twice. */
function isValidCleanRut(cleaned: string): boolean {
  if (cleaned.length < 2) return false;

  const body = cleaned.slice(0, -1);
  const checkDigit = cleaned.slice(-1).toUpperCase();

  if (!DIGITS_ONLY.test(body)) return false;
  if (!CHECK_DIGIT.test(checkDigit)) return false;

  return computeCheckDigit(body) === checkDigit;
}

/**
 * Validate a Chilean RUT via the mod-11 check-digit algorithm.
 *
 * Dots, hyphens and spaces are ignored, and a `k` check digit is accepted in
 * either case.
 */
export function isValidRut(rut: string): boolean {
  return isValidCleanRut(cleanRut(rut));
}

/**
 * Normalize a RUT to `XX.XXX.XXX-D`.
 *
 * Returns the cleaned input unchanged when the RUT is invalid — this never
 * throws and never reports failure, so a caller that needs to distinguish
 * "formatted" from "gave up" must call {@link isValidRut} first.
 */
export function formatRut(rut: string): string {
  const cleaned = cleanRut(rut);
  if (!isValidCleanRut(cleaned)) return cleaned;

  const body = cleaned.slice(0, -1);
  const checkDigit = cleaned.slice(-1).toUpperCase();

  return `${body.replace(THOUSANDS, '.')}-${checkDigit}`;
}

import { describe, expect, it } from 'vitest';
import { isDistortingFit, NON_DISTORTING_FITS } from './objectFit.ts';

describe('NON_DISTORTING_FITS', () => {
  it('holds exactly the four reshaping fits — fill is absent deliberately', () => {
    expect(NON_DISTORTING_FITS).toEqual(['contain', 'cover', 'none', 'scale-down']);
  });
});

describe('isDistortingFit', () => {
  it('returns false for each of the four non-distorting fits', () => {
    expect(isDistortingFit('contain')).toBe(false);
    expect(isDistortingFit('cover')).toBe(false);
    expect(isDistortingFit('none')).toBe(false);
    expect(isDistortingFit('scale-down')).toBe(false);
  });

  it("returns true for 'fill' — the one fit that scales the axes independently", () => {
    expect(isDistortingFit('fill')).toBe(true);
  });

  it('returns true for the empty string — it is not a fit at all', () => {
    expect(isDistortingFit('')).toBe(true);
  });

  it('returns true for an unknown future keyword — fail closed, never a silent excuse', () => {
    expect(isDistortingFit('smart-crop')).toBe(true);
  });

  it('treats uppercase variants as unknown — CSS computed values are lowercase', () => {
    expect(isDistortingFit('Cover')).toBe(true);
    expect(isDistortingFit('CONTAIN')).toBe(true);
    expect(isDistortingFit('SCALE-DOWN')).toBe(true);
  });
});

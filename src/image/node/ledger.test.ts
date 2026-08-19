import { describe, expect, it } from 'vitest';
import { needsEncode, paramsKey } from './ledger.ts';

const BASE = { sha256: 'aaa', params: 'p1', outputs: ['a-320.webp'] };
const allExist = () => true;

describe('needsEncode', () => {
  it('encodes when there is no ledger entry at all', () => {
    expect(
      needsEncode({ entry: undefined, sha256: 'aaa', params: 'p1', outputsExist: allExist }),
    ).toBe(true);
  });

  it('SKIPS when hash, params and outputs all match', () => {
    expect(needsEncode({ entry: BASE, sha256: 'aaa', params: 'p1', outputsExist: allExist })).toBe(
      false,
    );
  });

  it('re-encodes when the master CONTENT changed — the defect this module exists to fix', () => {
    expect(needsEncode({ entry: BASE, sha256: 'bbb', params: 'p1', outputsExist: allExist })).toBe(
      true,
    );
  });

  it('re-encodes when the generation params changed', () => {
    expect(needsEncode({ entry: BASE, sha256: 'aaa', params: 'p2', outputsExist: allExist })).toBe(
      true,
    );
  });

  it('re-encodes when a recorded output is missing from disk', () => {
    expect(
      needsEncode({ entry: BASE, sha256: 'aaa', params: 'p1', outputsExist: () => false }),
    ).toBe(true);
  });
});

describe('paramsKey', () => {
  it('is stable across key order', () => {
    const a = paramsKey({ class: 'content', widths: [1, 2], formats: { avif: 55, webp: 72 } });
    const b = paramsKey({ class: 'content', widths: [1, 2], formats: { webp: 72, avif: 55 } });
    expect(a).toBe(b);
  });

  it('changes when a quality changes', () => {
    const a = paramsKey({ class: 'content', widths: [1], formats: { avif: 55 } });
    const b = paramsKey({ class: 'content', widths: [1], formats: { avif: 50 } });
    expect(a).not.toBe(b);
  });

  it('changes when a rung is added', () => {
    const a = paramsKey({ class: 'content', widths: [1], formats: { avif: 55 } });
    const b = paramsKey({ class: 'content', widths: [1, 2], formats: { avif: 55 } });
    expect(a).not.toBe(b);
  });
});

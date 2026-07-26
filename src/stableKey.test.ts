import { describe, expect, it } from 'vitest';
import { resolveKeys, stableKey } from './stableKey.ts';

describe('stableKey', () => {
  it('returns the same key for the same object across calls', () => {
    const item = { name: 'alpha' };
    expect(stableKey(item)).toBe(stableKey(item));
  });

  it('returns different keys for equal-but-distinct objects', () => {
    expect(stableKey({ name: 'x' })).not.toBe(stableKey({ name: 'x' }));
  });

  it('uses the value itself for primitives', () => {
    expect(stableKey('beta')).toBe('beta');
    expect(stableKey(7)).toBe('7');
  });
});

describe('resolveKeys', () => {
  it('prefers an explicit id field', () => {
    expect(resolveKeys([{ id: 'a' }, { id: 'b' }])).toEqual(['a', 'b']);
  });

  it('keeps keys attached to items when the list is reordered', () => {
    const a = { id: 'a' };
    const b = { id: 'b' };
    const before = resolveKeys([a, b]);
    const after = resolveKeys([b, a]);
    expect(after).toEqual([before[1], before[0]]);
  });

  it('survives a prepend without shifting existing keys', () => {
    const items = [{ id: 'a' }, { id: 'b' }];
    const before = resolveKeys(items);
    const after = resolveKeys([{ id: 'new' }, ...items]);
    expect(after.slice(1)).toEqual(before);
  });

  it('falls back to object identity when there is no id', () => {
    const items = [{ name: 'x' }, { name: 'x' }];
    const keys = resolveKeys(items);
    expect(keys[0]).not.toBe(keys[1]);
    expect(resolveKeys(items)).toEqual(keys);
  });

  it('disambiguates duplicate primitives by occurrence', () => {
    expect(resolveKeys(['x', 'x', 'y'])).toEqual(['x', 'x#1', 'y']);
  });

  it('accepts a custom id accessor', () => {
    const items = [{ slug: 'a' }, { slug: 'b' }];
    expect(resolveKeys(items, (item) => item.slug)).toEqual(['a', 'b']);
  });

  it('never produces duplicate keys', () => {
    const keys = resolveKeys(['x', 'x', 'x', 'y', 'y']);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

import { describe, expect, it } from 'vitest';
import { buildSizes } from './sizes.ts';

describe('buildSizes', () => {
  it('emits conditions first and the unconditional value last', () => {
    expect(
      buildSizes([
        { minWidth: '64em', value: '395px' },
        { minWidth: '48em', value: 'calc((100vw - 72px) / 2)' },
        { value: 'calc(100vw - 48px)' },
      ]),
    ).toBe(
      '(min-width: 64em) 395px, (min-width: 48em) calc((100vw - 72px) / 2), calc(100vw - 48px)',
    );
  });

  it('accepts a single unconditional entry', () => {
    expect(buildSizes([{ value: '100vw' }])).toBe('100vw');
  });

  it('THROWS on ascending min-widths — sizes is first-match, so this silently picks wrong', () => {
    expect(() =>
      buildSizes([
        { minWidth: '48em', value: '50vw' },
        { minWidth: '64em', value: '395px' },
        { value: '100vw' },
      ]),
    ).toThrow(/descending/i);
  });

  it('throws when the last entry is conditional', () => {
    expect(() => buildSizes([{ minWidth: '64em', value: '395px' }])).toThrow(/unconditional/i);
  });

  it('throws when a non-final entry is unconditional', () => {
    expect(() => buildSizes([{ value: '50vw' }, { value: '100vw' }])).toThrow(/unconditional/i);
  });

  it('throws on an empty list', () => {
    expect(() => buildSizes([])).toThrow(/empty/i);
  });

  it('compares px and em on a common scale', () => {
    expect(() =>
      buildSizes([
        { minWidth: '100px', value: '50vw' },
        { minWidth: '64em', value: '395px' },
        { value: '100vw' },
      ]),
    ).toThrow(/descending/i);
  });

  it('throws on an unsupported unit rather than guessing its order', () => {
    expect(() => buildSizes([{ minWidth: '10vw', value: '50vw' }, { value: '100vw' }])).toThrow(
      /unsupported unit/i,
    );
  });
});

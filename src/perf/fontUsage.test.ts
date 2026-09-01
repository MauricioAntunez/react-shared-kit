import { describe, expect, it } from 'vitest';
import {
  findUnshippedFontUsage,
  normalizeFamily,
  type ObservedElement,
  parseFontFaces,
  type ShippedFace,
  shipsWeight,
} from './fontUsage.ts';

describe('parseFontFaces', () => {
  it('parses a single-weight face into weightMin === weightMax', () => {
    const css = `@font-face { font-family: "Space Grotesk"; font-weight: 700; src: url(/a.woff2); }`;
    expect(parseFontFaces(css)).toEqual([
      { family: 'space grotesk', weightMin: 700, weightMax: 700 },
    ]);
  });

  it('parses a variable-font range font-weight: 100 900', () => {
    const css = `@font-face { font-family: "Inter"; font-weight: 100 900; src: url(/b.woff2); }`;
    expect(parseFontFaces(css)).toEqual([{ family: 'inter', weightMin: 100, weightMax: 900 }]);
  });

  it('parses the real web-usa shape font-weight: 400 700', () => {
    const css = `@font-face { font-family: "Instrument Sans"; font-weight: 400 700; src: url(/c.woff2); }`;
    expect(parseFontFaces(css)).toEqual([
      { family: 'instrument sans', weightMin: 400, weightMax: 700 },
    ]);
  });

  it('skips a block missing font-family rather than defaulting it', () => {
    const css = `@font-face { font-weight: 700; src: url(/d.woff2); }`;
    expect(parseFontFaces(css)).toEqual([]);
  });

  it('skips a block missing font-weight rather than defaulting it', () => {
    const css = `@font-face { font-family: "Space Grotesk"; src: url(/e.woff2); }`;
    expect(parseFontFaces(css)).toEqual([]);
  });

  it('does not parse a commented-out @font-face block', () => {
    const css = `/* @font-face { font-family: "Ghost"; font-weight: 700; src: url(/f.woff2); } */`;
    expect(parseFontFaces(css)).toEqual([]);
  });

  it('normalises a quoted, mixed-case family identically to an unquoted lowercase one', () => {
    const css = `@font-face { font-family: 'SPACE GROTESK'; font-weight: 500; src: url(/g.woff2); }`;
    const [face] = parseFontFaces(css);
    expect(face?.family).toBe(normalizeFamily('space grotesk'));
    expect(face?.family).toBe('space grotesk');
  });

  it('takes only the first family token when font-family lists a fallback stack', () => {
    const css = `@font-face { font-family: "Space Grotesk", "Helvetica Neue", sans-serif; font-weight: 700; src: url(/h.woff2); }`;
    expect(parseFontFaces(css)).toEqual([
      { family: 'space grotesk', weightMin: 700, weightMax: 700 },
    ]);
  });
});

describe('shipsWeight', () => {
  const faces: ShippedFace[] = [{ family: 'inter', weightMin: 400, weightMax: 700 }];

  it('is true at exactly weightMin', () => {
    expect(shipsWeight('inter', 400, faces)).toBe(true);
  });

  it('is true at exactly weightMax', () => {
    expect(shipsWeight('inter', 700, faces)).toBe(true);
  });

  it('is false just below weightMin', () => {
    expect(shipsWeight('inter', 399, faces)).toBe(false);
  });

  it('is false just above weightMax', () => {
    expect(shipsWeight('inter', 701, faces)).toBe(false);
  });
});

describe('findUnshippedFontUsage', () => {
  const faces: ShippedFace[] = [{ family: 'instrument sans', weightMin: 400, weightMax: 400 }];

  it('is not a violation for an element in a family this build ships nothing for', () => {
    const elements: ObservedElement[] = [
      { tag: 'span', className: 'code', family: 'ui-monospace', weight: 400 },
    ];
    expect(findUnshippedFontUsage('/home', elements, faces)).toEqual([]);
  });

  it('is a violation for a shipped family observed at an unshipped weight', () => {
    const elements: ObservedElement[] = [
      { tag: 'strong', className: 'heading', family: 'Instrument Sans', weight: 700 },
    ];
    const violations = findUnshippedFontUsage('/home', elements, faces);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.tag).toBe('strong');
    expect(violations[0]?.weight).toBe(700);
    expect(violations[0]?.family).toBe('Instrument Sans');
    expect(violations[0]?.route).toBe('/home');
  });

  it('is not a violation for an element observed at a shipped weight', () => {
    const elements: ObservedElement[] = [
      { tag: 'p', className: 'body', family: 'Instrument Sans', weight: 400 },
    ];
    expect(findUnshippedFontUsage('/home', elements, faces)).toEqual([]);
  });

  it('is not a violation at a shipped weight when the observed family differs only by case/quotes', () => {
    const elements: ObservedElement[] = [
      { tag: 'p', className: 'body', family: '"INSTRUMENT SANS"', weight: 400 },
    ];
    expect(findUnshippedFontUsage('/home', elements, faces)).toEqual([]);
  });

  it('IS a violation at an unshipped weight even when the family only differs by case/quotes — proves shared normalisation matches it to the shipped family rather than treating it as unshipped', () => {
    const elements: ObservedElement[] = [
      { tag: 'strong', className: 'heading', family: "'Instrument Sans'", weight: 700 },
    ];
    const violations = findUnshippedFontUsage('/home', elements, faces);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.weight).toBe(700);
  });

  it('strips control characters and caps length in detail, given a crafted className with a newline', () => {
    const crafted = `evil\nFAKE PASS — everything is fine`;
    const elements: ObservedElement[] = [
      { tag: 'strong', className: crafted, family: 'Instrument Sans', weight: 700 },
    ];
    const violations = findUnshippedFontUsage('/home', elements, faces);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).not.toContain('\n');
    expect(violations[0]?.detail).toContain('\\n');
  });

  it('returns an empty result for empty elements', () => {
    expect(findUnshippedFontUsage('/home', [], faces)).toEqual([]);
  });

  it('reports nothing as a violation when faces is empty — nothing shipped is nothing "ours"', () => {
    // Intentional per the module doc comment: an empty shipped set is the CONSUMER's fail-closed
    // responsibility (e.g. "the build shipped zero @font-face blocks"), not something this pure
    // function can flag on its own — it has no context on whether fonts were supposed to ship.
    const elements: ObservedElement[] = [
      { tag: 'strong', className: 'heading', family: 'Instrument Sans', weight: 700 },
    ];
    expect(findUnshippedFontUsage('/home', elements, [])).toEqual([]);
  });
});

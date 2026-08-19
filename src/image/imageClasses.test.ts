import { describe, expect, it } from 'vitest';
import { defineImageClasses } from './imageClasses.ts';

const CLASSES = {
  avatar: { widths: [48, 96, 144], masterMin: 144 },
  content: { widths: [480, 768, 1024, 1280, 1600], masterMin: 1600 },
  hero: { widths: [768, 1024, 1440, 1920, 2560], masterMin: 2560 },
} as const;

const DIRS = { team: 'avatar', blog: 'content', guides: 'content', locations: 'hero' } as const;

describe('defineImageClasses', () => {
  it('maps a directory segment to its class', () => {
    const { classForPath } = defineImageClasses(CLASSES, DIRS);
    expect(classForPath('/images/blog/foo.jpg')).toBe('content');
    expect(classForPath('/images/team/bar.webp')).toBe('avatar');
  });

  it('matches the LAST directory segment so nested trees work', () => {
    const { classForPath } = defineImageClasses(CLASSES, DIRS);
    expect(classForPath('/static/image/webp/blog/deep/foo.jpg')).toBe('content');
  });

  it('throws on an unmapped directory rather than guessing a class', () => {
    const { classForPath } = defineImageClasses(CLASSES, DIRS);
    expect(() => classForPath('/images/unknown/foo.jpg')).toThrow(/no image class/i);
  });

  it('rejects a ladder whose largest rung exceeds masterMin (an upscale by construction)', () => {
    expect(() =>
      defineImageClasses({ bad: { widths: [100, 200], masterMin: 150 } }, { d: 'bad' }),
    ).toThrow(/masterMin/i);
  });

  it('rejects a non-ascending ladder', () => {
    expect(() =>
      defineImageClasses({ bad: { widths: [200, 100], masterMin: 200 } }, { d: 'bad' }),
    ).toThrow(/ascending/i);
  });

  it('rejects an empty ladder', () => {
    expect(() => defineImageClasses({ bad: { widths: [], masterMin: 0 } }, { d: 'bad' })).toThrow(
      /empty/i,
    );
  });

  it('rejects a directory mapped to a class that does not exist', () => {
    expect(() => defineImageClasses(CLASSES, { team: 'nope' as 'avatar' })).toThrow(
      /unknown class/i,
    );
  });
});

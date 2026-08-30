import { describe, expect, it } from 'vitest';
import { assertResolverReturn, assertStringOption } from './errors.ts';

/**
 * Direct unit tests of the shared boundary-validation helpers, since every gate's resolver call
 * and string option delegates to these — proving the helpers here proves the integration in
 * `fontChain.ts`, `cssBudget.ts`, and `headers.ts` by construction.
 *
 * Round 4 review retired the old error-CLASSIFICATION approach (`isFsError`) entirely: four
 * consecutive rounds of guessing, after `readFileSync` had already thrown, whether the error meant
 * "fs fact" or "caller bug" each failed differently (too broad, too narrow, then simultaneously
 * both). These tests instead prove the boundary check that replaced it: a resolver's return value,
 * or a required string option, is validated against its OWN declared type before it ever reaches
 * an fs call.
 */

describe('assertResolverReturn', () => {
  it('accepts a string', () => {
    expect(() => assertResolverReturn('/real/path.css', 'resolveHref', '/main.css')).not.toThrow();
  });

  it('accepts undefined', () => {
    expect(() => assertResolverReturn(undefined, 'resolveHref', '/main.css')).not.toThrow();
  });

  it('accepts a string containing a NUL byte — that is a filesystem fact, not a contract violation (round 4 Finding A)', () => {
    // The whole point of validating TYPE rather than classifying a downstream error: a NUL byte
    // makes the string un-openable, but it is still, unambiguously, a string. Rejecting it here
    // would just reintroduce the same "guess what readFileSync will do with it" failure mode this
    // redesign exists to retire.
    expect(() =>
      assertResolverReturn('/real/path\0.css', 'resolveHref', '/main.css'),
    ).not.toThrow();
  });

  it('rejects a plain object ({notAPath: true})', () => {
    expect(() =>
      assertResolverReturn({ notAPath: true } as unknown as string, 'resolveImport', './x.css'),
    ).toThrow(/resolveImport/);
  });

  it('rejects a URL object, naming it specifically since it is a likely real mistake (round 4 Finding B)', () => {
    const url = new URL('https://cdn.example.com/main.css');
    expect(() =>
      assertResolverReturn(url as unknown as string, 'resolveHref', '/main.css'),
    ).toThrow(/URL object/);
  });

  it('rejects a Proxy — any exotic non-string shape, not just the two shapes covered above', () => {
    const proxy = new Proxy({}, { get: () => 'trap' }) as unknown as string;
    expect(() => assertResolverReturn(proxy, 'resolveImport', './x.css')).toThrow(/resolveImport/);
  });

  it('rejects null', () => {
    expect(() =>
      assertResolverReturn(null as unknown as string, 'resolveHref', '/main.css'),
    ).toThrow();
  });

  it('rejects a number', () => {
    expect(() =>
      assertResolverReturn(42 as unknown as string, 'resolveHref', '/main.css'),
    ).toThrow();
  });

  it('names the resolver and the input in the thrown message', () => {
    expect(() =>
      assertResolverReturn({} as unknown as string, 'resolveImport', './specific-specifier.css'),
    ).toThrow(/resolveImport.*specific-specifier\.css/);
  });
});

describe('assertStringOption', () => {
  it('accepts a string', () => {
    expect(() => assertStringOption('/built/_headers', 'headersFile')).not.toThrow();
  });

  it('accepts a string containing a NUL byte — a filesystem fact, not a contract violation', () => {
    expect(() => assertStringOption('/built/_headers\0', 'headersFile')).not.toThrow();
  });

  it('rejects a URL object, naming both the option and the mistake (round 4 Finding B)', () => {
    const url = new URL('file:///built/_headers');
    expect(() => assertStringOption(url as unknown as string, 'headersFile')).toThrow(
      /headersFile.*URL object/s,
    );
  });

  it('rejects a plain object', () => {
    expect(() => assertStringOption({ notAPath: true } as unknown as string, 'assetsDir')).toThrow(
      /assetsDir/,
    );
  });

  it('rejects undefined (unlike assertResolverReturn, this option has no legitimate undefined case)', () => {
    expect(() => assertStringOption(undefined as unknown as string, 'assetsDir')).toThrow();
  });
});

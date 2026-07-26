import { describe, expect, it } from 'vitest';
import {
  camelCaseKeys,
  capitalize,
  snakeCaseKeys,
  toCamelCase,
  toSnakeCase,
} from './caseConversion.ts';

describe('toCamelCase', () => {
  it('converts snake_case to camelCase', () => {
    expect(toCamelCase('user_name')).toBe('userName');
    expect(toCamelCase('a_b_c')).toBe('aBC');
  });

  it('leaves strings with no boundary untouched', () => {
    expect(toCamelCase('username')).toBe('username');
    expect(toCamelCase('')).toBe('');
  });

  it('does not treat _ before a non-lowercase character as a boundary', () => {
    expect(toCamelCase('user_ID')).toBe('user_ID');
    expect(toCamelCase('field_2')).toBe('field_2');
  });
});

describe('toSnakeCase', () => {
  it('converts camelCase to snake_case', () => {
    expect(toSnakeCase('userName')).toBe('user_name');
    expect(toSnakeCase('aBC')).toBe('a_b_c');
  });

  it('strips the underscore a leading capital would produce', () => {
    expect(toSnakeCase('UserName')).toBe('user_name');
  });

  it('splits acronyms letter by letter', () => {
    // Documented limitation, not an accident.
    expect(toSnakeCase('parseURL')).toBe('parse_u_r_l');
  });

  it('round-trips with toCamelCase for ordinary identifiers', () => {
    for (const name of ['userName', 'parseURL', 'aBC', 'plain']) {
      expect(toCamelCase(toSnakeCase(name))).toBe(name);
    }
  });
});

describe('capitalize', () => {
  it('uppercases the first character only', () => {
    expect(capitalize('hello')).toBe('Hello');
    expect(capitalize('hELLO')).toBe('HELLO');
  });

  it('handles empty and already-capitalized input', () => {
    expect(capitalize('')).toBe('');
    expect(capitalize('Hello')).toBe('Hello');
  });
});

describe('camelCaseKeys', () => {
  it('renames keys recursively through objects and arrays', () => {
    expect(
      camelCaseKeys({ user_name: 'a', nested_thing: { inner_key: [{ deep_key: 1 }] } }),
    ).toEqual({ userName: 'a', nestedThing: { innerKey: [{ deepKey: 1 }] } });
  });

  it('does not mutate its input', () => {
    const input = { user_name: 'a', nested: { inner_key: 1 } };
    const snapshot = JSON.parse(JSON.stringify(input)) as typeof input;
    camelCaseKeys(input);
    expect(input).toEqual(snapshot);
  });

  it('passes Date through by reference rather than flattening it', () => {
    const date = new Date('2026-07-26T00:00:00.000Z');
    // Read through Record: the declared return type still claims the old key names.
    const result = camelCaseKeys({ created_at: date }) as Record<string, unknown>;
    expect(result.createdAt).toBe(date);
  });

  it('passes other non-plain objects through untouched', () => {
    const map = new Map([['a_b', 1]]);
    const regex = /x_y/;
    const result = camelCaseKeys({ a_map: map, a_regex: regex }) as Record<string, unknown>;
    expect(result.aMap).toBe(map);
    expect(result.aRegex).toBe(regex);
  });

  it('preserves null and undefined values', () => {
    expect(camelCaseKeys({ a_b: null, c_d: undefined })).toEqual({ aB: null, cD: undefined });
  });

  it('handles a bare array at the top level', () => {
    expect(camelCaseKeys([{ a_b: 1 }, { c_d: 2 }])).toEqual([{ aB: 1 }, { cD: 2 }]);
  });

  it('returns primitives unchanged', () => {
    expect(camelCaseKeys('a_b')).toBe('a_b');
    expect(camelCaseKeys(null)).toBe(null);
    expect(camelCaseKeys(7)).toBe(7);
  });

  it('renames __proto__ rather than reassigning the prototype', () => {
    const payload = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>;
    const result = camelCaseKeys(payload) as Record<string, unknown>;
    // camelCasing rewrites the key, so the dangerous name never reaches the assignment.
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result, '_Proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('snakeCaseKeys', () => {
  it('renames keys recursively', () => {
    expect(snakeCaseKeys({ userName: 'a', nestedThing: { innerKey: [{ deepKey: 1 }] } })).toEqual({
      user_name: 'a',
      nested_thing: { inner_key: [{ deep_key: 1 }] },
    });
  });

  it('round-trips with camelCaseKeys', () => {
    const original = { user_name: 'a', nested_thing: { inner_key: 1 } };
    expect(snakeCaseKeys(camelCaseKeys(original))).toEqual(original);
  });

  it('keeps a normalized __proto__ key as an own property instead of polluting the prototype', () => {
    // '___proto__' is the input that TRANSFORMS INTO '__proto__' (one leading
    // underscore is stripped). Under plain `result[key] = ...` assignment this
    // would reassign the prototype; defineProperty makes it an own property.
    const payload = JSON.parse('{"___proto__": {"polluted": true}}') as Record<string, unknown>;
    const result = snakeCaseKeys(payload) as Record<string, unknown>;
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

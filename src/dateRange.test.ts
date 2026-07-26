import { describe, expect, it } from 'vitest';
import {
  monthStartYmd,
  normalizeYmd,
  PERIODS,
  periodToRange,
  resolvePeriodRange,
  todayYmd,
  toYmd,
} from './dateRange.ts';

// 02:30 UTC on Sunday 2026-07-26 is still Saturday 2026-07-25 in Santiago
// (UTC-4 in July). Every assertion below turns on that one-day disagreement.
const NOW = new Date('2026-07-26T02:30:00Z');
const LOCAL = { now: NOW } as const;
const UTC = { now: NOW, utc: true } as const;

describe('timezone handling', () => {
  it('resolves a different calendar date in each zone', () => {
    expect(toYmd(NOW)).toBe('2026-07-25');
    expect(toYmd(NOW, { utc: true })).toBe('2026-07-26');
  });

  it('reports today in the requested zone', () => {
    expect(todayYmd(LOCAL)).toBe('2026-07-25');
    expect(todayYmd(UTC)).toBe('2026-07-26');
  });

  it('defaults to local when utc is not set', () => {
    expect(todayYmd(LOCAL)).toBe(todayYmd({ now: NOW, utc: false }));
  });
});

describe('periodToRange', () => {
  it('today', () => {
    expect(periodToRange('today', LOCAL)).toEqual({ from: '2026-07-25', to: '2026-07-25' });
    expect(periodToRange('today', UTC)).toEqual({ from: '2026-07-26', to: '2026-07-26' });
  });

  it('yesterday', () => {
    expect(periodToRange('yesterday', LOCAL)).toEqual({ from: '2026-07-24', to: '2026-07-24' });
    expect(periodToRange('yesterday', UTC)).toEqual({ from: '2026-07-25', to: '2026-07-25' });
  });

  it('week runs from Monday to today', () => {
    // Saturday locally, Sunday in UTC — both weeks start Monday the 20th.
    expect(periodToRange('week', LOCAL)).toEqual({ from: '2026-07-20', to: '2026-07-25' });
    expect(periodToRange('week', UTC)).toEqual({ from: '2026-07-20', to: '2026-07-26' });
  });

  it('lastweek is the full Monday-to-Sunday week before this one', () => {
    const expected = { from: '2026-07-13', to: '2026-07-19' };
    expect(periodToRange('lastweek', LOCAL)).toEqual(expected);
    expect(periodToRange('lastweek', UTC)).toEqual(expected);
  });

  it('month runs from the 1st to today', () => {
    expect(periodToRange('month', LOCAL)).toEqual({ from: '2026-07-01', to: '2026-07-25' });
    expect(periodToRange('month', UTC)).toEqual({ from: '2026-07-01', to: '2026-07-26' });
  });

  it('lastmonth covers the whole previous month', () => {
    const expected = { from: '2026-06-01', to: '2026-06-30' };
    expect(periodToRange('lastmonth', LOCAL)).toEqual(expected);
    expect(periodToRange('lastmonth', UTC)).toEqual(expected);
  });

  it('handles a Sunday, where the week started six days earlier', () => {
    const sunday = new Date('2026-07-26T12:00:00Z');
    expect(periodToRange('week', { now: sunday, utc: true })).toEqual({
      from: '2026-07-20',
      to: '2026-07-26',
    });
  });

  it('crosses a year boundary for lastmonth', () => {
    const january = new Date('2026-01-15T12:00:00Z');
    expect(periodToRange('lastmonth', { now: january, utc: true })).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    });
  });

  it('produces a from no later than to for every preset', () => {
    for (const period of PERIODS) {
      if (period === 'custom') continue;
      const range = periodToRange(period, UTC);
      expect(range.from <= range.to).toBe(true);
    }
  });
});

describe('resolvePeriodRange', () => {
  it('returns the custom dates verbatim when the period is custom', () => {
    expect(resolvePeriodRange('custom', '2026-01-01', '2026-01-31', UTC)).toEqual({
      from: '2026-01-01',
      to: '2026-01-31',
    });
  });

  it('ignores the custom dates for a preset period', () => {
    expect(resolvePeriodRange('today', '2026-01-01', '2026-01-31', UTC)).toEqual({
      from: '2026-07-26',
      to: '2026-07-26',
    });
  });
});

describe('monthStartYmd', () => {
  it('returns the 1st of the current month in the requested zone', () => {
    expect(monthStartYmd(LOCAL)).toBe('2026-07-01');
    expect(monthStartYmd(UTC)).toBe('2026-07-01');
  });

  it('uses the zone-local month at a boundary', () => {
    // 01:00 UTC on 1 August is still 31 July in Santiago.
    const boundary = new Date('2026-08-01T01:00:00Z');
    expect(monthStartYmd({ now: boundary })).toBe('2026-07-01');
    expect(monthStartYmd({ now: boundary, utc: true })).toBe('2026-08-01');
  });
});

describe('normalizeYmd', () => {
  it('accepts the dashed form with or without a time suffix', () => {
    expect(normalizeYmd('2026-07-26')).toBe('2026-07-26');
    expect(normalizeYmd('2026-07-26T03:00:00Z')).toBe('2026-07-26');
  });

  it('accepts the compact form', () => {
    expect(normalizeYmd('20260726')).toBe('2026-07-26');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeYmd('  2026-07-26  ')).toBe('2026-07-26');
  });

  it('returns an empty string for empty or unparseable input', () => {
    expect(normalizeYmd('')).toBe('');
    expect(normalizeYmd(null)).toBe('');
    expect(normalizeYmd(undefined)).toBe('');
    expect(normalizeYmd('not a date')).toBe('');
    expect(normalizeYmd('26-07-2026')).toBe('');
  });

  it('does not convert timezones — it reads the literal prefix', () => {
    // The instant is 2026-07-25 22:00 in Santiago, but the string says the 26th.
    expect(normalizeYmd('2026-07-26T02:00:00Z')).toBe('2026-07-26');
    expect(toYmd(new Date('2026-07-26T02:00:00Z'))).toBe('2026-07-25');
  });
});

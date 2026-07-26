/**
 * Preset date ranges for period pickers, in either the local timezone or UTC.
 *
 * Every function here answers a calendar question ("what day is it", "when did
 * this week start"), and the answer depends on the timezone: at 21:00 in
 * Santiago it is already tomorrow in UTC. Pass `{ utc: true }` when the consumer
 * of the range is a UTC-based API; leave it off when the range is shown to a
 * person in their own timezone.
 *
 * Dates are emitted as `YYYY-MM-DD` strings, never as `Date` objects, because a
 * calendar date has no time and no offset — attaching one invites the very
 * confusion this module exists to avoid.
 */

/** Every selectable period. Iterate this to build a picker. */
export const PERIODS = [
  'today',
  'yesterday',
  'week',
  'lastweek',
  'month',
  'lastmonth',
  'custom',
] as const;

export type Period = (typeof PERIODS)[number];

/** A period whose range is computed rather than supplied by the user. */
export type PresetPeriod = Exclude<Period, 'custom'>;

/** An inclusive range of calendar dates, both `YYYY-MM-DD`. */
export interface DateRange {
  from: string;
  to: string;
}

export interface DateRangeOptions {
  /** Resolve calendar dates in UTC rather than the local timezone. Defaults to local. */
  utc?: boolean;
  /** The instant treated as "now". Defaults to the current time; set it to make tests deterministic. */
  now?: Date;
}

/**
 * The timezone-dependent half of date arithmetic.
 *
 * Isolating it here is what lets every range function below be written once
 * instead of twice, and keeps `getDate()`/`getUTCDate()` from being interleaved
 * throughout the module where a mismatched pair would be invisible.
 */
interface Calendar {
  readonly year: (date: Date) => number;
  /** 0-based, matching `Date`. */
  readonly month: (date: Date) => number;
  readonly dayOfMonth: (date: Date) => number;
  /** 0 = Sunday, matching `Date`. */
  readonly dayOfWeek: (date: Date) => number;
  /** Builds a date from parts; out-of-range parts roll over, as `Date` does. */
  readonly at: (year: number, month: number, day: number) => Date;
}

const LOCAL_CALENDAR: Calendar = {
  year: (date) => date.getFullYear(),
  month: (date) => date.getMonth(),
  dayOfMonth: (date) => date.getDate(),
  dayOfWeek: (date) => date.getDay(),
  at: (year, month, day) => new Date(year, month, day),
};

const UTC_CALENDAR: Calendar = {
  year: (date) => date.getUTCFullYear(),
  month: (date) => date.getUTCMonth(),
  dayOfMonth: (date) => date.getUTCDate(),
  dayOfWeek: (date) => date.getUTCDay(),
  at: (year, month, day) => new Date(Date.UTC(year, month, day)),
};

function calendarFor(options?: DateRangeOptions): Calendar {
  return options?.utc ? UTC_CALENDAR : LOCAL_CALENDAR;
}

function format(date: Date, calendar: Calendar): string {
  const year = String(calendar.year(date)).padStart(4, '0');
  const month = String(calendar.month(date) + 1).padStart(2, '0');
  const day = String(calendar.dayOfMonth(date)).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Shifts by whole days by rebuilding from calendar parts rather than adding
 * milliseconds, so a DST boundary cannot turn "tomorrow" into 23 or 25 hours.
 */
function addDays(date: Date, days: number, calendar: Calendar): Date {
  return calendar.at(calendar.year(date), calendar.month(date), calendar.dayOfMonth(date) + days);
}

/** Monday of the week containing `date`. */
function startOfWeek(date: Date, calendar: Calendar): Date {
  const weekday = calendar.dayOfWeek(date);
  return addDays(date, weekday === 0 ? -6 : 1 - weekday, calendar);
}

function singleDay(date: Date, calendar: Calendar): DateRange {
  const ymd = format(date, calendar);
  return { from: ymd, to: ymd };
}

/**
 * Every preset period, keyed exhaustively — adding a `Period` without a range
 * here is a compile error rather than an empty range discovered at runtime.
 */
const PRESET_RANGES: Record<PresetPeriod, (now: Date, calendar: Calendar) => DateRange> = {
  today: (now, calendar) => singleDay(now, calendar),
  yesterday: (now, calendar) => singleDay(addDays(now, -1, calendar), calendar),
  week: (now, calendar) => ({
    from: format(startOfWeek(now, calendar), calendar),
    to: format(now, calendar),
  }),
  lastweek: (now, calendar) => {
    const start = addDays(startOfWeek(now, calendar), -7, calendar);
    return { from: format(start, calendar), to: format(addDays(start, 6, calendar), calendar) };
  },
  month: (now, calendar) => ({
    from: format(calendar.at(calendar.year(now), calendar.month(now), 1), calendar),
    to: format(now, calendar),
  }),
  lastmonth: (now, calendar) => {
    const start = calendar.at(calendar.year(now), calendar.month(now) - 1, 1);
    // Day 0 of the current month is the last day of the previous one.
    const end = calendar.at(calendar.year(now), calendar.month(now), 0);
    return { from: format(start, calendar), to: format(end, calendar) };
  },
};

/** Formats a `Date` as `YYYY-MM-DD` in the local timezone, or UTC with `{ utc: true }`. */
export function toYmd(date: Date, options?: DateRangeOptions): string {
  return format(date, calendarFor(options));
}

/** Today as `YYYY-MM-DD`. */
export function todayYmd(options?: DateRangeOptions): string {
  const calendar = calendarFor(options);
  return format(options?.now ?? new Date(), calendar);
}

/** The first day of the current month as `YYYY-MM-DD`. */
export function monthStartYmd(options?: DateRangeOptions): string {
  const calendar = calendarFor(options);
  const now = options?.now ?? new Date();
  return format(calendar.at(calendar.year(now), calendar.month(now), 1), calendar);
}

/**
 * Resolves a preset period to an explicit range.
 *
 * `'custom'` is deliberately not accepted — it has no computable range. Use
 * {@link resolvePeriodRange}, which takes the user's dates alongside the period.
 */
export function periodToRange(period: PresetPeriod, options?: DateRangeOptions): DateRange {
  return PRESET_RANGES[period](options?.now ?? new Date(), calendarFor(options));
}

/**
 * Resolves any period, including `'custom'`, to an explicit range: the supplied
 * dates when custom, otherwise the preset range. This is the entry point for a
 * period picker feeding a range-only endpoint.
 */
export function resolvePeriodRange(
  period: Period,
  customFrom: string,
  customTo: string,
  options?: DateRangeOptions,
): DateRange {
  if (period === 'custom') return { from: customFrom, to: customTo };
  return periodToRange(period, options);
}

const DASHED_YMD = /^(\d{4})-(\d{2})-(\d{2})/;
const COMPACT_YMD = /^(\d{4})(\d{2})(\d{2})/;

/**
 * Extracts the `YYYY-MM-DD` prefix of a date string, accepting either the dashed
 * form (with or without a time suffix) or compact `YYYYMMDD`. Returns `''` when
 * the input is empty or matches neither shape.
 *
 * This is string surgery, NOT a timezone conversion: `'2026-07-26T02:00:00Z'`
 * yields `'2026-07-26'` regardless of where you run it. To convert an instant to
 * a calendar date in a given zone, use `toYmd(new Date(iso), { utc })` instead —
 * those two disagree by a day near midnight, which is exactly the bug this note
 * exists to prevent.
 */
export function normalizeYmd(value: string | null | undefined): string {
  if (!value) return '';

  const trimmed = value.trim();
  const match = DASHED_YMD.exec(trimmed) ?? COMPACT_YMD.exec(trimmed);
  if (!match) return '';

  const [, year, month, day] = match;
  if (year === undefined || month === undefined || day === undefined) return '';

  return `${year}-${month}-${day}`;
}

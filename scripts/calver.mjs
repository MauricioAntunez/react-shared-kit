/**
 * CalVer helper for this package: versions are `YYYY.MMDD.PATCH`.
 *
 * Why MMDD is not zero-padded: semver forbids a leading zero in any numeric
 * identifier, so `2026.0726.0` is rejected by npm at publish time. Concatenating
 * month and day into one field (`726`, `1105`) keeps chronological ordering
 * intact — MMDD as an integer is monotonic within a year — while staying valid.
 *
 * Usage:
 *   node scripts/calver.mjs            print the version today's release should carry
 *   node scripts/calver.mjs --check X  exit non-zero unless X is a well-formed CalVer
 */

import { readFileSync } from 'node:fs';

// month has no leading zero (1-12), day always two digits (01-31).
const CALVER = /^(\d{4})\.([1-9]\d?)(\d{2})\.(0|[1-9]\d*)$/;

/** Returns null when `version` is a real calendar date in CalVer form, else the reason it is not. */
function reject(version) {
  const match = CALVER.exec(version);
  if (!match) return `'${version}' is not YYYY.MMDD.PATCH`;

  const [, year, month, day] = match;
  const [y, m, d] = [Number(year), Number(month), Number(day)];

  if (m < 1 || m > 12) return `month ${m} is out of range`;

  // Round-tripping through Date catches Feb 30 and friends: an overflowing day
  // rolls into the next month, so the parts come back changed.
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return `${year}-${month}-${day} is not a real date`;
  }

  return null;
}

/** Today's version, bumping the patch if this package already shipped today. */
function next() {
  const now = new Date();
  const stamp = `${now.getFullYear()}.${(now.getMonth() + 1) * 100 + now.getDate()}`;

  const current = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const match = CALVER.exec(current.version);
  const sameDay = match && `${match[1]}.${match[2]}${match[3]}` === stamp;

  return `${stamp}.${sameDay ? Number(match[4]) + 1 : 0}`;
}

const [flag, value] = process.argv.slice(2);

if (flag === '--check') {
  const reason = reject(value ?? '');
  if (reason) {
    console.error(`Invalid version: ${reason}. Expected YYYY.MMDD.PATCH, e.g. 2026.726.0`);
    process.exit(1);
  }
} else {
  process.stdout.write(`${next()}\n`);
}

import { requireBackfill as check } from './v4-backfill-contract.mjs'

// SQL DATETIME is a wall clock. Validation must not invent a historical timezone.
export function inspectWallClock(value) {
  if (value === null) return { raw: null, canonicalWallClock: null, utc: null, timeResolved: false }
  check(typeof value === 'string', 'identity_time_invalid')
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(value)
  check(match, 'identity_time_invalid')
  const [, y, m, d, h, min, s, fraction = ''] = match
  const year = Number(y), month = Number(m), day = Number(d)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  check(year >= 1000 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && Number(h) <= 23 && Number(min) <= 59 && Number(s) <= 59, 'identity_time_invalid')
  check(!/[1-9]/.test(fraction.slice(3)), 'identity_time_precision_loss')
  return { raw: value, canonicalWallClock: `${y}-${m}-${d} ${h}:${min}:${s}.${fraction.slice(0, 3).padEnd(3, '0')}`, utc: null, timeResolved: false }
}

export function epochMillisecondsToUtc(value) {
  if (value === null) return { raw: null, utc: null, timeResolved: true }
  check(typeof value === 'string' && value.length <= 15 && /^(?:0|[1-9][0-9]*)$/.test(value), 'identity_epoch_invalid')
  const n = BigInt(value)
  check(n <= 253402300799999n, 'identity_epoch_out_of_range')
  // The supported MySQL date range is below MAX_SAFE_INTEGER; Date sees exact ms.
  return { raw: value, utc: new Date(Number(n)).toISOString().replace('T', ' ').replace('Z', ''), timeResolved: true }
}

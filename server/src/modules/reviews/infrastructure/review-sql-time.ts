import { ReviewError } from '../domain/review.js'

export function reviewSqlTime(value: string): string {
  const match = typeof value === 'string' ? /^([1-9][0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:\.([0-9]{1,3}))?Z$/.exec(value) : null
  const canonical = match ? `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z` : ''
  if (!match || match[0].length !== value.length || !Number.isFinite(Date.parse(canonical)) || new Date(canonical).toISOString() !== canonical) {
    throw new ReviewError('review_time_invalid', 422)
  }
  return canonical.slice(0, 23).replace('T', ' ')
}

export function reviewIsoTime(value: Date | string): string {
  if (value instanceof Date) return value.toISOString()
  const match = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?$/.exec(value)
  const iso = match ? `${match[1]!.replace(' ', 'T')}.${(match[2] ?? '').padEnd(3, '0')}Z` : value
  reviewSqlTime(iso)
  return new Date(iso).toISOString()
}

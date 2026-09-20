export type ReviewPeriodKind = 'daily' | 'monthly'

/** UTC encodes the local calendar label only; the historical clock reader resolves real UTC boundaries. */
export function reviewPeriodCalendar(kind: ReviewPeriodKind, key: string) {
  const pattern = kind === 'daily' ? /^[1-9]\d{3}-\d{2}-\d{2}$/ : /^[1-9]\d{3}-\d{2}$/
  if (!['daily','monthly'].includes(kind) || !pattern.test(key)) throw Error('review_period_key_invalid')
  const localStartMsc = Date.parse(`${key}${kind === 'monthly' ? '-01' : ''}T00:00:00.000Z`)
  if (!Number.isFinite(localStartMsc) || new Date(localStartMsc).toISOString().slice(0,key.length) !== key) throw Error('review_period_key_invalid')
  const end = new Date(localStartMsc)
  if (kind === 'daily') end.setUTCDate(end.getUTCDate()+1)
  else end.setUTCMonth(end.getUTCMonth()+1)
  return { kind, key, localStartMsc, localEndMsc: end.getTime() }
}

/** Keyset discovery, independent of machine timezone and current terminal offset. */
export function listReviewPeriodCalendars(input: { rangeStartUtcMsc: number; rangeEndUtcMsc: number; after: string | null; limit: number }) {
  const { rangeStartUtcMsc: start, rangeEndUtcMsc: end, after, limit } = input
  if (![start,end].every(v => Number.isSafeInteger(v) && v > 0 && Number.isFinite(new Date(v).getTime()))
    || start >= end || !Number.isInteger(limit) || limit < 1 || limit > 100) throw Error('review_period_discovery_invalid')
  if (after !== null) {
    const [kind,key,...rest] = after.split(':')
    if (rest.length || (kind !== 'daily' && kind !== 'monthly') || !key) throw Error('review_period_cursor_invalid')
    reviewPeriodCalendar(kind,key)
  }
  const margin = 840 * 60_000, items = []
  for (const kind of ['daily','monthly'] as const) {
    if (kind === 'daily' && after?.startsWith('monthly:')) continue
    const first = new Date(start-margin).toISOString().slice(0,kind === 'daily' ? 10 : 7)
    let current = reviewPeriodCalendar(kind,first)
    if (after?.startsWith(kind+':')) {
      const previous = reviewPeriodCalendar(kind,after.slice(kind.length+1))
      if (previous.localEndMsc > current.localStartMsc) current = reviewPeriodCalendar(kind,new Date(previous.localEndMsc).toISOString().slice(0,kind === 'daily' ? 10 : 7))
    }
    while (current.localStartMsc <= end+margin) {
      const cursor = `${kind}:${current.key}`
      // An independent offset in [-14h,+14h] must at least permit both boundaries inside coverage.
      if ((after === null || cursor > after) && current.localStartMsc+margin >= start && current.localEndMsc-margin <= end) {
        items.push({ ...current, cursor })
        if (items.length > limit) return { items: items.slice(0,limit), next: items[limit-1]!.cursor }
      }
      if (current.localEndMsc > end+margin) break
      current = reviewPeriodCalendar(kind,new Date(current.localEndMsc).toISOString().slice(0,kind === 'daily' ? 10 : 7))
    }
  }
  return { items, next: null }
}

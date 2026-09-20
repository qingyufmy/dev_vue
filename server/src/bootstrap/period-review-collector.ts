import type { PoolConnection } from 'mysql2/promise'
import type { ReviewPeriod } from '../modules/reviews/index.js'
import { freezeReviewPeriod, reviewPeriodCalendar, type ReviewPeriodKind } from '../modules/reviews/index.js'
import { createMysqlPeriodReviewWriter } from '../modules/reviews/composition.js'
import { createActivePrincipalAccess } from '../modules/auth/composition.js'
import { createMysqlHistoricalClockReader, createMysqlOwnedHistoryAccess } from '../modules/trading/composition.js'
import { createTransactionPeriodReviewInventory } from './period-review-inventory.js'

/** One caller-owned transaction verifies ownership, historical clock boundaries, full inventory and creates cases. */
export function createTransactionPeriodReviewCollector(connection: PoolConnection) {
  const inventory = createTransactionPeriodReviewInventory(connection)
  const clocks = createMysqlHistoricalClockReader(connection)
  const ownership = createMysqlOwnedHistoryAccess(connection,createActivePrincipalAccess(connection))
  const writer = createMysqlPeriodReviewWriter(connection)
  const collector = { async collectCalendar(input: Omit<Parameters<typeof inventory.read>[0], 'period'> & {
    kind: ReviewPeriodKind; key: string; ownershipIntervalId: string
  }) {
    const scope = structuredClone(input), calendar = reviewPeriodCalendar(scope.kind,scope.key)
    const identity = { userId: scope.route.userId, accountId: scope.route.accountId,
      ownershipIntervalId: scope.ownershipIntervalId, asOfUtcMsc: scope.asOfUtcMsc }
    const start = await clocks.resolveLocal({ ...identity, localMidnightMsc: calendar.localStartMsc })
    const end = await clocks.resolveLocal({ ...identity, localMidnightMsc: calendar.localEndMsc })
    if (!start || !end) return { status: 'unresolved' as const, reason: 'period_clock_unavailable' }
    return collector.collect({ ...scope, period: { kind: scope.kind, key: scope.key, start, end } })
  }, async collect(input: Omit<Parameters<typeof inventory.read>[0], 'period'> & { period: ReviewPeriod; ownershipIntervalId: string }) {
    const scope = structuredClone(input), period = freezeReviewPeriod(scope.period,scope.asOfUtcMsc)
    const owned = await ownership.read({ userId: scope.route.userId, accountId: scope.route.accountId, platform: scope.route.platform,
      ownershipIntervalId: scope.ownershipIntervalId, openedAt: new Date(period.start.utcMsc).toISOString(),
      closedAt: new Date(period.end.utcMsc).toISOString() })
    if (!owned) return { status: 'unresolved' as const, reason: 'period_ownership_unavailable' }
    for (const boundary of [period.start,period.end]) {
      const proven = await clocks.read({ userId: scope.route.userId, accountId: scope.route.accountId,
        ownershipIntervalId: scope.ownershipIntervalId, utcMsc: boundary.utcMsc, asOfUtcMsc: scope.asOfUtcMsc })
      if (!proven || proven.offsetMinutes !== boundary.offsetMinutes) return { status: 'unresolved' as const, reason: 'period_clock_unavailable' }
      // Never persist the caller's evidenceRef as proof.
      boundary.evidenceRef = proven.evidenceRef
    }
    const selected = await inventory.read({ ...scope, period })
    return selected.status === 'selected' ? writer.write(scope.route.userId, selected) : selected
  } }
  return collector
}

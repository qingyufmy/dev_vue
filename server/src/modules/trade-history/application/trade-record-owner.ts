import { EvidenceAccountAccessPolicy, validateOwnershipTimeline, type OwnershipInterval } from '../../trading/index.js'
import type { AccountTradeProjection } from '../domain/terminal-history-projection.js'

const access = new EvidenceAccountAccessPolicy()

// The collecting route/user is intentionally not an input. Source classification
// (manual/system/EA) and personal record ownership are separate questions.
export function resolveTradeRecordOwner(accountId: string, projection: AccountTradeProjection,
  intervals: readonly OwnershipInterval[], now: Date): { userId: number; intervalId: string } | null {
  if (projection.evidenceStatus !== 'complete' || !validateOwnershipTimeline(intervals).ok
    || !Number.isFinite(projection.openedAtUtcMsc) || !Number.isFinite(projection.closedAtUtcMsc)) return null
  const start = new Date(projection.openedAtUtcMsc)
  const end = new Date(projection.closedAtUtcMsc)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || !Number.isFinite(now.getTime())) return null
  const matches = intervals.filter(interval => access.canReadOwnHistory({
    userId: interval.userId, accountId, active: true, mode: 'full', nowUtc: now.toISOString(),
  }, {
    recordId: projection.stableKey, accountId, userId: interval.userId,
    firstOccurredAtUtc: start.toISOString(), lastOccurredAtUtc: end.toISOString(),
    attribution: { kind: 'ownership_interval', interval },
  }))
  return matches.length === 1 ? { userId: matches[0]!.userId, intervalId: matches[0]!.id } : null
}

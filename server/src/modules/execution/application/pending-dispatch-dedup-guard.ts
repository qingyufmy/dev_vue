import { ExecutionError } from '../domain/execution.js'
import { findDuplicatePendingOrder, type PendingDedupOrder } from '../domain/pending-order-dedup.js'
import { checkPendingDedup, type PendingDedupRoute, type PendingDedupSnapshotReader } from './pending-dedup-guard.js'

export interface PendingDispatchOccupancy {
  commandId: string
  status: 'queued' | 'dispatched' | 'accepted' | 'uncertain' | 'reconciling' | 'succeeded'
  order: PendingDedupOrder
}
export interface PendingDispatchOccupancyReader {
  /** Same locked account transaction. Include successful commands until proven reconciled;
   * deadlines never release occupancy. Exact origin/route and complete bounded reads are mandatory. */
  read(input: { userId: number; accountId: string; strategyId: string; route: PendingDedupRoute; projectionRevision: string }): Promise<{
    userId: number; accountId: string; route: PendingDedupRoute; complete: boolean; items: PendingDispatchOccupancy[]
  } | null>
}

/** Called before the current command becomes dispatched, while holding the account lock. */
export async function checkPendingDispatchDedup(snapshots: PendingDedupSnapshotReader, occupancies: PendingDispatchOccupancyReader,
  input: Parameters<typeof checkPendingDedup>[1] & { commandId: string }, now: Date) {
  const frozen = structuredClone(input), observedNow = new Date(now.getTime())
  if (!frozen.commandId) throw new ExecutionError('execution_dedup_context_invalid', 409)
  const snapshot = await checkPendingDedup(snapshots, frozen, observedNow)
  const occupancy = await occupancies.read({ ...frozen.request.scope, route: { ...frozen.route }, projectionRevision: snapshot.revision })
  if (!occupancy || occupancy.complete !== true || !Array.isArray(occupancy.items)) {
    throw new ExecutionError('execution_dedup_occupancy_incomplete', 409)
  }
  if (occupancy.userId !== frozen.request.scope.userId || occupancy.accountId !== frozen.request.scope.accountId
    || (Object.keys(frozen.route) as (keyof PendingDedupRoute)[]).some(key => occupancy.route[key] !== frozen.route[key])) {
    throw new ExecutionError('execution_dedup_occupancy_scope_changed', 409)
  }
  const seen = new Set<string>()
  const orders: PendingDedupOrder[] = []
  for (const item of occupancy.items) {
    if (!item.commandId || seen.has(item.commandId)) throw new ExecutionError('execution_dedup_occupancy_invalid', 409)
    seen.add(item.commandId)
    if (item.commandId === frozen.commandId || item.status === 'queued') continue
    if (!['dispatched', 'accepted', 'uncertain', 'reconciling', 'succeeded'].includes(item.status)
      || !item.order.verifiedOrigin) throw new ExecutionError('execution_dedup_occupancy_invalid', 409)
    const origin = item.order.verifiedOrigin
    if (origin.userId !== frozen.request.scope.userId || origin.accountId !== frozen.request.scope.accountId
      || typeof origin.strategyId !== 'string' || !origin.strategyId) throw new ExecutionError('execution_dedup_occupancy_invalid', 409)
    orders.push(item.order)
  }
  if (findDuplicatePendingOrder(frozen.request, orders) !== null) {
    throw new ExecutionError('execution_duplicate_pending_dispatch', 409)
  }
  return snapshot
}

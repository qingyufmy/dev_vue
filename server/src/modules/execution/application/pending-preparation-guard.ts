import { ExecutionError } from '../domain/execution.js'
import { findDuplicatePendingOrder, type PendingDedupOrder } from '../domain/pending-order-dedup.js'
import { checkPendingDispatchDedup, type PendingDispatchOccupancyReader } from './pending-dispatch-dedup-guard.js'
import type { PendingDedupSnapshotReader, checkPendingDedup } from './pending-dedup-guard.js'

export interface PendingPreparationCandidate extends ParametersShape {
  intentId: string
}
type ParametersShape = Parameters<typeof checkPendingDedup>[1]
export interface PreparedPendingOccupancyReader {
  /** Read on the locked account transaction. Include prepared intents without commands and queued commands.
   * Exclude an intent only after authoritative terminal/cancellation evidence, never by TTL alone. */
  read(input: { userId: number; accountId: string; strategyId: string }): Promise<{
    complete: boolean; userId: number; accountId: string
    items: Array<{ intentId: string; order: PendingDedupOrder }>
  } | null>
}

/** Called before any bundle rows are inserted. All evidence ports belong to the same account transaction. */
export async function checkPendingPreparation(
  dependencies: { snapshots: PendingDedupSnapshotReader; dispatched: PendingDispatchOccupancyReader; prepared: PreparedPendingOccupancyReader },
  candidates: readonly PendingPreparationCandidate[], now: Date,
): Promise<void> {
  const frozen = structuredClone(candidates), observedNow = new Date(now.getTime())
  if (frozen.length > 100 || !Number.isFinite(observedNow.getTime())) throw new ExecutionError('execution_dedup_context_invalid', 409)
  const ids = new Set<string>(), batchOrders: PendingDedupOrder[] = []
  for (const candidate of frozen) {
    if (!candidate.intentId || ids.has(candidate.intentId)) throw new ExecutionError('execution_dedup_context_invalid', 409)
    ids.add(candidate.intentId)
    const first = frozen[0]!.request.scope, scope = candidate.request.scope
    if (scope.userId !== first.userId || scope.accountId !== first.accountId || scope.strategyId !== first.strategyId) throw new ExecutionError('execution_dedup_context_invalid', 409)
    // Preparation has no command ID. Never accidentally exclude an existing command by using an intent ID.
    await checkPendingDispatchDedup(dependencies.snapshots, dependencies.dispatched, { ...candidate, commandId: `preparation/${candidate.intentId}` }, observedNow)
    const existing = await dependencies.prepared.read(scope)
    if (!existing || !existing.complete || existing.userId !== scope.userId || existing.accountId !== scope.accountId || !Array.isArray(existing.items)) {
      throw new ExecutionError('execution_dedup_prepared_incomplete', 409)
    }
    const seen = new Set<string>()
    for (const item of existing.items) {
      if (!item.intentId || seen.has(item.intentId) || !item.order.verifiedOrigin
        || item.order.verifiedOrigin.userId !== scope.userId || item.order.verifiedOrigin.accountId !== scope.accountId) {
        throw new ExecutionError('execution_dedup_prepared_invalid', 409)
      }
      seen.add(item.intentId)
    }
    if (findDuplicatePendingOrder(candidate.request, existing.items.map(item => item.order)) !== null
      || findDuplicatePendingOrder(candidate.request, batchOrders) !== null) {
      throw new ExecutionError('execution_duplicate_prepared_pending', 409)
    }
    batchOrders.push({ ticket: candidate.intentId, instrumentId: candidate.request.instrumentId, type: candidate.request.type,
      price: candidate.request.price, verifiedOrigin: { ...scope } })
  }
}

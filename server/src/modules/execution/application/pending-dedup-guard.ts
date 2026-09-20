import { ExecutionError } from '../domain/execution.js'
import { findDuplicatePendingOrder, type PendingDedupOrder, type PendingDedupRequest } from '../domain/pending-order-dedup.js'

export interface PendingDedupRoute {
  terminalInstanceId: string
  brokerServer: string
  login: string
  connectionEpoch: string
  ownershipRevision: string
}
export interface PendingDedupSnapshot {
  accountId: string
  userId: number
  route: PendingDedupRoute
  complete: boolean
  observedAt: string
  revision: string
  orders: PendingDedupOrder[]
}
export interface PendingDedupSnapshotReader {
  /** Adapter must validate projection provenance and order lineage on the caller's transaction. */
  read(input: { accountId: string; userId: number; strategyId: string; route: PendingDedupRoute }): Promise<PendingDedupSnapshot | null>
}

export async function checkPendingDedup(reader: PendingDedupSnapshotReader, input: {
  request: PendingDedupRequest
  route: PendingDedupRoute
  expectedRevision: string
  maxAgeSeconds: number
}, now: Date) {
  const frozen = structuredClone(input), nowMs = now.getTime()
  const validRevision = (value: string) => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)
  if (!Number.isFinite(nowMs) || !Number.isSafeInteger(frozen.maxAgeSeconds) || frozen.maxAgeSeconds < 1 || frozen.maxAgeSeconds > 300
    || !validRevision(frozen.expectedRevision) || !validRevision(frozen.route.connectionEpoch) || !validRevision(frozen.route.ownershipRevision)
    || !frozen.route.terminalInstanceId || !frozen.route.brokerServer || !frozen.route.login) throw new ExecutionError('execution_dedup_context_invalid', 409)
  const snapshot = await reader.read({ ...frozen.request.scope, route: { ...frozen.route } })
  if (!snapshot || snapshot.complete !== true) throw new ExecutionError('execution_dedup_snapshot_incomplete', 409)
  if (snapshot.accountId !== frozen.request.scope.accountId || snapshot.userId !== frozen.request.scope.userId
    || snapshot.route.terminalInstanceId !== frozen.route.terminalInstanceId
    || snapshot.route.brokerServer !== frozen.route.brokerServer || snapshot.route.login !== frozen.route.login
    || snapshot.route.connectionEpoch !== frozen.route.connectionEpoch
    || snapshot.route.ownershipRevision !== frozen.route.ownershipRevision) throw new ExecutionError('execution_dedup_snapshot_scope_changed', 409)
  if (snapshot.revision !== frozen.expectedRevision) throw new ExecutionError('execution_dedup_snapshot_revision_changed', 409)
  const observed = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(snapshot.observedAt) ? Date.parse(snapshot.observedAt) : NaN
  if (!Number.isFinite(observed) || new Date(observed).toISOString() !== snapshot.observedAt
    || observed > nowMs || nowMs - observed > frozen.maxAgeSeconds * 1000) throw new ExecutionError('execution_dedup_snapshot_stale', 409)
  if (!Array.isArray(snapshot.orders)) throw new ExecutionError('execution_dedup_snapshot_incomplete', 409)
  const ticket = findDuplicatePendingOrder(frozen.request, snapshot.orders)
  if (ticket !== null) throw new ExecutionError('execution_duplicate_live_pending', 409)
  return { revision: snapshot.revision, observedAt: snapshot.observedAt }
}

import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { TradeDecisionOriginReader } from '../../inference/index.js'
import type { PendingDispatchOccupancyReader, PendingDispatchOccupancy } from '../application/pending-dispatch-dedup-guard.js'
import type { PendingDedupSnapshotReader } from '../application/pending-dedup-guard.js'
import { ExecutionError } from '../domain/execution.js'
import { executionOutcomeReference } from '../domain/execution-outcome-reference.js'
import { readPendingDispatchCandidates } from './mysql-pending-dispatch-candidates.js'
import { readPendingDispatchOrigin } from './mysql-pending-dispatch-origin.js'

/** Transaction-local adapter. Completed orders absent from the projection remain occupied
 * until a separate authoritative terminal-state proof is implemented. */
export function createMysqlPendingDispatchOccupancyReader(connection: Pick<PoolConnection, 'execute'>,
  decisions: TradeDecisionOriginReader, snapshots: PendingDedupSnapshotReader): PendingDispatchOccupancyReader {
  return {
    async read(input) {
      const scope = structuredClone(input)
      const snapshot = await snapshots.read(scope)
      if (!snapshot || !snapshot.complete || snapshot.revision !== scope.projectionRevision
        || snapshot.userId !== scope.userId || snapshot.accountId !== scope.accountId
        || Object.entries(scope.route).some(([key, value]) => snapshot.route[key as keyof typeof scope.route] !== value)) return null
      const candidates = await readPendingDispatchCandidates(connection, scope)
      const items: PendingDispatchOccupancy[] = []
      for (const candidate of candidates) {
        const origin = await readPendingDispatchOrigin(connection, decisions, { ...scope, candidate })
        if (!origin) continue
        if (candidate.status === 'succeeded' && candidate.resultHash !== null) {
          const [rows] = await connection.execute<(RowDataPacket & { result_json: string | Record<string, unknown> | null })[]>(
            `SELECT o.result_json FROM execution_outcomes o
             WHERE o.execution_intent_id=? AND o.trading_account_id=? AND o.result_sha256=? AND o.status='succeeded'
             LIMIT 2 FOR SHARE`, [candidate.intentId, scope.accountId, candidate.resultHash])
          if (rows.length > 1) throw new ExecutionError('execution_dedup_coverage_invalid', 409)
          if (rows.length === 1) {
            let result: Record<string, unknown> | null
            try { result = typeof rows[0]!.result_json === 'string' ? JSON.parse(rows[0]!.result_json as string) : rows[0]!.result_json as Record<string, unknown> | null }
            catch { throw new ExecutionError('execution_dedup_coverage_invalid', 409) }
            if (result !== null && (typeof result !== 'object' || Array.isArray(result))) throw new ExecutionError('execution_dedup_coverage_invalid', 409)
            const { ticket } = executionOutcomeReference('pending_order', 'succeeded', result)
            const covered = ticket === null ? undefined : snapshot.orders.find(order => order.ticket === ticket)
            if (covered && covered.instrumentId === candidate.instrumentId && covered.type === candidate.type
              && covered.verifiedOrigin?.userId === origin.userId && covered.verifiedOrigin.accountId === origin.accountId
              && covered.verifiedOrigin.strategyId === origin.strategyId) continue
          }
        }
        items.push({ commandId: candidate.commandId, status: candidate.status, order: { ticket: `command:${candidate.commandId}`,
          instrumentId: candidate.instrumentId, type: candidate.type, price: candidate.price, verifiedOrigin: origin } })
      }
      return { userId: scope.userId, accountId: scope.accountId, route: scope.route, complete: true, items }
    },
  }
}

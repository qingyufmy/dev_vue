import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { TradeDecisionOriginReader } from '../../inference/index.js'
import type { PendingDispatchCandidate } from './mysql-pending-dispatch-candidates.js'
import { ExecutionError } from '../domain/execution.js'

const invalid = (): never => { throw new ExecutionError('execution_dedup_origin_invalid', 409) }

/** Resolve historical strategy provenance; current subscription settings never rewrite it. */
export async function readPendingDispatchOrigin(connection: Pick<PoolConnection, 'execute'>, decisions: TradeDecisionOriginReader,
  input: { userId: number; accountId: string; candidate: Pick<PendingDispatchCandidate, 'intentId' | 'sourceType' | 'sourceId' | 'tradeDecisionId' | 'riskDecisionId'> }): Promise<{ userId: number; accountId: string; strategyId: string } | null> {
  const { userId, accountId, candidate } = structuredClone(input)
  let strategyId: string
  if (candidate.sourceType === 'risk_decision') {
    if (!candidate.tradeDecisionId || !candidate.riskDecisionId || candidate.sourceId !== candidate.riskDecisionId) return invalid()
    const origin = await decisions.read({ userId, accountId, decisionId: candidate.tradeDecisionId, riskDecisionId: candidate.riskDecisionId })
    if (!origin || origin.userId !== userId || origin.accountId !== accountId || origin.decisionId !== candidate.tradeDecisionId) return invalid()
    strategyId = origin.strategyId
  } else if (candidate.sourceType === 'strategy_distribution') {
    const [rows] = await connection.execute<(RowDataPacket & { strategy_id: string })[]>(`SELECT CAST(d.strategy_id AS CHAR) strategy_id
      FROM execution_intents i INNER JOIN execution_distribution_targets t ON t.id=i.source_id
        AND t.target_user_id=i.user_id AND t.trading_account_id=i.trading_account_id AND t.child_operation_id=i.operation_id
      INNER JOIN execution_distributions d ON d.id=t.distribution_id AND d.kind='manual_order'
      WHERE i.id=? AND i.source_type='strategy_distribution' AND i.source_id=?
        AND i.user_id=? AND i.trading_account_id=? AND i.action_kind='pending_order'
      LIMIT 2 FOR SHARE`, [candidate.intentId, candidate.sourceId, userId, accountId])
    if (rows.length !== 1) return invalid()
    strategyId = rows[0]!.strategy_id
  } else if (candidate.sourceType === 'user_command') {
    // Explicit manual commands are outside strategy dedup; do not guess an owner strategy.
    return null
  } else return invalid()
  if (!/^[1-9]\d{0,19}$/.test(strategyId)) return invalid()
  return { userId, accountId, strategyId }
}

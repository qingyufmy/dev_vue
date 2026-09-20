import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { TradeDecisionAnalysisReader, TradeDecisionOriginReader } from '../../inference/index.js'
import type { ExecutionPendingReader, InstrumentSnapshotReader } from '../../trading/index.js'
import type { PendingCommandReviewer } from '../application/pending-command-reviewer.js'
import { checkPendingDispatchDedup } from '../application/pending-dispatch-dedup-guard.js'
import { ExecutionError } from '../domain/execution.js'
import { readCommandSourceAction } from './mysql-command-source-action.js'
import { readPendingDispatchOrigin } from './mysql-pending-dispatch-origin.js'
import { createMysqlPendingDedupSnapshotReader } from './mysql-pending-dedup-snapshot-reader.js'
import { createMysqlPendingDispatchOccupancyReader } from './mysql-pending-dispatch-occupancy-reader.js'
import type { PendingDispatchCandidate } from './mysql-pending-dispatch-candidates.js'

const invalid = (): never => { throw new ExecutionError('execution_dedup_context_invalid', 409) }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

export function createMysqlPendingCommandReviewer(connection: PoolConnection, dependencies: {
  pending: ExecutionPendingReader; instruments: InstrumentSnapshotReader
  decisions: TradeDecisionOriginReader; analyses: TradeDecisionAnalysisReader
}): PendingCommandReviewer {
  const snapshots = createMysqlPendingDedupSnapshotReader(connection, dependencies.pending, dependencies.decisions)
  const occupancies = createMysqlPendingDispatchOccupancyReader(connection, dependencies.decisions, snapshots)
  return { async review(command, policy, now) {
    if (command.action !== 'order.place' || command.request.payload.params.order_type === 'market') return
    const [rows] = await connection.execute<(RowDataPacket & {
      source_type: string; source_id: string; trade_decision_id: string | null; risk_decision_id: string | null
    })[]>(`SELECT source_type,source_id,trade_decision_id,risk_decision_id FROM execution_intents
      WHERE id=? AND user_id=? AND trading_account_id=? AND action_kind='pending_order' LIMIT 1 FOR SHARE`,
    [command.executionIntentId, command.userId, command.accountId])
    if (rows.length !== 1) return invalid()
    const source = rows[0]!
    // Manual account commands have no strategy scope. Do not fabricate one.
    if (source.source_type === 'user_command') return
    const action = await readCommandSourceAction(connection, command.executionIntentId)
    const params = action.parameters, wire = command.request.payload.params
    if (action.kind !== 'pending_order' || typeof params.symbol !== 'string' || typeof params.type !== 'string'
      || typeof params.price !== 'string' || params.symbol !== wire.symbol || params.type !== wire.order_type || params.price !== wire.price) return invalid()
    const candidate: PendingDispatchCandidate = { commandId: command.id, intentId: command.executionIntentId, status: 'dispatched',
      sourceType: source.source_type, sourceId: source.source_id, tradeDecisionId: source.trade_decision_id, riskDecisionId: source.risk_decision_id,
      instrumentId: params.symbol, type: params.type as PendingDispatchCandidate['type'], price: params.price, resultHash: null }
    const origin = await readPendingDispatchOrigin(connection, dependencies.decisions, { userId: command.userId, accountId: command.accountId, candidate })
    if (!origin) return invalid()
    let atrAnchor: string | null = null
    if (source.source_type === 'risk_decision') {
      const analysis = await dependencies.analyses.read({ userId: command.userId, accountId: command.accountId,
        decisionId: source.trade_decision_id!, riskDecisionId: source.risk_decision_id! })
      if (!analysis || analysis.userId !== command.userId || analysis.accountId !== command.accountId
        || analysis.decisionId !== source.trade_decision_id || analysis.strategyId !== origin.strategyId
        || analysis.symbol !== params.symbol) return invalid()
      atrAnchor = analysis.atr.status === 'available' ? analysis.atr.value : null
    }
    const instrument = await dependencies.instruments.read(command.accountId, params.symbol)
    const evidence = instrument?.data.sourceEvidence
    if (!instrument || !record(evidence) || String(evidence.userId) !== String(command.userId)
      || String(evidence.terminalInstanceId) !== command.route.terminalInstanceId
      || String(evidence.connectionEpoch) !== String(command.route.connectionEpoch)
      || String(evidence.terminalProfileId) !== command.terminalProfileId
      || typeof evidence.ownershipRevision !== 'string') return invalid()
    const tickSize = instrument.data.tick_size ?? instrument.data.tickSize, point = instrument.data.point
    if (typeof tickSize !== 'string' || typeof point !== 'string' || instrument.revision !== action.expectedState.contractRevision
      || policy.userId !== command.userId || policy.accountId !== command.accountId) return invalid()
    await checkPendingDispatchDedup(snapshots, occupancies, {
      commandId: command.id, request: { scope: origin, instrumentId: params.symbol, type: candidate.type, price: params.price,
        atrAnchor, atrMultiplier: String(policy.values.pendingDedupAtrMultiplier), tickSize, point },
      route: { terminalInstanceId: command.route.terminalInstanceId, brokerServer: command.route.brokerServer,
        login: command.route.login, connectionEpoch: String(command.route.connectionEpoch), ownershipRevision: evidence.ownershipRevision },
      expectedRevision: String(action.expectedState.pendingOrdersRevision), maxAgeSeconds: Math.min(300, policy.values.maxRiskSummaryAgeSeconds),
    }, now)
  } }
}

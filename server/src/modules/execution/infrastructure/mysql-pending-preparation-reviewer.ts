import type { PoolConnection } from 'mysql2/promise'
import type { TradeDecisionAnalysisReader, TradeDecisionOriginReader } from '../../inference/index.js'
import type { AccountLiveRouteReader, ExecutionPendingReader, InstrumentSnapshotReader } from '../../trading/index.js'
import type { PendingPreparationReviewer } from '../application/pending-preparation-reviewer.js'
import { checkPendingPreparation, type PendingPreparationCandidate } from '../application/pending-preparation-guard.js'
import { ExecutionError, sha256Canonical } from '../domain/execution.js'
import { createMysqlPendingDedupSnapshotReader } from './mysql-pending-dedup-snapshot-reader.js'
import { createMysqlPendingDispatchOccupancyReader } from './mysql-pending-dispatch-occupancy-reader.js'
import { createMysqlPreparedPendingOccupancyReader } from './mysql-prepared-pending-occupancy-reader.js'
const invalid = (): never => { throw new ExecutionError('execution_dedup_context_invalid', 409) }
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
export function createMysqlPendingPreparationReviewer(connection: PoolConnection, dependencies: {
  routes: AccountLiveRouteReader; pending: ExecutionPendingReader; instruments: InstrumentSnapshotReader
  decisions: TradeDecisionOriginReader; analyses: TradeDecisionAnalysisReader
}): PendingPreparationReviewer {
  const snapshots = createMysqlPendingDedupSnapshotReader(connection, dependencies.pending, dependencies.decisions)
  return { async review(source, bundle, policy, now) {
    const intents = bundle.intents.filter(intent => intent.actionKind === 'pending_order')
    if (!intents.length) return
    if (policy.userId !== source.userId || policy.accountId !== source.accountId || bundle.riskDecisionId !== source.riskDecisionId) return invalid()
    const identity = { userId: source.userId, accountId: source.accountId, decisionId: source.tradeDecisionId, riskDecisionId: source.riskDecisionId }
    const origin = await dependencies.decisions.read(identity)
    const analysis = await dependencies.analyses.read(identity)
    const route = await dependencies.routes.current(source.accountId)
    if (!origin || !analysis || !route || origin.userId !== source.userId || origin.accountId !== source.accountId
      || origin.decisionId !== source.tradeDecisionId || !/^[1-9]\d{0,19}$/.test(origin.strategyId)
      || analysis.userId !== source.userId || analysis.accountId !== source.accountId || analysis.decisionId !== source.tradeDecisionId
      || analysis.strategyId !== origin.strategyId || route.userId !== source.userId || route.accountId !== source.accountId) return invalid()
    const candidates: PendingPreparationCandidate[] = []
    for (const intent of intents) {
      const approved = source.approvedActions.find(action => action.actionId === intent.actionId)
      if (!approved || sha256Canonical(approved) !== sha256Canonical(intent.action) || intent.userId !== source.userId || intent.accountId !== source.accountId) return invalid()
      const action = intent.action, params = action.parameters
      if (typeof params.symbol !== 'string' || params.symbol !== analysis.symbol || typeof params.type !== 'string' || typeof params.price !== 'string') return invalid()
      const instrument = await dependencies.instruments.read(source.accountId, params.symbol)
      const evidence = instrument?.data.sourceEvidence
      if (!instrument || !record(evidence) || String(evidence.userId) !== String(source.userId)
        || evidence.terminalInstanceId !== route.terminalInstanceId || evidence.terminalProfileId !== route.terminalProfileId
        || String(evidence.connectionEpoch) !== String(route.connectionEpoch) || typeof evidence.ownershipRevision !== 'string'
        || instrument.revision !== action.expectedState.contractRevision) return invalid()
      const tickSize = instrument.data.tick_size ?? instrument.data.tickSize, point = instrument.data.point
      if (typeof tickSize !== 'string' || typeof point !== 'string') return invalid()
      candidates.push({ intentId: intent.id, request: { scope: { userId: source.userId, accountId: source.accountId, strategyId: origin.strategyId },
        instrumentId: params.symbol, type: params.type as PendingPreparationCandidate['request']['type'], price: params.price,
        atrAnchor: analysis.atr.status === 'available' ? analysis.atr.value : null, atrMultiplier: String(policy.values.pendingDedupAtrMultiplier), tickSize, point },
        route: { terminalInstanceId: route.terminalInstanceId, brokerServer: route.brokerServer, login: route.login,
          connectionEpoch: String(route.connectionEpoch), ownershipRevision: evidence.ownershipRevision },
        expectedRevision: String(action.expectedState.pendingOrdersRevision), maxAgeSeconds: Math.min(300, policy.values.maxRiskSummaryAgeSeconds) })
    }
    await checkPendingPreparation({ snapshots, dispatched: createMysqlPendingDispatchOccupancyReader(connection, dependencies.decisions, snapshots),
      prepared: createMysqlPreparedPendingOccupancyReader(connection, dependencies.decisions) }, candidates, now)
  } }
}

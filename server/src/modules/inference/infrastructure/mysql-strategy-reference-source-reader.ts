import { readReferencePositionEntryAnalyses } from '../application/reference-position-entry-analyses.js'
import type { TradeDecisionEntryAnalysisReader } from '../application/trade-decision-entry-analysis-reader.js'
import type { ReferencePositionEvidenceReader } from '../application/reference-position-evidence.js'
import { readReferencePositionCreation, type ReferencePositionCreationReader } from '../application/reference-position-creation.js'
import type { Pool, PoolConnection } from 'mysql2/promise'
import { readReferencePositionLifecycles, type ReferencePositionLifecycleReader } from '../application/reference-position-lifecycle.js'
import type { StrategyObserverInventoryReader } from '../../trading/index.js'
import type { AnalysisSourceReader } from '../application/analysis-source-reader.js'
import { InferenceError } from '../domain/inference.js'
import { createMysqlAnalysisSourceReader } from './mysql-analysis-source-reader.js'
import { readReferencePendingCreation, type ReferencePendingCreationReader } from '../application/reference-pending-creation.js'

/** Acquires source evidence only. Inventory still requires exact execution attribution before model use. */
export function createMysqlStrategyReferenceSourceReader(pool: Pool,
  inventory: (connection: PoolConnection) => StrategyObserverInventoryReader,
  sources: (connection: PoolConnection) => AnalysisSourceReader = createMysqlAnalysisSourceReader,
  pendingCreation?: (connection: PoolConnection) => ReferencePendingCreationReader,
  positionHistory?: (connection: PoolConnection) => ReferencePositionLifecycleReader,
  positionCreation?: (connection: PoolConnection) => ReferencePositionCreationReader,
  positionEvidence?: (connection: PoolConnection) => ReferencePositionEvidenceReader,
  entryAnalyses?: (connection: PoolConnection) => TradeDecisionEntryAnalysisReader) {
  if (positionCreation && !positionHistory && !positionEvidence) throw new InferenceError('strategy_reference_position_history_required',500)
  return {
    async read(input: Parameters<AnalysisSourceReader['read']>[0] & { asOf: string }) {
      const scope = structuredClone(input)
      const connection = await pool.getConnection()
      let started = false
      let reusable = true
      try {
        // Transaction-only characteristics do not change the pooled session's default isolation.
        await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
        await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
        started = true
        const source = structuredClone(await sources(connection).read({ userId: scope.userId,
          analysisId: scope.analysisId, analysisStrategyId: scope.analysisStrategyId, symbol: scope.symbol }))
        if (!source || source.analysisId !== scope.analysisId) throw new InferenceError('strategy_reference_source_unavailable', 409)
        const current = structuredClone(await inventory(connection).read({ userId: scope.userId,
          sourceAccountId: source.sourceAccountId, analysisStrategyId: scope.analysisStrategyId, asOf: scope.asOf }))
        if (!current || current.analysisStrategyId !== scope.analysisStrategyId
          || current.authorization.userId !== scope.userId || current.authorization.accountId !== source.sourceAccountId
          || current.route.accountId !== source.sourceAccountId
          || current.route.userId !== current.authorization.operatorUserId) {
          throw new InferenceError('strategy_reference_inventory_unavailable', 409)
        }
        const pendingOrigins = pendingCreation ? await readReferencePendingCreation(current, pendingCreation(connection)) : null
        const positionEvidenceResult = positionEvidence ? structuredClone(await positionEvidence(connection).read(structuredClone(current))) : null
        if (positionEvidenceResult?.status === 'read') {
          const tickets = new Set(current.positions.items.map(item => item.ticket))
          if (!Array.isArray(positionEvidenceResult.items) || positionEvidenceResult.items.length !== tickets.size
            || new Set(positionEvidenceResult.items.map(item => item.ticket)).size !== tickets.size
            || positionEvidenceResult.items.some(item => !tickets.has(item.ticket))) {
            throw new InferenceError('strategy_reference_position_evidence_invalid',409)
          }
        }
        let positionIndex = 0
        const positionLifecycles = positionEvidenceResult ? await readReferencePositionLifecycles(current, { async read() {
          const ticket = current.positions.items[positionIndex++]!.ticket
          const evidence = positionEvidenceResult.status === 'read'
            ? positionEvidenceResult.items.find(item => item.ticket === ticket)?.history : null
          return evidence?.status === 'source_matched' ? evidence.lifecycle : { status: 'unresolved', reason: 'snapshot_mismatch' }
        } }) : positionHistory ? await readReferencePositionLifecycles(current, positionHistory(connection)) : null
        const positionOrigins = positionCreation && positionLifecycles
          ? await readReferencePositionCreation(current, positionLifecycles, positionCreation(connection)) : null
        const positionEntryAnalyses = entryAnalyses && positionOrigins
          ? await readReferencePositionEntryAnalyses(current, positionOrigins, entryAnalyses(connection)) : null
        return { source, inventory: current, pendingOrigins, positionLifecycles, positionOrigins, positionEvidence: positionEvidenceResult, positionEntryAnalyses }
      } finally {
        if (started) {
          try { await connection.rollback() } catch (error) { reusable = false; connection.destroy(); throw error }
        } else {
          // A failed START may leave next-transaction characteristics pending on this connection.
          reusable = false
          connection.destroy()
        }
        if (reusable) connection.release()
      }
    },
  }
}

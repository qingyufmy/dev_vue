import { restoreAnalysisSnapshot } from '../application/restore-analysis-snapshot.js'
import { matchesMarketSymbol } from '../../trading/index.js'
import { replayPriceActionEvidence } from '../../market/index.js'
import type { JsonObject } from '../domain/inference.js'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { AnalysisSourceReader } from '../application/analysis-source-reader.js'
import { contentHash, InferenceError } from '../domain/inference.js'

interface SourceRow extends RowDataPacket {
  analysis_id: string; user_id: number; strategy_id: string; strategy_version_id: string; standard_symbol: string
  snapshot_id: string; snapshot_hash: string; source_account_id: string | null; payload_json: unknown
}

const identifier = (value: unknown): value is string => typeof value === 'string'
  && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** One statement reads the immutable analysis/run/snapshot lineage; no cross-domain SQL. */
export function createMysqlAnalysisSourceReader(connection: Pick<PoolConnection, 'execute'>): AnalysisSourceReader {
  return {
    async read(input) {
      const scope = { ...input }
      const invalid = (): never => { throw new InferenceError('analysis_source_evidence_invalid', 409) }
      if (!Number.isSafeInteger(scope.userId) || scope.userId < 1 || !uuid(scope.analysisId)
        || !identifier(scope.analysisStrategyId) || !/^[A-Z0-9._-]{1,64}$/.test(scope.symbol)) return invalid()
      const [rows] = await connection.execute<SourceRow[]>(`SELECT a.id analysis_id,a.owner_user_id user_id,
        CAST(a.strategy_id AS CHAR) strategy_id,CAST(a.strategy_version_id AS CHAR) strategy_version_id,a.standard_symbol,
        s.id snapshot_id,s.payload_sha256 snapshot_hash,CAST(r.market_source_account_id AS CHAR) source_account_id,p.payload_json
        FROM market_analyses a
        INNER JOIN ai_analysis_runs r ON r.id=a.analysis_run_id AND r.user_id=a.owner_user_id
          AND r.strategy_id=a.strategy_id AND r.strategy_version_id=a.strategy_version_id
          AND r.standard_symbol=a.standard_symbol AND r.input_snapshot_id=a.input_snapshot_id AND r.status='succeeded'
        INNER JOIN inference_snapshots s ON s.id=a.input_snapshot_id AND s.user_id=a.owner_user_id
          AND s.strategy_id=a.strategy_id AND s.strategy_version_id=a.strategy_version_id
          AND s.standard_symbol=a.standard_symbol AND s.purpose='analysis' AND s.trading_account_id IS NULL
        INNER JOIN inference_snapshot_payloads p ON p.snapshot_id=s.id AND p.encoding='json'
        WHERE a.id=? AND a.owner_scope='user' AND a.owner_user_id=? AND a.strategy_id=? AND a.standard_symbol=?
        LIMIT 2`, [scope.analysisId, scope.userId, scope.analysisStrategyId, scope.symbol])
      if (rows.length === 0) return null
      if (rows.length !== 1) return invalid()
      const row = rows[0]!
      if (row.analysis_id !== scope.analysisId || Number(row.user_id) !== scope.userId || row.strategy_id !== scope.analysisStrategyId
        || row.standard_symbol !== scope.symbol || !identifier(row.strategy_version_id) || !uuid(row.snapshot_id)
        || !/^[0-9a-f]{64}$/.test(row.snapshot_hash)) return invalid()
      let payload: unknown
      try { payload = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json }
      catch { return invalid() }
      payload = restoreAnalysisSnapshot(payload, row.snapshot_hash)
      if (!object(payload) || contentHash(payload) !== row.snapshot_hash || payload.kind !== 'analysis'
        || !object(payload.strategy) || payload.strategy.id !== scope.analysisStrategyId || payload.strategy.versionId !== row.strategy_version_id
        || !object(payload.market) || typeof payload.market.symbol !== 'string' || !matchesMarketSymbol(payload.market.symbol, scope.symbol) || !identifier(payload.market.source_account_id)) return invalid()
      const sourceAccountId = payload.market.source_account_id
      // Manual analyses may leave the scheduled source null: the frozen market input is then authoritative.
      if (row.source_account_id !== null && row.source_account_id !== sourceAccountId) return invalid()
      let priceActionEvents: JsonObject | undefined
      if (payload.market.events !== undefined) {
        if (!object(payload.market.events) || Object.keys(payload.market.events).length > 7) return invalid()
        priceActionEvents = {}
        for (const [timeframe, raw] of Object.entries(payload.market.events)) {
          let evidence: ReturnType<typeof replayPriceActionEvidence>
          try { evidence = replayPriceActionEvidence(raw) } catch { return invalid() }
          if (evidence.timeframe !== timeframe || evidence.sourceAccountId !== sourceAccountId
            || evidence.symbol !== payload.market.symbol || evidence.referenceTime !== payload.capturedAt) return invalid()
          const { input: _input, ...projection } = evidence
          priceActionEvents[timeframe] = JSON.parse(JSON.stringify(projection)) as JsonObject
        }
      }
      return { ...(priceActionEvents === undefined ? {} : { priceActionEvents }), analysisId: scope.analysisId, sourceAccountId, strategyVersionId: row.strategy_version_id,
        snapshotId: row.snapshot_id, snapshotHash: row.snapshot_hash }
    },
  }
}

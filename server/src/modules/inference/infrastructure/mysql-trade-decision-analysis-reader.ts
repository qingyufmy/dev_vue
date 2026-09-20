import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { TradeDecisionAnalysisReader } from '../application/trade-decision-analysis-reader.js'
import { contentHash, type JsonObject } from '../domain/inference.js'
import { frozenAnalysisAtr } from '../domain/frozen-analysis-atr.js'
import { createMysqlTradeDecisionOriginReader } from './mysql-trade-decision-origin-reader.js'

interface AnalysisRow extends RowDataPacket {
  analysis_id: string
  snapshot_id: string
  strategy_id: string
  strategy_version_id: string
  standard_symbol: string
  payload_sha256: string
  payload_json: string | JsonObject
}

const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Caller retains all locks; no latest-analysis lookup or current strategy substitution. */
export function createMysqlTradeDecisionAnalysisReader(connection: Pick<PoolConnection, 'execute'>): TradeDecisionAnalysisReader {
  const origins = createMysqlTradeDecisionOriginReader(connection)
  return {
    async read(input) {
      const scope = { ...input }
      const origin = await origins.read(scope)
      if (!origin) return null
      const [rows] = await connection.execute<AnalysisRow[]>(`SELECT a.id analysis_id,s.id snapshot_id,
        CAST(s.strategy_id AS CHAR) strategy_id,CAST(s.strategy_version_id AS CHAR) strategy_version_id,
        s.standard_symbol,s.payload_sha256,p.payload_json
        FROM trade_decisions d INNER JOIN market_analyses a ON a.id=d.market_analysis_id AND a.owner_user_id=d.user_id
        INNER JOIN ai_analysis_runs r ON r.id=a.analysis_run_id AND r.user_id=a.owner_user_id
          AND r.strategy_id=a.strategy_id AND r.strategy_version_id=a.strategy_version_id
          AND r.input_snapshot_id=a.input_snapshot_id AND BINARY r.standard_symbol=BINARY a.standard_symbol
        INNER JOIN inference_snapshots s ON s.id=a.input_snapshot_id AND s.user_id=a.owner_user_id
          AND s.strategy_id=a.strategy_id AND s.strategy_version_id=a.strategy_version_id
          AND BINARY s.standard_symbol=BINARY a.standard_symbol AND s.purpose='analysis' AND s.trading_account_id IS NULL
        INNER JOIN inference_snapshot_payloads p ON p.snapshot_id=s.id AND p.encoding='json'
        WHERE d.id=? AND d.risk_decision_id=? AND d.user_id=? AND d.trading_account_id=?
          AND d.status='accepted' AND r.status='succeeded'
        LIMIT 2 FOR SHARE`, [scope.decisionId, scope.riskDecisionId, scope.userId, scope.accountId])
      if (rows.length !== 1) return null
      const row = rows[0]!
      let payload: unknown
      try { payload = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json } catch { return null }
      if (!object(payload) || contentHash(payload) !== row.payload_sha256 || payload.kind !== 'analysis'
        || !object(payload.strategy) || payload.strategy.id !== row.strategy_id || payload.strategy.versionId !== row.strategy_version_id
        || !object(payload.market) || payload.market.symbol !== row.standard_symbol
        || typeof payload.capturedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(payload.capturedAt)
        || !Number.isFinite(Date.parse(payload.capturedAt)) || new Date(payload.capturedAt).toISOString() !== payload.capturedAt) return null
      return { ...origin, analysisId: row.analysis_id, snapshotId: row.snapshot_id, snapshotHash: row.payload_sha256,
        symbol: row.standard_symbol, capturedAt: payload.capturedAt, market: payload.market,
        atr: frozenAnalysisAtr(payload.market, payload.capturedAt) }
    },
  }
}

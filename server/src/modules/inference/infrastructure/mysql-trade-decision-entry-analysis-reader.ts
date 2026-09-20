import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { TradeDecisionEntryAnalysisReader } from '../application/trade-decision-entry-analysis-reader.js'
import { assertMarketAnalysisResult, contentHash, InferenceError, type MarketAnalysisResult } from '../domain/inference.js'

interface EntryRow extends RowDataPacket {
  decision_id: string; risk_decision_id: string; user_id: number; account_id: string
  trader_strategy_id: string; trader_version_id: string; analysis_id: string
  analysis_strategy_id: string; analysis_version_id: string; standard_symbol: string
  analysis_hash: string; result_hash: string; result_json: unknown
  input_id: string; input_hash: string; input_json: unknown
  trader_input_id: string; trader_input_hash: string; trader_input_json: unknown
}
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n
const reference = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,191}$/.test(value)
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const utc = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const parse = (value: unknown): unknown => typeof value === 'string' ? JSON.parse(value) : value

/** Snapshot reads only: never select the latest analysis, current strategy, or live market state. */
export function createMysqlTradeDecisionEntryAnalysisReader(connection: Pick<PoolConnection, 'execute'>): TradeDecisionEntryAnalysisReader {
  return { async read(input) {
    const scope = structuredClone(input)
    if (!Number.isSafeInteger(scope.userId) || scope.userId < 1 || ![scope.accountId, scope.strategyId, scope.strategyVersionId].every(identifier)
      || ![scope.decisionId, scope.riskDecisionId].every(reference) || !/^[A-Za-z0-9._-]{1,64}$/.test(scope.symbol)) {
      throw new InferenceError('entry_analysis_scope_invalid', 409)
    }
    const [rows] = await connection.execute<EntryRow[]>(`SELECT d.id decision_id,d.risk_decision_id,d.user_id,
      CAST(d.trading_account_id AS CHAR) account_id,CAST(d.strategy_id AS CHAR) trader_strategy_id,
      CAST(d.strategy_version_id AS CHAR) trader_version_id,a.id analysis_id,
      CAST(a.strategy_id AS CHAR) analysis_strategy_id,CAST(a.strategy_version_id AS CHAR) analysis_version_id,
      a.standard_symbol,a.content_sha256 analysis_hash,p.payload_sha256 result_hash,p.payload_json result_json,
      s.id input_id,s.payload_sha256 input_hash,sp.payload_json input_json,
      ts.id trader_input_id,ts.payload_sha256 trader_input_hash,tp.payload_json trader_input_json
      FROM trade_decisions d INNER JOIN ai_trader_runs tr ON tr.id=d.trader_run_id
        AND tr.user_id=d.user_id AND tr.trading_account_id=d.trading_account_id
        AND tr.strategy_id=d.strategy_id AND tr.strategy_version_id=d.strategy_version_id
        AND tr.market_analysis_id=d.market_analysis_id AND tr.input_snapshot_id=d.input_snapshot_id AND tr.status='succeeded'
      INNER JOIN market_analyses a ON a.id=d.market_analysis_id AND a.owner_scope='user' AND a.owner_user_id=d.user_id
      INNER JOIN ai_analysis_runs ar ON ar.id=a.analysis_run_id AND ar.user_id=a.owner_user_id
        AND ar.strategy_id=a.strategy_id AND ar.strategy_version_id=a.strategy_version_id
        AND ar.input_snapshot_id=a.input_snapshot_id AND BINARY ar.standard_symbol=BINARY a.standard_symbol AND ar.status='succeeded'
      INNER JOIN inference_snapshots s ON s.id=a.input_snapshot_id AND s.user_id=a.owner_user_id
        AND s.strategy_id=a.strategy_id AND s.strategy_version_id=a.strategy_version_id
        AND BINARY s.standard_symbol=BINARY a.standard_symbol AND s.purpose='analysis' AND s.trading_account_id IS NULL
      INNER JOIN inference_snapshot_payloads sp ON sp.snapshot_id=s.id AND sp.encoding='json'
      INNER JOIN market_analysis_payloads p ON p.market_analysis_id=a.id
      INNER JOIN inference_snapshots ts ON ts.id=d.input_snapshot_id AND ts.user_id=d.user_id
        AND ts.trading_account_id=d.trading_account_id AND ts.strategy_id=d.strategy_id AND ts.strategy_version_id=d.strategy_version_id
        AND BINARY ts.standard_symbol=BINARY a.standard_symbol AND ts.purpose='trader'
      INNER JOIN inference_snapshot_payloads tp ON tp.snapshot_id=ts.id AND tp.encoding='json'
      WHERE d.id=? AND d.risk_decision_id=? AND d.user_id=? AND d.trading_account_id=?
        AND d.strategy_id=? AND d.strategy_version_id=? AND BINARY a.standard_symbol=BINARY ? AND d.status='accepted'
      LIMIT 2`, [scope.decisionId, scope.riskDecisionId, scope.userId, scope.accountId, scope.strategyId, scope.strategyVersionId, scope.symbol])
    if (rows.length !== 1) return null
    const row = rows[0]!
    if (row.decision_id !== scope.decisionId || row.risk_decision_id !== scope.riskDecisionId || Number(row.user_id) !== scope.userId
      || row.account_id !== scope.accountId || row.trader_strategy_id !== scope.strategyId || row.trader_version_id !== scope.strategyVersionId
      || row.standard_symbol !== scope.symbol || ![row.analysis_strategy_id, row.analysis_version_id].every(identifier)
      || ![row.analysis_id, row.input_id, row.trader_input_id].every(reference)) return null
    let result: unknown, snapshot: unknown, trader: unknown
    try { result = parse(row.result_json); snapshot = parse(row.input_json); trader = parse(row.trader_input_json) } catch { return null }
    if (!object(result) || !object(snapshot) || !object(trader) || contentHash(result) !== row.analysis_hash || row.result_hash !== row.analysis_hash
      || contentHash(snapshot) !== row.input_hash || contentHash(trader) !== row.trader_input_hash
      || snapshot.kind !== 'analysis' || !object(snapshot.strategy) || snapshot.strategy.id !== row.analysis_strategy_id || snapshot.strategy.versionId !== row.analysis_version_id
      || !object(snapshot.market) || snapshot.market.symbol !== scope.symbol || !utc(snapshot.capturedAt)
      || trader.kind !== 'trader' || !object(trader.strategy) || trader.strategy.id !== scope.strategyId || trader.strategy.versionId !== scope.strategyVersionId
      || !object(trader.account) || trader.account.id !== scope.accountId || !utc(trader.capturedAt)
      || !object(trader.analysis) || trader.analysis.id !== row.analysis_id || trader.analysis.contentHash !== row.analysis_hash
      || !object(trader.analysis.result) || contentHash(trader.analysis.result) !== row.analysis_hash
      || !utc(result.analyzedAt) || !utc(result.validUntil) || Date.parse(snapshot.capturedAt) > Date.parse(result.analyzedAt)
      || Date.parse(result.analyzedAt) > Date.parse(trader.capturedAt) || Date.parse(result.validUntil) <= Date.parse(trader.capturedAt)
      || typeof result.confidence !== 'number' || !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 100) return null
    try { assertMarketAnalysisResult(result as unknown as MarketAnalysisResult) } catch { return null }
    return { ...scope, analysisId: row.analysis_id, analysisStrategyId: row.analysis_strategy_id, analysisStrategyVersionId: row.analysis_version_id,
      analysisHash: row.analysis_hash, result: structuredClone(result) as unknown as MarketAnalysisResult,
      inputSnapshotId: row.input_id, inputSnapshotHash: row.input_hash, inputCapturedAt: snapshot.capturedAt,
      traderInputSnapshotId: row.trader_input_id, traderInputSnapshotHash: row.trader_input_hash }
  } }
}

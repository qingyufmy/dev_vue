import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { ProposedDecisionEvidenceReader } from '../application/proposed-decision-evidence-reader.js'
import { contentHash, type JsonObject } from '../domain/inference.js'

interface EvidenceRow extends RowDataPacket {
  decision_id: string; user_id: number; account_id: string; decision_revision: number
  decision_hash: string; decision_payload: string | JsonObject; confidence: number
  analysis_id: string; analysis_revision: number; snapshot_id: string; snapshot_hash: string
  strategy_id: string; strategy_version_id: string; standard_symbol: string; snapshot_payload: string | JsonObject
}
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value)
const decode = (value: unknown): unknown => typeof value === 'string' ? JSON.parse(value) : value

export function createMysqlProposedDecisionEvidenceReader(connection: Pick<PoolConnection, 'execute'>): ProposedDecisionEvidenceReader {
  return { async readPositions(input) {
    const [rows] = await connection.execute<RowDataPacket[]>(`SELECT p.payload_json,s.payload_sha256
      FROM trade_decisions d
      INNER JOIN ai_trader_runs r ON r.id=d.trader_run_id AND r.input_snapshot_id=d.input_snapshot_id
        AND r.user_id=d.user_id AND r.trading_account_id=d.trading_account_id AND r.status='succeeded'
      INNER JOIN inference_snapshots s ON s.id=d.input_snapshot_id AND s.user_id=d.user_id
        AND s.trading_account_id=d.trading_account_id AND s.purpose='trader'
      INNER JOIN inference_snapshot_payloads p ON p.snapshot_id=s.id AND p.encoding='json'
      WHERE d.id=? AND d.revision=? AND d.user_id=? AND d.trading_account_id=?
        AND r.analysis_revision=? AND d.status='proposed' AND d.risk_decision_id IS NULL LIMIT 2`,
    [input.decisionId,input.decisionRevision,input.userId,input.accountId,input.analysisRevision])
    if (rows.length !== 1) return null
    try {
      const payload = decode(rows[0]!.payload_json)
      if (!object(payload) || contentHash(payload) !== rows[0]!.payload_sha256
        || !Array.isArray(payload.positions)
        || !Number.isSafeInteger(payload.positionsRevision)) return null
      return { positions: payload.positions, revision: Number(payload.positionsRevision) }
    } catch { return null }
  }, async read(input) {
    const scope = { ...input }
    if (!Number.isSafeInteger(scope.decisionRevision) || scope.decisionRevision < 1
      || !Number.isSafeInteger(scope.analysisRevision) || scope.analysisRevision < 1
      || !Number.isSafeInteger(scope.userId) || scope.userId < 1 || !/^[1-9]\d{0,19}$/.test(scope.accountId)) return null
    const [rows] = await connection.execute<EvidenceRow[]>(`SELECT d.id decision_id,d.user_id,CAST(d.trading_account_id AS CHAR) account_id,
      d.revision decision_revision,d.content_sha256 decision_hash,dp.payload_json decision_payload,d.confidence,
      a.id analysis_id,a.revision analysis_revision,s.id snapshot_id,s.payload_sha256 snapshot_hash,
      CAST(s.strategy_id AS CHAR) strategy_id,CAST(s.strategy_version_id AS CHAR) strategy_version_id,
      s.standard_symbol,sp.payload_json snapshot_payload
      FROM trade_decisions d INNER JOIN trade_decision_payloads dp ON dp.trade_decision_id=d.id
      INNER JOIN ai_trader_runs tr ON tr.id=d.trader_run_id AND tr.user_id=d.user_id AND tr.trading_account_id=d.trading_account_id
        AND tr.strategy_id=d.strategy_id AND tr.strategy_version_id=d.strategy_version_id
        AND tr.market_analysis_id=d.market_analysis_id AND tr.input_snapshot_id=d.input_snapshot_id AND tr.status='succeeded'
      INNER JOIN market_analyses a ON a.id=d.market_analysis_id AND a.owner_user_id=d.user_id AND a.revision=tr.analysis_revision
      INNER JOIN ai_analysis_runs ar ON ar.id=a.analysis_run_id AND ar.user_id=a.owner_user_id
        AND ar.strategy_id=a.strategy_id AND ar.strategy_version_id=a.strategy_version_id
        AND ar.input_snapshot_id=a.input_snapshot_id AND BINARY ar.standard_symbol=BINARY a.standard_symbol AND ar.status='succeeded'
      INNER JOIN inference_snapshots s ON s.id=a.input_snapshot_id AND s.user_id=a.owner_user_id
        AND s.strategy_id=a.strategy_id AND s.strategy_version_id=a.strategy_version_id
        AND BINARY s.standard_symbol=BINARY a.standard_symbol AND s.purpose='analysis' AND s.trading_account_id IS NULL
      INNER JOIN inference_snapshot_payloads sp ON sp.snapshot_id=s.id AND sp.encoding='json'
      WHERE d.id=? AND d.revision=? AND d.user_id=? AND d.trading_account_id=? AND a.revision=?
        AND d.status='proposed' AND d.risk_decision_id IS NULL LIMIT 2 FOR SHARE`,
    [scope.decisionId, scope.decisionRevision, scope.userId, scope.accountId, scope.analysisRevision])
    if (rows.length !== 1) return null
    const row = rows[0]!
    try {
      const decision = decode(row.decision_payload), snapshot = decode(row.snapshot_payload)
      if (row.decision_id !== scope.decisionId || Number(row.decision_revision) !== scope.decisionRevision
        || Number(row.user_id) !== scope.userId || row.account_id !== scope.accountId || Number(row.analysis_revision) !== scope.analysisRevision
        || !object(decision) || contentHash(decision) !== row.decision_hash || typeof decision.confidence !== 'number'
        || !Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 100 || decision.confidence !== Number(row.confidence)
        || !object(snapshot) || contentHash(snapshot) !== row.snapshot_hash || snapshot.kind !== 'analysis'
        || !object(snapshot.strategy) || snapshot.strategy.id !== row.strategy_id || snapshot.strategy.versionId !== row.strategy_version_id
        || !object(snapshot.market) || snapshot.market.symbol !== row.standard_symbol
        || typeof snapshot.capturedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(snapshot.capturedAt)
        || !Number.isFinite(Date.parse(snapshot.capturedAt)) || new Date(snapshot.capturedAt).toISOString() !== snapshot.capturedAt) return null
      return { ...scope, decisionHash: row.decision_hash, confidence: decision.confidence, analysisId: row.analysis_id,
        snapshotId: row.snapshot_id, snapshotHash: row.snapshot_hash, symbol: row.standard_symbol,
        capturedAt: snapshot.capturedAt, market: snapshot.market }
    } catch { return null }
  } }
}

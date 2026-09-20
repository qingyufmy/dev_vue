import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { DecisionStrategyEvidenceReader } from '../application/decision-strategy-evidence-reader.js'
import { contentHash, type JsonObject } from '../domain/inference.js'
import { createHash } from 'node:crypto'

interface EvidenceRow extends RowDataPacket {
  decision_id: string; decision_revision: number; user_id: number; account_id: string
  decision_hash: string; decision_payload: unknown; snapshot_id: string; snapshot_hash: string; snapshot_payload: unknown
  subscription_id: string; subscription_revision: number; strategy_id: string; version_id: string
  analysis_id: string
}
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value)
const decode = (value: unknown): unknown => typeof value === 'string' ? JSON.parse(value) : value
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

export function createDecisionStrategyEvidenceReader(connection: Pick<PoolConnection, 'execute'>): DecisionStrategyEvidenceReader {
  return { async read(scope) {
    if (!Number.isSafeInteger(scope.decisionRevision) || scope.decisionRevision < 1
      || !Number.isSafeInteger(scope.userId) || scope.userId < 1 || !/^[1-9]\d{0,19}$/.test(scope.accountId)) return null
    const [rows] = await connection.execute<EvidenceRow[]>(`SELECT d.id decision_id,d.revision decision_revision,d.user_id,
        CAST(d.trading_account_id AS CHAR) account_id,d.content_sha256 decision_hash,dp.payload_json decision_payload,
        s.id snapshot_id,s.payload_sha256 snapshot_hash,sp.payload_json snapshot_payload,
        CAST(r.subscription_id AS CHAR) subscription_id,r.subscription_revision,
        CAST(d.strategy_id AS CHAR) strategy_id,CAST(d.strategy_version_id AS CHAR) version_id,d.market_analysis_id analysis_id
      FROM trade_decisions d INNER JOIN trade_decision_payloads dp ON dp.trade_decision_id=d.id
      INNER JOIN ai_trader_runs r ON r.id=d.trader_run_id AND r.user_id=d.user_id AND r.trading_account_id=d.trading_account_id
        AND r.strategy_id=d.strategy_id AND r.strategy_version_id=d.strategy_version_id AND r.market_analysis_id=d.market_analysis_id
        AND r.input_snapshot_id=d.input_snapshot_id AND r.status='succeeded'
      INNER JOIN inference_snapshots s ON s.id=d.input_snapshot_id AND s.user_id=d.user_id
        AND s.trading_account_id=d.trading_account_id AND s.strategy_id=d.strategy_id AND s.strategy_version_id=d.strategy_version_id
        AND s.purpose='trader'
      INNER JOIN inference_snapshot_payloads sp ON sp.snapshot_id=s.id AND sp.encoding='json'
      WHERE d.id=? AND d.revision=? AND d.user_id=? AND d.trading_account_id=?
        AND d.status='proposed' AND d.risk_decision_id IS NULL LIMIT 2 FOR SHARE`,
    [scope.decisionId, scope.decisionRevision, scope.userId, scope.accountId])
    if (rows.length !== 1) return null
    const row = rows[0]!
    try {
      const decision = decode(row.decision_payload), snapshot = decode(row.snapshot_payload)
      if (row.decision_id !== scope.decisionId || Number(row.decision_revision) !== scope.decisionRevision
        || Number(row.user_id) !== scope.userId || row.account_id !== scope.accountId
        || !object(decision) || contentHash(decision) !== row.decision_hash
        || !object(snapshot) || contentHash(snapshot) !== row.snapshot_hash || snapshot.kind !== 'trader'
        || !object(snapshot.strategy) || snapshot.strategy.id !== row.strategy_id || snapshot.strategy.versionId !== row.version_id
        || !hash(snapshot.strategyConfigHash) || !hash(snapshot.strategy.promptHash) || typeof snapshot.strategy.promptText !== 'string'
        || createHash('sha256').update(snapshot.strategy.promptText).digest('hex') !== snapshot.strategy.promptHash
        || !object(snapshot.account) || snapshot.account.id !== scope.accountId
        || !Number.isSafeInteger(snapshot.subscriptionRevision) || Number(snapshot.subscriptionRevision) < 1
        || snapshot.subscriptionRevision !== Number(row.subscription_revision)) return null
      let analysisMarketRegime: string | undefined
      if (snapshot.analysis !== undefined) {
        if (!object(snapshot.analysis) || snapshot.analysis.id !== row.analysis_id || !object(snapshot.analysis.result)
          || contentHash(snapshot.analysis.result) !== snapshot.analysis.contentHash) return null
        const regime = snapshot.analysis.result.marketRegime
        if (typeof regime === 'string' && regime.length <= 256) analysisMarketRegime = regime
      }
      return { ...scope, decisionHash: row.decision_hash, snapshotId: row.snapshot_id, snapshotHash: row.snapshot_hash,
        ...(analysisMarketRegime === undefined ? {} : { analysisMarketRegime }),
        strategyScope: { subscriptionId: row.subscription_id, subscriptionRevision: Number(row.subscription_revision),
          userId: scope.userId, accountId: scope.accountId, traderStrategyId: row.strategy_id, traderStrategyVersionId: row.version_id,
          promptHash: snapshot.strategy.promptHash, configHash: snapshot.strategyConfigHash } }
    } catch { return null }
  } }
}
